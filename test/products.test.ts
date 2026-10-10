import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RASTER_PRODUCTS, productsFor, usesRange } from '../src/products.ts';
import { percentileRange } from '../src/warp.ts';

test('six products: DTM and DSM, each as hillshade, elevation and shaded elevation', () => {
  assert.deepEqual(RASTER_PRODUCTS.map(p => p.label), [
    'DTM hillshade', 'DTM elevation', 'DTM shaded elevation',
    'DSM hillshade', 'DSM elevation', 'DSM shaded elevation',
  ]);
});

test('an item with no DSM offers only the DTM products', () => {
  assert.ok(productsFor({ dsm: null }).every(p => p.surface === 'dtm'));
  assert.equal(productsFor({ dsm: 'x.tif' }).length, 6);
});

test('only the colour-ramp renderings take an elevation range', () => {
  assert.equal(usesRange('hillshade'), false);
  assert.equal(usesRange('elevation'), true);
  assert.equal(usesRange('shaded'), true);
});

test('percentileRange ignores nodata, rounds outward, and is null on an empty window', () => {
  const v = [-32767, ...Array.from({ length: 101 }, (_, i) => 10 + i * 0.5), -32767];
  const valid = (x: number) => x > -1000;
  assert.deepEqual(percentileRange(v, valid), [11, 59]);
  assert.equal(percentileRange([-32767, NaN], (x) => Number.isFinite(x) && x > -1000), null);
  assert.deepEqual(percentileRange([5, 5, 5], valid), [5, 6]);
});
