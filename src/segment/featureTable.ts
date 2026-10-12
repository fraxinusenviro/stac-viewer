// The multi-source FEATURE TABLE: one row per grid cell over the view, one
// column per variable, for analysis outside the viewer (DuckDB, QGIS,
// pandas, a model).
//
// The grid is Sentinel-2's own pixel lattice (10 or 20 m, in the scene's UTM
// CRS, aligned to its COG's origin), so the coarsest input is never
// resampled: each cell IS a Sentinel pixel (or four). Every finer input —
// the 1 m LiDAR rasters, the point-cloud metrics, the orthophoto — is
// sampled at 2 m and AGGREGATED into the cell: the mean of every input, plus
// canopy-height P90 and spread, photo texture, and the share of the cell in
// each class of the selected rules or strata. Each row also carries H3 ids
// (resolution 13, ~44 m², the cell's centre; and resolution 11, ~2 150 m², for
// roll-ups and joins with other H3 data).
//
// Written as GeoParquet 1.1 (cell polygons in lon/lat, WKB) or CSV. A cell
// less than half covered by the view is left out.

import proj4 from 'proj4';
import { projDef } from '../crs.ts';
import { openFile, sampleGrid, type InputSource } from '../engine.ts';
import { FUSION_VARIABLES, type Product, type ProductStyle } from '../products.ts';
import { controlGrid, interpGrid, type LonLatBox } from '../warp.ts';
import { objectPlanes } from './objects.ts';
import { mercatorGrid } from './segmentView.ts';

import type { FeatureTable, TableColumn } from './featureTableExport.ts';
export type { FeatureTable, TableColumn } from './featureTableExport.ts';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

export async function buildFeatureTable(box: LonLatBox, sources: Record<string, InputSource>, cellM: 10 | 20, product: Product | null, style: ProductStyle | null, stage: (m: string) => void): Promise<FeatureTable> {
  // The lattice: the Sentinel-2 scene's own, when there is one.
  let epsg: number, originX = 0, originY = 0, lattice: string;
  const s2 = sources['s2:nir'] ?? sources['s2:red'];
  if (s2) {
    const f = await openFile(s2.url);
    epsg = f.epsg; originX = f.geo.originX; originY = f.geo.originY;
    lattice = `Sentinel-2 pixel lattice, EPSG:${epsg}`;
  } else {
    const lon = (box[0] + box[2]) / 2;
    epsg = 32600 + Math.floor((lon + 180) / 6) + 1;
    lattice = `UTM grid (no Sentinel-2 scene chosen), EPSG:${epsg}`;
  }
  const def = projDef(epsg);
  if (!def) throw new Error(`EPSG:${epsg} is not defined here`);
  const conv = proj4('EPSG:4326', def);
  const grid = mercatorGrid(box, 2);
  if (grid.cellM > 4) throw new Error(`the view is too large for a feature table (it would sample at ${grid.cellM.toFixed(0)} m) — zoom in to about level 15`);
  stage(`Reading every input over the view at ${grid.cellM.toFixed(1)} m…`);
  const planes = await sampleGrid(sources, grid, product?.sharpen);
  stage('Aggregating into cells…');
  await new Promise(r => setTimeout(r, 0));
  // Each 2 m pixel → its cell, through warp.ts's control grid (exact at the control points).
  const cg = controlGrid(grid, q => conv.forward(q) as [number, number], { originX, originY, resX: cellM, resY: -cellM });
  const n = grid.w * grid.h;
  const index = new Map<string, number>();
  const cells: { ix: number; iy: number }[] = [];
  const label = new Int32Array(n);
  const p: [number, number] = [0, 0];
  for (let py = 0; py < grid.h; py++) for (let px = 0; px < grid.w; px++) {
    interpGrid(cg, px + 0.5, py + 0.5, p);
    const ix = Math.floor(p[0]), iy = Math.floor(p[1]), key = `${ix},${iy}`;
    let k = index.get(key);
    if (k === undefined) { k = cells.length; index.set(key, k); cells.push({ ix, iy }); }
    label[py * grid.w + px] = k;
  }
  const objs = objectPlanes(label, cells.length, grid.w, grid.h, planes, grid.cellM);
  // A cell's full pixel count, for its coverage.
  const full = (cellM * cellM) / (grid.cellM * grid.cellM);
  const keep = cells.map((_, k) => objs.sizes[k] / full >= 0.5);
  const rowOfCell = new Int32Array(cells.length).fill(-1);
  const rows: FeatureTable['rows'] = [];
  cells.forEach((c, k) => { if (keep[k]) { rowOfCell[k] = rows.length; rows.push({ ...c, coverage: Math.min(1, objs.sizes[k] / full) }); } });
  const pick = (a: Float32Array) => { const o = new Float32Array(rows.length); cells.forEach((_, k) => { if (rowOfCell[k] >= 0) o[rowOfCell[k]] = a[k]; }); return o; };
  // Every variable that can be evaluated on the cells (the object measures that mean nothing for a fixed cell are left out).
  const have = new Set(Object.keys(objs.planes));
  const st = style ?? ({ ranges: [], curve: 'linear', gamma: 1, thresholds: {}, zFactor: 1, azimuth: 315 } as unknown as ProductStyle);
  const columns: TableColumn[] = [];
  for (const v of FUSION_VARIABLES) {
    if (v.sharpenKeys || v.id === 'obj_area' || v.id === 'obj_compact' || !v.inputs.every(k => have.has(k))) continue;
    const vals = new Float32Array(cells.length);
    for (let k = 0; k < cells.length; k++) vals[k] = v.channel.fn(objs.planes, k, st);
    const out = pick(vals);
    if (out.some(Number.isFinite)) columns.push({ name: v.id, label: v.label, values: out });
  }
  // Class shares from the per-pixel classification.
  const shares: TableColumn[] = [];
  if (product?.classes && style) {
    const fn = product.channels[0].fn;
    const counts = new Map<number, Float32Array>();
    const classified = new Float32Array(cells.length);
    for (let i = 0; i < n; i++) {
      const c = fn(planes, i, style);
      if (c !== c) continue;
      const k = label[i];
      (counts.get(c) ?? counts.set(c, new Float32Array(cells.length)).get(c)!)[k]++;
      classified[k]++;
    }
    for (const cls of product.classes) {
      const a = counts.get(cls.value);
      if (!a) continue;
      const share = new Float32Array(cells.length);
      for (let k = 0; k < cells.length; k++) share[k] = objs.sizes[k] ? a[k] / objs.sizes[k] : NaN;
      shares.push({ name: `share_${slug(cls.label)}`, label: `Share: ${cls.label}`, values: pick(share) });
    }
  }
  const rowOf = new Int32Array(n);
  for (let i = 0; i < n; i++) rowOf[i] = rowOfCell[label[i]];
  return { epsg, cellM, originX, originY, rows, columns, shares, grid, rowOf, lattice };
}

