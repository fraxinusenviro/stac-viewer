import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOLS, defaultParams, missingInput, searchTools, toolTree, type Runner } from '../src/toolbox/catalog.ts';
import { FUSION_PRODUCTS, IMAGERY_PRODUCTS, RASTER_PRODUCTS, variableById } from '../src/products.ts';

const RUNNERS: Runner[] = ['raster-product', 'variable-map', 'pc-metric', 'product', 's2-product', 'fusion-rgb', 'analysis', 'objects-tab'];

test('every tool is a complete contract: a place in the tree, help, inputs, outputs, a known runner', () => {
  const ids = new Set<string>();
  for (const t of TOOLS) {
    assert.ok(!ids.has(t.id), `duplicate ${t.id}`); ids.add(t.id);
    assert.equal(t.path.length, 2, t.id);
    assert.ok(t.help.purpose && t.help.method, `${t.id} needs a purpose and a method`);
    assert.ok(t.outputs.length, `${t.id} has no output`);
    assert.ok(RUNNERS.includes(t.runner), t.id);
    for (const p of t.params) {
      if (p.type === 'select' && p.options.length) assert.ok(p.options.some(o => o.value === p.default), `${t.id}.${p.id} default not an option`);
      if (p.type === 'range') assert.ok(p.default >= p.min && p.default <= p.max, `${t.id}.${p.id}`);
    }
    assert.ok(new Set(t.inputs.map(i => i.id)).size === t.inputs.length, `${t.id} repeats an input`);
  }
});

test('every product, variable and tool a tool names exists', () => {
  for (const t of TOOLS) {
    const v = defaultParams(t);
    if (t.runner === 'raster-product') {
      const modes = t.fixed!.mode === 'chm' ? ['chm'] : t.params.find(p => p.id === 'surface')!.type === 'select' ? (t.params.find(p => p.id === 'surface') as { options: { value: string }[] }).options.map(o => `${o.value}-${t.fixed!.mode}`) : [];
      for (const m of modes) assert.ok(RASTER_PRODUCTS.some(p => p.id === m), `${t.id}: ${m}`);
    }
    if (t.runner === 'product') assert.ok(FUSION_PRODUCTS.some(p => p.id === t.fixed!.product), t.id);
    if (t.runner === 's2-product') {
      const ids = t.fixed?.product ? [t.fixed.product] : (t.params[0] as { options: { value: string }[] }).options.map(o => o.value);
      for (const id of ids) assert.ok(IMAGERY_PRODUCTS.some(p => p.id === id), `${t.id}: ${id}`);
    }
    if (t.runner === 'pc-metric') for (const o of (t.params[0] as { options: { value: string }[] }).options) assert.ok(variableById.get(o.value)?.inputs.every(k => k.startsWith('pc:')), o.value);
    if (t.runner === 'variable-map') assert.ok(variableById.has(String(v.variable)));
    if (t.runner === 'fusion-rgb') for (const k of ['r', 'g', 'b']) assert.ok(variableById.has(String(v[k])), `${t.id}.${k}`);
    if (t.runner === 'analysis') assert.ok(['areas', 'objects', 'table'].includes(t.fixed!.tool), t.id);
    if (t.runner === 'objects-tab') assert.ok(['objects', 'classify', 'review'].includes(t.fixed!.step), t.id);
  }
});

test('every runner is implemented, and every parameter a tool declares is read by its runner', () => {
  const src = readFileSync(new URL('../src/tabs/toolbox.ts', import.meta.url), 'utf8');
  for (const r of RUNNERS) assert.ok(src.includes(`'${r}'`), `runner ${r} not handled in tabs/toolbox.ts`);
  for (const t of TOOLS) for (const p of t.params) {
    const readIn = (t.runner === 'analysis' && /segment|cellM/.test(src) && src.includes(`v.${p.id}`)) || src.includes(`v.${p.id}`);
    assert.ok(readIn, `${t.id}: parameter ${p.id} is never read`);
  }
});

test('the tree, search and the missing-input check', () => {
  const tree = toolTree();
  assert.deepEqual(tree.map(b => b.toolbox), ['LiDAR rasters (HRDEM)', 'Point cloud (CanElevation COPC)', 'Sentinel-2 imagery', 'LiDAR × imagery fusion', 'Object-based analysis (OBIA)']);
  assert.equal(tree.reduce((n, b) => n + b.toolsets.reduce((m, s) => m + s.tools.length, 0), 0), TOOLS.length);
  assert.deepEqual(searchTools('intensity').map(t => t.id).sort(), ['pc.evidence', 'pc.metric', 'pc.ortho']);
  assert.deepEqual(searchTools('crowns objects').map(t => t.id), ['fusion.objects']);
  const areas = TOOLS.find(t => t.id === 'fusion.areas')!;
  assert.match(missingInput(areas, k => k !== 'classes'), /classes/i);
  assert.equal(missingInput(areas, () => true), '');
  // Optional inputs never block.
  assert.equal(missingInput(areas, k => ['area', 'classes', 'lidar-dsm'].includes(k)), '');
});
