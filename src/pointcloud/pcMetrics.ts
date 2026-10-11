// Point-cloud evidence rasters: per-cell metrics of LiDAR returns, the
// laser's own view of a surface that HRDEM's height rasters throw away. Pure;
// unit-tested.
//
// The definitions are FieldMapper's (GPS2026felt src/lib/habitat/features/
// structure.ts), on FIRST returns throughout, because a first return is one
// pulse and pulse counts are what the ratios need:
//
//   int  mean intensity of first returns
//   ivg  mean intensity of first returns ON VEGETATION more than 0.5 m up — the
//        laser is near-infrared (1064 nm), so this is a fine-grained NIR band:
//        broadleaf crowns return more than needle-leaved ones
//   igr  mean intensity of first returns reaching the ground layer (≤ 0.5 m)
//   pen  penetration: share of first returns that reach the ground layer
//   att  canopy attenuation, Beer–Lambert over the canopy: −ln T / (top − 0.5)
//        with T = ground first returns ÷ all first returns, `top` the cell's
//        highest vegetation return; needle-leaved crowns stop more pulses per
//        metre of crown. Defined only under ≥ 2 m of canopy.
//   den  first returns per m²
//
// Heights are above a GROUND SURFACE built from the returns themselves —
// class 2 (ground) and 9 (water), averaged per cell and filled across gaps
// (under a dense crown, under a building) by repeated neighbourhood means.
// Too few returns of a kind to average is no data, never zero. Intensity is
// UNCALIBRATED (sensor, range and gain set it), so it is only comparable
// within one acquisition — the conifer index standardises it within the view.
//
// Vegetation follows FieldMapper's fallback rule: anything not ground, water,
// building (6), bridge (17) or noise (7, 18). The NRCan acquisitions leave
// most vegetation as class 1, so classes 3–5 alone would see none of it.

export interface PointArrays {
  count: number;
  x: Float64Array;
  y: Float64Array;
  z: Float32Array;
  cls: Uint8Array;
  /** 1 for a first return (ReturnNumber 1). */
  first: Uint8Array;
  intensity: Uint16Array;
}

/** A north-up cell grid; row 0 is the SOUTHERN edge. */
export interface CellGrid { x0: number; y0: number; cell: number; w: number; h: number }

export const PC_METRICS = ['int', 'ivg', 'igr', 'pen', 'att', 'den'] as const;
export type PcMetric = typeof PC_METRICS[number];

export const GROUND_LAYER_M = 0.5;
export const MIN_CANOPY_M = 2;
/** Returns of a kind needed before their mean or ratio is reported. */
export const MIN_N = 4;
const MAX_FILL_PASSES = 24;

const isGround = (c: number) => c === 2 || c === 9;
const isNoise = (c: number) => c === 7 || c === 18;
export const isVegetation = (c: number) => !isGround(c) && !isNoise(c) && c !== 6 && c !== 17;

/** Cell of a point, or −1 outside. */
export function cellOf(g: CellGrid, x: number, y: number): number {
  const c = Math.floor((x - g.x0) / g.cell), r = Math.floor((y - g.y0) / g.cell);
  return c < 0 || r < 0 || c >= g.w || r >= g.h ? -1 : r * g.w + c;
}

/** Mean ground/water elevation per cell, gaps filled from their neighbours; NaN where nothing reaches. */
export function groundSurface(p: PointArrays, g: CellGrid): Float32Array {
  const n = g.w * g.h;
  const sum = new Float64Array(n), cnt = new Uint32Array(n);
  for (let i = 0; i < p.count; i++) {
    if (!isGround(p.cls[i])) continue;
    const k = cellOf(g, p.x[i], p.y[i]);
    if (k >= 0) { sum[k] += p.z[i]; cnt[k]++; }
  }
  let cur = new Float32Array(n);
  for (let k = 0; k < n; k++) cur[k] = cnt[k] ? sum[k] / cnt[k] : NaN;
  for (let pass = 0; pass < MAX_FILL_PASSES; pass++) {
    let holes = 0, filled = 0;
    const next = cur.slice();
    for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) {
      const k = r * g.w + c;
      if (cur[k] === cur[k]) continue;
      holes++;
      let s = 0, m = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= g.h || cc >= g.w) continue;
        const v = cur[rr * g.w + cc];
        if (v === v) { s += v; m++; }
      }
      if (m) { next[k] = s / m; filled++; }
    }
    cur = next;
    if (!holes || !filled) break;
  }
  return cur;
}

/** Every metric over a grid. */
export function gridMetrics(p: PointArrays, g: CellGrid): Record<PcMetric, Float32Array> {
  const n = g.w * g.h;
  const ground = groundSurface(p, g);
  const first = new Uint32Array(n), fGround = new Uint32Array(n), vegN = new Uint32Array(n), grN = new Uint32Array(n);
  const iSum = new Float64Array(n), ivSum = new Float64Array(n), igSum = new Float64Array(n);
  const top = new Float32Array(n).fill(-Infinity);
  for (let i = 0; i < p.count; i++) {
    const c = p.cls[i];
    if (isNoise(c)) continue;
    const k = cellOf(g, p.x[i], p.y[i]);
    if (k < 0) continue;
    const gz = ground[k];
    if (gz !== gz) continue;
    const hgt = p.z[i] - gz;
    const veg = isVegetation(c);
    if (veg && hgt > top[k] && hgt < 80) top[k] = hgt;
    if (!p.first[i]) continue;
    const it = p.intensity[i];
    first[k]++; iSum[k] += it;
    if (hgt <= GROUND_LAYER_M) { fGround[k]++; igSum[k] += it; grN[k]++; }
    else if (veg) { ivSum[k] += it; vegN[k]++; }
  }
  const out = Object.fromEntries(PC_METRICS.map(m => [m, new Float32Array(n).fill(NaN)])) as Record<PcMetric, Float32Array>;
  const area = g.cell * g.cell;
  for (let k = 0; k < n; k++) {
    const f = first[k];
    out.den[k] = ground[k] === ground[k] ? f / area : NaN;
    if (f >= MIN_N) {
      out.int[k] = iSum[k] / f;
      out.pen[k] = fGround[k] / f;
      if (top[k] >= MIN_CANOPY_M) out.att[k] = attenuation(fGround[k], f, top[k] - GROUND_LAYER_M);
    }
    if (vegN[k] >= MIN_N) out.ivg[k] = ivSum[k] / vegN[k];
    if (grN[k] >= MIN_N) out.igr[k] = igSum[k] / grN[k];
  }
  return out;
}

/** Beer–Lambert attenuation (per m) of a layer `dz` thick; a layer no pulse passed is given half a pulse so it saturates. */
export function attenuation(below: number, entering: number, dz: number): number {
  if (entering < MIN_N || !(dz > 0)) return NaN;
  const t = Math.max(below, 0.5) / entering;
  return (0 - Math.log(Math.min(1, t))) / dz;
}

// ── Level of detail ────────────────────────────────────────────────────────

/** Cell sizes a request can be read at, finest first. */
export const PC_CELLS = [2, 4, 8, 16];
/** Cells per chunk side. */
export const CHUNK = 128;
/** Returns wanted per cell when choosing how deep into the octree to read. */
export const TARGET_PER_CELL = 16;

/** The cell size for an output of `mpp` metres per pixel; null when too coarse to read point clouds for. */
export function cellFor(mpp: number): number | null {
  for (const c of PC_CELLS) if (c >= mpp * 0.9) return c;
  return null;
}

/**
 * How deep to read a COPC octree so each of `cells` cells gets
 * ~TARGET_PER_CELL returns, from the returns each level holds over the box
 * (`perDepth[d]`, from the hierarchy — not from the header's `spacing`, which
 * NRCan files do not state consistently). The levels are spatially
 * stratified, so a shallower read is an unbiased thinning: means and ratios
 * stay right, they only get noisier. Every level when even that is too few.
 */
export function depthForCounts(perDepth: number[], cells: number): number {
  let sum = 0;
  for (let d = 0; d < perDepth.length; d++) { sum += perDepth[d]; if (sum >= TARGET_PER_CELL * cells) return d; }
  return Math.max(0, perDepth.length - 1);
}
