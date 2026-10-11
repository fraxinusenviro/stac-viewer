import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STRATA, MASKED, cellValue, compileScheme, defaultScheme, parseScheme, stratumOf, stratumRange, stratumShade, strataProblem, type StrataScheme } from '../src/strata.ts';
import { defaultStyle, type Planes } from '../src/products.ts';

const planes = (o: Record<string, number[]>): Planes => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Float32Array.from(v)]));

test('strata: half-open bands, open top, NaN has none', () => {
  const s = DEFAULT_STRATA;
  assert.equal(stratumOf(0.05, s), 0); assert.equal(stratumOf(0.1, s), 1); assert.equal(stratumOf(1.99, s), 2);
  assert.equal(stratumOf(2, s), 3); assert.equal(stratumOf(30, s), 4); assert.equal(stratumOf(NaN, s), -1);
  assert.equal(stratumRange(s[0]), '< 0.1 m'); assert.equal(stratumRange(s[2]), '0.5–2 m'); assert.equal(stratumRange(s[4]), '> 8 m');
});

test('strataProblem catches overlaps, inverted bands and missing names', () => {
  assert.equal(strataProblem(DEFAULT_STRATA), null);
  assert.match(strataProblem([{ id: 'a', label: 'A', min: 0, max: 2 }, { id: 'b', label: 'B', min: 1, max: 3 }])!, /overlaps/);
  assert.match(strataProblem([{ id: 'a', label: 'A', min: 2, max: 1 }])!, /upper height/);
  assert.match(strataProblem([{ id: 'a', label: ' ', min: 0, max: 1 }])!, /no name/);
});

test('a cover type only claims the strata it allows; the pixel falls through otherwise', () => {
  const p = compileScheme(defaultScheme());
  const s = defaultStyle(p);
  const name = (v: number) => p.classes!.find(c => c.value === v)?.label;
  // [chm, nir, red, green] — conifer-like spectrum (NDVI high, NIR < 0.3).
  const px = (chm: number, nir: number, red: number, green: number, scl = 4) =>
    p.channels[0].fn(planes({ 'lidar:dsm': [chm], 'lidar:dtm': [0], 's2:nir': [nir], 's2:red': [red], 's2:green': [green], 's2:scl': [scl] }), 0, s);
  assert.equal(name(px(12, 0.22, 0.02, 0.04)), 'Coniferous · Forest');
  assert.equal(name(px(4, 0.22, 0.02, 0.04)), 'Coniferous · High shrub');
  assert.equal(name(px(1, 0.22, 0.02, 0.04)), 'Coniferous · Low shrub');
  // Conifer spectrum at 0.3 m: coniferous is not allowed there, so it falls to "Other vegetation".
  assert.equal(name(px(0.3, 0.22, 0.02, 0.04)), 'Other vegetation · Herbaceous / forb');
  // Broadleaf in every stratum, groundcover included.
  assert.equal(name(px(0.05, 0.4, 0.03, 0.06)), 'Broadleaf · Groundcover');
  assert.equal(name(px(15, 0.4, 0.03, 0.06)), 'Broadleaf · Forest');
  assert.equal(name(px(10, 0.15, 0.12, 0.1)), 'Built structure · Forest');
  assert.equal(name(px(0.05, 0.15, 0.12, 0.1)), 'Bare or impervious · Groundcover');
  assert.equal(name(px(0, 0.01, 0.02, 0.05)), 'Water · Groundcover');
  assert.equal(px(12, 0.22, 0.02, 0.04, 9), MASKED);
  // Tall and too dark for any index (a deep shadow): no rule can see it → unclassified, by stratum.
  assert.equal(name(px(10, 0.002, 0.003, 0.002)), 'Unclassified · Forest');
});

test('class values are a row-major matrix and the legend can find every cell', () => {
  const sc = defaultScheme();
  const p = compileScheme(sc);
  const m = p.matrix!;
  assert.deepEqual(m.rows.map(r => r.label), ['Water', 'Coniferous', 'Broadleaf', 'Other vegetation', 'Built structure', 'Bare or impervious']);
  assert.equal(m.cols.length, 5);
  for (let r = 0; r < m.rows.length; r++) for (let c = 0; c < m.cols.length; c++) {
    assert.equal(m.value(r, c), cellValue(r, c, 5));
    assert.ok(p.classes!.some(k => k.value === m.value(r, c)));
  }
});

test('stratum shading: low strata lighter, tall darker', () => {
  const lum = (h: string) => [1, 3, 5].reduce((a, k) => a + parseInt(h.slice(k, k + 2), 16), 0);
  assert.ok(lum(stratumShade('#1b5e20', 0, 5)) > lum(stratumShade('#1b5e20', 4, 5)));
});

test('parseScheme round-trips the default and refuses bad input', () => {
  const sc = defaultScheme();
  assert.deepEqual(parseScheme(JSON.parse(JSON.stringify(sc))), sc);
  assert.throws(() => parseScheme({}), /not a strata scheme/);
  const bad: StrataScheme = JSON.parse(JSON.stringify(sc));
  bad.covers[0].strata = ['nope'];
  assert.throws(() => parseScheme(bad), /unknown stratum "nope"/);
  const overl: StrataScheme = JSON.parse(JSON.stringify(sc));
  overl.strata[1].min = 0.05;
  assert.throws(() => parseScheme(overl), /overlaps/);
});

test('compileScheme refuses broken strata rather than drawing them', () => {
  const sc = defaultScheme();
  sc.strata[2].max = 0.2;
  assert.throws(() => compileScheme(sc), /upper height|overlaps/);
});
