import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aoiAreaM2, aoiBox, boxPolygon, fmtArea, maskLabels, parseAoi, parseAois, pointInAoi, polygonMask, uniqueAoiName, type MaskGrid } from '../src/aoi.ts';
import { tallyClasses, classAreasCsv } from '../src/analysis/tally.ts';

/** A plain lon/lat grid (rows linear in latitude) over a box. */
function grid(box: [number, number, number, number], w: number, h: number): MaskGrid {
  return { w, h, box, lonLat: (px, py) => [box[0] + (px / w) * (box[2] - box[0]), box[3] - (py / h) * (box[3] - box[1])] };
}

test('box polygon: closed, and its box is itself', () => {
  const b: [number, number, number, number] = [-63.6, 44.6, -63.5, 44.7];
  const g = boxPolygon(b);
  assert.deepEqual(g.coordinates[0][0], g.coordinates[0][4]);
  assert.deepEqual(aoiBox(g), b);
});

test('area: a 0.01° square near Halifax is about 0.88 km², and a hole is taken out', () => {
  const g = boxPolygon([-63.6, 44.6, -63.59, 44.61]);
  const a = aoiAreaM2(g);
  // 0.01° lat ≈ 1112 m; 0.01° lon ≈ 1112 · cos 44.605° ≈ 792 m.
  assert.ok(Math.abs(a - 1112 * 792) / a < 0.01, `area ${a}`);
  const holed = { ...g, coordinates: [g.coordinates[0], boxPolygon([-63.598, 44.602, -63.592, 44.608]).coordinates[0]] };
  assert.ok(aoiAreaM2(holed) < a * 0.7);
});

test('format area: hectares under a square kilometre, km² above', () => {
  assert.equal(fmtArea(12_345), '1.23 ha');
  assert.equal(fmtArea(345_000), '34.5 ha');
  assert.equal(fmtArea(3_210_000), '3.21 km²');
});

test('point in polygon honours holes', () => {
  const g: GeoJSON.Polygon = { type: 'Polygon', coordinates: [boxPolygon([0, 0, 10, 10]).coordinates[0], boxPolygon([4, 4, 6, 6]).coordinates[0]] };
  assert.equal(pointInAoi(g, 1, 1), true);
  assert.equal(pointInAoi(g, 5, 5), false);
  assert.equal(pointInAoi(g, 11, 5), false);
});

test('mask: the scanline fill agrees with point-in-polygon at every pixel centre', () => {
  // A triangle with a notch: not convex, so a row crosses it twice.
  const g: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [5, 4], [0, 10], [0, 0]]] };
  const G = grid([-1, -1, 11, 11], 48, 40);
  const m = polygonMask(G, g);
  let inside = 0;
  for (let py = 0; py < G.h; py++) for (let px = 0; px < G.w; px++) {
    const [lon, lat] = G.lonLat(px + 0.5, py + 0.5);
    assert.equal(m[py * G.w + px], pointInAoi(g, lon, lat) ? 1 : 0, `pixel ${px},${py}`);
    inside += m[py * G.w + px];
  }
  assert.ok(inside > 0 && inside < G.w * G.h);
});

test('mask: a box covering the grid masks every pixel in', () => {
  const G = grid([0, 0, 1, 1], 10, 10);
  assert.equal(polygonMask(G, boxPolygon([-1, -1, 2, 2])).reduce((a, b) => a + b, 0), 100);
});

test('mask labels: drops outside pixels, renumbers, and loses objects wholly outside', () => {
  const labels = Int32Array.of(0, 0, 1, 1, 2, 2, -1, 3);
  const mask = Uint8Array.of(1, 0, 0, 0, 1, 1, 1, 1);
  const r = maskLabels(labels, mask);
  assert.deepEqual([...r.labels], [0, -1, -1, -1, 1, 1, -1, 2]);
  assert.equal(r.count, 3);
});

test('unique name: first free suffix, case-insensitive', () => {
  assert.equal(uniqueAoiName([], 'Wetland'), 'Wetland');
  assert.equal(uniqueAoiName(['wetland', 'Wetland 2'], 'Wetland'), 'Wetland 3');
  assert.equal(uniqueAoiName([], '  '), 'Study area');
});

test('parse: refuses what has no ground, closes an open ring, keeps a valid one', () => {
  const ok = parseAoi({ id: 'a', name: ' Bog ', source: 'rect', createdAt: '2026-01-01', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] } });
  assert.ok(ok);
  assert.equal(ok.name, 'Bog');
  assert.equal(ok.geometry.coordinates[0].length, 5);
  assert.equal(parseAoi({ id: 'b', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] } }), null);
  assert.equal(parseAoi({ id: 'c', geometry: { type: 'Point', coordinates: [0, 0] } }), null);
  assert.equal(parseAoi({ geometry: boxPolygon([0, 0, 1, 1]) }), null, 'no id');
  assert.equal(parseAois([ok, null, 'x', { id: 'd', geometry: boxPolygon([0, 0, 1, 1]) }]).length, 2);
  assert.deepEqual(parseAois('nonsense'), []);
});

test('tally: hectares and shares of the classified area inside the mask; the rest is unclassified', () => {
  const classes = [{ value: 1, label: 'Forest', colour: '#00ff00' }, { value: 2, label: 'Water', colour: '#0000ff' }, { value: 3, label: 'Absent', colour: '#ff0000' }];
  const classOf = Float32Array.of(1, 1, 1, 2, NaN, 2, 1);
  const mask = Uint8Array.of(1, 1, 1, 1, 1, 0, 0);
  const t = tallyClasses(classOf, mask, classes, 4);
  assert.deepEqual(t.rows.map(r => [r.label, r.areaM2, r.share]), [['Forest', 12, 0.75], ['Water', 4, 0.25]]);
  assert.equal(t.unclassifiedM2, 4);
  assert.equal(t.areaM2, 20);
  const csv = classAreasCsv(t, { run: '#1 Class areas', area: 'Bog, north', product: 'Strata' }).split('\n');
  assert.equal(csv[0], 'run,study_area,product,class,area_ha,share_of_classified');
  assert.equal(csv[1], '#1 Class areas,"Bog, north",Strata,Forest,0.0012,0.750000');
  assert.equal(csv[3], '#1 Class areas,"Bog, north",Strata,Unclassified,0.0004,');
  assert.equal(classAreasCsv(t, { run: 'r', area: 'a', product: 'p' }, false).split('\n').length, 3, 'no header');
});
