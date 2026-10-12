import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesPerPixel, deviceBudget, estimateBytes, maxAreaM2 } from '../src/obia/budget.ts';

test('budget: per-pixel cost grows with inputs; device budget is bounded; area limit follows', () => {
  assert.ok(bytesPerPixel({ rgb: true, chm: true, dtm: true }) > bytesPerPixel({ rgb: false, chm: true, dtm: false }));
  assert.equal(deviceBudget(undefined), 512 * 1024 ** 2);
  assert.equal(deviceBudget(4), 512 * 1024 ** 2);
  assert.equal(deviceBudget(32), 1024 ** 3);
  const e = estimateBytes({ px: 1e6, rgb: true, chm: true, dtm: false, sentinelNativePx: 0, sentinelPlanes: 0, targetAreaM2: 100, cellM: 1 });
  assert.ok(e > 1e8 && e < 2e8, `${e}`);
  // Halving the cell size quarters the area that fits.
  const i = { rgb: true, chm: true, dtm: false };
  assert.ok(Math.abs(maxAreaM2(1e9, 1, i) / maxAreaM2(1e9, 0.5, i) - 4) < 1e-9);
});
