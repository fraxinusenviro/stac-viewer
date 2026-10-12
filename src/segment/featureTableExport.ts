// Writing a feature table (featureTable.ts): CSV and GeoParquet 1.1, with
// each cell's polygon and centre in lon/lat and its H3 ids. Kept apart from
// the builder so it imports nothing that needs a browser. Pure apart from the
// dynamic imports of h3-js and hyparquet-writer.

import proj4 from 'proj4';
import { projDef } from '../crs.ts';
import type { SegmentGrid } from './segmentView.ts';

export interface TableColumn { name: string; label: string; values: Float32Array }
export interface FeatureTable {
  epsg: number;
  cellM: number;
  /** Lattice origin (a Sentinel-2 pixel corner). */
  originX: number;
  originY: number;
  rows: { ix: number; iy: number; coverage: number }[];
  columns: TableColumn[];
  /** Class share columns (0–1), one per class present. */
  shares: TableColumn[];
  /** The 2 m sampling grid and, per pixel, its row (−1: none) — for drawing a column on the map. */
  grid: SegmentGrid;
  rowOf: Int32Array;
  lattice: string;
}

/** Cell geometry: centre and the four corners in lon/lat. */
function cellGeometry(t: FeatureTable, r: { ix: number; iy: number }, inv: (p: [number, number]) => [number, number]) {
  const x0 = t.originX + r.ix * t.cellM, y0 = t.originY - r.iy * t.cellM;
  const corners = [[x0, y0], [x0, y0 - t.cellM], [x0 + t.cellM, y0 - t.cellM], [x0 + t.cellM, y0], [x0, y0]].map(c => inv(c as [number, number]));
  return { cx: x0 + t.cellM / 2, cy: y0 - t.cellM / 2, centre: inv([x0 + t.cellM / 2, y0 - t.cellM / 2]), ring: corners };
}

/** Rows as plain records (the id, geometry columns, H3 ids, then every column). */
export async function tableRecords(t: FeatureTable) {
  const { latLngToCell } = await import('h3-js');
  const conv = proj4('EPSG:4326', projDef(t.epsg)!);
  const inv = (q: [number, number]) => conv.inverse(q) as [number, number];
  const all = [...t.columns, ...t.shares];
  return t.rows.map((r, j) => {
    const g = cellGeometry(t, r, inv);
    const rec: Record<string, string | number | null> = {
      cell_id: `${t.epsg}:${t.cellM}:${r.ix}:${r.iy}`, x: g.cx, y: g.cy, lon: g.centre[0], lat: g.centre[1],
      h3_r13: latLngToCell(g.centre[1], g.centre[0], 13), h3_r11: latLngToCell(g.centre[1], g.centre[0], 11), coverage: r.coverage,
    };
    for (const c of all) rec[c.name] = Number.isFinite(c.values[j]) ? c.values[j] : null;
    return { rec, ring: g.ring };
  });
}

/** CSV text (RFC 4180; numbers as written, blanks for missing). */
export async function tableCsv(t: FeatureTable): Promise<string> {
  const rows = await tableRecords(t);
  if (!rows.length) return '';
  const head = Object.keys(rows[0].rec);
  const cell = (v: string | number | null) => (v === null ? '' : typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [head.join(','), ...rows.map(r => head.map(k => cell(r.rec[k])).join(','))].join('\n');
}

/** GeoParquet 1.1 bytes: cell polygons in lon/lat (WKB), every column a DOUBLE or STRING. */
export async function tableGeoParquet(t: FeatureTable): Promise<ArrayBuffer> {
  const [{ parquetWriteBuffer }, rows] = await Promise.all([import('hyparquet-writer'), tableRecords(t)]);
  if (!rows.length) throw new Error('the table is empty');
  const keys = Object.keys(rows[0].rec);
  const columnData = keys.map(name => {
    const str = typeof rows[0].rec[name] === 'string';
    return { name, type: str ? 'STRING' as const : 'DOUBLE' as const, data: rows.map(r => r.rec[name]) };
  });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rows) for (const [x, y] of r.ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const geo = { version: '1.1.0', primary_column: 'geometry', columns: { geometry: { encoding: 'WKB', geometry_types: ['Polygon'], bbox: [x0, y0, x1, y1] } } };
  return parquetWriteBuffer({
    columnData: [...columnData, { name: 'geometry', type: 'GEOMETRY', data: rows.map(r => ({ type: 'Polygon', coordinates: [r.ring] })) }],
    kvMetadata: [{ key: 'geo', value: JSON.stringify(geo) }],
  } as Parameters<typeof parquetWriteBuffer>[0]);
}
