import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FUSION_PRODUCTS, FUSION_VARIABLES, IMAGERY_PRODUCTS, INDICES, RASTER_PRODUCTS,
  customFusionProduct, needsLeafOff, variableById, defaultStyle, hasCurve, hasStretch, rasterProductsFor, seedRanges, type Planes,
} from '../src/products.ts';

const planes = (o: Record<string, number[]>): Planes => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Float32Array.from(v)]));

test('raster products: DTM and DSM in three renderings, plus the CHM', () => {
  assert.deepEqual(RASTER_PRODUCTS.map(p => p.label), [
    'DTM hillshade', 'DTM elevation', 'DTM shaded elevation',
    'DSM hillshade', 'DSM elevation', 'DSM shaded elevation',
    'Canopy height model (DSM − DTM)',
  ]);
  assert.ok(rasterProductsFor({ dsm: null }).every(p => !p.inputs.includes('lidar:dsm')), 'no DSM, no DSM or CHM');
  assert.equal(rasterProductsFor({ dsm: 'x' }).length, 7);
});

test('the CHM is DSM − DTM, floored at 0, and missing where either is', () => {
  const chm = RASTER_PRODUCTS.find(p => p.id === 'chm')!;
  const p = planes({ 'lidar:dsm': [30, 10, NaN], 'lidar:dtm': [12, 10.4, 5] });
  const s = defaultStyle(chm);
  assert.equal(chm.channels[0].fn(p, 0, s), 18);
  assert.equal(chm.channels[0].fn(p, 1, s), 0);
  assert.ok(Number.isNaN(chm.channels[0].fn(p, 2, s)));
});

test('indices are computed on reflectance and clamped to −1..1', () => {
  const ndvi = IMAGERY_PRODUCTS.find(p => p.id === 'ndvi')!;
  const p = planes({ 's2:nir': [0.5, 0.2, NaN], 's2:red': [0.1, 0.2, 0.1] });
  const s = defaultStyle(ndvi);
  assert.ok(Math.abs(ndvi.channels[0].fn(p, 0, s) - 0.6667) < 1e-3);
  assert.equal(ndvi.channels[0].fn(p, 1, s), 0);
  assert.ok(Number.isNaN(ndvi.channels[0].fn(p, 2, s)));
  // Dark water after correction: a negative reflectance reads as 0, and bands too dark to carry a ratio give no index — never NDVI = 1.
  assert.ok(Number.isNaN(ndvi.channels[0].fn(planes({ 's2:nir': [0.004], 's2:red': [-0.002] }), 0, s)));
  const ndwi = IMAGERY_PRODUCTS.find(p => p.id === 'ndwi')!;
  assert.equal(ndwi.channels[0].fn(planes({ 's2:green': [0.03], 's2:nir': [-0.003] }), 0, s), 1, 'water with a negative NIR is as watery as NDWI gets');
  const evi = INDICES.find(x => x.id === 'evi')!;
  assert.ok(Math.abs(evi.value({ nir: 0.5, red: 0.1, blue: 0.05 }) - 2.5 * 0.4 / (0.5 + 0.6 - 0.375 + 1)) < 1e-9);
});

test('every product reads only the inputs it declares', () => {
  const all = [...IMAGERY_PRODUCTS, ...RASTER_PRODUCTS, ...FUSION_PRODUCTS, customFusionProduct(['chm', 'evi', 'swir22']), customFusionProduct(['s_ndvi', 's_d_ndvi', 'ci'])];
  for (const prod of all) {
    const sharp = new Set((prod.sharpen?.keys ?? []).map(k => `u:${k}`));
    const p: Planes = new Proxy({}, { get: (_, k) => { assert.ok(prod.inputs.includes(String(k)) || sharp.has(String(k)), `${prod.id} read undeclared ${String(k)}`); return Float32Array.of(0.2); } });
    for (const c of prod.channels) c.fn(p, 0, defaultStyle(prod));
  }
});

test('seedRanges: fixed seeds stay, percentiles fill the rest, CHM starts at 0', () => {
  const chm = RASTER_PRODUCTS.find(p => p.id === 'chm')!;
  assert.deepEqual(seedRanges(chm, [[0, 1]], [{ p2: 3, p98: 22 }]), [[0, 22]]);
  const nat = IMAGERY_PRODUCTS.find(p => p.id === 'natural')!;
  assert.deepEqual(seedRanges(nat, [[0, 1], [0, 1], [0, 1]], [{ p2: 0.01, p98: 0.2 }, null, { p2: 0.02, p98: 0.15 }]), [[0.01, 0.2], [0, 1], [0.02, 0.15]]);
  const ndvi = IMAGERY_PRODUCTS.find(p => p.id === 'ndvi')!;
  assert.deepEqual(seedRanges(ndvi, [[0, 1]], [{ p2: 0.1, p98: 0.9 }]), [[-1, 1]]);
});

test('stretch and curve controls appear only where they mean something', () => {
  const by = (id: string) => [...IMAGERY_PRODUCTS, ...RASTER_PRODUCTS, ...FUSION_PRODUCTS].find(p => p.id === id)!;
  assert.equal(hasStretch(by('tci')), false);
  assert.equal(hasStretch(by('scl')), false);
  assert.equal(hasStretch(by('dtm-hillshade')), false);
  assert.equal(hasStretch(by('chm')), true);
  assert.equal(hasCurve(by('fcir')), true);
  assert.equal(hasCurve(by('ndvi')), false);
});

test('fusion variables cover LiDAR, every index and the 10–20 m bands', () => {
  const ids = FUSION_VARIABLES.map(v => v.id);
  for (const id of ['chm', 'dtm', 'dsm', ...INDICES.map(i => i.id), 'nir', 'swir16', 'rededge1', 'ndvi_off', 'nir_off', 'd_ndvi', 'd_nir']) assert.ok(ids.includes(id), id);
  assert.equal(needsLeafOff(variableById.get('d_ndvi')!), true);
  assert.equal(needsLeafOff(variableById.get('ndvi')!), false);
  assert.ok(!ids.includes('coastal'), '60 m bands are left out');
});

test('the composite water channel agrees with the classifier on dark water', () => {
  const sgw = FUSION_PRODUCTS.find(p => p.id === 'fusion-sgw')!;
  const s = defaultStyle(sgw);
  const p = planes({ 's2:green': [0.004, 0.004], 's2:nir': [0.002, 0.2], 's2:red': [0.003, 0.1], 'lidar:dsm': [0, 0], 'lidar:dtm': [0, 0] });
  assert.equal(sgw.channels[2].fn(p, 0, s), 1);
  assert.ok(sgw.channels[2].fn(p, 1, s) < 0, 'a bright NIR pixel keeps its own NDWI');
});

test('ΔNDVI is leaf-on minus leaf-off NDVI', () => {
  const v = variableById.get('d_ndvi')!;
  const p = planes({ 's2:nir': [0.4], 's2:red': [0.04], 's2b:nir': [0.2], 's2b:red': [0.1] });
  const on = (0.4 - 0.04) / 0.44, off = (0.2 - 0.1) / 0.3;
  assert.ok(Math.abs(v.channel.fn(p, 0, defaultStyle(FUSION_PRODUCTS[0])) - (on - off)) < 1e-6);
});
