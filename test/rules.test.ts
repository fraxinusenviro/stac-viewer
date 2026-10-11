import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASKED, PRESETS, compileRuleSet, parseRuleSet, ruleClasses, ruleInputs, test as cond, usesLeafOff, type RuleSet } from '../src/rules.ts';
import { defaultStyle, type Planes } from '../src/products.ts';

const planes = (o: Record<string, number[]>): Planes => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Float32Array.from(v)]));

test('conditions: every operator, and NaN is never true', () => {
  assert.ok(cond('>=', 5, 5)); assert.ok(!cond('>', 5, 5)); assert.ok(cond('<', 4, 5)); assert.ok(cond('<=', 5, 5));
  assert.ok(cond('between', 3, 5, 1)); assert.ok(!cond('between', 6, 1, 5));
  for (const op of ['<', '<=', '>', '>=', 'between'] as const) assert.ok(!cond(op, NaN, 0, 1));
});

test('rules sharing a name and colour are one class (an OR); disabled rules make none', () => {
  const rs: RuleSet = { name: 't', maskClouds: false, rules: [
    { label: 'Water', colour: '#0000ff', when: [{ v: 'ndwi', op: '>', a: 0 }] },
    { label: 'water ', colour: '#0000FF', when: [{ v: 'nir', op: '<', a: 0.04 }] },
    { label: 'Trees', colour: '#00ff00', when: [{ v: 'chm', op: '>=', a: 5 }], off: true },
    { label: 'Tall', colour: '#ff0000', when: [{ v: 'chm', op: '>=', a: 2 }] },
  ] };
  const { classes, valueOf } = ruleClasses(rs);
  assert.deepEqual(classes.map(c => c.label), ['Water', 'Tall']);
  assert.deepEqual(valueOf, [1, 1, 0, 2]);
});

test('the first matching rule wins; a pixel matching none is unclassified; clouds are masked', () => {
  const rs: RuleSet = { name: 't', maskClouds: true, rules: [
    { label: 'Trees', colour: '#00ff00', when: [{ v: 'chm', op: '>=', a: 5 }, { v: 'ndvi', op: '>=', a: 0.4 }] },
    { label: 'Tall', colour: '#ff0000', when: [{ v: 'chm', op: '>=', a: 2 }] },
  ] };
  const p = compileRuleSet(rs);
  assert.deepEqual(p.inputs.sort(), ['lidar:dsm', 'lidar:dtm', 's2:nir', 's2:red', 's2:scl'].sort());
  const pl = planes({
    'lidar:dsm': [20, 20, 3, 0, 20, NaN], 'lidar:dtm': [0, 0, 0, 0, 0, 0],
    's2:nir': [0.4, 0.1, 0.4, 0.4, 0.4, 0.4], 's2:red': [0.04, 0.1, 0.04, 0.04, 0.04, 0.04],
    's2:scl': [4, 4, 4, 4, 9, 4],
  });
  const s = defaultStyle(p);
  const out = [0, 1, 2, 3, 4, 5].map(i => p.channels[0].fn(pl, i, s));
  assert.equal(out[0], 1);
  assert.equal(out[1], 2, 'tall but not green: falls through to "Tall"');
  assert.equal(out[2], 2);
  assert.ok(Number.isNaN(out[3]), 'matches nothing');
  assert.equal(out[4], MASKED);
  assert.ok(Number.isNaN(out[5]), 'no LiDAR: a condition on canopy height cannot hold');
});

test('the land cover preset reproduces the original classifier on its test cases', () => {
  const p = compileRuleSet(PRESETS[0]);
  const s = defaultStyle(p);
  // chm, ndvi via nir/red, ndwi via green/nir.
  const px = (chm: number, nir: number, red: number, green: number) =>
    p.channels[0].fn(planes({ 'lidar:dsm': [chm], 'lidar:dtm': [0], 's2:nir': [nir], 's2:red': [red], 's2:green': [green], 's2:scl': [4] }), 0, s);
  const name = (v: number) => p.classes!.find(c => c.value === v)?.label;
  assert.equal(name(px(0.2, 0.02, 0.03, 0.06)), 'Water');
  assert.equal(name(px(0, 0.002, -0.001, 0.003)), 'Water', 'dark water: by NIR');
  assert.equal(name(px(15, 0.4, 0.04, 0.06)), 'Trees');
  assert.equal(name(px(2, 0.4, 0.04, 0.06)), 'Shrub or regeneration');
  assert.equal(name(px(0.3, 0.4, 0.05, 0.06)), 'Grass, crops or low vegetation');
  assert.equal(name(px(8, 0.15, 0.12, 0.1)), 'Building or structure');
  assert.equal(name(px(0.1, 0.15, 0.12, 0.1)), 'Bare ground or pavement');
});

test('leaf-off rules ask for the second scene and mask its clouds too', () => {
  assert.equal(usesLeafOff(PRESETS[1]), false);
  assert.equal(usesLeafOff(PRESETS[2]), true);
  assert.ok(ruleInputs(PRESETS[2]).includes('s2b:scl'));
});

test('parseRuleSet round-trips a preset and refuses what it does not understand', () => {
  for (const p of PRESETS) assert.deepEqual(parseRuleSet(JSON.parse(JSON.stringify(p))), p);
  assert.throws(() => parseRuleSet({}), /not a rule set/);
  assert.throws(() => parseRuleSet({ rules: [{ label: 'x', colour: 'red', when: [] }] }), /colour/);
  assert.throws(() => parseRuleSet({ rules: [{ label: 'x', colour: '#ff0000', when: [{ v: 'nope', op: '>', a: 1 }] }] }), /unknown variable "nope"/);
  assert.throws(() => parseRuleSet({ rules: [{ label: 'x', colour: '#ff0000', when: [{ v: 'chm', op: '=', a: 1 }] }] }), /unknown operator/);
  assert.throws(() => parseRuleSet({ rules: [{ label: 'x', colour: '#ff0000', when: [{ v: 'chm', op: 'between', a: 1 }] }] }), /number/);
});
