import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageTouches, parseHrdem, parseS2 } from '../src/stac.ts';

test('HRDEM: projects first, newest first, items without a DTM dropped', () => {
  const items = parseHrdem({ features: [
    { id: 'm1', collection: 'hrdem-mosaic-1m', assets: { dtm: { href: 'a' } } },
    { id: 'old', collection: 'hrdem-lidar', properties: { datetime: '2016-01-01' }, assets: { dtm: { href: 'b' } } },
    { id: 'new', collection: 'hrdem-lidar', properties: { datetime: '2020-01-01' }, assets: { dtm: { href: 'c' }, dsm: { href: 'd' } } },
    { id: 'nodtm', collection: 'hrdem-lidar', assets: {} },
  ] });
  assert.deepEqual(items.map(i => i.id), ['new', 'old', 'm1']);
  assert.equal(items[0].dsm, 'd');
  assert.equal(items[2].kind, 'mosaic-1m');
});

test('Sentinel-2: newest first, the MGRS tile read off grid:code, no visual asset dropped', () => {
  const items = parseS2({ features: [
    { id: 'a', properties: { datetime: '2026-07-01T15:00:00Z', 'eo:cloud_cover': 3.2, 'grid:code': 'MGRS-20TMQ' }, assets: { visual: { href: 'v' } } },
    { id: 'b', properties: { datetime: '2026-08-01T15:00:00Z' }, assets: { visual: { href: 'w' } } },
    { id: 'c', properties: { datetime: '2026-09-01T15:00:00Z' }, assets: {} },
  ] });
  assert.deepEqual(items.map(i => i.id), ['b', 'a']);
  assert.equal(items[1].mgrs, '20TMQ');
  assert.equal(items[0].cloud, null);
});

test('coverageTouches: inside, overlapping, in a hole, and outside', () => {
  const sq = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const donut: GeoJSON.Geometry = { type: 'Polygon', coordinates: [sq(0, 0, 10, 10), sq(4, 4, 6, 6)] };
  assert.equal(coverageTouches(donut, [1, 1, 2, 2]), true, 'box inside');
  assert.equal(coverageTouches(donut, [-5, -5, 1, 1]), true, 'polygon corner inside the box');
  assert.equal(coverageTouches(donut, [4.5, 4.5, 5.5, 5.5]), false, 'box in the hole');
  assert.equal(coverageTouches(donut, [20, 20, 21, 21]), false, 'far away');
  assert.equal(coverageTouches({ type: 'MultiPolygon', coordinates: [[sq(30, 30, 31, 31)], [sq(0, 0, 1, 1)]] }, [0.2, 0.2, 0.4, 0.4]), true, 'second part');
});

import { s2AssetScaling } from '../src/stac.ts';
import { resolveInputs } from '../src/sources.ts';

test('s2AssetScaling: STAC raster:bands wins; else the baseline rule', () => {
  assert.deepEqual(s2AssetScaling('red', { scale: 0.0001, offset: -0.1, nodata: 0 }, '05.13'), { scale: 0.0001, offset: -0.1, nodata: 0, from: 'stac' });
  assert.equal(s2AssetScaling('red', undefined, '04.00').offset, -0.1);
  assert.equal(s2AssetScaling('red', undefined, '02.09').offset, 0);
  assert.equal(s2AssetScaling('red', undefined, null).from, 'none');
  assert.equal(s2AssetScaling('scl', undefined, '05.13').scale, 1);
});

test('resolveInputs maps product inputs to files, and names what is missing', () => {
  const s2 = { assets: { nir: { href: 'n.tif', scale: 0.0001, offset: -0.1, nodata: 0, from: 'stac' as const } }, visual: 'v.tif' } as never;
  const lidar = { id: 'P', dtm: 't.tif', dsm: null } as never;
  const r = resolveInputs(['s2:nir', 'lidar:dtm'], s2, lidar);
  assert.equal(r['s2:nir'].url, 'n.tif'); assert.equal(r['s2:nir'].offset, -0.1);
  assert.equal(r['lidar:dtm'].nodata, -32767);
  assert.throws(() => resolveInputs(['lidar:dsm'], s2, lidar), /no DSM/);
  assert.throws(() => resolveInputs(['s2:red'], s2, lidar), /no red/);
  assert.equal(resolveInputs(['s2:nir'], s2, null, { nodataAuto: false })['s2:nir'].nodata, null);
});
