import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawOrder, effectiveVisible, emptyToc, moveBy, moveTo, moveToEdge, remove, rows, upsert, type Family, type TocLayerNode } from '../src/layers/tocModel.ts';

const L = (id: string, family: Family, parent?: string, mapLayers = [id]): TocLayerNode => ({ type: 'layer', id, title: id, family, kind: 'raster', mapLayers, visible: true, opacity: 1, parent });

test('a new output lands on top of its own family, below higher families', () => {
  const s = emptyToc();
  upsert(s, L('res1', 'result'));
  upsert(s, L('dtm', 'raster'));
  upsert(s, L('s2', 'imagery'));
  upsert(s, L('chm', 'raster'));
  upsert(s, L('res2', 'result'));
  assert.deepEqual(s.order, ['res2', 'res1', 'chm', 'dtm', 's2']);
  assert.deepEqual(drawOrder(s), ['s2', 'dtm', 'chm', 'res1', 'res2']);
});

test('moving: within the list, clamped; the user order then stands', () => {
  const s = emptyToc();
  for (const id of ['a', 'b', 'c']) upsert(s, L(id, 'raster'));
  assert.deepEqual(s.order, ['c', 'b', 'a']);
  assert.ok(moveToEdge(s, 'a', 'top'));
  assert.deepEqual(s.order, ['a', 'c', 'b']);
  assert.ok(moveBy(s, 'a', 1));
  assert.deepEqual(s.order, ['c', 'a', 'b']);
  assert.equal(moveTo(s, 'b', 99), false);
  assert.ok(moveTo(s, 'b', -5));
  assert.deepEqual(s.order, ['b', 'c', 'a']);
  // An imagery layer moved to the top stays there when a raster is added.
  upsert(s, L('img', 'imagery'));
  moveToEdge(s, 'img', 'top');
  upsert(s, L('d', 'raster'));
  assert.equal(s.order[0], 'img');
});

test('groups move as a unit; children stay contiguous and reorder inside', () => {
  const s = emptyToc();
  upsert(s, L('dtm', 'raster'));
  upsert(s, { type: 'group', id: 'obia', title: 'Objects', family: 'objects', visible: true, collapsed: false, children: [] });
  upsert(s, L('rgb', 'objects', 'obia'));
  upsert(s, L('objs', 'objects', 'obia', ['objs-fill', 'objs-line']));
  assert.deepEqual(drawOrder(s), ['dtm', 'rgb', 'objs-fill', 'objs-line']);
  moveToEdge(s, 'obia', 'bottom');
  assert.deepEqual(drawOrder(s), ['rgb', 'objs-fill', 'objs-line', 'dtm']);
  moveToEdge(s, 'rgb', 'top');
  assert.deepEqual(drawOrder(s), ['objs-fill', 'objs-line', 'rgb', 'dtm']);
  // A child cannot leave its group.
  assert.equal(moveTo(s, 'rgb', 5), true);
  assert.deepEqual(s.order, ['dtm', 'obia']);
  // Hiding the group hides its children without changing their own switches.
  (s.nodes.get('obia') as { visible: boolean }).visible = false;
  assert.equal(effectiveVisible(s, 'rgb'), false);
  assert.equal((s.nodes.get('rgb') as TocLayerNode).visible, true);
  // A collapsed group shows one row.
  (s.nodes.get('obia') as { collapsed: boolean }).collapsed = true;
  assert.equal(rows(s).length, 2);
  assert.deepEqual(remove(s, 'obia').sort(), ['objs', 'rgb']);
  assert.deepEqual(drawOrder(s), ['dtm']);
});

test('re-adding an output keeps its place, visibility and opacity', () => {
  const s = emptyToc();
  upsert(s, L('a', 'raster')); upsert(s, L('b', 'raster'));
  moveToEdge(s, 'a', 'top');
  const a = s.nodes.get('a') as TocLayerNode;
  a.visible = false; a.opacity = 0.4;
  upsert(s, { ...L('a', 'raster'), title: 'renamed' });
  const a2 = s.nodes.get('a') as TocLayerNode;
  assert.deepEqual(s.order, ['a', 'b']);
  assert.equal(a2.title, 'renamed');
  assert.equal(a2.visible, false);
  assert.equal(a2.opacity, 0.4);
});
