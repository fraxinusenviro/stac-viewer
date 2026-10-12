// Fine object features (spec §8), computed on the analysis grid over each
// object's own pixels. Pure; test/obiaFeatures.test.ts.
//
// A deliberately short default set, one or two measures per idea rather than
// dozens of near-duplicates:
//   rgb        mean R, G, B; mean L*, a*, b*; brightness s.d. (texture);
//              mean L* gradient (edge density); excess green (2G−R−B)/(R+G+B)
//   structure  CHM mean, median, P90, max, s.d.; and the SHARE OF THE OBJECT'S
//              VALID CHM CELLS in each height band (default 0.5–2, 2–8, > 8 m).
//              These are top-surface fractions from a canopy height model, not
//              return fractions from the point cloud: the denominator is valid
//              CHM cells, and a shrub under a canopy is not seen.
//   colour composition (for vegetation TYPE within a structural class)
//              chroma C* and hue h of the object's mean a*b*; the share of
//              PALE GREY pixels (L* > 65, C* < 15: lichen mats, bare rock,
//              senescent litter) and of REDDISH pixels (a* > 10: autumn
//              ericaceous shrubs, red Sphagnum, red maple)
//   crown shape (from the CHM, for conifer against broadleaf)
//              apex sharpness — at each local maximum above 2 m, its height
//              minus the mean height 2 m away (a cone drops ~4 m there, a
//              broadleaf dome under 1 m); treetops per hectare; canopy rumple
//              (CHM surface area / planimetric area)
//   terrain    mean DTM elevation, mean slope
//   geometry   area, compactness 4πA/P² (pixel-edge perimeter, so read it
//              comparatively), elongation √(λ1/λ2) of the pixel coordinates
// Missing values are null, never 0. Each group's support (valid share of the
// object) is recorded.

import { srgbToLab, slopeDeg, type FinePlanes } from './segment.ts';
import type { FeatureDefinition, ObjectRecord, SupportRecord } from './types.ts';

export interface FineFeatureInput {
  labels: Int32Array;
  count: number;
  w: number;
  h: number;
  cellM: number;
  x0: number;
  y0: number;
  planes: FinePlanes;
  heightBandsM: number[];
  segmentationVersion: string;
  /** Segmentation flags per object. */
  flags: string[][];
  sources: { rgb: string | null; chm: string | null; dtm: string | null };
}

/** Distance at which a crown's flank is measured for apex sharpness, m. */
export const APEX_RING_M = 2;

const quantile = (s: Float64Array, p: number) => { if (!s.length) return NaN; const q = p * (s.length - 1), lo = Math.floor(q), hi = Math.ceil(q); return s[lo] + (s[hi] - s[lo]) * (q - lo); };

export function bandIds(bands: number[]): { id: string; lo: number; hi: number; label: string }[] {
  const edges = [...bands].sort((a, b) => a - b);
  return edges.map((lo, i) => {
    const hi = edges[i + 1] ?? Infinity;
    const fmt = (v: number) => String(v).replace('.', 'p');
    return { id: `chm_frac_${fmt(lo)}_${hi === Infinity ? 'up' : fmt(hi)}`, lo, hi, label: hi === Infinity ? `Share of CHM cells > ${lo} m` : `Share of CHM cells ${lo}–${hi} m` };
  });
}

export function fineFeatureDefs(inp: Pick<FineFeatureInput, 'cellM' | 'heightBandsM' | 'sources' | 'planes'>): FeatureDefinition[] {
  const defs: FeatureDefinition[] = [];
  const d = (id: string, label: string, group: FeatureDefinition['group'], src: string | null, unit: string, operation: string, extra: Partial<FeatureDefinition> = {}) => defs.push({
    id, label, group, sourceIds: src ? [src] : [], unit, operation, parameters: {}, processingResolutionM: inp.cellM,
    sampling: 'fine-grid', useForSegmentation: false, useForClassification: true, ...extra,
  });
  const { rgb, chm, dtm } = inp.sources;
  if (inp.planes.r) {
    d('rgb_r', 'Mean red', 'rgb', rgb, 'DN 0–255', 'mean');
    d('rgb_g', 'Mean green', 'rgb', rgb, 'DN 0–255', 'mean');
    d('rgb_b', 'Mean blue', 'rgb', rgb, 'DN 0–255', 'mean');
    d('lab_l', 'Mean L*', 'rgb', rgb, 'CIE L*', 'mean of per-pixel L*', { useForSegmentation: true });
    d('lab_a', 'Mean a*', 'rgb', rgb, 'CIE a*', 'mean of per-pixel a*', { useForSegmentation: true });
    d('lab_b', 'Mean b*', 'rgb', rgb, 'CIE b*', 'mean of per-pixel b*', { useForSegmentation: true });
    d('rgb_l_sd', 'L* s.d. (texture)', 'rgb', rgb, 'CIE L*', 'standard deviation of per-pixel L*');
    d('rgb_grad', 'Mean L* gradient (edges)', 'rgb', rgb, 'L* per m', 'mean Sobel gradient magnitude of L*');
    d('rgb_exg', 'Excess green', 'rgb', rgb, 'ratio', 'mean of (2G−R−B)/(R+G+B)');
    d('lab_chroma', 'Chroma C*', 'rgb', rgb, 'CIE C*', 'chroma of the mean a*, b*');
    d('lab_hue', 'Hue angle h', 'rgb', rgb, '°', 'hue angle of the mean a*, b* (0 red, 90 yellow, 180 green, 270 blue)');
    d('rgb_pale_frac', 'Share of pale grey pixels', 'rgb', rgb, 'fraction', 'pixels with L* > 65 and C* < 15 / valid imagery pixels');
    d('rgb_red_frac', 'Share of reddish pixels', 'rgb', rgb, 'fraction', 'pixels with a* > 10 / valid imagery pixels');
  }
  if (inp.planes.chm) {
    d('chm_mean', 'CHM mean', 'structure', chm, 'm', 'mean', { useForSegmentation: true });
    d('chm_p50', 'CHM median', 'structure', chm, 'm', 'median');
    d('chm_p90', 'CHM P90', 'structure', chm, 'm', '90th percentile');
    d('chm_max', 'CHM max', 'structure', chm, 'm', 'maximum');
    d('chm_sd', 'CHM s.d.', 'structure', chm, 'm', 'standard deviation');
    d('chm_apex', 'Crown apex sharpness', 'structure', chm, 'm', 'mean over local maxima > 2 m of (height − mean height 2 m away)', { parameters: { ringM: APEX_RING_M, minHeightM: 2 } });
    d('chm_tops_ha', 'Treetops per hectare', 'structure', chm, 'per ha', 'local maxima > 2 m (3 × 3 window) per hectare of valid CHM');
    d('chm_rumple', 'Canopy rumple', 'structure', chm, 'ratio', 'CHM surface area / planimetric area (central differences)');
    for (const b of bandIds(inp.heightBandsM)) d(b.id, b.label, 'structure', chm, 'fraction', 'valid CHM cells in band / valid CHM cells', { parameters: { loM: b.lo, hiM: b.hi } });
  }
  if (inp.planes.dtm) {
    d('dtm_mean', 'Mean ground elevation', 'terrain', dtm, 'm', 'mean');
    d('slope_mean', 'Mean slope', 'terrain', dtm, '°', 'mean of Horn slope');
  }
  d('area_m2', 'Area', 'geometry', null, 'm²', 'pixel count × cell area');
  d('compactness', 'Compactness', 'geometry', null, 'ratio', '4πA / P², pixel-edge perimeter');
  d('elongation', 'Elongation', 'geometry', null, 'ratio', '√(λ1/λ2) of pixel coordinates');
  return defs;
}

export function fineFeatures(inp: FineFeatureInput): ObjectRecord[] {
  const { labels, count, w, h, cellM, planes } = inp;
  const n = w * h, area = cellM * cellM;
  // Pixel lists per object, in pixel order (deterministic).
  const sizes = new Int32Array(count);
  for (let i = 0; i < n; i++) if (labels[i] >= 0) sizes[labels[i]]++;
  const start = new Int32Array(count + 1);
  for (let k = 0; k < count; k++) start[k + 1] = start[k] + sizes[k];
  const fill = start.slice(0, count), px = new Int32Array(start[count]);
  for (let i = 0; i < n; i++) { const k = labels[i]; if (k >= 0) px[fill[k]++] = i; }

  // Per-pixel derived planes.
  let L: Float32Array | null = null, A: Float32Array | null = null, B: Float32Array | null = null, grad: Float32Array | null = null;
  if (planes.r && planes.g && planes.b) {
    L = new Float32Array(n).fill(NaN); A = new Float32Array(n).fill(NaN); B = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) { const r = planes.r[i], g = planes.g[i], b = planes.b[i]; if (r === r && g === g && b === b) { const lab = srgbToLab(r, g, b); L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2]; } }
    grad = new Float32Array(n).fill(NaN);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const z = (dx: number, dy: number) => L![(y + dy) * w + x + dx];
      const gx = (z(1, -1) + 2 * z(1, 0) + z(1, 1) - z(-1, -1) - 2 * z(-1, 0) - z(-1, 1)) / (8 * cellM);
      const gy = (z(-1, 1) + 2 * z(0, 1) + z(1, 1) - z(-1, -1) - 2 * z(0, -1) - z(1, -1)) / (8 * cellM);
      const v = Math.hypot(gx, gy);
      if (v === v) grad[y * w + x] = v;
    }
  }
  const slope = planes.dtm ? slopeDeg(planes.dtm, w, h, cellM) : null;
  const bands = bandIds(inp.heightBandsM);
  // Crown shape: apex sharpness at local maxima, and per-pixel surface ratio.
  let apex: Float32Array | null = null, rumple: Float32Array | null = null;
  if (planes.chm) {
    const c = planes.chm, R = Math.max(1, Math.round(APEX_RING_M / cellM));
    apex = new Float32Array(n).fill(NaN); rumple = new Float32Array(n).fill(NaN);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, v = c[i];
      if (v !== v) continue;
      const gx = (c[i + 1] - c[i - 1]) / (2 * cellM), gy = (c[i + w] - c[i - w]) / (2 * cellM);
      const sr = Math.sqrt(1 + gx * gx + gy * gy);
      if (sr === sr) rumple[i] = sr;
      if (v <= 2 || y < R || x < R || y >= h - R || x >= w - R) continue;
      let peak = true;
      for (let dy = -1; dy <= 1 && peak; dy++) for (let dx = -1; dx <= 1; dx++) { if ((dx || dy) && !(c[i + dy * w + dx] <= v)) { peak = false; break; } }
      if (!peak) continue;
      let sum = 0, k = 0;
      for (let d = -R; d <= R; d++) for (const [xx, yy] of [[x + d, y - R], [x + d, y + R], [x - R, y + d], [x + R, y + d]]) { const u = c[yy * w + xx]; if (u === u) { sum += u; k++; } }
      if (k) apex[i] = v - sum / k;
    }
  }

  const out: ObjectRecord[] = [];
  for (let k = 0; k < count; k++) {
    const s = start[k], e = start[k + 1], m = e - s;
    const fv: Record<string, number | null> = {};
    const support: Record<string, SupportRecord> = {};
    const nn = (v: number) => (Number.isFinite(v) ? v : null);
    const meanOf = (a: Float32Array) => { let sum = 0, c = 0; for (let j = s; j < e; j++) { const v = a[px[j]]; if (v === v) { sum += v; c++; } } return { mean: c ? sum / c : NaN, c }; };
    // Geometry.
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, perim = 0;
    for (let j = s; j < e; j++) {
      const i = px[j], x = i % w, y = (i - x) / w;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x === 0 || labels[i - 1] !== k) perim++;
      if (x === w - 1 || labels[i + 1] !== k) perim++;
      if (y === 0 || labels[i - w] !== k) perim++;
      if (y === h - 1 || labels[i + w] !== k) perim++;
    }
    const mx = sx / m, my = sy / m;
    const cxx = sxx / m - mx * mx, cyy = syy / m - my * my, cxy = sxy / m - mx * my;
    const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    const areaM2 = m * area, pM = perim * cellM;
    fv.area_m2 = areaM2;
    fv.compactness = nn((4 * Math.PI * areaM2) / (pM * pM));
    fv.elongation = m >= 3 ? nn(Math.sqrt((l1 + 1 / 12) / (l2 + 1 / 12))) : null;
    if (L && A && B && grad && planes.r && planes.g && planes.b) {
      const r = meanOf(planes.r), g = meanOf(planes.g), b = meanOf(planes.b), l = meanOf(L), gr = meanOf(grad);
      fv.rgb_r = nn(r.mean); fv.rgb_g = nn(g.mean); fv.rgb_b = nn(b.mean);
      fv.lab_l = nn(l.mean); fv.lab_a = nn(meanOf(A).mean); fv.lab_b = nn(meanOf(B).mean);
      let ss = 0;
      for (let j = s; j < e; j++) { const v = L[px[j]]; if (v === v) ss += (v - l.mean) ** 2; }
      fv.rgb_l_sd = l.c > 1 ? Math.sqrt(ss / (l.c - 1)) : null;
      fv.rgb_grad = nn(gr.mean);
      let ex = 0, ec = 0;
      for (let j = s; j < e; j++) { const i = px[j], R = planes.r[i], G = planes.g[i], Bb = planes.b[i], t = R + G + Bb; if (t === t && t > 0) { ex += (2 * G - R - Bb) / t; ec++; } }
      fv.rgb_exg = ec ? ex / ec : null;
      const am = meanOf(A).mean, bm = meanOf(B).mean;
      fv.lab_chroma = nn(Math.hypot(am, bm));
      fv.lab_hue = Number.isFinite(am) && Number.isFinite(bm) ? (Math.atan2(bm, am) * 180 / Math.PI + 360) % 360 : null;
      let pale = 0, red = 0, lc = 0;
      for (let j = s; j < e; j++) { const i = px[j], LL = L[i]; if (LL !== LL) continue; lc++; const C = Math.hypot(A[i], B[i]); if (LL > 65 && C < 15) pale++; if (A[i] > 10) red++; }
      fv.rgb_pale_frac = lc ? pale / lc : null;
      fv.rgb_red_frac = lc ? red / lc : null;
      support.rgb = { validFraction: l.c / m, qualityFlags: l.c < m ? ['partial-imagery'] : [] };
    }
    if (planes.chm) {
      const v: number[] = [];
      for (let j = s; j < e; j++) { const x = planes.chm[px[j]]; if (x === x) v.push(Math.max(0, x)); }
      const sorted = Float64Array.from(v).sort();
      const c = sorted.length;
      const mean = c ? v.reduce((a, b) => a + b, 0) / c : NaN;
      fv.chm_mean = nn(mean); fv.chm_p50 = nn(quantile(sorted, 0.5)); fv.chm_p90 = nn(quantile(sorted, 0.9));
      fv.chm_max = c ? sorted[c - 1] : null;
      fv.chm_sd = c > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (c - 1)) : null;
      for (const bd of bands) { let z = 0; for (const x of v) if (x >= bd.lo && x < bd.hi) z++; fv[bd.id] = c ? z / c : null; }
      if (apex && rumple) {
        let as = 0, ac = 0, rs = 0, rc = 0;
        for (let j = s; j < e; j++) { const i = px[j]; if (apex[i] === apex[i]) { as += apex[i]; ac++; } if (rumple[i] === rumple[i]) { rs += rumple[i]; rc++; } }
        fv.chm_apex = ac ? as / ac : null;
        fv.chm_tops_ha = c ? ac / (c * area / 1e4) : null;
        fv.chm_rumple = rc ? rs / rc : null;
      }
      support.structure = { validFraction: c / m, qualityFlags: c === 0 ? ['no-chm'] : c < m ? ['partial-chm'] : [] };
    }
    if (planes.dtm && slope) {
      const z = meanOf(planes.dtm), sl = meanOf(slope);
      fv.dtm_mean = nn(z.mean); fv.slope_mean = nn(sl.mean);
      support.terrain = { validFraction: z.c / m, qualityFlags: z.c === 0 ? ['no-dtm'] : [] };
    }
    out.push({
      id: `${inp.segmentationVersion}:${k}`, index: k, segmentationVersion: inp.segmentationVersion, areaM2,
      cx: inp.x0 + (mx + 0.5) * cellM, cy: inp.y0 - (my + 0.5) * cellM,
      featureValues: fv, support, flags: [...(inp.flags[k] ?? [])],
    });
  }
  return out;
}
