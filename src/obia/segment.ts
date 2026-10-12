// Fine-object segmentation on the analysis grid (spec §6). Pure; runs in the
// OBIA worker. Unit-tested in test/obiaSegment.test.ts.
//
// Channels: the RGB colour as CIE L*a*b* (the conversion is applied to the
// three colour channels only, never to arbitrary bands), the canopy height
// model, and optionally slope from the DTM. Sentinel-2 is NOT an input here,
// by construction: this module never sees it.
//
// Distance. Each channel is normalized by a FIXED reference difference
// (recipe.REFERENCE_SCALES: L* 8, a*/b* 6, CHM 2 m, slope 5°), so one unit
// means "a meaningful difference" identically in a preview window and in the
// whole area. A group's channels are then multiplied by
// influence / √(channels in the group), so the three colour channels together
// weigh as much as the one CHM channel at equal influence. SLIC's distance is
//     D² = Σ_c (Δc)² + compactness² · (Δxy / S)²
// with S the seed spacing in pixels, S = √(target object area) / cell size.
// A pixel with every channel missing (no data, outside the area) has no label.
//
// Then: connectivity (every object one 4-connected component), a
// Felzenszwalb–Huttenlocher merge on the region adjacency graph with
// tolerance `mergeSimilarity` (in reference differences, × S² pixels), and a
// minimum-patch pass. Deterministic: seeds on a regular lattice, no
// randomness, a fixed iteration count.

import { connect, mergeRegions, regionMeans, slic } from '../segment/slic.ts';
import { REFERENCE_SCALES, type SegmentParams } from './recipe.ts';

/** sRGB (0–255) to CIE L*a*b* (D65). */
export function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
  const Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Slope in degrees (Horn), NaN where a neighbour is missing. */
export function slopeDeg(dtm: Float32Array, w: number, h: number, cellM: number): Float32Array {
  const out = new Float32Array(w * h).fill(NaN);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const z = (dx: number, dy: number) => dtm[(y + dy) * w + x + dx];
    const gx = ((z(1, -1) + 2 * z(1, 0) + z(1, 1)) - (z(-1, -1) + 2 * z(-1, 0) + z(-1, 1))) / (8 * cellM);
    const gy = ((z(-1, 1) + 2 * z(0, 1) + z(1, 1)) - (z(-1, -1) + 2 * z(0, -1) + z(1, -1))) / (8 * cellM);
    const s = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
    if (s === s) out[y * w + x] = s;
  }
  return out;
}

export interface FinePlanes {
  /** 0–255 colour, NaN where no data. */
  r?: Float32Array; g?: Float32Array; b?: Float32Array;
  chm?: Float32Array;
  dtm?: Float32Array;
}

export interface Channel { id: string; group: 'rgb' | 'structure' | 'terrain'; weight: number; data: Float32Array }

/** The segmentation channels, normalized and group-weighted, inside `mask` only. */
export function segmentationChannels(p: FinePlanes, w: number, h: number, cellM: number, s: SegmentParams, mask: Uint8Array): Channel[] {
  const n = w * h, out: Channel[] = [];
  if (p.r && p.g && p.b && s.imageryWeight > 0) {
    const L = new Float32Array(n).fill(NaN), A = new Float32Array(n).fill(NaN), B = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      const r = p.r[i], g = p.g[i], b = p.b[i];
      if (r !== r || g !== g || b !== b) continue;
      const lab = srgbToLab(r, g, b);
      L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
    }
    const k = s.imageryWeight / Math.sqrt(3);
    for (const [id, a] of [['lab_l', L], ['lab_a', A], ['lab_b', B]] as const) out.push({ id, group: 'rgb', weight: k / REFERENCE_SCALES[id].scale, data: a });
  }
  if (p.chm && s.structureWeight > 0) {
    const c = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (mask[i]) c[i] = p.chm[i];
    out.push({ id: 'chm', group: 'structure', weight: s.structureWeight / REFERENCE_SCALES.chm.scale, data: c });
  }
  if (p.dtm && s.terrainWeight > 0) {
    const sl = slopeDeg(p.dtm, w, h, cellM);
    for (let i = 0; i < n; i++) if (!mask[i]) sl[i] = NaN;
    out.push({ id: 'slope', group: 'terrain', weight: s.terrainWeight / REFERENCE_SCALES.slope.scale, data: sl });
  }
  for (const c of out) { const d = c.data; for (let i = 0; i < n; i++) if (d[i] === d[i]) d[i] *= c.weight; }
  return out;
}

export interface Segmentation {
  labels: Int32Array;
  count: number;
  /** Per-object flags from segmentation (`below-min-patch`, `touches-window-edge`, `clipped-by-area`). */
  flags: string[][];
  seedSpacingPx: number;
}

/**
 * Segment. `mask` is 1 inside the study area; `windowEdge` marks a preview
 * whose edges are artificial (objects touching them are flagged).
 */
export function segment(channels: Channel[], w: number, h: number, cellM: number, s: SegmentParams, mask: Uint8Array, windowEdge = false): Segmentation {
  if (!channels.length) throw new Error('nothing to segment on: needs RGB imagery or a canopy height model with a non-zero influence');
  const S = Math.max(2, Math.sqrt(s.targetAreaM2) / cellM);
  const feats = channels.map(c => c.data);
  // Fragments are NOT absorbed by adjacency here (SLIC's usual S²/4 rule would
  // swallow a pond smaller than that into whatever touches it); the
  // minimum-patch pass below decides by similarity instead.
  const sp = slic(feats, w, h, { step: S, compactness: s.compactness, minFragment: 1 });
  let { labels, count } = mergeRegions(sp.labels, sp.count, w, h, feats, s.mergeSimilarity * S * S);
  const minPx = Math.max(1, Math.round(s.minPatchAreaM2 / (cellM * cellM)));
  // Older recipes have no keepDistinctAbove: they used 2 × max(merge, 0.5).
  const small = minPatch(labels, count, w, h, feats, minPx, s.keepDistinctAbove ?? Math.max(s.mergeSimilarity, 0.5) * 2);
  labels = small.labels; count = small.count;
  const flags: string[][] = Array.from({ length: count }, () => []);
  const sizes = new Float64Array(count);
  for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) sizes[labels[i]]++;
  for (let k = 0; k < count; k++) if (sizes[k] < minPx) flags[k].push('below-min-patch');
  const edge = new Uint8Array(count), clipped = new Uint8Array(count);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, k = labels[i];
    if (k < 0) continue;
    if (windowEdge && (x === 0 || y === 0 || x === w - 1 || y === h - 1)) edge[k] = 1;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && !mask[j]) clipped[k] = 1;
  }
  for (let k = 0; k < count; k++) { if (edge[k]) flags[k].push('touches-window-edge'); if (clipped[k]) flags[k].push('clipped-by-area'); }
  return { labels, count, flags, seedSpacingPx: S };
}

/**
 * Absorb objects under `minPx` pixels into their most similar neighbour —
 * but only when that neighbour is within `maxDist` reference differences.
 * A small object unlike every neighbour (a pond, a rock, a narrow channel)
 * is KEPT and later flagged, rather than forced into unrelated land cover.
 */
export function minPatch(labels: Int32Array, count: number, w: number, h: number, feats: Float32Array[], minPx: number, maxDist: number): { labels: Int32Array; count: number } {
  if (minPx <= 1 || count < 2) return { labels, count };
  const nF = feats.length;
  const { means, sizes } = regionMeans(labels, count, feats);
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const nbs: Set<number>[] = Array.from({ length: count }, () => new Set());
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, a = labels[i];
    if (a < 0) continue;
    if (x < w - 1) { const b = labels[i + 1]; if (b >= 0 && b !== a) { nbs[a].add(b); nbs[b].add(a); } }
    if (y < h - 1) { const b = labels[i + w]; if (b >= 0 && b !== a) { nbs[a].add(b); nbs[b].add(a); } }
  }
  const sz = Float64Array.from(sizes), mean = Float64Array.from(means);
  const dist = (a: number, b: number) => {
    let d = 0, u = 0;
    for (let f = 0; f < nF; f++) { const x = mean[a * nF + f], y = mean[b * nF + f]; if (x === x && y === y) { d += (x - y) ** 2; u++; } }
    return u ? Math.sqrt(d) : Infinity;
  };
  // Smallest first, deterministic by index on ties.
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => sizes[a] - sizes[b] || a - b);
  for (const k0 of order) {
    const a = find(k0);
    if (sz[a] >= minPx) continue;
    let best = -1, bd = Infinity;
    for (const n0 of [...nbs[a]].sort((x, y) => x - y)) {
      const b = find(n0);
      if (b === a) continue;
      const d = dist(a, b);
      if (d < bd) { bd = d; best = b; }
    }
    if (best < 0 || bd > maxDist) continue;
    // Merge a into best: means weighted by size.
    for (let f = 0; f < nF; f++) {
      const x = mean[a * nF + f], y = mean[best * nF + f];
      mean[best * nF + f] = x !== x ? y : y !== y ? x : (x * sz[a] + y * sz[best]) / (sz[a] + sz[best]);
    }
    sz[best] += sz[a];
    parent[a] = best;
    for (const n of nbs[a]) { const b = find(n); if (b !== best) { nbs[best].add(b); nbs[b].add(best); } }
  }
  const remap = new Int32Array(count).fill(-1);
  let next = 0;
  const out = new Int32Array(labels.length).fill(-1);
  for (let i = 0; i < labels.length; i++) {
    const L = labels[i];
    if (L < 0) continue;
    const r = find(L);
    if (remap[r] < 0) remap[r] = next++;
    out[i] = remap[r];
  }
  // Merging can never disconnect an object (only neighbours join), but re-check cheaply.
  return connect(out, w, h, 1);
}
