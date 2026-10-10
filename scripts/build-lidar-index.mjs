// Builds the static LiDAR tile index the viewer searches with HTTP range reads.
//
//   node scripts/build-lidar-index.mjs [source.json ...]
//
// Input: one or more tile catalogues in the `nshabitat.tilecatalog/0.1` shape
// (data-src/*.json — the Nova Scotia one is copied from GPS2026felt). Output,
// all under public/data/ so Pages serves them next to the app:
//
//   lidar-tiles.parquet    one row per COPC tile, GeoParquet 1.1 (WKB polygon
//                          + a bbox covering), Hilbert-sorted, small row groups
//   lidar-projects.json    one record per acquisition project (URL template,
//                          CRS, datum, totals) — the tile rows only name a key
//   lidar-coverage.geojson project coverage on a 0.05° cell grid, drawn at
//                          every zoom; the tiles themselves come from the parquet
//
// Why this shape (the s2-stac-geoparquet lesson): a viewport search must touch
// a FEW row groups. Rows are sorted on a Hilbert key of the tile centre, so
// tiles near each other on the ground are near each other in the file, and the
// writer's per-row-group min/max statistics on xmin/ymin/xmax/ymax let the
// reader skip every group whose box cannot meet the view. The geometry column
// is for desktop tools (DuckDB, QGIS, GDAL); the browser never decodes it.
//
// Footprints are projected with proj4 and NO datum shift (NAD83(CSRS) taken as
// WGS84). That is ~1.4 m in Nova Scotia — invisible on a 1 km tile footprint,
// and this index only answers "which files cover here?".

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import proj4 from 'proj4';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { projDef } from '../src/crs.ts';

const round = (v) => Math.round(v * 1e6) / 1e6;

const ROW_GROUP = 512;
const CELL_DEG = 0.05;
// Canada, padded: the Hilbert grid's frame. Anything outside clamps to the edge.
const FRAME = [-142, 41, -52, 84];
const HILBERT_ORDER = 16;

const sources = process.argv.slice(2);
if (!sources.length) sources.push('data-src/nrcan-canelevation-ns.json');

/** Hilbert index of (x, y) on a 2^order grid. */
export function hilbert(x, y, order = HILBERT_ORDER) {
  let d = 0;
  for (let s = 1 << (order - 1); s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      const t = x; x = y; y = t;
    }
  }
  return d;
}

function hilbertOf(lon, lat) {
  const n = 1 << HILBERT_ORDER;
  const gx = Math.min(n - 1, Math.max(0, Math.floor(((lon - FRAME[0]) / (FRAME[2] - FRAME[0])) * n)));
  const gy = Math.min(n - 1, Math.max(0, Math.floor(((lat - FRAME[1]) / (FRAME[3] - FRAME[1])) * n)));
  return hilbert(gx, gy);
}

const rows = [];
const projects = [];
const cells = new Map(); // projectId -> Set("i,j")

for (const file of sources) {
  const cat = JSON.parse(readFileSync(file, 'utf8'));
  for (const p of cat.projects) {
    const def = projDef(p.crs);
    if (!def) throw new Error(`${basename(file)}: project ${p.id} is in ${p.crs}, which src/crs.ts does not define — add it rather than guess`);
    const fwd = proj4(def, 'EPSG:4326');
    const fi = Object.fromEntries(p.fields.map((f, i) => [f, i]));
    const pcells = new Set();
    let points = 0, bytes = 0;
    const pb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const t of p.tiles) {
      const [x0, y0, x1, y1] = [t[fi.minx], t[fi.miny], t[fi.maxx], t[fi.maxy]];
      const ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(c => fwd.forward(c));
      const lons = ring.map(c => c[0]), lats = ring.map(c => c[1]);
      const box = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
      pb[0] = Math.min(pb[0], box[0]); pb[1] = Math.min(pb[1], box[1]);
      pb[2] = Math.max(pb[2], box[2]); pb[3] = Math.max(pb[3], box[3]);
      points += t[fi.points]; bytes += t[fi.bytes];
      rows.push({
        project: p.id, key: String(t[fi.name]), year: p.acquisitionYear,
        points: t[fi.points], bytes: t[fi.bytes],
        xmin: box[0], ymin: box[1], xmax: box[2], ymax: box[3],
        geometry: { type: 'Polygon', coordinates: [ring.map(c => [round(c[0]), round(c[1])])] },
        h: hilbertOf((box[0] + box[2]) / 2, (box[1] + box[3]) / 2),
      });
      for (let i = Math.floor(box[0] / CELL_DEG); i <= Math.floor(box[2] / CELL_DEG); i++)
        for (let j = Math.floor(box[1] / CELL_DEG); j <= Math.floor(box[3] / CELL_DEG); j++) pcells.add(`${i},${j}`);
    }
    cells.set(p.id, pcells);
    projects.push({
      id: p.id, label: p.label, jurisdiction: p.jurisdiction, year: p.acquisitionYear,
      crs: p.crs, verticalDatum: p.verticalDatum, provider: cat.provider, licence: cat.licence,
      urlTemplate: cat.baseUrl + p.keyTemplate, tiles: p.tiles.length, points, bytes,
      bbox: pb.map(round),
    });
  }
}


rows.sort((a, b) => a.h - b.h || a.project.localeCompare(b.project) || a.key.localeCompare(b.key));

const col = (name, type, pick) => ({ name, type, data: rows.map(pick) });
const bbox = [
  Math.min(...rows.map(r => r.xmin)), Math.min(...rows.map(r => r.ymin)),
  Math.max(...rows.map(r => r.xmax)), Math.max(...rows.map(r => r.ymax)),
];
const geo = {
  version: '1.1.0', primary_column: 'geometry',
  columns: {
    geometry: {
      encoding: 'WKB', geometry_types: ['Polygon'], crs: null, bbox,
      covering: { bbox: { xmin: ['xmin'], ymin: ['ymin'], xmax: ['xmax'], ymax: ['ymax'] } },
    },
  },
};

const buf = parquetWriteBuffer({
  columnData: [
    col('project', 'STRING', r => r.project),
    col('key', 'STRING', r => r.key),
    col('year', 'INT32', r => r.year),
    // DOUBLE, not INT64: hyparquet returns INT64 as BigInt, and a national
    // tile's counts are far inside 2^53.
    col('points', 'DOUBLE', r => r.points),
    col('bytes', 'DOUBLE', r => r.bytes),
    col('xmin', 'DOUBLE', r => r.xmin),
    col('ymin', 'DOUBLE', r => r.ymin),
    col('xmax', 'DOUBLE', r => r.xmax),
    col('ymax', 'DOUBLE', r => r.ymax),
    col('geometry', 'GEOMETRY', r => r.geometry),
  ],
  rowGroupSize: ROW_GROUP,
  statistics: true,
  kvMetadata: [{ key: 'geo', value: JSON.stringify(geo) }],
});

// Coverage: each project's occupied cells, merged into horizontal runs so a
// county is a few hundred rectangles rather than thousands.
const features = [];
for (const p of projects) {
  const byRow = new Map();
  for (const k of cells.get(p.id)) {
    const [i, j] = k.split(',').map(Number);
    if (!byRow.has(j)) byRow.set(j, []);
    byRow.get(j).push(i);
  }
  const polys = [];
  for (const [j, is] of byRow) {
    is.sort((a, b) => a - b);
    let start = is[0], prev = is[0];
    for (const i of [...is.slice(1), Infinity]) {
      if (i === prev + 1) { prev = i; continue; }
      const [x0, x1, y0, y1] = [start * CELL_DEG, (prev + 1) * CELL_DEG, j * CELL_DEG, (j + 1) * CELL_DEG].map(round);
      polys.push([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]);
      start = prev = i;
    }
  }
  features.push({
    type: 'Feature',
    properties: { project: p.id, label: p.label, year: p.year },
    geometry: { type: 'MultiPolygon', coordinates: polys },
  });
}

mkdirSync('public/data', { recursive: true });
writeFileSync('public/data/lidar-tiles.parquet', Buffer.from(buf));
writeFileSync('public/data/lidar-projects.json', JSON.stringify({ generated: new Date().toISOString().slice(0, 10), projects }, null, 1));
writeFileSync('public/data/lidar-coverage.geojson', JSON.stringify({ type: 'FeatureCollection', features }));

console.log(`${rows.length} tiles in ${Math.ceil(rows.length / ROW_GROUP)} row groups, ${(buf.byteLength / 1024).toFixed(0)} KiB; ${projects.length} projects`);
