// The CLASSIFICATION stage as one pure function (run in the OBIA worker).
// test/obiaModel.test.ts, test/obiaComposition.test.ts.
//
// HIERARCHICAL. The class schema is a tree: structural classes at the top
// (forest, shrub, low vegetation, water, built), composition classes under
// them (coniferous / broadleaf / mixed forest; graminoid, ericaceous, lichen,
// moss… under low vegetation). Two models are fitted:
//
//   level 1  every training label, rolled up to its top-level class;
//   level 2  for each top-level class with at least two labelled
//            sub-classes, a separate model fitted ONLY on objects labelled
//            with those sub-classes, and applied only to objects that
//            level 1 put in that class.
//
// So a composition model never has to tell a meadow from a forest, and an
// object labelled only "Forest" still teaches level 1. Each level has its own
// spatial cross-validation, ablation and held-out report. Level-2 figures are
// CONDITIONAL on the structural class being right, and are labelled so.
//
// Per level: spatial cross-validation of the selected predictor groups, the
// ablation RGB + LiDAR against RGB + LiDAR + Sentinel on the SAME folds, a
// final model on every training label, and the held-out validation report.

import { DEFAULT_FOREST, argmax, predictScores, scoreMargin, trainForest, type Forest, type ForestOptions } from './rf.ts';
import { crossValidate, groupKeys, report, spatialFolds, type CvResult, type Report, type Row } from './validation.ts';
import type { ClassDef, LabelEntry } from './labels.ts';
import type { FeatureDefinition, FeatureGroup, ObjectRecord } from './types.ts';

export interface ClassifyJob {
  objects: ObjectRecord[];
  featureDefs: FeatureDefinition[];
  labels: LabelEntry[];
  /** The class tree (parent ids). Absent: one flat level, as before. */
  classes?: ClassDef[];
  groups: FeatureGroup[];
  blockM: number;
  folds: number;
  forest: ForestOptions;
  /** Per object index, coarsest native pixel ids (leakage control); null without Sentinel. */
  coarsePixels: (ArrayLike<number> | null)[] | null;
}

export interface Prediction {
  objectId: string;
  /** The deepest class predicted (a composition class where a level-2 model exists, else structural). */
  cls: string;
  scores: Record<string, number>;
  margin: number;
  /** Level 1. */
  parent?: string;
  parentScores?: Record<string, number>;
}

export interface LevelResult {
  /** null for level 1; the structural class for a level-2 model. */
  parent: string | null;
  features: string[];
  model: Forest;
  cv: { report: Report; folds: number; groups: number; blocks: number; reason?: string; buffered: number[] } | null;
  ablation: { base: Report; withSentinel: Report; baseFeatures: string[]; sentinelFeatures: string[] } | null;
  validation: Report | null;
  trainedOn: number;
}

export interface ClassifyResult extends LevelResult {
  /** Level-2 composition models, one per structural class with ≥ 2 labelled sub-classes. */
  sublevels: LevelResult[];
  /** Structural classes with sub-classes defined but too few labelled (why no level 2). */
  skipped: { parent: string; reason: string }[];
  predictions: Prediction[];
}

/** Every class's top-level ancestor, and its child directly under that ancestor. */
export function classPaths(classes: ClassDef[] | undefined) {
  const byId = new Map((classes ?? []).map(c => [c.id, c]));
  const chain = (id: string) => { const out = [id]; let c = byId.get(id); const seen = new Set([id]); while (c?.parent && byId.has(c.parent) && !seen.has(c.parent)) { seen.add(c.parent); out.unshift(c.parent); c = byId.get(c.parent); } return out; };
  return {
    root: (id: string) => chain(id)[0],
    child: (id: string) => chain(id)[1] as string | undefined,
    childrenOf: (root: string) => (classes ?? []).filter(c => c.parent === root).map(c => c.id),
  };
}

function fitLevel(job: ClassifyJob, feats: string[], train: Row[], held: Row[], parent: string | null): LevelResult & { predict: (o: ObjectRecord) => number[] } {
  const opts = { ...DEFAULT_FOREST, ...job.forest };
  const folds = spatialFolds(train, job.blockM, job.folds);
  const gk = groupKeys(train, job.blockM);
  const all = feats.map((_, j) => j);
  const res: CvResult = crossValidate(train, feats, all, folds, gk, opts);
  const cv = { report: res.report, folds: folds.k, groups: folds.groups, blocks: folds.blocks, reason: folds.reason, buffered: res.buffered };
  // The ablation's base drops everything Sentinel informs: its bands and indices, and the derived conifer score.
  const sentinelSet = new Set(job.featureDefs.filter(d => d.group === 'sentinel' || d.group === 'index').map(d => d.id));
  const baseIdx = all.filter(j => !sentinelSet.has(feats[j]));
  let ablation: LevelResult['ablation'] = null;
  if (folds.k >= 2 && baseIdx.length && baseIdx.length < all.length) {
    const base = crossValidate(train, feats, baseIdx, folds, gk, opts);
    ablation = { base: base.report, withSentinel: res.report, baseFeatures: baseIdx.map(j => feats[j]), sentinelFeatures: feats.filter(f => sentinelSet.has(f)) };
  }
  const model = trainForest(train.map(r => r.x), train.map(r => r.cls), feats, opts);
  const predict = (o: ObjectRecord) => predictScores(model, feats.map(f => o.featureValues[f] ?? null));
  let validation: Report | null = null;
  if (held.length) {
    const byId = new Map(job.objects.map(o => [o.id, o]));
    const pred = held.map(r => model.classes[argmax(predict(byId.get(r.id)!))]);
    const hg = groupKeys(held, job.blockM);
    validation = report(held, pred, hg, 0, new Set(hg).size, true);
  }
  return { parent, features: feats, model, cv, ablation, validation, trainedOn: train.length, predict };
}

export function runClassify(job: ClassifyJob): ClassifyResult {
  const feats = job.featureDefs.filter(d => d.useForClassification && job.groups.includes(d.group)).map(d => d.id);
  if (!feats.length) throw new Error('no predictor group selected');
  const byId = new Map(job.objects.map(o => [o.id, o]));
  const paths = classPaths(job.classes);
  const rowOf = (e: LabelEntry, cls: string): Row | null => {
    const o = byId.get(e.objectId);
    if (!o) return null;
    return { id: o.id, cls, areaM2: o.areaM2, cx: o.cx, cy: o.cy, x: feats.map(f => o.featureValues[f] ?? null), coarse: job.coarsePixels?.[o.index] ?? null };
  };
  const usable = job.labels.filter(e => !e.pending && (e.role === 'training' || e.role === 'validation'));
  const rows = (role: string, map: (e: LabelEntry) => string | undefined) => usable.filter(e => e.role === role).flatMap(e => { const c = map(e); const r = c ? rowOf(e, c) : null; return r ? [r] : []; });

  // Level 1: structural classes (labels rolled up to their top-level class).
  const train1 = rows('training', e => paths.root(e.classId)), held1 = rows('validation', e => paths.root(e.classId));
  if (new Set(train1.map(r => r.cls)).size < 2) throw new Error('label objects of at least two top-level classes (training role) first');
  const l1 = fitLevel(job, feats, train1, held1, null);

  // Level 2: one model per structural class with ≥ 2 labelled sub-classes.
  const sublevels: (LevelResult & { predict: (o: ObjectRecord) => number[] })[] = [];
  const skipped: ClassifyResult['skipped'] = [];
  for (const root of [...new Set((job.classes ?? []).filter(c => c.parent).map(c => paths.root(c.id)))].sort()) {
    const sub = (e: LabelEntry) => (paths.root(e.classId) === root ? paths.child(e.classId) : undefined);
    const train2 = rows('training', sub), held2 = rows('validation', sub);
    const n = new Set(train2.map(r => r.cls)).size;
    if (n < 2) { skipped.push({ parent: root, reason: n ? 'only one sub-class labelled' : 'no sub-class labelled' }); continue; }
    sublevels.push(fitLevel(job, feats, train2, held2, root));
  }

  const predictions: Prediction[] = job.objects.map(o => {
    const s1 = l1.predict(o), parent = l1.model.classes[argmax(s1)];
    const parentScores = Object.fromEntries(l1.model.classes.map((c, k) => [c, s1[k]]));
    const lv = sublevels.find(l => l.parent === parent);
    if (!lv) return { objectId: o.id, cls: parent, scores: parentScores, margin: scoreMargin(s1), parent, parentScores };
    const s2 = lv.predict(o);
    return { objectId: o.id, cls: lv.model.classes[argmax(s2)], scores: Object.fromEntries(lv.model.classes.map((c, k) => [c, s2[k]])), margin: scoreMargin(s2), parent, parentScores };
  });
  const strip = ({ predict: _p, ...rest }: LevelResult & { predict: unknown }) => { void _p; return rest; };
  return { ...strip(l1), sublevels: sublevels.map(strip), skipped, predictions };
}
