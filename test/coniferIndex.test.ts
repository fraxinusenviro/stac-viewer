import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bimodality, calibrate, calibrations, coniferIndexAt, otsu, robustStat } from '../src/coniferIndex.ts';
import { variableById, type Planes } from '../src/products.ts';

test('robustStat: median and IQR/1.349', () => {
  const s = robustStat([1, 2, 3, 4, 5, NaN]);
  assert.equal(s.median, 3); assert.equal(s.n, 5);
  assert.ok(Math.abs(s.scale - 2 / 1.349) < 1e-9);
});

test('otsu splits two clusters between them; bimodality sees two groups', () => {
  const a = Array.from({ length: 200 }, (_, i) => -1 + (i % 10) * 0.02), b = Array.from({ length: 200 }, (_, i) => 1 + (i % 10) * 0.02);
  const t = otsu([...a, ...b]);
  assert.ok(t >= Math.max(...a) && t <= Math.min(...b), `threshold ${t}`);
  assert.ok(bimodality([...a, ...b]) > 0.555);
  assert.ok(bimodality(Array.from({ length: 400 }, (_, i) => Math.sin(i) * 0.01 + (i % 2 ? 0.001 : 0))) < 0.9);
});

/** Woody pixels of two kinds: broadleaf (bright NIR, green) and conifer (dark). */
function stand(n = 400): Planes {
  const P = (f: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => f(i));
  const conifer = (i: number) => i % 2 === 1;
  const jitter = (i: number) => ((i * 2654435761) % 1000) / 1000 - 0.5;
  return {
    'lidar:dsm': P(() => 20), 'lidar:dtm': P(() => 0),
    's2:nir': P(i => (conifer(i) ? 0.22 : 0.40) + jitter(i) * 0.03),
    's2:red': P(i => (conifer(i) ? 0.02 : 0.03) + jitter(i) * 0.004),
    's2:green': P(i => (conifer(i) ? 0.035 : 0.06) + jitter(i) * 0.005),
    's2:blue': P(i => (conifer(i) ? 0.02 : 0.03) + jitter(i) * 0.004),
  };
}

test('calibrate: separates the two kinds, conifer positive, and reports the split', () => {
  const p = stand();
  const cal = calibrate(p, 400, { leafOff: false, sharpened: false })!;
  assert.equal(cal.woodyPixels, 400);
  assert.ok(cal.bimodality > 0.555, `bimodality ${cal.bimodality}`);
  assert.ok(Math.abs(cal.coniferShare - 0.5) < 0.05);
  let right = 0;
  for (let i = 0; i < 400; i++) if ((coniferIndexAt(cal, p, i) > 0) === (i % 2 === 1)) right++;
  assert.ok(right / 400 > 0.95, `agreement ${right / 400}`);
});

test('non-woody pixels have no index; the variable is NaN until calibrated', () => {
  const p = stand(100);
  p['lidar:dsm'][0] = 1; // 1 m: not woody
  const cal = calibrate(p, 100, { leafOff: false, sharpened: false })!;
  assert.ok(Number.isNaN(coniferIndexAt(cal, p, 0)));
  calibrations.delete('ci');
  assert.ok(Number.isNaN(variableById.get('ci')!.channel.fn(p, 1, {} as never)));
  calibrations.set('ci', cal);
  assert.ok(Number.isFinite(variableById.get('ci')!.channel.fn(p, 1, {} as never)));
  calibrations.delete('ci');
});

test('too few woody pixels refuses to calibrate', () => {
  const p = stand(20);
  assert.equal(calibrate(p, 20, { leafOff: false, sharpened: false }), null);
});
