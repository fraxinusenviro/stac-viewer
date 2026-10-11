// The conifer index, ported from FieldMapper (GPS2026felt
// src/lib/habitat/models/landcover.ts, the `conifer_index` feature) to the
// data this viewer has.
//
// The METHOD is FieldMapper's, unchanged: over the woody pixels of the area in
// view, each line of evidence is turned into a robust z-score (median and
// IQR / 1.349 of the woody pixels), clamped to ±3, signed so that positive
// means needle-leaved, and averaged with weights renormalised over the terms
// that are available. Standardising WITHIN the view's woody population is what
// lets it work with no absolute calibration — it needs only that the
// conifer/broadleaf contrast exists in this scene. The split is placed by
// Otsu's method on the index, and Sarle's bimodality coefficient says whether
// there are two groups to split at all. The index is reported MINUS the
// threshold: positive leans coniferous, negative broadleaf, near zero mixed or
// uncertain.
//
// The TERMS are adapted. FieldMapper's two strongest come from the point cloud
// — vegetation intensity (the laser's own near-infrared) and canopy
// attenuation — and HRDEM rasters carry neither; its crown texture needs
// sub-crown imagery, which 10 m Sentinel-2 is not. What carries over is the
// imagery evidence, with Sentinel-2's calibrated NIR standing in for the
// laser intensity, and — with a leaf-off scene — the seasonal change, which is
// stronger evidence than anything in the original:
//
//   − NIR (B08) 0.35 · − visible brightness 0.20 · − excess green 0.15
//   − ΔNDVI (leaf-on − leaf-off) 0.35 · + leaf-off NDVI 0.20      (two scenes)
//
// Pure apart from the calibration slots the variables read. Unit-tested.

import type { Channel, Planes, Variable } from './products.ts';

// ── Robust statistics (FieldMapper landcover.ts, unchanged in substance) ────

export interface RobustStat { median: number; scale: number; n: number }

/** Median and IQR / 1.349 (≈ SD for a normal) of the finite values. */
export function robustStat(xs: number[]): RobustStat {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { median: NaN, scale: NaN, n: 0 };
  const q = (p: number) => { const pos = p * (v.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos); return v[lo] + (v[hi] - v[lo]) * (pos - lo); };
  const iqr = q(0.75) - q(0.25);
  return { median: q(0.5), scale: iqr > 0 ? iqr / 1.349 : Math.max(1e-6, Math.abs(q(0.5)) * 1e-3), n: v.length };
}

/** Otsu's threshold: the split maximising between-class variance, 256 bins between the 1st and 99th percentiles. */
export function otsu(values: number[]): number {
  if (values.length < 2) return 0;
  const xs = [...values].sort((a, b) => a - b);
  const lo = xs[Math.floor(0.01 * (xs.length - 1))], hi = xs[Math.ceil(0.99 * (xs.length - 1))];
  if (!(hi > lo)) return lo;
  const B = 256, hist = new Float64Array(B);
  for (const x of xs) hist[Math.min(B - 1, Math.max(0, Math.floor(((x - lo) / (hi - lo)) * B)))]++;
  let sumAll = 0;
  for (let i = 0; i < B; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = -1, bestT = 0;
  for (let t = 0; t < B; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = xs.length - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sumAll - sumB) / wF) ** 2;
    if (between > best) { best = between; bestT = t; }
  }
  return lo + ((bestT + 1) / B) * (hi - lo);
}

/** Sarle's bimodality coefficient; above ~0.555 (a uniform's value) a distribution may be bimodal. */
export function bimodality(values: number[]): number {
  const n = values.length;
  if (n < 4) return NaN;
  const m = values.reduce((a, b) => a + b, 0) / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const v of values) { const d = v - m; m2 += d * d; m3 += d ** 3; m4 += d ** 4; }
  m2 /= n; m3 /= n; m4 /= n;
  if (!(m2 > 0)) return NaN;
  const g = m3 / m2 ** 1.5, k = m4 / (m2 * m2) - 3;
  const skew = (g * Math.sqrt(n * (n - 1))) / (n - 2);
  const kurt = ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * k + 6);
  return (skew * skew + 1) / (kurt + (3 * (n - 1) ** 2) / ((n - 2) * (n - 3)));
}

// ── Terms ───────────────────────────────────────────────────────────────────

export interface CiOptions { leafOff: boolean; sharpened: boolean }

interface Term { id: string; label: string; weight: number; sign: 1 | -1; value: (p: Planes, i: number) => number }

/** Woody: canopy ≥ 3 m and green (leaf-on NDVI ≥ 0.4). Only woody pixels have an index. */
export const WOODY_MIN_M = 3, WOODY_MIN_NDVI = 0.4;

function termsFor(o: CiOptions): { terms: Term[]; woody: (p: Planes, i: number) => boolean; inputs: string[]; sharpenKeys: string[] } {
  const k = (scene: 's2' | 's2b', a: string) => `${o.sharpened ? 'u:' : ''}${scene}:${a}`;
  const val = (p: Planes, key: string, i: number) => { const x = p[key][i]; return x > 0 ? x : x === x ? 0 : NaN; };
  const ndvi = (p: Planes, i: number, sc: 's2' | 's2b') => { const n = val(p, k(sc, 'nir'), i), r = val(p, k(sc, 'red'), i); return n + r >= 0.01 ? (n - r) / (n + r) : NaN; };
  const terms: Term[] = [
    { id: 'nir', label: 'NIR (B08)', weight: 0.35, sign: -1, value: (p, i) => val(p, k('s2', 'nir'), i) },
    { id: 'brightness', label: 'Visible brightness', weight: 0.2, sign: -1, value: (p, i) => (val(p, k('s2', 'red'), i) + val(p, k('s2', 'green'), i) + val(p, k('s2', 'blue'), i)) / 3 },
    {
      id: 'greenness', label: 'Excess green', weight: 0.15, sign: -1,
      value: (p, i) => { const r = val(p, k('s2', 'red'), i), g = val(p, k('s2', 'green'), i), b = val(p, k('s2', 'blue'), i), s = r + g + b; return s > 0.005 ? (2 * g - r - b) / s : NaN; },
    },
  ];
  if (o.leafOff) {
    terms.push(
      { id: 'd_ndvi', label: 'ΔNDVI (leaf-on − leaf-off)', weight: 0.35, sign: -1, value: (p, i) => ndvi(p, i, 's2') - ndvi(p, i, 's2b') },
      { id: 'ndvi_off', label: 'Leaf-off NDVI', weight: 0.2, sign: 1, value: (p, i) => ndvi(p, i, 's2b') },
    );
  }
  const bands = ['nir', 'red', 'green', 'blue'];
  const imagery = [...bands.map(b => `s2:${b}`), ...(o.leafOff ? ['s2b:nir', 's2b:red'] : [])];
  return {
    terms,
    woody: (p, i) => { const d = p['lidar:dsm'][i] - p['lidar:dtm'][i]; return d >= WOODY_MIN_M && ndvi(p, i, 's2') >= WOODY_MIN_NDVI; },
    inputs: ['lidar:dsm', 'lidar:dtm', ...imagery],
    sharpenKeys: o.sharpened ? imagery : [],
  };
}

export interface CiTermStat { id: string; label: string; weight: number; sign: 1 | -1; median: number; scale: number }

export interface Calibration {
  options: CiOptions;
  terms: CiTermStat[];
  /** Otsu threshold on the raw index (already subtracted from the reported index). */
  threshold: number;
  bimodality: number;
  woodyPixels: number;
  /** Share of woody pixels on the coniferous side of the threshold. */
  coniferShare: number;
}

/** The raw (pre-threshold) index of one pixel under a calibration; NaN if not woody or no term is finite. */
function rawIndex(t: ReturnType<typeof termsFor>, stats: CiTermStat[], p: Planes, i: number): number {
  if (!t.woody(p, i)) return NaN;
  let s = 0, ws = 0;
  t.terms.forEach((term, j) => {
    const st = stats[j], v = term.value(p, i);
    if (!Number.isFinite(v) || !Number.isFinite(st.median)) return;
    const z = Math.max(-3, Math.min(3, (v - st.median) / st.scale));
    s += term.weight * term.sign * z; ws += term.weight;
  });
  return ws > 0 ? s / ws : NaN;
}

/** Calibrate on the pixels of a view sample (every input's plane, n pixels). Null when there are too few woody pixels. */
export function calibrate(p: Planes, n: number, o: CiOptions, minWoody = 50): Calibration | null {
  const t = termsFor(o);
  const woody: number[] = [];
  for (let i = 0; i < n; i++) if (t.woody(p, i)) woody.push(i);
  if (woody.length < minWoody) return null;
  const terms: CiTermStat[] = t.terms.map(term => {
    const st = robustStat(woody.map(i => term.value(p, i)));
    return { id: term.id, label: term.label, weight: term.weight, sign: term.sign, median: st.median, scale: st.scale };
  });
  const raw = woody.map(i => rawIndex(t, terms, p, i)).filter(Number.isFinite);
  const threshold = otsu(raw);
  return {
    options: o, terms, threshold, bimodality: bimodality(raw), woodyPixels: woody.length,
    coniferShare: raw.filter(x => x > threshold).length / (raw.length || 1),
  };
}

/** The reported index (raw − threshold) of one pixel. */
export function coniferIndexAt(cal: Calibration, p: Planes, i: number): number {
  const v = rawIndex(termsFor(cal.options), cal.terms, p, i);
  return v - cal.threshold;
}

// ── The variables ───────────────────────────────────────────────────────────

/** The live calibration of each conifer-index variable, by variable id. */
export const calibrations = new Map<string, Calibration>();

export const CI_VARIANTS: { id: string; label: string; options: CiOptions }[] = [
  { id: 'ci', label: 'Conifer index (one scene)', options: { leafOff: false, sharpened: false } },
  { id: 'ci2', label: 'Conifer index (leaf-on + leaf-off)', options: { leafOff: true, sharpened: false } },
  { id: 's_ci', label: 'Conifer index (one scene) · sharpened', options: { leafOff: false, sharpened: true } },
  { id: 's_ci2', label: 'Conifer index (leaf-on + leaf-off) · sharpened', options: { leafOff: true, sharpened: true } },
];

export function ciInputs(o: CiOptions) { const t = termsFor(o); return { inputs: t.inputs, sharpenKeys: t.sharpenKeys }; }

/** The conifer-index variables, reading their calibration when there is one (NaN until calibrated). */
export function coniferVariables(): Variable[] {
  return CI_VARIANTS.map(v => {
    const t = termsFor(v.options);
    // A per-variant cache of the term definitions, re-read only when the calibration object changes.
    const channel: Channel = {
      label: v.label, unit: 'z', step: 0.05, seed: [-2, 2], domain: [-3, 3],
      fn: (p, i) => { const cal = calibrations.get(v.id); return cal ? rawIndex(t, cal.terms, p, i) - cal.threshold : NaN; },
    };
    return { id: v.id, label: v.label, group: 'Conifer index (FieldMapper method)', inputs: t.inputs, channel, ...(t.sharpenKeys.length ? { sharpenKeys: t.sharpenKeys } : {}) };
  });
}
