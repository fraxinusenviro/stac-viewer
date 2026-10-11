import { test } from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { projDef } from '../src/crs.ts';
import { boxGrid, chooseLevel, controlGrid, hillshade, interpGrid, tileBounds, tileGrid, tileToLonLat, TILE } from '../src/warp.ts';

test('tile 0/0/0 spans the Web Mercator world', () => {
  const [w, s, e, n] = tileBounds(0, 0, 0);
  assert.equal(w, -180); assert.equal(e, 180);
  assert.ok(Math.abs(n - 85.0511) < 1e-3 && Math.abs(s + 85.0511) < 1e-3);
});

test('the interpolated control grid stays within a tenth of a source pixel of exact proj4 (UTM 20N, z14)', () => {
  const conv = proj4('EPSG:4326', projDef(32620)!);
  const toSrc = (p: [number, number]) => conv.forward(p) as [number, number];
  const geo = { originX: 399960, originY: 5000040, resX: 10, resY: -10 };
  const [z, x, y] = [14, 5306, 5880]; // over Halifax
  const g = controlGrid(tileGrid(z, x, y), toSrc, geo);
  const out: [number, number] = [0, 0];
  let worst = 0;
  for (const [px, py] of [[7.5, 3.5], [100.5, 200.5], [255.5, 255.5], [128, 9]]) {
    interpGrid(g, px, py, out);
    const [sx, sy] = toSrc(tileToLonLat(x + px / TILE, y + py / TILE, z));
    worst = Math.max(worst, Math.hypot(out[0] - (sx - geo.originX) / geo.resX, out[1] - (sy - geo.originY) / geo.resY));
  }
  assert.ok(worst < 0.1, `worst error ${worst} px`);
});

test('chooseLevel picks the coarsest overview still finer than the output', () => {
  const f = [1, 2, 4, 8, 16];
  assert.equal(chooseLevel(f, 0.5), 0);
  assert.equal(chooseLevel(f, 3), 1);
  assert.equal(chooseLevel(f, 8), 3);
  assert.equal(chooseLevel(f, 1000), 4);
});

test('hillshade: flat ground lit at 45° reads cos(45°); a gap is NaN', () => {
  const w = 5, hgt = 5;
  const flat = new Float32Array(w * hgt).fill(10);
  const hs = hillshade(flat, w, hgt, 1);
  assert.ok(Math.abs(hs[4] - Math.cos(Math.PI / 4)) < 1e-6);
  flat[0] = NaN;
  assert.ok(Number.isNaN(hillshade(flat, w, hgt, 1)[0]));
});

test('projDef refuses a code it does not define', () => {
  assert.equal(projDef('EPSG:99999'), null);
  assert.match(projDef('EPSG:2961')!, /zone=20/);
  assert.match(projDef(3979)!, /lcc/);
});

test('boxGrid runs west to east and north to south', () => {
  const g = boxGrid([-64, 44, -63, 45], 100, 50);
  assert.deepEqual(g.lonLat(0, 0), [-64, 45]);
  assert.deepEqual(g.lonLat(100, 50), [-63, 44]);
});

test('a padded tile grid puts the pad outside the tile', () => {
  const g = tileGrid(3, 2, 2, 1);
  assert.equal(g.w, TILE + 2);
  assert.deepEqual(g.lonLat(1, 1), tileToLonLat(2, 2, 3));
});
