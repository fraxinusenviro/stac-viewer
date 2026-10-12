import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureScene } from '../src/obia/fixture.ts';
import { runObjects, type ObjectsJob } from '../src/obia/pipeline.ts';
import { returnsStats, type ReturnsInput } from '../src/obia/returns.ts';
import { areaWeighted, type NativeRaster } from '../src/obia/sentinel.ts';

const f = fixtureScene();
const job = (returns: ReturnsInput | null): ObjectsJob => ({
  grid: { w: f.w, h: f.h, x0: f.x0, y0: f.y0, cellM: f.cellM, epsg: f.epsg }, planes: f.planes, mask: f.mask, params: { ...f.params, mergeSimilarity: 0 },
  windowEdge: false, heightBandsM: [0.5, 2, 8], segmentationVersion: 'v', sources: { rgb: 'rgb', chm: 'chm', dtm: null }, sentinel: null, sentinelB: null, returns,
});
const run = runObjects(job(f.returns));
const coverOfObject = (() => {
  const votes = new Map<number, Map<string, number>>();
  for (let i = 0; i < run.labels.length; i++) { const k = run.labels[i]; if (k < 0) continue; const m = votes.get(k) ?? votes.set(k, new Map()).get(k)!; const c = f.coverOf(i); m.set(c, (m.get(c) ?? 0) + 1); }
  return (k: number) => [...votes.get(k)!].sort((a, b) => b[1] - a[1])[0][0];
})();
const mean = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)); return v.reduce((a, b) => a + b, 0) / v.length; };
const by = (cover: string, id: string) => mean(run.objects.filter(o => coverOfObject(o.index) === cover).map(o => o.featureValues[id]));

test('area-weighted spread: two cells, weighted by the area in each', () => {
  const r: NativeRaster = { key: 'r', epsg: 1, originX: 0, originY: 2, res: 1, w: 2, h: 1, values: { v: Float32Array.of(10, 20) } };
  // One object, three fine pixels in cell 0 and one in cell 1 (fine cell 0.5 m).
  const labels = Int32Array.of(0, 0, 0, 0), idx = Int32Array.of(0, 0, 0, 1);
  const s = areaWeighted(labels, 1, idx, 0.25, r, ['v']).v;
  assert.ok(Math.abs(s.mean[0] - 12.5) < 1e-6);
  assert.ok(Math.abs(s.sd[0] - Math.sqrt(0.75 * 2.5 ** 2 + 0.25 * 7.5 ** 2)) < 1e-5);
});

test('LiDAR returns: native-support definitions, group, survey density not a predictor', () => {
  const d = run.featureDefs.find(x => x.id === 'pc_ivg')!;
  assert.equal(d.group, 'returns');
  assert.equal(d.sampling, 'native-area-weighted');
  assert.equal(d.effectiveSupportM, 2);
  assert.equal(run.featureDefs.find(x => x.id === 'pc_den')!.useForClassification, false);
  assert.ok(run.featureDefs.some(x => x.id === 'pc_ivg_sd'));
  assert.equal(run.returnsExact, true);
});

test('LiDAR returns separate the covers the way the laser sees them', () => {
  assert.ok(by('broadleaf', 'pc_ivg') > by('conifer', 'pc_ivg') + 40);
  assert.ok(by('conifer', 'pc_att') > by('broadleaf', 'pc_att'));
  assert.ok(by('lichen', 'pc_igr') > by('ericaceous', 'pc_igr') + 50);
  // No canopy, no vegetation intensity: missing, never zero.
  assert.ok(run.objects.filter(o => coverOfObject(o.index) === 'graminoid').every(o => o.featureValues.pc_ivg === null));
  const o = run.objects.find(x => coverOfObject(x.index) === 'conifer' && x.areaM2 > 40)!;
  const sup = o.support.returns_2m;
  assert.ok(sup.validFraction > 0.9 && (sup.pointCount ?? 0) > 0);
});

test('returns never touch the segmentation; the conifer score uses the laser', () => {
  assert.deepEqual(runObjects(job(null)).labels, run.labels);
  assert.ok(run.coniferScore.terms.some(t => t.id === 'pc_ivg'));
  assert.ok(by('conifer', 'conifer_score') > by('broadleaf', 'conifer_score'));
});

test('several acquisitions: intensity flagged as not comparable on every object', () => {
  const r = runObjects(job({ ...f.returns, acquisitions: ['a', 'b'] }));
  assert.ok(r.objects.every(o => o.support.returns_2m.qualityFlags.includes('returns-multiple-acquisitions')));
  assert.deepEqual(r.featureDefs.find(x => x.id === 'pc_int')!.parameters.acquisitions, ['a', 'b']);
});

test('a raster in another CRS is intersected through the projection', () => {
  const objs = run.objects.map(o => ({ ...o, featureValues: {} as Record<string, number | null>, support: {}, flags: [] as string[] }));
  const shifted = { ...f.returns, raster: { ...f.returns.raster, epsg: 2961 } };
  const res = returnsStats({ w: f.w, h: f.h, x0: f.x0, y0: f.y0, cellM: 1, epsg: f.epsg }, run.labels, run.count, objs, shifted, p => p);
  assert.equal(res.exact, false);
  assert.ok(objs.some(o => typeof o.featureValues.pc_int === 'number'));
});
