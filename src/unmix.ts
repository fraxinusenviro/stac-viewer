// LiDAR-guided spectral unmixing: "pansharpening" Sentinel-2 with the CHM.
//
// A 10 m Sentinel-2 pixel is a MIXTURE of whatever stands in it. The 1 m
// canopy height model says what the mixture is made of — so many square
// metres of ground, of shrub, of canopy — but not what each looks like. Over
// a small neighbourhood of Sentinel pixels, each pixel's reflectance is
// modelled as the area-weighted sum of one spectrum per height class:
//
//     R_j  ≈  Σ_c  f_jc · S_c          (f_jc: share of pixel j in class c)
//
// and the class spectra S_c are solved by ridge-regularised least squares
// (the ridge pulls a class that is barely present toward the local mean,
// rather than letting it take any value that fits). Every fine pixel then
// takes the spectrum of ITS OWN height class in its own neighbourhood. A last
// correction adds each coarse pixel's residual back to all its fine pixels,
// so the sharpened image averages back to exactly what Sentinel-2 measured:
// nothing is invented, it is redistributed by structure.
//
// Limits, stated: height classes are not spectral classes — trees and roofs
// share the tall class, so in built-up areas the tall spectrum is a blend of
// both; and a class absent from a neighbourhood has no spectrum of its own
// there (it takes the local mean). Pure; unit-tested.

export interface UnmixParams {
  /** CHM class breaks in metres, ascending: [1, 5] → <1, 1–5, ≥5 m. */
  breaks: number[];
  /** Neighbourhood half-width, in coarse (Sentinel) pixels. 2 → 5 × 5 pixels. */
  radius: number;
  /** Ridge strength, as a share of the neighbourhood's weight. */
  ridge: number;
}

export const DEFAULT_UNMIX: UnmixParams = { breaks: [1, 5], radius: 2, ridge: 0.05 };

/** Fewer fine pixels per coarse pixel than this and there is no mixture to resolve. */
export const MIN_FINE_PER_COARSE = 4;

export const heightClass = (chm: number, breaks: number[]): number => {
  if (chm !== chm) return -1;
  let k = 0;
  while (k < breaks.length && chm >= breaks[k]) k++;
  return k;
};

/** Solve A x = b (K × K, Gaussian elimination with partial pivoting). Returns null if singular. */
export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array<number>(n);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

export interface UnmixInput {
  /** Coarse pixel id per fine pixel (row × idWidth + col in the source window), NaN where none. */
  ids: Float32Array;
  idWidth: number;
  /** Canopy height per fine pixel. */
  chm: Float32Array;
  /** Bands to sharpen, per fine pixel (constant within a coarse pixel, as sampled). */
  bands: Record<string, Float32Array>;
}

export interface UnmixResult {
  bands: Record<string, Float32Array>;
  /** Whether the grid was fine enough to unmix (else the bands come back unchanged). */
  sharpened: boolean;
  finePerCoarse: number;
}

export function unmix(inp: UnmixInput, p: UnmixParams = DEFAULT_UNMIX): UnmixResult {
  const n = inp.ids.length, K = p.breaks.length + 1;
  const keys = Object.keys(inp.bands);
  const cls = new Int8Array(n);
  for (let i = 0; i < n; i++) cls[i] = heightClass(inp.chm[i], p.breaks);

  // Coarse pixels present: their class counts and band values.
  const slotOf = new Map<number, number>();
  const counts: number[][] = [], values: number[][] = [], total: number[] = [], idList: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = inp.ids[i];
    if (id !== id || cls[i] < 0) continue;
    let s = slotOf.get(id);
    if (s === undefined) {
      s = idList.length; slotOf.set(id, s); idList.push(id);
      counts.push(new Array(K).fill(0)); total.push(0);
      values.push(keys.map(k => inp.bands[k][i]));
    }
    counts[s][cls[i]]++; total[s]++;
  }
  const finePerCoarse = idList.length ? total.reduce((a, b) => a + b, 0) / idList.length : 0;
  if (finePerCoarse < MIN_FINE_PER_COARSE) return { bands: inp.bands, sharpened: false, finePerCoarse };

  // Class spectra per coarse pixel, from its neighbourhood.
  const spectra: Float64Array[] = new Array(idList.length); // [band * K + class]
  const W = inp.idWidth, r = p.radius;
  for (let s = 0; s < idList.length; s++) {
    const id = idList[s], col = id % W, row = Math.floor(id / W);
    const A = Array.from({ length: K }, () => new Array<number>(K).fill(0));
    const bs = keys.map(() => new Array<number>(K).fill(0));
    const mean = new Array<number>(keys.length).fill(0), lo = new Array<number>(keys.length).fill(Infinity), hi = new Array<number>(keys.length).fill(-Infinity);
    let wsum = 0;
    for (let dr = -r; dr <= r; dr++) for (let dc = -r; dc <= r; dc++) {
      const c2 = col + dc;
      if (c2 < 0 || c2 >= W) continue;
      const t = slotOf.get(id + dr * W + dc);
      if (t === undefined) continue;
      const f = counts[t].map(x => x / total[t]);
      const v = values[t];
      if (v.some(x => x !== x)) continue;
      for (let a = 0; a < K; a++) { for (let b = 0; b < K; b++) A[a][b] += f[a] * f[b]; v.forEach((x, k) => { bs[k][a] += f[a] * x; }); }
      v.forEach((x, k) => { mean[k] += x; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; });
      wsum++;
    }
    const out = new Float64Array(keys.length * K).fill(NaN);
    if (wsum) {
      const lam = p.ridge * wsum;
      for (let a = 0; a < K; a++) A[a][a] += lam;
      keys.forEach((_, k) => {
        const m = mean[k] / wsum;
        const x = solve(A, bs[k].map(y => y + lam * m));
        // Guard against wild extrapolation, but allow some: a class with no
        // pure pixel nearby (canopy in a corner of mixtures) has its true
        // spectrum OUTSIDE the range of the mixed values around it. So the
        // bound is one neighbourhood range beyond, and never below 0 for a
        // band that is never negative.
        const span = hi[k] - lo[k], floor = lo[k] >= 0 ? Math.max(0, lo[k] - span) : lo[k] - span;
        for (let c = 0; c < K; c++) out[k * K + c] = x ? Math.min(hi[k] + span, Math.max(floor, x[c])) : m;
        // Keep the coarse pixel's own average: add its residual to every class.
        const f = counts[s].map(q => q / total[s]);
        const fitted = f.reduce((acc, fc, c) => acc + fc * out[k * K + c], 0);
        const e = values[s][k] - fitted;
        if (e === e) for (let c = 0; c < K; c++) out[k * K + c] += e;
      });
    }
    spectra[s] = out;
  }

  const result: Record<string, Float32Array> = {};
  keys.forEach((key, k) => {
    const src = inp.bands[key], dst = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = inp.ids[i] === inp.ids[i] ? slotOf.get(inp.ids[i]) : undefined;
      const v = s !== undefined && cls[i] >= 0 ? spectra[s][k * K + cls[i]] : NaN;
      dst[i] = v === v ? v : src[i];
    }
    result[key] = dst;
  });
  return { bands: result, sharpened: true, finePerCoarse };
}
