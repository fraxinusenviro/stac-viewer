// UNSUPERVISED CLASSIFICATION: k-means over the chosen variables at every
// pixel of a study area. Pure (no engine, no DOM); test/cluster.test.ts. The
// runner that reads the inputs is clusterRun.ts.
//
// The rule-based classes say what each class IS and find the pixels that
// match; this goes the other way — it finds the groups the data falls into
// and leaves the naming to the person who knows the ground. A cluster is a
// statistical group, not a cover type: two clusters may be one cover in
// different light, and one cluster may hold two covers that look alike in the
// variables chosen.
//
//   • Variables are STANDARDISED (z-scores over the area) by default, or a
//     variable measured in metres (canopy height) would outvote one measured
//     in index units (NDVI) by its numbers alone.
//   • A pixel missing ANY chosen variable is left unclassified — never filled
//     with a mean or a zero — and the share left out is reported.
//   • Seeded k-means++ start and Lloyd iterations on a random SAMPLE of the
//     valid pixels (60 000 by default), then every pixel assigned to its
//     nearest centre: the same seed and inputs give the same clusters.
//   • Clusters are numbered in order of the first variable's centre, lowest
//     first, so "cluster 1" means the same thing on a rerun.
//   • Reported: each cluster's centre in the variables' own units (the profile
//     a name is chosen from), its size, and the share of the variance the
//     clustering explains (between-cluster ÷ total sum of squares) — how
//     distinct the groups are, not how right.

export interface ClusterOptions {
  k: number;
  seed?: number;
  maxIter?: number;
  /** Valid pixels the centres are fitted on (all are assigned). */
  sample?: number;
  /** z-score every variable over the area first (default true). */
  standardise?: boolean;
}

export interface ClusterModel {
  k: number;
  d: number;
  /** Per variable: the mean and standard deviation used to standardise (sd 1 when not standardised). */
  mean: number[];
  sd: number[];
  /** Cluster centres in the standardised space, ordered (see header). */
  centres: number[][];
  /** The same centres in the variables' own units. */
  centresRaw: number[][];
  iterations: number;
  converged: boolean;
  /** Between-cluster ÷ total sum of squares on the fitting sample (0…1). */
  explained: number;
  /** Valid pixels (every variable present) and the sample size used. */
  valid: number;
  sampled: number;
}

/** mulberry32: a small seeded generator, so a run is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const rowValid = (X: Float32Array, i: number, d: number) => { for (let j = 0; j < d; j++) { const v = X[i * d + j]; if (v !== v || !Number.isFinite(v)) return false; } return true; };

function nearest(c: number[][], x: ArrayLike<number>, off: number, d: number): [number, number] {
  let best = 0, bd = Infinity;
  for (let k = 0; k < c.length; k++) {
    let s = 0;
    for (let j = 0; j < d; j++) { const t = x[off + j] - c[k][j]; s += t * t; }
    if (s < bd) { bd = s; best = k; }
  }
  return [best, bd];
}

/**
 * Fit k-means to the rows of `X` (n rows × d variables, row-major; a row with
 * any non-finite value is skipped). `mask`, when given, restricts the rows to
 * those inside the study area.
 */
export function fitKMeans(X: Float32Array, n: number, d: number, opts: ClusterOptions, mask?: Uint8Array): ClusterModel {
  const k = Math.round(opts.k);
  if (!(k >= 2)) throw new Error('k-means needs at least 2 clusters');
  if (d < 1) throw new Error('choose at least one variable');
  const rand = rng(opts.seed ?? 1);
  const valid: number[] = [];
  for (let i = 0; i < n; i++) if ((!mask || mask[i]) && rowValid(X, i, d)) valid.push(i);
  if (valid.length < k * 5) throw new Error(`only ${valid.length} pixels have every chosen variable; at least ${k * 5} are needed for ${k} clusters`);
  // Standardisation over every valid pixel.
  const mean = new Array(d).fill(0), sd = new Array(d).fill(1);
  if (opts.standardise !== false) {
    for (const i of valid) for (let j = 0; j < d; j++) mean[j] += X[i * d + j];
    for (let j = 0; j < d; j++) mean[j] /= valid.length;
    const ss = new Array(d).fill(0);
    for (const i of valid) for (let j = 0; j < d; j++) { const t = X[i * d + j] - mean[j]; ss[j] += t * t; }
    for (let j = 0; j < d; j++) sd[j] = Math.sqrt(ss[j] / valid.length) || 1;
  }
  // The fitting sample (a seeded partial shuffle).
  const m = Math.min(valid.length, opts.sample ?? 60000);
  for (let a = 0; a < m; a++) { const b = a + Math.floor(rand() * (valid.length - a)); const t = valid[a]; valid[a] = valid[b]; valid[b] = t; }
  const S = new Float64Array(m * d);
  for (let a = 0; a < m; a++) for (let j = 0; j < d; j++) S[a * d + j] = (X[valid[a] * d + j] - mean[j]) / sd[j];
  // k-means++ start.
  const centres: number[][] = [Array.from(S.subarray(0, d))];
  const first = Math.floor(rand() * m);
  centres[0] = Array.from(S.subarray(first * d, first * d + d));
  const dist = new Float64Array(m).fill(Infinity);
  while (centres.length < k) {
    let sum = 0;
    const c = centres[centres.length - 1];
    for (let a = 0; a < m; a++) {
      let s = 0;
      for (let j = 0; j < d; j++) { const t = S[a * d + j] - c[j]; s += t * t; }
      if (s < dist[a]) dist[a] = s;
      sum += dist[a];
    }
    let r = rand() * sum, pick = m - 1;
    for (let a = 0; a < m; a++) { r -= dist[a]; if (r <= 0) { pick = a; break; } }
    centres.push(Array.from(S.subarray(pick * d, pick * d + d)));
  }
  // Lloyd iterations; an emptied cluster is re-seeded at the point farthest from its centre.
  const lab = new Int32Array(m);
  const maxIter = opts.maxIter ?? 60;
  let it = 0, converged = false;
  for (; it < maxIter; it++) {
    let moved = 0;
    for (let a = 0; a < m; a++) { const [c] = nearest(centres, S, a * d, d); if (c !== lab[a] || it === 0) { if (c !== lab[a]) moved++; lab[a] = c; } }
    const sums = Array.from({ length: k }, () => new Float64Array(d)), cnt = new Uint32Array(k);
    for (let a = 0; a < m; a++) { const c = lab[a]; cnt[c]++; for (let j = 0; j < d; j++) sums[c][j] += S[a * d + j]; }
    for (let c = 0; c < k; c++) {
      if (cnt[c]) { for (let j = 0; j < d; j++) centres[c][j] = sums[c][j] / cnt[c]; continue; }
      let far = 0, fd = -1;
      for (let a = 0; a < m; a++) { const [, dd] = nearest(centres, S, a * d, d); if (dd > fd) { fd = dd; far = a; } }
      centres[c] = Array.from(S.subarray(far * d, far * d + d));
      moved++;
    }
    if (it > 0 && moved <= m * 1e-4) { converged = true; it++; break; }
  }
  // Order by the first variable's centre, lowest first.
  const order = centres.map((c, i) => [c[0], i] as [number, number]).sort((x, y) => x[0] - y[0]).map(p => p[1]);
  const ordered = order.map(i => centres[i]);
  // Variance explained on the sample.
  const gm = new Array(d).fill(0);
  for (let a = 0; a < m; a++) for (let j = 0; j < d; j++) gm[j] += S[a * d + j] / m;
  let tot = 0, within = 0;
  for (let a = 0; a < m; a++) {
    const [, dd] = nearest(ordered, S, a * d, d);
    within += dd;
    for (let j = 0; j < d; j++) { const t = S[a * d + j] - gm[j]; tot += t * t; }
  }
  return {
    k, d, mean, sd, centres: ordered, centresRaw: ordered.map(c => c.map((v, j) => v * sd[j] + mean[j])),
    iterations: it, converged, explained: tot > 0 ? 1 - within / tot : 0, valid: valid.length, sampled: m,
  };
}

/** The cluster (0…k−1) of every row, or −1 where a variable is missing or the row is outside the mask. */
export function assignClusters(model: ClusterModel, X: Float32Array, n: number, mask?: Uint8Array): Int16Array {
  const { d } = model;
  const out = new Int16Array(n).fill(-1);
  const z = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    if ((mask && !mask[i]) || !rowValid(X, i, d)) continue;
    for (let j = 0; j < d; j++) z[j] = (X[i * d + j] - model.mean[j]) / model.sd[j];
    out[i] = nearest(model.centres, z, 0, d)[0];
  }
  return out;
}

/** A qualitative palette for up to 20 clusters (Tableau 20 order, dark and light alternating). */
export const CLUSTER_COLOURS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf', '#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5', '#c49c94', '#f7b6d2', '#c7c7c7', '#dbdb8d', '#9edae5'];

const csvText = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** One row per cluster: its name, size and centre in each variable's own units. */
export function clusterProfileCsv(model: ClusterModel, names: string[], vars: { id: string; label: string }[], areasM2: number[]): string {
  const head = ['cluster', 'name', 'area_ha', ...vars.map(v => csvText(`${v.id} (${v.label})`))].join(',');
  return [head, ...model.centresRaw.map((c, k) => [k + 1, csvText(names[k]), (areasM2[k] / 1e4).toFixed(4), ...c.map(v => (Math.abs(v) >= 100 ? v.toFixed(2) : v.toPrecision(5)))].join(','))].join('\n');
}
