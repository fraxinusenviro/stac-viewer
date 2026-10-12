// Spatial cross-validation and the accuracy report (spec §8). Pure;
// test/obiaModel.test.ts.
//
// FOLDS are built from spatial GROUPS, never from objects:
//   1. each labelled object falls in a square block (its centroid, `blockM`);
//   2. blocks are UNIONED when objects in them share a parent object (when
//      parents exist), since parent context is shared by construction;
//   3. groups are dealt to k folds deterministically (largest first, to the
//      fold with fewest objects; ties by first object).
// COARSE SUPPORT is handled by a BUFFER, not by unioning: in each fold, any
// training object that shares a native Sentinel pixel (of the coarsest
// raster) with a test object of that fold is DROPPED from that fold's
// training set. Unioning instead chains every contiguous labelled patch into
// one group through 20 m pixels and leaves nothing to cross-validate. Either
// way no Sentinel pixel informs a training and a test object at once; the
// buffer's cost (training objects dropped) is reported per fold.
// Learned preprocessing (the imputer) is fitted inside each training fold, in
// trainForest. Held-out VALIDATION labels never enter a fold.
//
// The REPORT gives per-class precision / recall / F1, the confusion matrix,
// macro-F1, and overall accuracy both per object and per unit area — and
// SUPPRESSES what the labels cannot support rather than printing a number:
// a class with fewer than MIN_PER_CLASS objects or present in fewer than two
// groups gets no metrics, macro-F1 needs two eligible classes, and nothing is
// reported from fewer than two folds.

import { argmax, trainForest, predictScores, type ForestOptions } from './rf.ts';

export const MIN_PER_CLASS = 5;

export interface Row { id: string; cls: string; areaM2: number; cx: number; cy: number; x: (number | null)[]; coarse?: ArrayLike<number> | null; parent?: string | null }

export interface Folds { fold: number[]; k: number; groups: number; blocks: number; reason?: string }

export function spatialFolds(rows: Row[], blockM: number, k: number): Folds {
  const blockOf = rows.map(r => `${Math.floor(r.cx / blockM)},${Math.floor(r.cy / blockM)}`);
  const keys = [...new Set(blockOf)];
  const parent = new Map(keys.map(b => [b, b]));
  const find = (a: string): string => { let x = a; while (parent.get(x) !== x) x = parent.get(x)!; parent.set(a, x); return x; };
  const union = (a: string, b: string) => { const x = find(a), y = find(b); if (x !== y) (x < y ? parent.set(y, x) : parent.set(x, y)); };
  const owner = new Map<string, string>();
  rows.forEach((r, i) => {
    const units = r.parent ? [`pa:${r.parent}`] : [];
    for (const u of units) { const o = owner.get(u); if (o) union(o, blockOf[i]); else owner.set(u, blockOf[i]); }
  });
  const groupOf = blockOf.map(find);
  const members = new Map<string, number[]>();
  groupOf.forEach((g, i) => (members.get(g) ?? members.set(g, []).get(g)!).push(i));
  const groups = [...members.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
  const kk = Math.min(k, groups.length);
  const fold = new Array(rows.length).fill(-1);
  if (kk < 2) return { fold, k: kk, groups: groups.length, blocks: keys.length, reason: `the labels fall in ${groups.length} spatial group${groups.length === 1 ? '' : 's'}; spatial cross-validation needs at least two` };
  const size = new Array(kk).fill(0);
  for (const g of groups) {
    let f = 0;
    for (let j = 1; j < kk; j++) if (size[j] < size[f]) f = j;
    for (const i of g) fold[i] = f;
    size[f] += g.length;
  }
  return { fold, k: kk, groups: groups.length, blocks: keys.length };
}

export interface ClassMetrics { cls: string; n: number; areaM2: number; groups: number; precision: number | null; recall: number | null; f1: number | null; areaPrecision: number | null; areaRecall: number | null; suppressed?: string }

export interface Report {
  classes: string[];
  /** confusion[actual][predicted], object counts. */
  confusion: number[][];
  perClass: ClassMetrics[];
  macroF1: number | null;
  macroF1Classes: string[];
  accuracy: number | null;
  areaAccuracy: number | null;
  nObjects: number;
  folds: number;
  groups: number;
  suppressed: string[];
}

/** `holdout`: the rows are independent validation labels predicted by a model fitted without them (no folds involved). */
export function report(rows: Row[], predicted: string[], groupOf: string[], folds: number, nGroups: number, holdout = false): Report {
  if (holdout) folds = Math.max(folds, 2);
  const classes = [...new Set(rows.map(r => r.cls))].sort();
  const C = classes.length, ix = (c: string) => classes.indexOf(c);
  const conf = Array.from({ length: C }, () => new Array(C).fill(0));
  const confA = Array.from({ length: C }, () => new Array(C).fill(0));
  rows.forEach((r, i) => { const p = ix(predicted[i]); if (p < 0) return; conf[ix(r.cls)][p]++; confA[ix(r.cls)][p] += r.areaM2; });
  const suppressed: string[] = [];
  if (folds < 2) suppressed.push('fewer than two spatial folds: no accuracy can be estimated');
  const perClass: ClassMetrics[] = classes.map((c, k) => {
    const n = rows.filter(r => r.cls === c).length, areaM2 = rows.filter(r => r.cls === c).reduce((s, r) => s + r.areaM2, 0);
    const groups = new Set(rows.map((r, i) => (r.cls === c ? groupOf[i] : null)).filter(Boolean)).size;
    const why = folds < 2 ? 'no folds' : n < MIN_PER_CLASS ? `${n} labelled object${n === 1 ? '' : 's'} (needs ${MIN_PER_CLASS})` : groups < 2 ? 'labelled in one spatial group only' : undefined;
    if (why) return { cls: c, n, areaM2, groups, precision: null, recall: null, f1: null, areaPrecision: null, areaRecall: null, suppressed: why };
    const tp = conf[k][k], col = conf.reduce((s, row) => s + row[k], 0), rowS = conf[k].reduce((a, b) => a + b, 0);
    const tpA = confA[k][k], colA = confA.reduce((s, row) => s + row[k], 0), rowA = confA[k].reduce((a, b) => a + b, 0);
    const precision = col ? tp / col : null, recall = rowS ? tp / rowS : null;
    const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : precision !== null && recall !== null ? 0 : null;
    return { cls: c, n, areaM2, groups, precision, recall, f1, areaPrecision: colA ? tpA / colA : null, areaRecall: rowA ? tpA / rowA : null };
  });
  const eligible = perClass.filter(m => m.f1 !== null);
  const macroF1 = folds >= 2 && eligible.length >= 2 ? eligible.reduce((s, m) => s + m.f1!, 0) / eligible.length : null;
  if (folds >= 2 && eligible.length < 2) suppressed.push('fewer than two classes have enough labelled objects for a macro-F1');
  const total = rows.length, totalA = rows.reduce((s, r) => s + r.areaM2, 0);
  const diag = conf.reduce((s, row, k) => s + row[k], 0), diagA = confA.reduce((s, row, k) => s + row[k], 0);
  return {
    classes, confusion: conf, perClass, macroF1, macroF1Classes: eligible.map(m => m.cls),
    accuracy: folds >= 2 && total ? diag / total : null, areaAccuracy: folds >= 2 && totalA ? diagA / totalA : null,
    nObjects: total, folds, groups: nGroups, suppressed,
  };
}

export interface CvResult { predicted: string[]; report: Report; featureIdx: number[]; /** Training objects dropped by the coarse-support buffer, per fold. */ buffered: number[] }

/** Out-of-fold predictions for every row, the model refitted per fold on the selected features. */
export function crossValidate(rows: Row[], features: string[], featureIdx: number[], f: Folds, groupOf: string[], opts: ForestOptions): CvResult {
  const predicted = new Array(rows.length).fill('');
  const buffered: number[] = [];
  if (f.k >= 2) {
    for (let k = 0; k < f.k; k++) {
      const test = rows.map((r, i) => [r, i] as const).filter(([, i]) => f.fold[i] === k);
      const testPx = new Set<number>();
      for (const [r] of test) if (r.coarse) for (const u of Array.from(r.coarse)) testPx.add(u);
      const others = rows.filter((_, i) => f.fold[i] !== k);
      const train = others.filter(r => !r.coarse || !Array.from(r.coarse).some(u => testPx.has(u)));
      buffered.push(others.length - train.length);
      if (!test.length) continue;
      if (new Set(train.map(r => r.cls)).size < 2) { for (const [, i] of test) predicted[i] = ''; continue; }
      const m = trainForest(train.map(r => featureIdx.map(j => r.x[j])), train.map(r => r.cls), featureIdx.map(j => features[j]), { ...opts, seed: opts.seed + k });
      for (const [r, i] of test) predicted[i] = m.classes[argmax(predictScores(m, featureIdx.map(j => r.x[j])))];
    }
  }
  return { predicted, report: report(rows, predicted, groupOf, f.k, f.groups), featureIdx, buffered };
}

/** Each row's spatial group key (as spatialFolds formed them). */
export function groupKeys(rows: Row[], blockM: number): string[] {
  const f = spatialFolds(rows, blockM, Number.MAX_SAFE_INTEGER);
  return f.fold.map(String);
}
