// Sentinel-2 statistics per object AT NATIVE SUPPORT (spec §7). Pure;
// test/obiaSentinel.test.ts.
//
// Sentinel values are never resampled onto the fine grid. Each band stays on
// its own native grid (10 m or 20 m, the scene's UTM CRS) and each object is
// sampled against the native pixel FOOTPRINTS it intersects:
//
//     objectMean = Σ_i a_i v_i / Σ_i a_i          (valid pixels only)
//
// where a_i is the area of the object inside native pixel i. The intersection
// areas are measured on the analysis grid: a_i = (fine pixels of the object
// whose centre lies in native pixel i) × fine cell area. When the analysis
// CRS is the scene's CRS and the cell size divides the native size with
// aligned origins (the default: WGS 84 UTM, 0.5/1/2 m against 10/20 m), every
// fine pixel lies wholly inside one native pixel and the areas are EXACT;
// otherwise they are exact to within the fine pixels cut by a native edge,
// and the run says so (`exact: false`).
//
// Recorded beside each mean:
//   validFraction       valid intersection area / object area
//   nativePixelCount    distinct native pixels the object intersects (valid or not)
//   effectivePixelCount (Σa)² / Σa² over the valid intersections — how
//                       concentrated the weights are. NOT a count of independent
//                       observations: neighbouring Sentinel pixels are
//                       correlated, and the overlap weighting unmixes nothing.
// Flags: `coarse-subpixel` (object smaller than one native pixel),
// `coarse-mixed` (the native pixels it touches are mostly NOT the object, so
// the value describes a mixture), `coarse-no-valid` (no valid pixel: missing,
// never zero).
//
// Indices are computed per NATIVE pixel from bands of the SAME native
// resolution (NDVI from B04/B08 at 10 m; NDMI from B8A/B11 at 20 m) and then
// area-averaged: the mean of the pixel index, not the index of the mean
// reflectance. Recorded on the feature definition.

import type { FeatureDefinition, SupportRecord } from './types.ts';

export interface NativeRaster {
  /** Stable key, e.g. `s2:<item>:10m`. */
  key: string;
  epsg: number;
  /** Top-left corner and (positive) pixel size. */
  originX: number;
  originY: number;
  res: number;
  w: number;
  h: number;
  /** Named value planes on this grid; NaN = no valid value. */
  values: Record<string, Float32Array>;
}

export interface FineGrid { w: number; h: number; x0: number; y0: number; cellM: number; epsg: number }

/**
 * For each fine pixel, the index of the native pixel its centre lies in (−1:
 * outside the raster). `toNative` maps an analysis-CRS coordinate into the
 * raster's CRS when the two differ.
 */
export function fineToNative(g: FineGrid, r: NativeRaster, toNative?: (xy: [number, number]) => [number, number]): { index: Int32Array; exact: boolean } {
  const index = new Int32Array(g.w * g.h).fill(-1);
  const same = g.epsg === r.epsg;
  if (!same && !toNative) throw new Error(`no transformation from EPSG:${g.epsg} to EPSG:${r.epsg}`);
  const ratio = r.res / g.cellM;
  const exact = same && Math.abs(ratio - Math.round(ratio)) < 1e-9
    && Math.abs(((g.x0 - r.originX) / g.cellM) - Math.round((g.x0 - r.originX) / g.cellM)) < 1e-6
    && Math.abs(((r.originY - g.y0) / g.cellM) - Math.round((r.originY - g.y0) / g.cellM)) < 1e-6;
  const p: [number, number] = [0, 0];
  for (let py = 0; py < g.h; py++) for (let px = 0; px < g.w; px++) {
    p[0] = g.x0 + (px + 0.5) * g.cellM; p[1] = g.y0 - (py + 0.5) * g.cellM;
    const q = same ? p : toNative!(p);
    const c = Math.floor((q[0] - r.originX) / r.res), rr = Math.floor((r.originY - q[1]) / r.res);
    if (c >= 0 && rr >= 0 && c < r.w && rr < r.h) index[py * g.w + px] = rr * r.w + c;
  }
  return { index, exact };
}

export interface CoarseStats {
  mean: Float32Array;
  support: SupportRecord[];
}

/** Area-weighted statistics of every plane of one native raster, per object. */
export function areaWeighted(labels: Int32Array, count: number, nativeIndex: Int32Array, cellAreaM2: number, r: NativeRaster, planes: string[]): Record<string, CoarseStats> & { _pixels: Int32Array[] } {
  const nativeArea = r.res * r.res;
  // (object, native pixel) pairs with their fine-pixel counts, by sorting.
  const N = r.w * r.h;
  const objArea = new Float64Array(count);
  let m = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) m++;
  const keys = new Float64Array(m);
  m = 0;
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i];
    if (k < 0) continue;
    objArea[k] += cellAreaM2;
    const j = nativeIndex[i];
    keys[m++] = k * (N + 1) + (j < 0 ? N : j);
  }
  keys.sort();
  const pairs: { k: number; j: number; a: number }[] = [];
  for (let s = 0; s < keys.length;) {
    let e = s;
    while (e < keys.length && keys[e] === keys[s]) e++;
    const k = Math.floor(keys[s] / (N + 1)), j = keys[s] - k * (N + 1);
    pairs.push({ k, j: j === N ? -1 : j, a: (e - s) * cellAreaM2 });
    s = e;
  }
  const out = { _pixels: [] as Int32Array[] } as Record<string, CoarseStats> & { _pixels: Int32Array[] };
  const pixelsOf: number[][] = Array.from({ length: count }, () => []);
  for (const q of pairs) if (q.j >= 0) pixelsOf[q.k].push(q.j);
  out._pixels = pixelsOf.map(a => Int32Array.from(a));
  for (const name of planes) {
    const v = r.values[name];
    const sw = new Float64Array(count), swv = new Float64Array(count), sw2 = new Float64Array(count);
    for (const q of pairs) {
      if (q.j < 0) continue;
      const x = v[q.j];
      if (x !== x) continue;
      sw[q.k] += q.a; swv[q.k] += q.a * x; sw2[q.k] += q.a * q.a;
    }
    const mean = new Float32Array(count);
    const support: SupportRecord[] = [];
    for (let k = 0; k < count; k++) {
      mean[k] = sw[k] > 0 ? swv[k] / sw[k] : NaN;
      const flags: string[] = [];
      const touched = pixelsOf[k].length;
      if (objArea[k] < nativeArea) flags.push('coarse-subpixel');
      if (touched && objArea[k] / (touched * nativeArea) < 0.5) flags.push('coarse-mixed');
      if (!(sw[k] > 0)) flags.push('coarse-no-valid');
      support.push({
        validFraction: objArea[k] ? sw[k] / objArea[k] : 0,
        nativePixelCount: touched,
        effectivePixelCount: sw2[k] > 0 ? (sw[k] * sw[k]) / sw2[k] : 0,
        qualityFlags: flags,
      });
    }
    out[name] = { mean, support };
  }
  return out;
}

/** Spectral index per native pixel; NaN where either band is missing or the denominator is ~0. */
export function normalizedDifference(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length).fill(NaN);
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i], d = x + y;
    if (x === x && y === y && Math.abs(d) > 1e-6) out[i] = (x - y) / d;
  }
  return out;
}

/**
 * Invalid-pixel mask from the scene classification (SCL, 20 m): the listed
 * classes, with cloud and shadow classes (3, 8, 9, 10) dilated by `bufferPx`
 * SCL pixels. 1 = invalid.
 */
export function sclInvalid(scl: Float32Array, w: number, h: number, invalid: number[], bufferPx: number): Uint8Array {
  const bad = new Set(invalid), grow = new Set([3, 8, 9, 10].filter(c => bad.has(c)));
  const out = new Uint8Array(w * h);
  for (let i = 0; i < scl.length; i++) { const c = scl[i]; if (c !== c || bad.has(c)) out[i] = 1; }
  if (bufferPx > 0) {
    const src = Uint8Array.from(scl, c => (grow.has(c) ? 1 : 0));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!src[y * w + x]) continue;
      for (let dy = -bufferPx; dy <= bufferPx; dy++) for (let dx = -bufferPx; dx <= bufferPx; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
      }
    }
  }
  return out;
}

/** Sentinel bands this module reads, with their native resolution. */
export const S2_BAND_RES: Record<string, number> = { blue: 10, green: 10, red: 10, nir: 10, rededge1: 20, rededge2: 20, rededge3: 20, nir08: 20, swir16: 20, swir22: 20, scl: 20 };

export const S2_INDICES: Record<string, { label: string; a: string; b: string; res: number; formula: string }> = {
  ndvi: { label: 'NDVI', a: 'nir', b: 'red', res: 10, formula: '(B08 − B04) / (B08 + B04), per native 10 m pixel, then area-weighted mean of the pixel index' },
  ndmi: { label: 'NDMI (moisture)', a: 'nir08', b: 'swir16', res: 20, formula: '(B8A − B11) / (B8A + B11), per native 20 m pixel, then area-weighted mean of the pixel index' },
  ndre: { label: 'NDRE (red edge)', a: 'nir08', b: 'rededge1', res: 20, formula: '(B8A − B05) / (B8A + B05), per native 20 m pixel, then area-weighted mean of the pixel index' },
};

/**
 * Feature definitions for one scene. `prefix` is `s2` for the main (leaf-on)
 * scene and `s2b` for the second date; `dateLabel` names it on screen.
 */
export function sentinelFeatureDefs(sourceId: string, bands: string[], indices: string[], prefix = 's2', dateLabel = 'Sentinel-2'): FeatureDefinition[] {
  const defs: FeatureDefinition[] = bands.map(b => ({
    id: `${prefix}_${b}`, label: `${dateLabel} ${b} reflectance`, sourceIds: [sourceId], group: 'sentinel', operation: 'area-weighted mean of native pixels',
    parameters: { band: b }, unit: 'reflectance', processingResolutionM: S2_BAND_RES[b], effectiveSupportM: S2_BAND_RES[b],
    sampling: 'native-area-weighted', useForSegmentation: false, useForClassification: true,
  }));
  for (const id of indices) {
    const ix = S2_INDICES[id];
    if (!ix) continue;
    defs.push({
      id: `${prefix}_${id}`, label: `${dateLabel} ${ix.label}`, sourceIds: [sourceId], group: 'sentinel', operation: 'normalized difference per native pixel, then area-weighted mean',
      parameters: { formula: ix.formula, bands: [ix.a, ix.b], aggregation: 'mean-of-pixel-index' }, unit: 'index (−1…1)',
      processingResolutionM: ix.res, effectiveSupportM: ix.res, sampling: 'native-area-weighted', useForSegmentation: false, useForClassification: true,
    });
  }
  return defs;
}

/** Seasonal differences: main-scene object mean minus second-date object mean, both at native support. */
export const SEASONAL_DELTAS = ['ndvi', 'ndre', 'ndmi', 'nir', 'red', 'swir16'];

export function seasonalDeltaDefs(sourceIds: string[]): FeatureDefinition[] {
  return SEASONAL_DELTAS.map(k => ({
    id: `d_${k}`, label: `Δ ${S2_INDICES[k]?.label ?? `${k} reflectance`} (main − second date)`, sourceIds, group: 'sentinel' as const,
    operation: 'difference of the two dates\' area-weighted object means (not a per-pixel difference: the two scenes need not share a grid)',
    parameters: { a: `s2_${k}`, b: `s2b_${k}` }, unit: S2_INDICES[k] ? 'index difference' : 'reflectance difference',
    processingResolutionM: S2_INDICES[k]?.res ?? S2_BAND_RES[k], effectiveSupportM: S2_INDICES[k]?.res ?? S2_BAND_RES[k],
    sampling: 'native-area-weighted' as const, useForSegmentation: false, useForClassification: true,
  }));
}
