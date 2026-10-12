import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromArrayBuffer } from 'geotiff';
import { writeGeoTiff } from '../src/obia/geotiffWrite.ts';
import { analysisGrid } from '../src/obia/grid.ts';
import { boxPolygon } from '../src/aoi.ts';

test('ACCEPTANCE 5/14 — GeoTIFF: segment ids read back exactly, with origin, pixel size and EPSG', async () => {
  const g = analysisGrid(boxPolygon([454000, 4945000, 454037, 4945013]), 32620, 1, 0);
  const ids = Int32Array.from({ length: g.width * g.height }, (_, i) => (i % 7 === 0 ? -1 : i));
  const buf = writeGeoTiff(g, ids, { nodata: -1, description: 'segment ids' });
  const tiff = await fromArrayBuffer(buf);
  const im = await tiff.getImage();
  assert.equal(im.getWidth(), g.width);
  assert.equal(im.getHeight(), g.height);
  assert.deepEqual(im.getOrigin()!.slice(0, 2), [g.transform[0], g.transform[3]]);
  assert.deepEqual(im.getResolution()!.slice(0, 2), [1, -1]);
  assert.equal(im.getGeoKeys()!.ProjectedCSTypeGeoKey, 32620);
  assert.equal(im.getGeoKeys()!.GTRasterTypeGeoKey, 1, 'PixelIsArea');
  assert.equal(im.getGDALNoData(), -1);
  const [band] = await im.readRasters() as unknown as Int32Array[];
  assert.deepEqual(Array.from(band), Array.from(ids));
});

test('GeoTIFF: a multi-strip UInt8 class raster reads back', async () => {
  const g = analysisGrid(boxPolygon([0, 0, 300, 400]), 32620, 1, 0);
  const cls = Uint8Array.from({ length: g.width * g.height }, (_, i) => i % 5);
  const im = await (await fromArrayBuffer(writeGeoTiff(g, cls, { nodata: 0 }))).getImage();
  const [band] = await im.readRasters() as unknown as Uint8Array[];
  assert.equal(band.length, cls.length);
  assert.equal(band[123457], cls[123457]);
  assert.equal(band[cls.length - 1], cls[cls.length - 1]);
});

import { fixtureScene } from '../src/obia/fixture.ts';
import { runObjects } from '../src/obia/pipeline.ts';
import { classRaster, dissolvedGeoJSON, featuresCsv, fromBundle, objectsGeoJSON, rle, toBundle, unrle, PROJECT_SCHEMA, type ObiaProject } from '../src/obia/project.ts';
import { projector } from '../src/obia/grid.ts';
import { DEFAULT_SENTINEL, OBIA_ALGORITHM_VERSION, REFERENCE_SCALES } from '../src/obia/recipe.ts';
import { DEFAULT_CLASSES } from '../src/obia/labels.ts';

function fixtureProject(): ObiaProject {
  const f = fixtureScene();
  const r = runObjects({ grid: { w: f.w, h: f.h, x0: f.x0, y0: f.y0, cellM: f.cellM, epsg: f.epsg }, planes: f.planes, mask: f.mask, params: { ...f.params, mergeSimilarity: 0 }, windowEdge: false, heightBandsM: [0.5, 2, 8], segmentationVersion: 'seg1', sources: { rgb: 'rgb', chm: 'chm', dtm: null }, sentinel: f.sentinel });
  const grid = { crs: 'EPSG:32620', epsg: 32620, cellM: 1, transform: [f.x0, 1, 0, f.y0, 0, -1] as [number, number, number, number, number, number], width: f.w, height: f.h, pixelConvention: 'area' as const, bounds: [f.x0, f.y0 - f.h, f.x0 + f.w, f.y0] as [number, number, number, number] };
  r.objects.forEach((o, i) => { o.predictedClass = i % 2 ? 'forest' : 'herb'; o.classScores = { forest: 0.7, herb: 0.3 }; });
  return {
    schema: PROJECT_SCHEMA, created: 't', updated: 't',
    recipe: { algorithm: OBIA_ALGORITHM_VERSION, aoi: { id: 'a', name: 'Fixture', geometry: boxPolygon([0, 0, 1, 1]) }, objective: 'fine-patches', epsg: 32620, cellM: 1, bufferM: 0, segment: f.params, referenceScales: REFERENCE_SCALES, sources: { rgb: 'rgb', chm: 'chm', dtm: null, sentinel: 's2' }, sourceVersions: {}, sentinel: { itemId: 'x', ...DEFAULT_SENTINEL }, heightBandsM: [0.5, 2, 8] },
    recipeHash: 'h', segmentationVersion: 'seg1', sources: [], grid, crsDefinition: projector(32620).def,
    labels: r.labels, count: r.count, objects: r.objects, featureDefs: r.featureDefs, coarsePixels: r.coarsePixels,
    classes: DEFAULT_CLASSES, labelEntries: [{ objectId: r.objects[0].id, classId: 'herb', role: 'training', source: 'manual', at: 't' }], references: [], model: null, classification: null, measured: {},
  };
}

test('RLE round-trips a label raster', () => {
  const a = Int32Array.of(-1, -1, 0, 0, 0, 1, -1, 2, 2);
  assert.deepEqual(unrle(rle(a), a.length), a);
});

test('ACCEPTANCE 5/9/14 — bundle reload preserves labels, objects, ids, CRS; exported ids, areas and geometry agree', () => {
  const p = fixtureProject();
  const q = fromBundle(toBundle(p));
  assert.deepEqual(q.labels, p.labels);
  assert.deepEqual(q.objects, p.objects);
  assert.deepEqual(q.labelEntries, p.labelEntries);
  assert.deepEqual(q.grid, p.grid);
  assert.deepEqual(q.coarsePixels, p.coarsePixels);
  assert.equal(JSON.parse(toBundle(p)).manifest.analysisCrs.code, 'EPSG:32620');
  const proj = projector(32620);
  const fc = objectsGeoJSON(q, proj);
  assert.equal(fc.features.length, q.count);
  // Every exported polygon's area (re-projected to UTM) equals its object's pixel area.
  for (const ft of fc.features) {
    const o = q.objects.find(x => x.id === ft.id)!;
    const polys = ft.geometry.type === 'Polygon' ? [ft.geometry.coordinates] : (ft.geometry as GeoJSON.MultiPolygon).coordinates;
    const ringAreaUtm = (r: number[][]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return a / 2; };
    const utm = polys.reduce((s, poly) => s + poly.reduce((t, ring, k) => t + (k ? -1 : 1) * Math.abs(ringAreaUtm(ring.map(c => proj.forward([c[0], c[1]])))), 0), 0);
    assert.ok(Math.abs(utm - o.areaM2) < 0.01 * o.areaM2 + 0.5, `object ${o.id}: polygon ${utm} vs ${o.areaM2}`);
    assert.equal(ft.properties!.area_m2, o.areaM2);
  }
  const csv = featuresCsv(q).split('\n');
  assert.equal(csv.length, q.count + 1);
  assert.ok(csv[0].startsWith('object_id,'));
  const diss = dissolvedGeoJSON(q, proj);
  assert.deepEqual(diss.features.map(f => f.properties!.class), ['forest', 'herb']);
  const cr = classRaster(q);
  assert.equal(cr.data.length, q.labels.length);
  for (let i = 0; i < q.labels.length; i++) if (q.labels[i] < 0) assert.equal(cr.data[i], 0);
});

test('ACCEPTANCE 1/4 — Sentinel support survives export and reload; no fine Sentinel plane exists', () => {
  const p = fromBundle(toBundle(fixtureProject()));
  const s2 = p.featureDefs.filter(d => d.group === 'sentinel');
  assert.ok(s2.length >= 6);
  for (const d of s2) { assert.equal(d.sampling, 'native-area-weighted'); assert.ok(d.effectiveSupportM! >= 10); }
  assert.ok(p.objects.every(o => o.support.sentinel_10m && o.support.sentinel_20m));
  const props = objectsGeoJSON(p, projector(32620)).features[0].properties!;
  assert.ok('support_sentinel_10m_n_eff' in props && 'support_sentinel_20m_valid' in props);
});
