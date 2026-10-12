import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argmax, predictScores, scoreMargin, trainForest, fitImputer } from '../src/obia/rf.ts';
import { crossValidate, report, spatialFolds, groupKeys, type Row } from '../src/obia/validation.ts';
import { LabelStore, assignFromPolygons, type LabelEntry } from '../src/obia/labels.ts';
import { analysisGrid } from '../src/obia/grid.ts';
import { boxPolygon } from '../src/aoi.ts';

const rnd = (i: number, k = 0) => { const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return s - Math.floor(s); };

test('forest: separable classes are learned, seeded runs are identical, scores are vote shares', () => {
  const X: (number | null)[][] = [], y: string[] = [];
  for (let i = 0; i < 60; i++) { const a = i % 2; X.push([a * 10 + rnd(i), rnd(i, 1), i % 7 === 0 ? null : rnd(i, 2)]); y.push(a ? 'B' : 'A'); }
  const m1 = trainForest(X, y, ['f0', 'f1', 'f2'], { trees: 25, maxDepth: 8, minLeaf: 1, seed: 7 });
  const m2 = trainForest(X, y, ['f0', 'f1', 'f2'], { trees: 25, maxDepth: 8, minLeaf: 1, seed: 7 });
  assert.deepEqual(m1, m2, 'not deterministic');
  const s = predictScores(m1, [10.5, 0.5, null]);
  assert.equal(m1.classes[argmax(s)], 'B');
  assert.ok(Math.abs(s.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(scoreMargin(s) > 0.5);
  assert.ok(m1.importance[0] > m1.importance[1], 'the informative feature should matter most');
});

test('imputer: medians from the rows it is given only; an all-missing feature is reported', () => {
  const { medians, empty } = fitImputer([[1, null], [3, null], [5, null]], 2);
  assert.deepEqual(medians, [3, 0]);
  assert.deepEqual(empty, [1]);
});

/** Rows on a 400 m square: class by x half, one informative feature, centroids spread over 16 blocks. */
function rows(n = 80, coarse = false): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const cx = (i % 10) * 40 + 5, cy = Math.floor(i / 10) * 50 + 5, cls = cx < 200 ? 'A' : 'B';
    return { id: `o${i}`, cls, areaM2: 50 + (i % 3) * 25, cx, cy, x: [(cls === 'A' ? 0 : 5) + rnd(i) * 2, rnd(i, 3)], coarse: coarse ? Int32Array.of(Math.floor(cx / 400)) : null };
  });
}

test('folds: blocks group objects, a shared parent unions blocks, assignment is deterministic', () => {
  const r = rows();
  const f = spatialFolds(r, 100, 4);
  assert.equal(f.k, 4);
  assert.equal(f.blocks, 16);
  // Objects in one block share a fold.
  const byBlock = new Map<string, Set<number>>();
  r.forEach((o, i) => { const b = `${Math.floor(o.cx / 100)},${Math.floor(o.cy / 100)}`; (byBlock.get(b) ?? byBlock.set(b, new Set()).get(b)!).add(f.fold[i]); });
  for (const [, s] of byBlock) assert.equal(s.size, 1);
  assert.deepEqual(spatialFolds(r, 100, 4), f);
  // One parent over everything → one group → no CV, with the reason.
  const g = spatialFolds(rows().map(o => ({ ...o, parent: 'P' })), 100, 4);
  assert.equal(g.groups, 1);
  assert.ok(g.reason);
});

test('ACCEPTANCE 10 — leakage control: in every fold, no coarse pixel is shared by a training and a test object', async () => {
  const { trainForest } = await import('../src/obia/rf.ts');
  void trainForest;
  // Coarse "pixels" of 120 m straddle the 100 m blocks.
  const r = rows().map(o => ({ ...o, coarse: Int32Array.of(Math.floor(o.cx / 120) * 100 + Math.floor(o.cy / 120)) }));
  const f = spatialFolds(r, 100, 3);
  const cv = crossValidate(r, ['f0', 'noise'], [0, 1], f, groupKeys(r, 100), { trees: 5, maxDepth: 4, minLeaf: 1, seed: 1 });
  assert.ok(cv.buffered.some(n => n > 0), 'the buffer should have dropped someone');
  for (let k = 0; k < f.k; k++) {
    const testPx = new Set(r.filter((_, i) => f.fold[i] === k).flatMap(o => [...o.coarse!]));
    const others = r.filter((_, i) => f.fold[i] !== k);
    const kept = others.filter(o => ![...o.coarse!].some(u => testPx.has(u)));
    assert.equal(others.length - kept.length, cv.buffered[k]);
    for (const o of kept) for (const u of o.coarse!) assert.ok(!testPx.has(u));
  }
});

test('cross-validation and report: per-class metrics, area-weighted accuracy, suppression of thin classes', () => {
  const r = rows();
  const f = spatialFolds(r, 100, 4);
  const cv = crossValidate(r, ['f0', 'noise'], [0, 1], f, groupKeys(r, 100), { trees: 30, maxDepth: 8, minLeaf: 1, seed: 1 });
  assert.equal(cv.report.folds, 4);
  assert.ok(cv.report.accuracy! > 0.9, `accuracy ${cv.report.accuracy}`);
  assert.ok(cv.report.macroF1! > 0.9);
  assert.ok(cv.report.areaAccuracy !== null);
  const total = cv.report.confusion.flat().reduce((a, b) => a + b, 0);
  assert.equal(total, r.length);
  // A class with three objects is reported without metrics, and macro-F1 is suppressed when only one class is left.
  const thin: Row[] = [...r.filter(o => o.cls === 'A'), ...r.filter(o => o.cls === 'B').slice(0, 3)];
  const rep = report(thin, thin.map(o => o.cls), groupKeys(thin, 100), 4, 9);
  const b = rep.perClass.find(m => m.cls === 'B')!;
  assert.equal(b.f1, null);
  assert.match(b.suppressed!, /3 labelled objects/);
  assert.equal(rep.macroF1, null);
  // Fewer than two folds: nothing is reported.
  const none = report(r, r.map(o => o.cls), groupKeys(r, 100), 1, 1);
  assert.equal(none.accuracy, null);
  assert.ok(none.suppressed.length);
});

test('ACCEPTANCE 11 — ablation runs both feature sets on identical folds', () => {
  const r = rows();
  const f = spatialFolds(r, 100, 4), gk = groupKeys(r, 100);
  const a = crossValidate(r, ['f0', 'noise'], [1], f, gk, { trees: 20, maxDepth: 6, minLeaf: 1, seed: 1 });
  const b = crossValidate(r, ['f0', 'noise'], [0, 1], f, gk, { trees: 20, maxDepth: 6, minLeaf: 1, seed: 1 });
  assert.equal(a.report.nObjects, b.report.nObjects);
  assert.ok(b.report.macroF1! > (a.report.macroF1 ?? 0));
});

test('labels: undo/redo whole operations; roles are kept', () => {
  const s = new LabelStore();
  const e = (id: string, c: string): LabelEntry => ({ objectId: id, classId: c, role: 'training', source: 'manual', at: 't' });
  s.apply(['a', 'b'], id => e(id, 'x'));
  s.apply(['a'], () => null);
  assert.equal(s.labels.size, 1);
  s.undo();
  assert.equal(s.labels.size, 2);
  s.undo();
  assert.equal(s.labels.size, 0);
  s.redo();
  assert.equal(s.labels.get('a')?.classId, 'x');
  assert.ok(s.canRedo);
});

test('reference polygons: ≥ 80 % coverage labels; partial, mixed and conflicting coverage go to review', () => {
  // A 10 × 10 grid of 1 m cells; objects are the four 5 × 5 quadrants.
  const g = analysisGrid(boxPolygon([0, 0, 10, 10]), 32620, 1, 0);
  const labels = new Int32Array(100);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) labels[y * 10 + x] = (y < 5 ? 0 : 2) + (x < 5 ? 0 : 1);
  const ids = ['q0', 'q1', 'q2', 'q3'];
  // Grid rows run top-down from y = 10: quadrant 0 is x 0–5, y 5–10.
  const polys = [
    { id: 'p1', classId: 'forest', geometry: boxPolygon([0, 5, 5, 10]) },        // q0 fully
    { id: 'p2', classId: 'water', geometry: boxPolygon([5, 5, 8, 10]) },         // q1 at 60 %
    { id: 'p3', classId: 'forest', geometry: boxPolygon([0, 0, 3, 5]) },         // q2 forest 60 %…
    { id: 'p4', classId: 'herb', geometry: boxPolygon([3, 0, 5, 5]) },           // …and herb 40 %
    { id: 'p5', classId: 'herb', geometry: boxPolygon([5, 0, 10, 5]) },          // q3 herb
    { id: 'p6', classId: 'water', geometry: boxPolygon([9, 0, 10, 1]) },         // overlapping q3: conflict
  ];
  const r = assignFromPolygons(g, labels, ids, polys, 0.8, 'training', 't');
  assert.deepEqual(r.labels.map(l => [l.objectId, l.classId, l.coverage]), [['q0', 'forest', 1]]);
  const why = Object.fromEntries(r.review.map(v => [v.objectId, v.reason]));
  assert.match(why.q1, /60 % covered/);
  assert.match(why.q2, /more than one class/);
  assert.match(why.q3, /overlapping/);
});

test('classify: CV, ablation on identical folds, held-out validation never trained on', async () => {
  const { runClassify } = await import('../src/obia/classify.ts');
  const r = rows(100);
  const objects = r.map((o, i) => ({ id: o.id, index: i, segmentationVersion: 'v', areaM2: o.areaM2, cx: o.cx, cy: o.cy, featureValues: { f0: o.x[0], noise: o.x[1], s2_red: o.cls === 'A' ? 0.03 : 0.07 }, support: {}, flags: [] }));
  const defs = [
    { id: 'f0', group: 'rgb' }, { id: 'noise', group: 'structure' }, { id: 's2_red', group: 'sentinel' },
  ].map(d => ({ ...d, label: d.id, sourceIds: [], operation: '', parameters: {}, unit: '', sampling: 'fine-grid', useForSegmentation: false, useForClassification: true })) as never[];
  const labels = r.map((o, i) => ({ objectId: o.id, classId: o.cls, role: i % 10 === 0 ? 'validation' : 'training', source: 'manual', at: 't' })) as never[];
  const out = runClassify({ objects, featureDefs: defs, labels, groups: ['rgb', 'structure', 'sentinel'], blockM: 100, folds: 4, forest: { trees: 20, maxDepth: 6, minLeaf: 1, seed: 3 }, coarsePixels: null });
  assert.equal(out.trainedOn, 90);
  assert.ok(out.ablation);
  assert.equal(out.ablation.base.nObjects, out.ablation.withSentinel.nObjects);
  assert.deepEqual(out.ablation.sentinelFeatures, ['s2_red']);
  assert.ok(out.validation && out.validation.nObjects === 10);
  assert.equal(out.predictions.length, 100);
  for (const p of out.predictions) assert.ok(Math.abs(Object.values(p.scores).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});
