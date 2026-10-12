import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisGrid, gridIndexOf, gridXY, projector, projectPolygon, utmEpsgFor } from '../src/obia/grid.ts';
import { PRESETS, fnv1a64, recipeHash, stableStringify } from '../src/obia/recipe.ts';
import { minPatch, segment, segmentationChannels, srgbToLab } from '../src/obia/segment.ts';
import { areaWeighted, fineToNative, normalizedDifference, sclInvalid, type NativeRaster } from '../src/obia/sentinel.ts';
import { fineFeatures, bandIds } from '../src/obia/features.ts';
import { runObjects, type ObjectsJob } from '../src/obia/pipeline.ts';
import { fixtureScene } from '../src/obia/fixture.ts';
import { boxPolygon } from '../src/aoi.ts';

test('grid: UTM zone, snapped origin, corner convention, index of a coordinate', () => {
  assert.equal(utmEpsgFor(-63.6, 44.65, 'wgs84'), 32620);
  assert.equal(utmEpsgFor(-63.6, 44.65, 'csrs'), 2961);
  const p = projector(32620);
  const poly = projectPolygon(boxPolygon([-63.61, 44.64, -63.60, 44.65]), p);
  const g = analysisGrid(poly, 32620, 2, 10);
  assert.equal(g.transform[0] % 2, 0);
  assert.equal(g.transform[3] % 2, 0);
  assert.equal(g.transform[5], -2);
  // Pixel (3, 4)'s top-left corner, and a point inside it maps back to it.
  const [x, y] = gridXY(g, 3, 4);
  assert.equal(x, g.transform[0] + 6);
  assert.equal(y, g.transform[3] - 8);
  assert.equal(gridIndexOf(g, x + 1, y - 1), 4 * g.width + 3);
  assert.equal(gridIndexOf(g, x - 0.001, y - 1), 4 * g.width + 2);
  // Width × cell = extent.
  assert.equal(g.width * 2, g.bounds[2] - g.bounds[0]);
});

test('recipe: hash ignores key order, changes with any value', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(recipeHash({ a: 1, b: 2 }), recipeHash({ b: 2, a: 1 }));
  assert.notEqual(recipeHash({ a: 1 }), recipeHash({ a: 2 }));
  assert.equal(fnv1a64(''), 'cbf29ce484222325');
  assert.equal(PRESETS.length, 3);
});

test('Lab: white, black and a pure red', () => {
  const w = srgbToLab(255, 255, 255), k = srgbToLab(0, 0, 0), r = srgbToLab(255, 0, 0);
  assert.ok(Math.abs(w[0] - 100) < 0.01 && Math.abs(w[1]) < 0.01 && Math.abs(w[2]) < 0.01);
  assert.ok(Math.abs(k[0]) < 1e-9);
  assert.ok(Math.abs(r[0] - 53.24) < 0.05 && Math.abs(r[1] - 80.09) < 0.1 && Math.abs(r[2] - 67.2) < 0.1);
});

test('segmentation: deterministic, respects the mask, keeps a distinct small object, merges a similar one', () => {
  const f = fixtureScene();
  const ch = () => segmentationChannels(f.planes, f.w, f.h, f.cellM, f.params, f.mask);
  const a = segment(ch(), f.w, f.h, f.cellM, f.params, f.mask), b = segment(ch(), f.w, f.h, f.cellM, f.params, f.mask);
  assert.deepEqual(a.labels, b.labels, 'not deterministic');
  for (let i = 0; i < f.mask.length; i++) if (!f.mask[i]) assert.equal(a.labels[i], -1);
  // The fixture's 3 × 3 m pond (dark, water-coloured) is under the minimum patch but kept.
  const pondLabel = a.labels[f.pondIndex];
  assert.ok(pondLabel >= 0);
  assert.ok(a.flags[pondLabel].includes('below-min-patch'));
  // Objects never straddle the forest/meadow edge.
  const side = new Map<number, Set<boolean>>();
  for (let i = 0; i < a.labels.length; i++) { const k = a.labels[i]; if (k < 0 || i === f.pondIndex) continue; (side.get(k) ?? side.set(k, new Set()).get(k)!).add(f.isForest(i)); }
  let straddle = 0;
  for (const [, s] of side) if (s.size > 1) straddle++;
  assert.ok(straddle === 0, `${straddle} objects straddle the edge`);
});

test('min patch: a small region joins a similar neighbour, not a distinct one', () => {
  // 1 × 6 strip: [0 0 1 1 1 1] labels, feature equal on 0 and 1 → merges; distinct → stays.
  const lab = Int32Array.of(0, 0, 1, 1, 1, 1);
  assert.equal(minPatch(lab, 2, 6, 1, [Float32Array.of(0, 0, 0.1, 0.1, 0.1, 0.1)], 3, 1).count, 1);
  assert.equal(minPatch(lab, 2, 6, 1, [Float32Array.of(9, 9, 0, 0, 0, 0)], 3, 1).count, 2);
});

/** A 4 × 2 native raster of 10 m pixels, values 1…8, pixel 6 invalid. */
function native(): NativeRaster {
  const v = Float32Array.from({ length: 8 }, (_, i) => i + 1);
  v[5] = NaN;
  return { key: 't', epsg: 32620, originX: 500000, originY: 5000020, res: 10, w: 4, h: 2, values: { v } };
}

test('weighted sampling: full, partial, sub-pixel and missing pixels give the hand-computed statistics', () => {
  // Fine 2 m grid exactly over the native raster: 20 × 10 pixels.
  const r = native(), G = { w: 20, h: 10, x0: 500000, y0: 5000020, cellM: 2, epsg: 32620 };
  const { index, exact } = fineToNative(G, r);
  assert.ok(exact);
  const labels = new Int32Array(200).fill(-1);
  const set = (k: number, x0: number, x1: number, y0: number, y1: number) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) labels[y * 20 + x] = k; };
  set(0, 0, 5, 0, 5);      // exactly native pixel 0 (value 1)
  set(1, 5, 10, 0, 1);     // 5 × 1 fine px inside native pixel 1 (value 2): sub-pixel
  set(2, 8, 13, 5, 10);    // 2 × 5 in native 5 (value 6? no: row 1 → index 5 is NaN) and 3 × 5 in native 6 (value 7)
  set(3, 15, 20, 0, 10);   // native 3 (value 4) and native 7 (value 8), equal areas
  const s = areaWeighted(labels, 4, index, 4, r, ['v']);
  const m = s.v.mean, sp = s.v.support;
  assert.equal(m[0], 1); assert.equal(sp[0].validFraction, 1); assert.equal(sp[0].nativePixelCount, 1); assert.equal(sp[0].effectivePixelCount, 1);
  assert.equal(m[1], 2); assert.ok(sp[1].qualityFlags.includes('coarse-subpixel')); assert.ok(sp[1].qualityFlags.includes('coarse-mixed'));
  // Object 2: 10 fine px (40 m²) in the invalid pixel, 15 (60 m²) in value 7 → mean 7, valid 0.6.
  assert.equal(m[2], 7); assert.ok(Math.abs(sp[2].validFraction - 0.6) < 1e-12); assert.equal(sp[2].nativePixelCount, 2); assert.equal(sp[2].effectivePixelCount, 1);
  // Object 3: two equal halves → mean 6, nEff = (50+50)² / (50² + 50²) = 2.
  assert.equal(m[3], 6); assert.equal(sp[3].effectivePixelCount, 2); assert.equal(sp[3].nativePixelCount, 2);
});

test('weighted sampling: an object over no valid pixel is missing, not zero', () => {
  const r = native(); r.values.v.fill(NaN);
  const G = { w: 20, h: 10, x0: 500000, y0: 5000020, cellM: 2, epsg: 32620 };
  const labels = new Int32Array(200).fill(0);
  const s = areaWeighted(labels, 1, fineToNative(G, r).index, 4, r, ['v']);
  assert.ok(Number.isNaN(s.v.mean[0]));
  assert.ok(s.v.support[0].qualityFlags.includes('coarse-no-valid'));
});

test('indices and SCL masking', () => {
  const nd = normalizedDifference(Float32Array.of(0.4, NaN, 0), Float32Array.of(0.1, 0.2, 0));
  assert.ok(Math.abs(nd[0] - 0.6) < 1e-6); assert.ok(Number.isNaN(nd[1])); assert.ok(Number.isNaN(nd[2]));
  // 3 × 3 SCL with a cloud (9) in the centre, dilated by one → all invalid; vegetation (4) alone stays valid.
  const scl = Float32Array.of(4, 4, 4, 4, 9, 4, 4, 4, 4);
  assert.deepEqual([...sclInvalid(scl, 3, 3, [0, 1, 3, 8, 9, 10, 11], 0)], [0, 0, 0, 0, 1, 0, 0, 0, 0]);
  assert.equal(sclInvalid(scl, 3, 3, [9], 1).reduce((a, b) => a + b, 0), 9);
});

test('features: CHM band shares use valid CHM cells as the denominator; missing is null', () => {
  const w = 4, h = 1;
  const labels = Int32Array.of(0, 0, 0, 0);
  const chm = Float32Array.of(1, 3, 10, NaN);
  const [o] = fineFeatures({ labels, count: 1, w, h, cellM: 1, x0: 0, y0: 0, planes: { chm }, heightBandsM: [0.5, 2, 8], segmentationVersion: 'v', flags: [[]], sources: { rgb: null, chm: 'c', dtm: null } });
  const ids = bandIds([0.5, 2, 8]).map(b => b.id);
  assert.deepEqual(ids, ['chm_frac_0p5_2', 'chm_frac_2_8', 'chm_frac_8_up']);
  assert.ok(Math.abs((o.featureValues.chm_frac_0p5_2 as number) - 1 / 3) < 1e-12);
  assert.ok(Math.abs((o.featureValues.chm_frac_8_up as number) - 1 / 3) < 1e-12);
  assert.equal(o.support.structure.validFraction, 0.75);
  assert.equal(o.areaM2, 4);
  assert.equal(o.featureValues.rgb_r, undefined);
});

test('ACCEPTANCE 2 — Sentinel independence: changing Sentinel values leaves the segmentation identical', () => {
  const f = fixtureScene();
  const job = (scale: number): ObjectsJob => ({
    grid: { w: f.w, h: f.h, x0: f.x0, y0: f.y0, cellM: f.cellM, epsg: f.epsg }, planes: f.planes, mask: f.mask, params: f.params,
    windowEdge: false, heightBandsM: [0.5, 2, 8], segmentationVersion: 'v', sources: { rgb: 'rgb', chm: 'chm', dtm: null },
    sentinel: { ...f.sentinel, rasters: f.sentinel.rasters.map(r => ({ ...r, values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, k === 'scl' ? v : v.map(x => x * scale)])) })) },
  });
  const a = runObjects(job(1)), b = runObjects(job(3)), c = runObjects({ ...job(1), sentinel: null });
  assert.deepEqual(a.labels, b.labels);
  assert.deepEqual(a.labels, c.labels);
  assert.notEqual(a.objects[0].featureValues.s2_red, b.objects[0].featureValues.s2_red);
  // Sentinel features carry native support and are never segmentation inputs.
  for (const d of a.featureDefs.filter(d => d.group === 'sentinel')) {
    assert.equal(d.useForSegmentation, false);
    assert.equal(d.sampling, 'native-area-weighted');
    assert.ok(d.effectiveSupportM === 10 || d.effectiveSupportM === 20);
  }
  assert.ok(a.coarsePixels && a.coarsePixels.length === a.count);
  assert.equal(a.sentinelExact, true);
});

test('ACCEPTANCE 6 — determinism: the whole objects stage reproduces exactly', () => {
  const f = fixtureScene();
  const job: ObjectsJob = { grid: { w: f.w, h: f.h, x0: f.x0, y0: f.y0, cellM: f.cellM, epsg: f.epsg }, planes: f.planes, mask: f.mask, params: f.params, windowEdge: false, heightBandsM: [0.5, 2, 8], segmentationVersion: 'v', sources: { rgb: 'rgb', chm: 'chm', dtm: null }, sentinel: f.sentinel };
  const a = runObjects(job), b = runObjects(job);
  assert.deepEqual(a.labels, b.labels);
  assert.deepEqual(a.objects.map(o => o.featureValues), b.objects.map(o => o.featureValues));
});
