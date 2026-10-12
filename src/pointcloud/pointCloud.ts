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
import { CHUNK, PC_CELLS, cellFor, PC_METRICS, type CellGrid, type PcMetric } from './pcMetrics.ts';
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


// ── A whole box, on the tiles' own grid (the Objects tab) ───────────────────

export interface PcBoxResult {
  /** The tiles' CRS, e.g. `EPSG:2961`, and its code. */
  crs: string;
  epsg: number;
  /** Top-left corner and cell size of the assembled grid; row 0 is the NORTHERN edge. */
  originX: number;
  originY: number;
  cell: number;
  w: number;
  h: number;
  /** One plane per metric (NaN: no value). */
  values: Record<PcMetric, Float32Array>;
  /** The acquisitions (catalogue projects) whose tiles were read, and their years. */
  projects: { id: string; label: string; year: number }[];
  /** Tiles in other CRSs over the box, left out (one CRS per read). */
  otherCrsTiles: number;
  chunks: number;
}

/**
 * Every metric over a lon/lat box at the FINEST cell size the chunk budget
 * allows (2 m where it can), on the chunk lattice in the tiles' own CRS —
 * never resampled. Null when no indexed tile meets the box. Throws when the
 * box would need more than `maxChunks` even at 16 m.
 */
export async function readPointCloudBox(box: LonLatBox, onProgress?: (msg: string) => void, maxChunks = MAX_CHUNKS): Promise<PcBoxResult | null> {
  await loadProjects();
  const { tiles } = await index.search(box);
  if (!tiles.length) return null;
  const byCrs = new Map<string, typeof tiles>();
  for (const t of tiles) { const c = projectById.get(t.project)?.crs ?? ''; (byCrs.get(c) ?? byCrs.set(c, []).get(c)!).push(t); }
  const [crs, mine] = [...byCrs].sort((a, b) => b[1].length - a[1].length)[0];
  const epsg = Number(crs.replace(/^EPSG:/, ''));
  const def = projDef(epsg);
  if (!def) throw new Error(`the point cloud's CRS ${crs} is not defined here`);
  const conv = proj4('EPSG:4326', def);
  const corners = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(q => conv.forward(q) as [number, number]);
  const X0 = Math.min(...corners.map(q => q[0])), X1 = Math.max(...corners.map(q => q[0])), Y0 = Math.min(...corners.map(q => q[1])), Y1 = Math.max(...corners.map(q => q[1]));
  let cell = 0, cx0 = 0, cx1 = 0, cy0 = 0, cy1 = 0;
  for (const c of PC_CELLS) {
    const size = CHUNK * c;
    cx0 = Math.floor(X0 / size); cx1 = Math.floor(X1 / size); cy0 = Math.floor(Y0 / size); cy1 = Math.floor(Y1 / size);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) <= maxChunks) { cell = c; break; }
  }
  if (!cell) throw new Error(`the study area needs more than ${maxChunks} point-cloud chunks even at ${PC_CELLS[PC_CELLS.length - 1]} m cells`);
  const nx = cx1 - cx0 + 1, ny = cy1 - cy0 + 1, total = nx * ny;
  const w = nx * CHUNK, hh = ny * CHUNK;
  const values = Object.fromEntries(PC_METRICS.map(m => [m, new Float32Array(w * hh).fill(NaN)])) as Record<PcMetric, Float32Array>;
  let done = 0;
  const jobs: Promise<void>[] = [];
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
    jobs.push(chunk(crs, cell, cx, cy, q => conv.inverse(q) as [number, number]).then(m => {
      onProgress?.(`Reading the point cloud: ${++done} of ${total} chunks (${cell} m cells)…`);
      if (!m) return;
      // Chunk row 0 is its SOUTHERN edge; the assembled grid's row 0 is the northern edge.
      const ox = (cx - cx0) * CHUNK, oyTop = (cy1 - cy) * CHUNK;
      for (let r = 0; r < CHUNK; r++) {
        const dst = (oyTop + (CHUNK - 1 - r)) * w + ox;
        for (const k of PC_METRICS) values[k].set(m[k].subarray(r * CHUNK, (r + 1) * CHUNK), dst);
      }
    }));
  }
  await Promise.all(jobs);
  const projects = [...new Set(mine.map(t => t.project))].map(id => { const p = projectById.get(id); return { id, label: p?.label ?? id, year: p?.year ?? 0 }; });
  return { crs, epsg, originX: cx0 * CHUNK * cell, originY: (cy1 + 1) * CHUNK * cell, cell, w, h: hh, values, projects, otherCrsTiles: tiles.length - mine.length, chunks: total };
}
