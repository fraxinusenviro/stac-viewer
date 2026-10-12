import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignClusters, clusterProfileCsv, fitKMeans } from '../src/analysis/cluster.ts';

/** Three well-separated groups in (canopy height m, NDVI): forest, meadow, water. */
function scene(n = 3000) {
  const d = 2, X = new Float32Array(n * d), truth = new Int8Array(n);
  let s = 7;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  for (let i = 0; i < n; i++) {
    const g = i % 3; truth[i] = g;
    const [h, v] = g === 0 ? [18, 0.8] : g === 1 ? [0.3, 0.6] : [0, -0.3];
    X[i * d] = h + r() * 3; X[i * d + 1] = v + r() * 0.1;
  }
  return { X, n, d, truth };
}

test('k-means finds three separated groups, numbered by the first variable', () => {
  const { X, n, d, truth } = scene();
  const m = fitKMeans(X, n, d, { k: 3, seed: 3 });
  const lab = assignClusters(m, X, n);
  // Cluster 1 has the lowest canopy height (water or meadow), cluster 3 the highest (forest).
  assert.ok(m.centresRaw[2][0] > 15 && m.centresRaw[0][0] < 1);
  // Each true group maps to exactly one cluster.
  for (const g of [0, 1, 2]) assert.equal(new Set([...lab].filter((_, i) => truth[i] === g)).size, 1);
  assert.ok(m.explained > 0.9, `explained ${m.explained}`);
  assert.ok(m.converged);
});

test('standardised by default: an index is not outvoted by a variable in metres', () => {
  const { X, n, d, truth } = scene();
  // Meadow (0.3 m, NDVI 0.6) and water (0 m, NDVI −0.3) differ only in NDVI once height noise is ±1.5 m.
  const m = fitKMeans(X, n, d, { k: 3, seed: 3 });
  const z = assignClusters(m, X, n);
  assert.ok([1, 2].every(g => new Set([...z].filter((_, i) => truth[i] === g)).size === 1));
  // The standardisation is recorded, so the centres convert back to the variables' units.
  assert.ok(m.sd[0] > 1 && m.sd[1] < 1);
});

test('reproducible, missing values left unclassified, mask respected', () => {
  const { X, n, d } = scene();
  X[0] = NaN;
  const mask = new Uint8Array(n).fill(1); mask[1] = 0;
  const a = fitKMeans(X, n, d, { k: 4, seed: 9 }, mask), b = fitKMeans(X, n, d, { k: 4, seed: 9 }, mask);
  assert.deepEqual(a.centres, b.centres);
  const lab = assignClusters(a, X, n, mask);
  assert.equal(lab[0], -1);
  assert.equal(lab[1], -1);
  assert.equal(a.valid, n - 2);
});

test('refusals and the profile CSV', () => {
  const { X, n, d } = scene(20);
  assert.throws(() => fitKMeans(X, n, d, { k: 1 }), /at least 2/);
  assert.throws(() => fitKMeans(X, n, d, { k: 10 }), /at least 50/);
  const m = fitKMeans(scene().X, 3000, 2, { k: 3, seed: 1 });
  const csv = clusterProfileCsv(m, ['Water', 'Meadow, wet', 'Forest'], [{ id: 'chm', label: 'Canopy height' }, { id: 'ndvi', label: 'NDVI' }], [1e4, 2e4, 3e4]);
  const lines = csv.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^cluster,name,area_ha,chm \(Canopy height\),ndvi \(NDVI\)$/);
  assert.match(lines[2], /^2,"Meadow, wet",2\.0000,/);
});
