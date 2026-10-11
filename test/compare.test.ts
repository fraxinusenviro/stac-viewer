import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestSplit, compareLabels, niceThreshold, type Sample } from '../src/compare.ts';

const s = (label: string, values: Record<string, number>): Sample => ({ id: Math.random().toString(), label, lon: 0, lat: 0, values });

test('bestSplit finds the clean cut and which side A is on', () => {
  assert.deepEqual(bestSplit([0.4, 0.42, 0.38], [0.2, 0.22, 0.25]), { threshold: (0.25 + 0.38) / 2, aAbove: true, accuracy: 1 });
  assert.equal(bestSplit([1, 2], [5, 6]).aAbove, false);
});

test('balanced accuracy: lopsided samples cannot inflate a useless variable', () => {
  const a = [1, 1, 1, 1, 1, 1, 1, 1, 1, 2], b = [1, 2];
  assert.ok(bestSplit(a, b).accuracy < 0.8);
});

test('compareLabels ranks the separating variable first and reports d', () => {
  const samples = [
    s('Broadleaf', { nir: 0.40, chm: 18, ndvi: 0.85 }), s('Broadleaf', { nir: 0.43, chm: 15, ndvi: 0.86 }), s('Broadleaf', { nir: 0.38, chm: 20, ndvi: 0.84 }),
    s('Conifer', { nir: 0.24, chm: 17, ndvi: 0.84 }), s('Conifer', { nir: 0.22, chm: 19, ndvi: 0.86 }), s('Conifer', { nir: 0.26, chm: 14, ndvi: 0.85 }),
  ];
  const rows = compareLabels(samples, 'Broadleaf', 'Conifer', ['ndvi', 'chm', 'nir', 'missing']);
  assert.equal(rows[0].v, 'nir');
  assert.equal(rows[0].accuracy, 1);
  assert.ok(rows[0].d > 5);
  assert.ok(!rows.some(r => r.v === 'missing'), 'needs two finite values a side');
});

test('niceThreshold rounds to three significant figures', () => {
  assert.equal(niceThreshold(0.312345), 0.312);
  assert.equal(niceThreshold(12.3456), 12.3);
});
