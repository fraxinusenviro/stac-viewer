import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { tableCsv, tableGeoParquet, type FeatureTable } from '../src/segment/featureTableExport.ts';

// Two 10 m cells on a UTM 20N lattice near Halifax.
const t = {
  epsg: 32620, cellM: 10, originX: 399960, originY: 5000040, lattice: 'test',
  rows: [{ ix: 4500, iy: 4950, coverage: 1 }, { ix: 4501, iy: 4950, coverage: 0.6 }],
  columns: [{ name: 'chm', label: 'Canopy height', values: Float32Array.of(12.5, NaN) }],
  shares: [{ name: 'share_coniferous', label: 'Share: Coniferous', values: Float32Array.of(0.75, 0) }],
} as unknown as FeatureTable;

test('feature table CSV: ids, cell centres on the lattice, H3, blanks for missing', async () => {
  const csv = (await tableCsv(t)).split('\n');
  assert.equal(csv[0], 'cell_id,x,y,lon,lat,h3_r13,h3_r11,coverage,chm,share_coniferous');
  const a = csv[1].split(','), b = csv[2].split(',');
  assert.equal(a[0], '32620:10:4500:4950');
  assert.equal(+a[1], 399960 + 45005); assert.equal(+a[2], 5000040 - 49505);
  assert.match(a[5], /^8d[0-9a-f]+$/, 'an H3 resolution-13 id');
  assert.equal(a[8], '12.5'); assert.equal(b[8], '', 'missing is blank, not 0');
});

test('feature table GeoParquet reads back with its geo metadata and polygons', async () => {
  const buf = await tableGeoParquet(t);
  const meta = parquetMetadata(buf);
  const geo = JSON.parse(meta.key_value_metadata!.find(kv => kv.key === 'geo')!.value!);
  assert.equal(geo.primary_column, 'geometry');
  const rows = await parquetReadObjects({ file: buf });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cell_id, '32620:10:4500:4950');
  assert.equal(rows[0].share_coniferous, 0.75);
  assert.equal(rows[1].chm, null);
  assert.equal((rows[0].geometry as { type: string }).type, 'Polygon');
});
