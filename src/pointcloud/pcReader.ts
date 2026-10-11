// Reading the returns of a box from CanElevation COPC files, and turning them
// into the metric grids of pcMetrics.ts. Runs in the point-cloud worker
// (pcWorker.ts) so laz-perf's decoding never blocks the map.
//
// A box is read the way FieldMapper's copcSource reads one: the header, then
// only the hierarchy pages whose octree cells meet the box, then only the
// nodes that meet it, down to the depth the cell size needs (depthFor). A node
// only partly inside the box is decoded whole, so decoded nodes are kept in a
// byte-bounded LRU: the next chunk along asks for the same edge nodes.

import { Copc, type Hierarchy } from 'copc';
import type { LazPerf } from 'laz-perf';
import { depthForCounts, gridMetrics, type CellGrid, type PcMetric, type PointArrays } from './pcMetrics.ts';

export type Box = [number, number, number, number];

interface NodeEntry { key: string; depth: number; bounds: Box; node: Hierarchy.Node }
interface FileState {
  copc: Copc; nodes: Map<string, NodeEntry>; pending: Map<string, Hierarchy.Page>; full: number;
  /** Hierarchy loads are serialised per file: a page taken off `pending` is not in `nodes` until it lands, and a concurrent reader would see neither. */
  lock: Promise<void>;
}

/** One decoded node, compact: coordinates as offsets from the file's minimum. */
interface Decoded { n: number; ox: number; oy: number; x: Float32Array; y: Float32Array; z: Float32Array; cls: Uint8Array; first: Uint8Array; intensity: Uint16Array }

const READ_TIMEOUT_MS = 30000;

function getter(url: string, stats: { bytes: number }) {
  return async (begin: number, end: number): Promise<Uint8Array> => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), READ_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` }, cache: 'no-store', signal: ctl.signal });
      if (res.status !== 206 && !(res.status === 200 && begin === 0)) throw new Error(`HTTP ${res.status} for a range of ${url.split('/').pop()}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      stats.bytes += buf.byteLength;
      return buf;
    } finally { clearTimeout(t); }
  };
}

function overlap(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = (a[2] - a[0]) * (a[3] - a[1]);
  return area > 0 ? (w * h) / area : 0;
}

const intersects = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

function nodeBounds(cube: number[], key: string): { depth: number; bounds: Box } {
  const [d, x, y] = key.split('-').map(Number);
  const sx = (cube[3] - cube[0]) / 2 ** d, sy = (cube[4] - cube[1]) / 2 ** d;
  return { depth: d, bounds: [cube[0] + x * sx, cube[1] + y * sy, cube[0] + (x + 1) * sx, cube[1] + (y + 1) * sy] };
}

export class PcReader {
  private files = new Map<string, Promise<FileState>>();
  private decoded = new Map<string, Decoded>();
  private decoding = new Map<string, Promise<Decoded>>();
  private decodedBytes = 0;
  readonly stats = { bytes: 0, nodes: 0, reused: 0 };
  private lazPerf: () => Promise<LazPerf>;
  private maxDecodedBytes: number;

  constructor(lazPerf: () => Promise<LazPerf>, maxDecodedBytes = 256 * 1024 * 1024) {
    this.lazPerf = lazPerf;
    this.maxDecodedBytes = maxDecodedBytes;
  }

  private file(url: string): Promise<FileState> {
    let p = this.files.get(url);
    if (!p) {
      p = Copc.create(getter(url, this.stats)).then(copc => {
        if (!copc.info) throw new Error(`${url.split('/').pop()} is not a COPC file`);
        return { copc, nodes: new Map(), pending: new Map([['0-0-0-0', copc.info.rootHierarchyPage]]), full: 0, lock: Promise.resolve() };
      });
      this.files.set(url, p);
      p.catch(() => this.files.delete(url));
    }
    return p;
  }

  /** Load the hierarchy pages that meet `box`, to `maxDepth` (one load at a time per file). */
  private hierarchy(url: string, f: FileState, box: Box, maxDepth: number): Promise<void> {
    const run = f.lock.then(() => this.loadPages(url, f, box, maxDepth));
    f.lock = run.catch(() => undefined);
    return run;
  }

  private async loadPages(url: string, f: FileState, box: Box, maxDepth: number) {
    const cube = f.copc.info.cube as unknown as number[];
    const get = getter(url, this.stats);
    for (;;) {
      const todo = [...f.pending].filter(([k]) => { const nb = nodeBounds(cube, k); return nb.depth <= maxDepth && intersects(nb.bounds, box); });
      if (!todo.length) return;
      await Promise.all(todo.map(async ([k, page]) => {
        f.pending.delete(k);
        const sub = await Copc.loadHierarchyPage(get, page);
        for (const [nk, node] of Object.entries(sub.nodes)) {
          if (!node) continue;
          const nb = nodeBounds(cube, nk);
          f.nodes.set(nk, { key: nk, ...nb, node });
          if (nb.depth > f.full) f.full = nb.depth;
        }
        for (const [pk, pg] of Object.entries(sub.pages)) if (pg) f.pending.set(pk, pg);
      }));
    }
  }

  private decode(url: string, f: FileState, e: NodeEntry): Promise<Decoded> {
    const key = `${url}@${e.key}`;
    const hit = this.decoded.get(key);
    if (hit) { this.decoded.delete(key); this.decoded.set(key, hit); this.stats.reused++; return Promise.resolve(hit); }
    let p = this.decoding.get(key);
    if (!p) { p = this.decodeNode(url, f, e, key).finally(() => this.decoding.delete(key)); this.decoding.set(key, p); }
    return p;
  }

  private async decodeNode(url: string, f: FileState, e: NodeEntry, key: string): Promise<Decoded> {
    const view = await Copc.loadPointDataView(getter(url, this.stats), f.copc, e.node, { lazPerf: await this.lazPerf(), include: ['X', 'Y', 'Z', 'Classification', 'ReturnNumber', 'Intensity'] });
    this.stats.nodes++;
    const n = view.pointCount;
    const X = view.getter('X'), Y = view.getter('Y'), Z = view.getter('Z'), C = view.getter('Classification'), R = view.getter('ReturnNumber');
    const I = view.dimensions.Intensity ? view.getter('Intensity') : null;
    const ox = Math.floor(f.copc.header.min[0]), oy = Math.floor(f.copc.header.min[1]);
    const d: Decoded = { n, ox, oy, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), cls: new Uint8Array(n), first: new Uint8Array(n), intensity: new Uint16Array(n) };
    for (let i = 0; i < n; i++) {
      d.x[i] = X(i) - ox; d.y[i] = Y(i) - oy; d.z[i] = Z(i);
      d.cls[i] = C(i); d.first[i] = R(i) === 1 ? 1 : 0; d.intensity[i] = I ? I(i) : 0;
    }
    const bytes = n * 18;
    this.decoded.set(key, d);
    this.decodedBytes += bytes;
    for (const [k, v] of this.decoded) { if (this.decodedBytes <= this.maxDecodedBytes) break; this.decoded.delete(k); this.decodedBytes -= v.n * 18; }
    return d;
  }

  /** Every return in `box` from these files, read to the depth `cell` needs. */
  async readBox(urls: string[], box: Box, cell: number): Promise<{ points: PointArrays; depths: number[] }> {
    const parts: { d: Decoded }[] = [];
    const depths: number[] = [];
    await Promise.all(urls.map(async url => {
      const f = await this.file(url);
      // The whole hierarchy over the box (pages are a few KB), then the
      // shallowest depth whose nodes hold enough returns for the cell size.
      await this.hierarchy(url, f, box, Infinity);
      const perDepth = new Array(f.full + 1).fill(0);
      for (const e of f.nodes.values()) if (intersects(e.bounds, box)) perDepth[e.depth] += e.node.pointCount * overlap(e.bounds, box);
      const dd = depthForCounts(perDepth, ((box[2] - box[0]) * (box[3] - box[1])) / (cell * cell));
      depths.push(dd);
      const nodes = [...f.nodes.values()].filter(e => e.depth <= dd && e.node.pointCount > 0 && intersects(e.bounds, box));
      let next = 0;
      const work = async () => { for (;;) { const k = next++; if (k >= nodes.length) return; parts.push({ d: await this.decode(url, f, nodes[k]) }); } };
      await Promise.all(Array.from({ length: Math.min(4, nodes.length) }, work));
    }));
    // Keep only the returns inside the box.
    let total = 0;
    for (const { d } of parts) total += d.n;
    const p: PointArrays = { count: 0, x: new Float64Array(total), y: new Float64Array(total), z: new Float32Array(total), cls: new Uint8Array(total), first: new Uint8Array(total), intensity: new Uint16Array(total) };
    let m = 0;
    for (const { d } of parts) {
      for (let i = 0; i < d.n; i++) {
        const x = d.x[i] + d.ox, y = d.y[i] + d.oy;
        if (x < box[0] || x >= box[2] || y < box[1] || y >= box[3]) continue;
        p.x[m] = x; p.y[m] = y; p.z[m] = d.z[i]; p.cls[m] = d.cls[i]; p.first[m] = d.first[i]; p.intensity[m] = d.intensity[i];
        m++;
      }
    }
    p.count = m;
    return { points: p, depths };
  }

  /**
   * The metrics of one chunk: read the chunk plus a margin (so the ground
   * surface under its edge cells sees ground on both sides), compute, crop.
   */
  async chunk(urls: string[], grid: CellGrid, margin: number): Promise<{ metrics: Record<PcMetric, Float32Array>; points: number; depths: number[] }> {
    const big: CellGrid = { x0: grid.x0 - margin * grid.cell, y0: grid.y0 - margin * grid.cell, cell: grid.cell, w: grid.w + 2 * margin, h: grid.h + 2 * margin };
    const box: Box = [big.x0, big.y0, big.x0 + big.w * big.cell, big.y0 + big.h * big.cell];
    const { points, depths } = await this.readBox(urls, box, grid.cell);
    const all = gridMetrics(points, big);
    const metrics = {} as Record<PcMetric, Float32Array>;
    for (const [k, a] of Object.entries(all) as [PcMetric, Float32Array][]) {
      const out = new Float32Array(grid.w * grid.h);
      for (let r = 0; r < grid.h; r++) out.set(a.subarray((r + margin) * big.w + margin, (r + margin) * big.w + margin + grid.w), r * grid.w);
      metrics[k] = out;
    }
    return { metrics, points: points.count, depths };
  }
}
