import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attenuation, cellFor, depthForCounts, gridMetrics, groundSurface, type CellGrid, type PointArrays } from '../src/pointcloud/pcMetrics.ts';
import { focalStd } from '../src/xyz.ts';

/** Build a point set from [x, y, z, class, first, intensity] rows. */
function pts(rows: number[][]): PointArrays {
  const n = rows.length;
  const p: PointArrays = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float32Array(n), cls: new Uint8Array(n), first: new Uint8Array(n), intensity: new Uint16Array(n) };
  rows.forEach(([x, y, z, c, f, it], i) => { p.x[i] = x; p.y[i] = y; p.z[i] = z; p.cls[i] = c; p.first[i] = f; p.intensity[i] = it; });
  return p;
}

const g: CellGrid = { x0: 0, y0: 0, cell: 2, w: 2, h: 1 };

test('a canopy cell: half the pulses reach the ground; vegetation and ground intensity kept apart', () => {
  const rows: number[][] = [];
  // Cell 0: 4 ground first returns (z 10, intensity 100), 4 canopy first returns 15 m up (class 1, intensity 40), one last return.
  for (let k = 0; k < 4; k++) rows.push([0.5 + k * 0.3, 0.5, 10, 2, 1, 100]);
  for (let k = 0; k < 4; k++) rows.push([0.5 + k * 0.3, 1.5, 25, 1, 1, 40]);
  rows.push([1, 1, 18, 1, 0, 999]);
  // Cell 1: open ground only.
  for (let k = 0; k < 5; k++) rows.push([2.5 + k * 0.2, 1, 10, 2, 1, 200]);
  const m = gridMetrics(pts(rows), g);
  assert.equal(m.pen[0], 0.5);
  assert.equal(m.ivg[0], 40);
  assert.equal(m.igr[0], 100);
  assert.equal(m.int[0], 70);
  assert.ok(Math.abs(m.att[0] - Math.log(2) / 14.5) < 1e-9, `att ${m.att[0]}`);
  assert.equal(m.den[0], 8 / 4);
  assert.equal(m.pen[1], 1);
  assert.ok(Number.isNaN(m.att[1]), 'no canopy, no attenuation');
  assert.ok(Number.isNaN(m.ivg[1]), 'no vegetation, no vegetation intensity');
});

test('too few returns of a kind is no data, never zero; noise is ignored', () => {
  const m = gridMetrics(pts([[0.5, 0.5, 10, 2, 1, 50], [0.6, 0.5, 10, 2, 1, 50], [0.7, 0.5, 30, 7, 1, 5000]]), g);
  assert.ok(Number.isNaN(m.pen[0]) && Number.isNaN(m.int[0]));
});

test('ground surface fills a gap from its neighbours', () => {
  const gr = groundSurface(pts([[0.5, 0.5, 10, 2, 1, 0], [4.5, 0.5, 14, 2, 1, 0]]), { x0: 0, y0: 0, cell: 2, w: 3, h: 1 });
  assert.equal(gr[0], 10); assert.equal(gr[2], 14); assert.equal(gr[1], 12);
});

test('attenuation saturates rather than going infinite', () => {
  assert.ok(Number.isFinite(attenuation(0, 10, 10)) && attenuation(0, 10, 10) > attenuation(5, 10, 10));
  assert.ok(Number.isNaN(attenuation(1, 2, 10)));
});

test('cell size and octree depth follow the output resolution', () => {
  assert.equal(cellFor(0.8), 2); assert.equal(cellFor(3.4), 4); assert.equal(cellFor(15), 16); assert.equal(cellFor(40), null);
  // 100 cells want 1600 returns: levels of 100, 400, 1600 → depth 2 (2100 cumulative); too few anywhere → the deepest.
  assert.equal(depthForCounts([100, 400, 1600, 6400], 100), 2);
  assert.equal(depthForCounts([100, 400], 100), 1);
  assert.equal(depthForCounts([2000, 400], 100), 0);
});

test('focalStd: flat is 0, a checkerboard is 0.5, NaN stays NaN', () => {
  const flat = new Float32Array(25).fill(0.3);
  assert.ok(focalStd(flat, 5, 5, 1).every(v => Math.abs(v) < 1e-6));
  const chk = Float32Array.from({ length: 100 }, (_, i) => ((i % 10) + Math.floor(i / 10)) % 2);
  const s = focalStd(chk, 10, 10, 2);
  assert.ok(Math.abs(s[55] - 0.5) < 0.03, `${s[55]}`);
  const withNan = flat.slice(); withNan[12] = NaN;
  assert.ok(Number.isNaN(focalStd(withNan, 5, 5, 1)[12]));
});
