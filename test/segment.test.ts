import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, mergeRegions, slic } from '../src/segment/slic.ts';
import { classifyObjects, objectPlanes, ringArea2, ringsToPolygons, traceRings } from '../src/segment/objects.ts';
import { compileRuleSet } from '../src/rules.ts';
import { defaultStyle } from '../src/products.ts';

/** A 40 × 20 image: a tall stand (feature 5) on the left half, open ground (0) on the right. */
function twoHalves(noise = 0.1) {
  const w = 40, h = 20, f = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = (x < 20 ? 5 : 0) + Math.sin(x * 7.1 + y * 3.3) * noise;
  return { w, h, f };
}

test('slic: superpixels never straddle a strong edge, and are connected', () => {
  const { w, h, f } = twoHalves();
  const { labels, count } = slic([f], w, h, { step: 5, compactness: 1 });
  assert.ok(count >= 20 && count <= 50, `count ${count}`);
  const side = new Map<number, Set<boolean>>();
  for (let i = 0; i < labels.length; i++) (side.get(labels[i]) ?? side.set(labels[i], new Set()).get(labels[i])!).add(i % w < 20);
  for (const [, s] of side) assert.equal(s.size, 1, 'a superpixel crosses the edge');
  // Connected: relabelling by components changes nothing.
  assert.equal(connect(labels, w, h, 1).count, count);
});

test('slic: a pixel with every feature missing has no label', () => {
  const { w, h, f } = twoHalves();
  f[0] = NaN;
  assert.equal(slic([f], w, h, { step: 5, compactness: 1 }).labels[0], -1);
});

test('merge: uniform halves become two patches; k = 0 merges nothing', () => {
  const { w, h, f } = twoHalves(0.05);
  const s = slic([f], w, h, { step: 5, compactness: 1 });
  const m = mergeRegions(s.labels, s.count, w, h, [f], 25 * 2);
  assert.equal(m.count, 2);
  assert.equal(mergeRegions(s.labels, s.count, w, h, [f], 0).count, s.count);
});

test('objects: means, SCL majority, region measures, classification once per object', () => {
  const w = 4, h = 2;
  const labels = Int32Array.of(0, 0, 1, 1, 0, 0, 1, 1);
  const planes = {
    'lidar:dsm': Float32Array.of(20, 22, 10, 10, 18, 20, 10, 11),
    'lidar:dtm': Float32Array.of(10, 10, 10, 10, 10, 10, 10, 10),
    's2:scl': Float32Array.of(4, 4, 6, 8, 4, 9, 6, 6),
    'ortho:r': Float32Array.of(10, 20, 100, 100, 10, 20, 100, 100),
    'ortho:g': Float32Array.of(10, 20, 100, 100, 10, 20, 100, 100),
    'ortho:b': Float32Array.of(10, 20, 100, 100, 10, 20, 100, 100),
  };
  const o = objectPlanes(labels, 2, w, h, planes, 2);
  assert.deepEqual([...o.planes['lidar:dsm']], [20, 10.25]);
  assert.deepEqual([...o.planes['s2:scl']], [4, 6]);
  assert.equal(o.planes['obj:area'][0], 16);
  assert.ok(Math.abs(o.planes['obj:compact'][0] - (4 * Math.PI * 16) / 256) < 1e-6);
  assert.ok(o.planes['obj:chm_p90'][0] > 10 && o.planes['obj:chm_p90'][0] <= 12);
  assert.ok(o.planes['obj:tex'][0] > 0 && o.planes['obj:tex'][1] === 0);
  const p = compileRuleSet({ name: 't', maskClouds: false, rules: [{ label: 'Tall', colour: '#00ff00', when: [{ v: 'chm', op: '>=', a: 5 }] }, { label: 'Small object', colour: '#0000ff', when: [{ v: 'obj_area', op: '<', a: 100 }] }] });
  assert.deepEqual([...classifyObjects(p, o, defaultStyle(p))], [1, 2]);
});

test('trace: a square with a hole is one outer ring and one hole, oriented as GeoJSON expects after flipping y', () => {
  const w = 5, h = 5, labels = new Int32Array(25).fill(-1);
  for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) labels[y * w + x] = 7;
  labels[2 * w + 2] = -1;
  const rings = traceRings(labels, w, h).get(7)!;
  assert.equal(rings.length, 2);
  const polys = ringsToPolygons(rings);
  assert.equal(polys.length, 1);
  assert.equal(polys[0].length, 2);
  assert.ok(ringArea2(polys[0][0]) === 18 && ringArea2(polys[0][1]) === -2);
  assert.deepEqual(polys[0][0][0], polys[0][0][polys[0][0].length - 1], 'closed');
  assert.equal(polys[0][0].length, 5, 'collinear vertices dropped: a square is 4 corners + closure');
});

test('trace: pixels touching only at a corner give two rings, not a crossing one', () => {
  const w = 2, h = 2, labels = Int32Array.of(3, -1, -1, 3);
  const polys = ringsToPolygons(traceRings(labels, w, h).get(3)!);
  assert.equal(polys.length, 2);
  for (const p of polys) assert.equal(ringArea2(p[0]), 2);
});
