import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelStats, classCounts, makeLut, paint } from '../src/paint.ts';

test('the curves keep 0 → 0 and 1 → 255; gamma above 1 brightens the middle', () => {
  for (const c of ['linear', 'sqrt', 'log'] as const) {
    const l = makeLut(c);
    assert.equal(l[0], 0); assert.equal(l[l.length - 1], 255);
  }
  const mid = (l: Uint8ClampedArray) => l[l.length >> 1];
  assert.ok(mid(makeLut('linear', 2)) > mid(makeLut('linear', 1)));
  assert.ok(mid(makeLut('sqrt')) > mid(makeLut('linear')));
});

test('channelStats: percentiles, a histogram over a fixed domain, NaN ignored', () => {
  const v = [NaN, ...Array.from({ length: 101 }, (_, i) => i / 100)];
  const s = channelStats(v, [-1, 1])!;
  assert.equal(s.n, 101);
  assert.ok(Math.abs(s.p2 - 0.02) < 1e-6 && Math.abs(s.p98 - 0.98) < 1e-6);
  assert.equal(s.lo, -1); assert.equal(s.hist.reduce((a, b) => a + b, 0), 101);
  assert.equal(s.hist.slice(0, 32).reduce((a, b) => a + b, 0), 0, 'nothing below zero');
  assert.equal(channelStats([NaN]), null);
});

test('paint rgb: stretch maps the range onto 0..255, NaN in any channel is transparent', () => {
  const size = 256, n = size * size;
  const ch = [0, 1, 2].map(() => new Float32Array(n).fill(0.1));
  ch[1][1] = NaN;
  const out = paint(ch, size, 0, { render: 'rgb', ranges: [[0, 0.2], [0, 0.2], [0, 0.1]], curve: 'linear', gamma: 1 }, 1);
  assert.ok(Math.abs(out[0] - 128) <= 1);
  assert.equal(out[2], 255);
  assert.equal(out[3], 255);
  assert.equal(out[7], 0, 'pixel 1 has a NaN channel');
});

test('paint classes draws known classes only', () => {
  const size = 256, ch = [new Float32Array(size * size).fill(2)];
  ch[0][1] = 9;
  const out = paint(ch, size, 0, { render: 'classes', ranges: [[0, 1]], curve: 'linear', gamma: 1, classes: [{ value: 2, colour: '#1b7837' }] }, 1);
  assert.deepEqual([...out.slice(0, 4)], [0x1b, 0x78, 0x37, 255]);
  assert.equal(out[7], 0);
});

test('classCounts tallies finite values', () => {
  assert.deepEqual([...classCounts([1, 1, 2, NaN])], [[1, 2], [2, 1]]);
});

test('partial rgb paints a pixel with one channel missing; strict rgb does not', () => {
  const size = 256, n = size * size;
  const ch = [0, 1, 2].map(() => new Float32Array(n).fill(0.5));
  ch[2][0] = NaN;
  const spec = { render: 'rgb' as const, ranges: [[0, 1], [0, 1], [0, 1]] as [number, number][], curve: 'linear' as const, gamma: 1 };
  assert.equal(paint(ch, size, 0, spec, 1)[3], 0);
  const out = paint(ch, size, 0, { ...spec, partial: true }, 1);
  assert.equal(out[3], 255); assert.equal(out[2], 0);
});
