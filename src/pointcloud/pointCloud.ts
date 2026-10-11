// Point-cloud metrics as engine planes: the main-thread half of the
// point-cloud inputs (`pc:<metric>`, products.ts).
//
// The metrics are computed per CHUNK — 128 × 128 cells on a lattice fixed in
// the tiles' own projected CRS, at a cell size chosen from the output's
// resolution (2, 4, 8 or 16 m) — never per map tile: neighbouring map tiles
// share chunks, a restyle or a pan reuses them, and a cell means the same
// ground whichever tile asked for it. Each chunk is read by a worker
// (pcWorker.ts) from the COPC files the parquet index lists for it; every
// output pixel then takes the value of the cell its own lon/lat falls in
// (warp.ts's control grid, as for a COG).
//
// Below ~16 m a pixel (zoom ≲ 13) the point cloud is not read at all: the
// planes stay empty (NaN) and every variable reading them has no value there.

import proj4 from 'proj4';
import { projDef } from '../crs.ts';
import { controlGrid, gridWindow, interpGrid, type LonLatBox, type OutGrid } from '../warp.ts';
import { index, loadProjects, projectById, copcUrl } from './catalog.ts';
import { CHUNK, cellFor, PC_METRICS, type CellGrid, type PcMetric } from './pcMetrics.ts';
import type { PcRequest, PcResponse } from './pcWorker.ts';

type Metrics = Record<PcMetric, Float32Array> | null;

const MAX_CHUNKS = 64;
const MARGIN = 2;
const CACHE_BYTES = 192 * 1024 * 1024;
const WORKERS = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));

// ── Workers ─────────────────────────────────────────────────────────────────

let pool: Worker[] | null = null;
let rr = 0, nextId = 1;
const waiting = new Map<number, { resolve: (r: PcResponse) => void }>();
const workerBytes = new Map<Worker, number>();

function worker(): Worker {
  pool ??= Array.from({ length: WORKERS }, () => {
    const w = new Worker(new URL('./pcWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<PcResponse>) => {
      if (e.data.ok) { workerBytes.set(w, e.data.totalBytes); pcStatus.bytes = [...workerBytes.values()].reduce((a, b) => a + b, 0); }
      waiting.get(e.data.id)?.resolve(e.data); waiting.delete(e.data.id);
    };
    return w;
  });
  return pool[rr++ % pool.length];
}

function request(urls: string[], grid: CellGrid): Promise<PcResponse> {
  const id = nextId++;
  return new Promise(resolve => {
    waiting.set(id, { resolve });
    worker().postMessage({ id, urls, grid, margin: MARGIN } satisfies PcRequest);
  });
}

// ── Status (for the UI) ─────────────────────────────────────────────────────

export const pcStatus = { loading: 0, chunks: 0, points: 0, bytes: 0, lastError: '', events: new EventTarget() };
const changed = () => pcStatus.events.dispatchEvent(new Event('change'));

// ── Chunks ──────────────────────────────────────────────────────────────────

const cache = new Map<string, Metrics>();
let cacheBytes = 0;
const inflight = new Map<string, Promise<Metrics>>();
const chunkBytes = (m: Metrics) => (m ? PC_METRICS.length * CHUNK * CHUNK * 4 : 64);

/**
 * One chunk's metrics. The files to read are looked up for the CHUNK's own
 * box, never taken from the request that first asked: a chunk outlives that
 * request and covers ground beyond it.
 */
function chunk(crs: string, cell: number, cx: number, cy: number, inv: (p: [number, number]) => [number, number]): Promise<Metrics> {
  const key = `${crs}|${cell}|${cx}|${cy}`;
  if (cache.has(key)) { const v = cache.get(key)!; cache.delete(key); cache.set(key, v); return Promise.resolve(v); }
  let p = inflight.get(key);
  if (!p) {
    const size = CHUNK * cell;
    const grid: CellGrid = { x0: cx * size, y0: cy * size, cell, w: CHUNK, h: CHUNK };
    const ll = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([a, b]) => inv([grid.x0 + a * size, grid.y0 + b * size]));
    const box: LonLatBox = [Math.min(...ll.map(q => q[0])), Math.min(...ll.map(q => q[1])), Math.max(...ll.map(q => q[0])), Math.max(...ll.map(q => q[1]))];
    let urls: string[] = [];
    p = (async (): Promise<Metrics> => {
      const { tiles } = await index.search(box);
      urls = [...new Set(tiles.filter(t => projectById.get(t.project)?.crs === crs).map(copcUrl).filter(Boolean))];
      if (!urls.length) return null;
      pcStatus.loading++; changed();
      try {
        const r = await request(urls, grid);
        if (!r.ok) { pcStatus.lastError = r.error; console.warn('[pc]', r.error); return null; }
        pcStatus.chunks++; pcStatus.points += r.points;
        return r.metrics as Record<PcMetric, Float32Array>;
      } finally { pcStatus.loading--; changed(); }
    })().then(m => {
      // A failed read is not cached: the next request tries again.
      if (m || !urls.length) {
        cache.set(key, m);
        cacheBytes += chunkBytes(m);
        for (const [k, v] of cache) { if (cacheBytes <= CACHE_BYTES) break; cache.delete(k); cacheBytes -= chunkBytes(v); }
      }
      return m;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** The lon/lat box and ground metres per pixel of an output grid. */
function gridExtent(out: OutGrid): { box: LonLatBox; mpp: number } {
  const pts: [number, number][] = [];
  for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) pts.push(out.lonLat(fx * out.w, fy * out.h));
  const box: LonLatBox = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
  const lat = (box[1] + box[3]) / 2;
  const mpp = ((box[2] - box[0]) * 111320 * Math.cos((lat * Math.PI) / 180)) / out.w;
  return { box, mpp };
}

/**
 * Sample point-cloud metrics onto an output grid: `keys` maps each plane key
 * to the metric it holds. Planes are NaN where no tile covers the ground, the
 * read failed, the metric is undefined, or the output is too coarse.
 */
export async function samplePointCloud(out: OutGrid, keys: [string, PcMetric][]): Promise<Record<string, Float32Array>> {
  const n = out.w * out.h;
  const planes: Record<string, Float32Array> = Object.fromEntries(keys.map(([k]) => [k, new Float32Array(n).fill(NaN)]));
  const { box, mpp } = gridExtent(out);
  const cell = cellFor(mpp);
  if (!cell) return planes;
  await loadProjects();
  const { tiles } = await index.search(box);
  if (!tiles.length) return planes;
  // One CRS per request: the CRS most of the tiles in view are in.
  const byCrs = new Map<string, typeof tiles>();
  for (const t of tiles) { const c = projectById.get(t.project)?.crs ?? ''; (byCrs.get(c) ?? byCrs.set(c, []).get(c)!).push(t); }
  const [crs] = [...byCrs].sort((a, b) => b[1].length - a[1].length)[0];
  const epsg = Number(crs.replace(/^EPSG:/, ''));
  const def = projDef(epsg);
  if (!def) return planes;
  const conv = proj4('EPSG:4326', def);
  // Global cell coordinates (X / cell, Y / cell), Y north-positive.
  const grid = controlGrid(out, q => conv.forward(q) as [number, number], { originX: 0, originY: 0, resX: cell, resY: cell });
  const [c0, r0, c1, r1] = gridWindow(grid);
  const cx0 = Math.floor(c0 / CHUNK), cx1 = Math.floor((c1 - 1) / CHUNK), cy0 = Math.floor(r0 / CHUNK), cy1 = Math.floor((r1 - 1) / CHUNK);
  if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAX_CHUNKS) return planes;
  const chunks = new Map<string, Metrics>();
  const jobs: Promise<void>[] = [];
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
    jobs.push(chunk(crs, cell, cx, cy, q => conv.inverse(q) as [number, number]).then(m => { chunks.set(`${cx},${cy}`, m); }));
  }
  await Promise.all(jobs);
  const p: [number, number] = [0, 0];
  for (let py = 0; py < out.h; py++) for (let px = 0; px < out.w; px++) {
    interpGrid(grid, px + 0.5, py + 0.5, p);
    const col = Math.floor(p[0]), row = Math.floor(p[1]);
    const cx = Math.floor(col / CHUNK), cy = Math.floor(row / CHUNK);
    const m = chunks.get(`${cx},${cy}`);
    if (!m) continue;
    const k = (row - cy * CHUNK) * CHUNK + (col - cx * CHUNK), i = py * out.w + px;
    for (const [key, metric] of keys) planes[key][i] = m[metric][k];
  }
  return planes;
}

