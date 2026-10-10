// The tile search against the BUILT index (run `npm run index` first): row
// groups are skipped by their bbox statistics, and skipping never loses a tile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { admitGroups, groupRowStarts, intersects, type LidarTile, type LonLatBox } from '../src/lidarIndex.ts';

const bytes = readFileSync(new URL('../public/data/lidar-tiles.parquet', import.meta.url));
const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const meta = parquetMetadata(file);
const COLS = ['project', 'key', 'year', 'points', 'bytes', 'xmin', 'ymin', 'xmax', 'ymax'];
const all = (await parquetReadObjects({ file, columns: COLS })) as LidarTile[];

async function search(box: LonLatBox) {
  const starts = groupRowStarts(meta);
  const groups = admitGroups(meta, box);
  const rows = (await Promise.all(groups.map(g => parquetReadObjects({ file, metadata: meta, columns: COLS, rowStart: starts[g], rowEnd: starts[g + 1] })))).flat() as LidarTile[];
  return { groups, tiles: rows.filter(t => intersects(t, box)) };
}

const ids = (ts: LidarTile[]) => ts.map(t => `${t.project}/${t.key}`).sort();

test('the index holds every tile once, with the geo metadata desktop tools read', () => {
  assert.equal(all.length, 8816);
  assert.equal(new Set(ids(all)).size, all.length);
  const geo = JSON.parse(meta.key_value_metadata!.find(k => k.key === 'geo')!.value!);
  assert.equal(geo.primary_column, 'geometry');
  assert.deepEqual(geo.columns.geometry.covering.bbox.xmin, ['xmin']);
});

for (const [name, box] of [
  ['downtown Halifax', [-63.60, 44.63, -63.56, 44.66]],
  ['a Sackville viewport', [-63.75, 44.74, -63.60, 44.82]],
  ['the whole county', [-64.5, 44.3, -62.5, 45.3]],
  ['open ocean', [-62.0, 43.5, -61.9, 43.6]],
] as [string, LonLatBox][]) {
  test(`${name}: pruned search returns exactly the brute-force answer`, async () => {
    const { tiles } = await search(box);
    assert.deepEqual(ids(tiles), ids(all.filter(t => intersects(t, box))));
  });
}

test('a city viewport reads a small fraction of the row groups', async () => {
  const { groups, tiles } = await search([-63.60, 44.63, -63.56, 44.66]);
  assert.ok(tiles.length > 0);
  assert.ok(groups.length <= meta.row_groups.length / 3, `read ${groups.length} of ${meta.row_groups.length}`);
});

test('the ocean reads nothing', async () => {
  assert.equal((await search([-62.0, 43.5, -61.9, 43.6])).groups.length, 0);
});
