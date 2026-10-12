// The CLASSIFICATION stage as one pure function (run in the OBIA worker):
// spatial cross-validation of the selected predictor groups, the ablation
// RGB + LiDAR against RGB + LiDAR + Sentinel on the SAME folds, a final model
// on every training label, predictions for every object, and a report on the
// held-out validation labels when there are any. test/obiaModel.test.ts.

import { DEFAULT_FOREST, argmax, predictScores, scoreMargin, trainForest, type Forest, type ForestOptions } from './rf.ts';
import { crossValidate, groupKeys, report, spatialFolds, type CvResult, type Report, type Row } from './validation.ts';
import type { LabelEntry } from './labels.ts';
import type { FeatureDefinition, FeatureGroup, ObjectRecord } from './types.ts';

export interface ClassifyJob {
  objects: ObjectRecord[];
  featureDefs: FeatureDefinition[];
  labels: LabelEntry[];
  groups: FeatureGroup[];
  blockM: number;
  folds: number;
  forest: ForestOptions;
  /** Per object index, coarsest native pixel ids (leakage control); null without Sentinel. */
  coarsePixels: (ArrayLike<number> | null)[] | null;
}

export interface Prediction { objectId: string; cls: string; scores: Record<string, number>; margin: number }

export interface ClassifyResult {
  features: string[];
  model: Forest;
  cv: { report: Report; folds: number; groups: number; blocks: number; reason?: string; buffered: number[] } | null;
  ablation: { base: Report; withSentinel: Report; baseFeatures: string[]; sentinelFeatures: string[] } | null;
  validation: Report | null;
  predictions: Prediction[];
  trainedOn: number;
}

export function runClassify(job: ClassifyJob): ClassifyResult {
  const feats = job.featureDefs.filter(d => d.useForClassification && job.groups.includes(d.group)).map(d => d.id);
  if (!feats.length) throw new Error('no predictor group selected');
  const byId = new Map(job.objects.map(o => [o.id, o]));
  const rowOf = (e: LabelEntry): Row | null => {
    const o = byId.get(e.objectId);
    if (!o) return null;
    return { id: o.id, cls: e.classId, areaM2: o.areaM2, cx: o.cx, cy: o.cy, x: feats.map(f => o.featureValues[f] ?? null), coarse: job.coarsePixels?.[o.index] ?? null };
  };
  const usable = job.labels.filter(e => !e.pending);
  const train = usable.filter(e => e.role === 'training').map(rowOf).filter((r): r is Row => r !== null);
  const held = usable.filter(e => e.role === 'validation').map(rowOf).filter((r): r is Row => r !== null);
  if (new Set(train.map(r => r.cls)).size < 2) throw new Error('label objects of at least two classes (training role) first');
  const opts = { ...DEFAULT_FOREST, ...job.forest };

  // Cross-validation on spatial folds.
  const folds = spatialFolds(train, job.blockM, job.folds);
  const gk = groupKeys(train, job.blockM);
  let cv: ClassifyResult['cv'] = null, ablation: ClassifyResult['ablation'] = null;
  const all = feats.map((_, j) => j);
  const res: CvResult = crossValidate(train, feats, all, folds, gk, opts);
  cv = { report: res.report, folds: folds.k, groups: folds.groups, blocks: folds.blocks, reason: folds.reason, buffered: res.buffered };
  const sentinelSet = new Set(job.featureDefs.filter(d => d.group === 'sentinel').map(d => d.id));
  const baseIdx = all.filter(j => !sentinelSet.has(feats[j]));
  if (folds.k >= 2 && baseIdx.length && baseIdx.length < all.length) {
    const base = crossValidate(train, feats, baseIdx, folds, gk, opts);
    ablation = { base: base.report, withSentinel: res.report, baseFeatures: baseIdx.map(j => feats[j]), sentinelFeatures: feats.filter(f => sentinelSet.has(f)) };
  }

  // The final model on every training label.
  const model = trainForest(train.map(r => r.x), train.map(r => r.cls), feats, opts);
  const predictions: Prediction[] = job.objects.map(o => {
    const s = predictScores(model, feats.map(f => o.featureValues[f] ?? null));
    return { objectId: o.id, cls: model.classes[argmax(s)], scores: Object.fromEntries(model.classes.map((c, k) => [c, s[k]])), margin: scoreMargin(s) };
  });
  let validation: Report | null = null;
  if (held.length) {
    const pred = held.map(r => predictions.find(p => p.objectId === r.id)!.cls);
    const hg = groupKeys(held, job.blockM);
    validation = report(held, pred, hg, 0, new Set(hg).size, true);
  }
  return { features: feats, model, cv, ablation, validation, predictions, trainedOn: train.length };
}
