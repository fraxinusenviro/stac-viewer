import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureReferences, fixtureScene } from '../src/obia/fixture.ts';
import { runObjects, type ObjectsJob } from '../src/obia/pipeline.ts';
import { runClassify, classPaths } from '../src/obia/classify.ts';
import { assignFromPolygons, DEFAULT_CLASSES, STRUCTURE_CLASSES, withComposition } from '../src/obia/labels.ts';
import { scoreConifer } from '../src/obia/composition.ts';
import { projector, projectPolygon } from '../src/obia/grid.ts';

const f = fixtureScene();
const job = (withB = true): ObjectsJob => ({
  grid: { w: f.w, h: f.h, x0: f.x0, y0: f.y0, cellM: f.cellM, epsg: f.epsg }, planes: f.planes, mask: f.mask, params: { ...f.params, mergeSimilarity: 0 },
  windowEdge: false, heightBandsM: [0.5, 2, 8], segmentationVersion: 'v', sources: { rgb: 'rgb', chm: 'chm', dtm: null }, sentinel: f.sentinel, sentinelB: withB ? f.sentinelB : null,
});
const run = runObjects(job());
/** Each object's dominant fixture cover, by its pixels. */
const coverOfObject = (() => {
  const votes = new Map<number, Map<string, number>>();
  for (let i = 0; i < run.labels.length; i++) { const k = run.labels[i]; if (k < 0) continue; const m = votes.get(k) ?? votes.set(k, new Map()).get(k)!; const c = f.coverOf(i); m.set(c, (m.get(c) ?? 0) + 1); }
  return (k: number) => [...votes.get(k)!].sort((a, b) => b[1] - a[1])[0][0];
})();
const mean = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)); return v.reduce((a, b) => a + b, 0) / v.length; };
const by = (cover: string, id: string) => mean(run.objects.filter(o => coverOfObject(o.index) === cover).map(o => o.featureValues[id]));

test('crown shape: cone crowns have sharper apices than domes', () => {
  assert.ok(by('conifer', 'chm_apex') > 2 * by('broadleaf', 'chm_apex'), `${by('conifer', 'chm_apex')} vs ${by('broadleaf', 'chm_apex')}`);
  assert.ok(by('conifer', 'chm_tops_ha') > by('broadleaf', 'chm_tops_ha'));
  assert.ok(by('conifer', 'chm_rumple') > by('broadleaf', 'chm_rumple'));
});

test('colour composition: lichen is pale grey, ericaceous heath reddish', () => {
  assert.ok(by('lichen', 'rgb_pale_frac') > 0.9 && by('graminoid', 'rgb_pale_frac') < 0.1);
  assert.ok(by('ericaceous', 'rgb_red_frac') > 0.9 && by('graminoid', 'rgb_red_frac') < 0.1);
  assert.ok(by('lichen', 'lab_chroma') < by('graminoid', 'lab_chroma'));
});

test('second date: Δ NDVI is large for broadleaf and graminoid, small for conifer and lichen; definitions carry native support', () => {
  assert.ok(by('broadleaf', 'd_ndvi') > 0.2 && by('graminoid', 'd_ndvi') > 0.2);
  assert.ok(Math.abs(by('conifer', 'd_ndvi')) < 0.1 && Math.abs(by('lichen', 'd_ndvi')) < 0.05);
  const d = run.featureDefs.find(x => x.id === 'd_ndvi')!;
  assert.equal(d.sampling, 'native-area-weighted');
  assert.equal(d.effectiveSupportM, 10);
  assert.ok(run.featureDefs.some(x => x.id === 's2b_ndre') && run.featureDefs.some(x => x.id === 's2_ndre'));
  // The second date never touches the segmentation.
  assert.deepEqual(runObjects(job(false)).labels, run.labels);
});

test('conifer score: conifer stands score above broadleaf; the split is bimodal; non-woody objects are unscored', () => {
  const r = run.coniferScore;
  assert.ok(!r.reason, r.reason);
  assert.ok(r.bimodality! > 0.555, `bimodality ${r.bimodality}`);
  assert.ok(by('conifer', 'conifer_score') > r.threshold! && by('broadleaf', 'conifer_score') < r.threshold!);
  assert.ok(run.objects.filter(o => coverOfObject(o.index) === 'graminoid').every(o => o.featureValues.conifer_score === null));
  // Too few woody objects: no score, a reason.
  const few = scoreConifer(run.objects.slice(0, 3).map(o => ({ ...o, featureValues: { ...o.featureValues } })));
  assert.ok(few.reason);
});

test('class tree: paths, and adding composition classes to an older flat schema', () => {
  const p = classPaths(DEFAULT_CLASSES);
  assert.equal(p.root('forest-conifer'), 'forest');
  assert.equal(p.child('forest-conifer'), 'forest-conifer');
  assert.equal(p.root('forest'), 'forest');
  assert.equal(p.child('forest'), undefined);
  assert.equal(withComposition(STRUCTURE_CLASSES).length, DEFAULT_CLASSES.length);
  assert.equal(withComposition(DEFAULT_CLASSES).length, DEFAULT_CLASSES.length);
});

test('hierarchical classification: structure, then composition within forest and low vegetation; shrub skipped with a reason', () => {
  const proj = projector(f.epsg);
  const grid = { crs: 'EPSG:32620', epsg: 32620, cellM: 1, transform: [f.x0, 1, 0, f.y0, 0, -1] as [number, number, number, number, number, number], width: f.w, height: f.h, pixelConvention: 'area' as const, bounds: [f.x0, f.y0 - f.h, f.x0 + f.w, f.y0] as [number, number, number, number] };
  const polys = fixtureReferences().features.map((ft, i) => ({ id: String(i), classId: String(ft.properties!.class), geometry: projectPolygon(ft.geometry as GeoJSON.Polygon, proj) }));
  const a = assignFromPolygons(grid, run.labels, run.objects.map(o => o.id), polys, 0.8, 'training', 't');
  assert.ok(a.labels.length > 100);
  const res = runClassify({ objects: run.objects, featureDefs: run.featureDefs, labels: a.labels, classes: DEFAULT_CLASSES, groups: ['rgb', 'structure', 'geometry', 'sentinel', 'index'], blockM: 60, folds: 4, forest: { trees: 40, maxDepth: 12, minLeaf: 1, seed: 5 }, coarsePixels: run.coarsePixels });
  assert.deepEqual(res.model.classes, ['forest', 'herb', 'water']);
  assert.deepEqual(res.sublevels.map(l => l.parent), ['forest', 'herb']);
  assert.deepEqual(res.sublevels[0].model.classes, ['forest-broadleaf', 'forest-conifer']);
  assert.deepEqual(res.sublevels[1].model.classes, ['herb-ericaceous', 'herb-graminoid', 'herb-lichen']);
  assert.ok(res.skipped.some(s => s.parent === 'shrub'));
  for (const lv of res.sublevels) assert.ok((lv.cv?.report.macroF1 ?? 0) > 0.8, `${lv.parent} macro-F1 ${lv.cv?.report.macroF1}`);
  // Predictions: deepest class, with the structural parent beside it.
  const byCover = (cover: string) => res.predictions.filter((_, k) => coverOfObject(run.objects[k].index) === cover);
  const share = (cover: string, cls: string) => byCover(cover).filter(p => p.cls === cls).length / byCover(cover).length;
  assert.ok(share('conifer', 'forest-conifer') > 0.9 && share('broadleaf', 'forest-broadleaf') > 0.9);
  assert.ok(share('lichen', 'herb-lichen') > 0.8 && share('ericaceous', 'herb-ericaceous') > 0.8 && share('graminoid', 'herb-graminoid') > 0.8);
  for (const p of res.predictions) if (p.cls.includes('-')) assert.equal(classPaths(DEFAULT_CLASSES).root(p.cls), p.parent);
});
