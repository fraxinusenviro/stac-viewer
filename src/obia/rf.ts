// A small, deterministic Random Forest classifier (Breiman 2001): CART trees
// on Gini impurity, each on a bootstrap sample with √p candidate features per
// split, seeded (mulberry32) so a fixed seed reproduces the model exactly.
// Pure; runs in the OBIA worker; test/obiaModel.test.ts.
//
// Why not a library: none in this repository, and the candidates checked
// would have had to be wrapped for missing values and seeded serialization
// anyway; a tree learner this size is easier to verify than to vet.
//
// MISSING VALUES: the declared policy is median imputation, with the medians
// FITTED ON THE TRAINING ROWS ONLY and stored with the model, so a test fold
// never informs its own preprocessing. A feature with no training value at
// all is imputed 0 and reported (`emptyFeatures`).
//
// OUTPUT: the share of trees voting for each class. These are MODEL SCORES,
// not calibrated probabilities, and every surface labels them so.

export interface ForestOptions { trees: number; maxDepth: number; minLeaf: number; seed: number; mtry?: number }
export const DEFAULT_FOREST: ForestOptions = { trees: 100, maxDepth: 16, minLeaf: 1, seed: 20261012 };

type Node = { f: number; t: number; l: number; r: number } | { leaf: number[] };

export interface Forest {
  kind: 'stac-viewer-rf/1';
  features: string[];
  classes: string[];
  medians: number[];
  emptyFeatures: string[];
  options: ForestOptions;
  trees: Node[][];
  /** Mean decrease in Gini impurity per feature, normalized to sum 1. */
  importance: number[];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const median = (v: number[]) => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Fit medians on these rows; return imputed copies. */
export function fitImputer(X: (number | null)[][], p: number): { medians: number[]; empty: number[] } {
  const medians: number[] = [], empty: number[] = [];
  for (let j = 0; j < p; j++) {
    const v = X.map(r => r[j]).filter((x): x is number => x !== null && Number.isFinite(x));
    const m = median(v);
    if (Number.isNaN(m)) { empty.push(j); medians.push(0); } else medians.push(m);
  }
  return { medians, empty };
}
export const impute = (row: (number | null)[], medians: number[]) => row.map((x, j) => (x === null || !Number.isFinite(x) ? medians[j] : x));

export function trainForest(Xraw: (number | null)[][], y: string[], features: string[], opts: ForestOptions = DEFAULT_FOREST): Forest {
  if (Xraw.length !== y.length || !Xraw.length) throw new Error('no training rows');
  const classes = [...new Set(y)].sort();
  if (classes.length < 2) throw new Error('training needs at least two classes');
  const p = features.length;
  const { medians, empty } = fitImputer(Xraw, p);
  const X = Xraw.map(r => impute(r, medians));
  const Y = y.map(c => classes.indexOf(c));
  const C = classes.length, n = X.length;
  const rand = mulberry32(opts.seed);
  const mtry = opts.mtry ?? Math.max(1, Math.floor(Math.sqrt(p)));
  const importance = new Float64Array(p);
  const gini = (counts: number[], tot: number) => { let s = 1; for (const c of counts) s -= (c / tot) ** 2; return s; };

  const trees: Node[][] = [];
  for (let t = 0; t < opts.trees; t++) {
    const sample = Array.from({ length: n }, () => Math.floor(rand() * n));
    const nodes: Node[] = [];
    const build = (idx: number[], depth: number): number => {
      const counts = new Array(C).fill(0);
      for (const i of idx) counts[Y[i]]++;
      const id = nodes.length;
      nodes.push({ leaf: counts.map(c => c / idx.length) });
      const pure = counts.filter(c => c > 0).length <= 1;
      if (pure || depth >= opts.maxDepth || idx.length < 2 * opts.minLeaf) return id;
      // Candidate features: a partial Fisher–Yates shuffle.
      const fs = Array.from({ length: p }, (_, j) => j);
      for (let k = 0; k < Math.min(mtry, p); k++) { const j = k + Math.floor(rand() * (p - k)); [fs[k], fs[j]] = [fs[j], fs[k]]; }
      const parentG = gini(counts, idx.length);
      let best = { gain: 1e-12, f: -1, t: 0 };
      for (const f of fs.slice(0, mtry)) {
        const sorted = [...idx].sort((a, b) => X[a][f] - X[b][f] || a - b);
        const left = new Array(C).fill(0), right = counts.slice();
        for (let k = 0; k < sorted.length - 1; k++) {
          const c = Y[sorted[k]];
          left[c]++; right[c]--;
          const a = X[sorted[k]][f], b = X[sorted[k + 1]][f];
          if (a === b || k + 1 < opts.minLeaf || sorted.length - k - 1 < opts.minLeaf) continue;
          const nl = k + 1, nr = sorted.length - nl;
          const gain = parentG - (nl / sorted.length) * gini(left, nl) - (nr / sorted.length) * gini(right, nr);
          if (gain > best.gain) best = { gain, f, t: (a + b) / 2 };
        }
      }
      if (best.f < 0) return id;
      importance[best.f] += best.gain * idx.length;
      const L = idx.filter(i => X[i][best.f] <= best.t), R = idx.filter(i => X[i][best.f] > best.t);
      const l = build(L, depth + 1), r = build(R, depth + 1);
      nodes[id] = { f: best.f, t: best.t, l, r };
      return id;
    };
    build(sample, 0);
    trees.push(nodes);
  }
  const tot = importance.reduce((a, b) => a + b, 0);
  return {
    kind: 'stac-viewer-rf/1', features, classes, medians, emptyFeatures: empty.map(j => features[j]), options: { ...opts, mtry }, trees,
    importance: [...importance].map(v => (tot ? v / tot : 0)),
  };
}

/** Vote shares per class (model scores, uncalibrated). */
export function predictScores(m: Forest, rowRaw: (number | null)[]): number[] {
  const row = impute(rowRaw, m.medians);
  const out = new Array(m.classes.length).fill(0);
  for (const nodes of m.trees) {
    let k = 0;
    for (;;) {
      const nd = nodes[k];
      if ('leaf' in nd) { let bi = 0; for (let c = 1; c < nd.leaf.length; c++) if (nd.leaf[c] > nd.leaf[bi]) bi = c; out[bi]++; break; }
      k = row[nd.f] <= nd.t ? nd.l : nd.r;
    }
  }
  return out.map(v => v / m.trees.length);
}

export function argmax(v: number[]): number { let b = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[b]) b = i; return b; }

/** Top score minus the runner-up: a low margin means the trees disagree. */
export function scoreMargin(v: number[]): number { const s = [...v].sort((a, b) => b - a); return s[0] - (s[1] ?? 0); }
