import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heightClass, solve, unmix } from '../src/unmix.ts';

test('heightClass by breaks; NaN has no class', () => {
  assert.equal(heightClass(0.2, [1, 5]), 0); assert.equal(heightClass(1, [1, 5]), 1); assert.equal(heightClass(12, [1, 5]), 2);
  assert.equal(heightClass(NaN, [1, 5]), -1);
});

test('solve a small system', () => {
  assert.deepEqual(solve([[2, 1], [1, 3]], [3, 5])!.map(x => Math.round(x * 1e9) / 1e9), [0.8, 1.4]);
  assert.equal(solve([[1, 1], [1, 1]], [1, 2]), null);
});

/** A synthetic scene: 12 × 12 coarse pixels of 5 × 5 fine pixels, canopy in a varying share of each. */
function scene(trueTree: number, trueLow: number) {
  const C = 12, F = 5, W = C * F, n = W * W;
  const ids = new Float32Array(n), chm = new Float32Array(n), nir = new Float32Array(n);
  const share = new Float64Array(C * C);
  for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) {
    const cr = Math.floor(r / F), cc = Math.floor(c / F), id = cr * C + cc, i = r * W + c;
    ids[i] = id;
    // Canopy in the first k columns of each coarse pixel, k varying across the scene.
    const k = (cr + cc) % (F + 1);
    chm[i] = (c % F) < k ? 15 : 0.2;
  }
  for (let id = 0; id < C * C; id++) {
    let t = 0;
    for (let i = 0; i < n; i++) if (ids[i] === id && chm[i] >= 5) t++;
    share[id] = t / (F * F);
  }
  for (let i = 0; i < n; i++) nir[i] = share[ids[i]] * trueTree + (1 - share[ids[i]]) * trueLow;
  return { ids, chm, nir, C, W, n };
}

test('unmix recovers the class spectra a mixture was made from', () => {
  const s = scene(0.40, 0.08);
  const r = unmix({ ids: s.ids, idWidth: s.C, chm: s.chm, bands: { nir: s.nir } }, { breaks: [5], radius: 2, ridge: 0.001 });
  assert.equal(r.sharpened, true);
  let worst = 0;
  for (let i = 0; i < s.n; i++) worst = Math.max(worst, Math.abs(r.bands.nir[i] - (s.chm[i] >= 5 ? 0.40 : 0.08)));
  assert.ok(worst < 0.01, `worst error ${worst}`);
});

test('the sharpened image averages back to the coarse values (nothing invented)', () => {
  const s = scene(0.35, 0.1);
  for (let i = 0; i < s.n; i++) s.nir[i] += ((s.ids[i] * 7919) % 13) / 1000; // some noise per coarse pixel
  const r = unmix({ ids: s.ids, idWidth: s.C, chm: s.chm, bands: { nir: s.nir } }, { breaks: [5], radius: 2, ridge: 0.05 });
  const sum = new Map<number, [number, number]>();
  for (let i = 0; i < s.n; i++) { const e = sum.get(s.ids[i]) ?? [0, 0]; sum.set(s.ids[i], [e[0] + r.bands.nir[i], e[1] + 1]); }
  for (const [id, [t, k]] of sum) {
    const coarse = s.nir[s.ids.indexOf(id)];
    assert.ok(Math.abs(t / k - coarse) < 1e-5, `pixel ${id}`);
  }
});

test('too coarse a grid is left alone', () => {
  const ids = Float32Array.from([0, 1, 2, 3]), chm = Float32Array.from([10, 0, 10, 0]), nir = Float32Array.from([0.3, 0.1, 0.3, 0.1]);
  const r = unmix({ ids, idWidth: 2, chm, bands: { nir } });
  assert.equal(r.sharpened, false);
  assert.equal(r.bands.nir, nir);
});
