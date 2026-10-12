// "Segment this view": sample every input over the view on one fine grid,
// segment it (slic.ts), turn the segments into objects and classify them with
// the product the pixel map uses (objects.ts), and draw the result as one
// image over the map with the object boundaries in it.
//
// A view, not map tiles, because a segment does not stop at a tile edge. The
// grid is linear in Web Mercator, so the image lies on the map exactly, and
// its pixels are square on the ground (2 m wherever the view is small enough,
// coarser past ~1.2 M pixels; refused past 8 m — zoom in).
//
// Segments are drawn on canopy height and, when there is one, the
// orthophoto's brightness and greenness — the structure and the sub-metre
// picture, not the 10 m imagery, which would draw 10 m squares.

import { sampleGrid, type InputSource } from '../engine.ts';
import { FUSION_VARIABLES, type Planes, type Product, type ProductStyle } from '../products.ts';
import type { LonLatBox, OutGrid } from '../warp.ts';
import { mergeRegions, slic } from './slic.ts';
import { crowns, smooth3 } from './crowns.ts';
import { classifyObjects, objectPlanes, ringsToPolygons, traceRings, type ObjectSet } from './objects.ts';

export interface SegmentParams {
  /** Patches (superpixels merged) or tree crowns (canopy height model). */
  method: 'patches' | 'crowns';
  /** The height an object's stratum and height rules read: its mean canopy height, or its 90th percentile. */
  heightStat: 'mean' | 'p90';
  /** Crowns: minimum tree height, m. */
  minTreeM: number;
  /** Superpixel size, metres. */
  sizeM: number;
  /** Merge tolerance for a lone superpixel, in feature units (0: no merging). */
  merge: number;
  /** Space against features (SLIC compactness). */
  compactness: number;
}
export const DEFAULT_SEGMENT: SegmentParams = { method: 'patches', heightStat: 'mean', minTreeM: 3, sizeM: 12, merge: 0.6, compactness: 1.2 };

export interface SegmentGrid extends OutGrid { box: LonLatBox; cellM: number }

export interface SegmentResult {
  grid: SegmentGrid;
  labels: Int32Array;
  count: number;
  objs: ObjectSet;
  product: Product | null;
  classes: Float32Array | null;
  /** Which features drew the segments. */
  features: string[];
}

const MAX_PX = 1_200_000;
const R = 6378137;
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const latOf = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y / R)) - 90;

/** A grid over a lon/lat box, linear in Web Mercator, with square cells of ~cellM on the ground. */
export function mercatorGrid(box: LonLatBox, minCellM = 2): SegmentGrid {
  const lat = (box[1] + box[3]) / 2, k = Math.cos((lat * Math.PI) / 180);
  const wM = ((box[2] - box[0]) * Math.PI / 180) * R * k, hM = (mercY(box[3]) - mercY(box[1])) * k;
  const cellM = Math.max(minCellM, Math.sqrt((wM * hM) / MAX_PX));
  const w = Math.max(8, Math.round(wM / cellM)), h = Math.max(8, Math.round(hM / cellM));
  const y0 = mercY(box[3]), y1 = mercY(box[1]);
  return { w, h, box, cellM, lonLat: (px, py) => [box[0] + (px / w) * (box[2] - box[0]), latOf(y0 + (py / h) * (y1 - y0))] };
}

/** The grid pixel under a lon/lat, or −1. */
export function pixelAt(g: SegmentGrid, lon: number, lat: number): number {
  const px = Math.floor(((lon - g.box[0]) / (g.box[2] - g.box[0])) * g.w);
  const py = Math.floor(((mercY(g.box[3]) - mercY(lat)) / (mercY(g.box[3]) - mercY(g.box[1]))) * g.h);
  return px < 0 || py < 0 || px >= g.w || py >= g.h ? -1 : py * g.w + px;
}

/** 3 × 3 NaN-aware mean. */
function boxMean(f: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(f.length).fill(NaN);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (f[y * w + x] !== f[y * w + x]) continue;
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const v = f[yy * w + xx];
      if (v === v) { s += v; n++; }
    }
    out[y * w + x] = s / n;
  }
  return out;
}

/** Segmentation features, each scaled so one unit is a meaningful difference. */
function featuresOf(p: Planes, n: number): { list: Float32Array[]; names: string[] } {
  const list: Float32Array[] = [], names: string[] = [];
  if (p['lidar:dsm'] && p['lidar:dtm']) {
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) { const d = p['lidar:dsm'][i] - p['lidar:dtm'][i]; f[i] = d === d ? Math.min(30, Math.max(0, d)) / 3 : NaN; }
    list.push(f); names.push('canopy height (per 3 m)');
  }
  if (p['ortho:r'] && p['ortho:g'] && p['ortho:b']) {
    const br = new Float32Array(n), ex = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = p['ortho:r'][i], g = p['ortho:g'][i], b = p['ortho:b'][i], t = r + g + b;
      br[i] = t / 765 / 0.06;
      ex[i] = t >= 15 ? (2 * g - r - b) / t / 0.05 : NaN;
    }
    list.push(br, ex); names.push('photo brightness (per 6 %)', 'photo excess green (per 0.05)');
  }
  return { list, names };
}

export async function segmentView(box: LonLatBox, sources: Record<string, InputSource>, product: Product | null, style: ProductStyle | null, params: SegmentParams, stage: (msg: string) => void): Promise<SegmentResult> {
  const crownMode = params.method === 'crowns';
  const grid = mercatorGrid(box, crownMode ? 1 : 2);
  if (crownMode && grid.cellM > 1.5) throw new Error(`crowns need ~1 m pixels and this view would get ${grid.cellM.toFixed(1)} m — zoom in to about level 17`);
  if (grid.cellM > 8) throw new Error(`the view is too large to segment (it would need ${grid.cellM.toFixed(0)} m pixels) — zoom in to about level 15`);
  stage(`Reading every input over the view at ${grid.cellM.toFixed(1)} m (${grid.w} × ${grid.h} pixels)…`);
  const planes = await sampleGrid(sources, grid, product?.sharpen);
  const n = grid.w * grid.h;
  let merged: { labels: Int32Array; count: number }, names: string[];
  stage(crownMode ? 'Finding treetops and growing crowns…' : 'Segmenting…');
  await new Promise(r => setTimeout(r, 0));
  if (crownMode) {
    if (!planes['lidar:dsm'] || !planes['lidar:dtm']) throw new Error('crowns need the LiDAR canopy height model');
    const chm = new Float32Array(n);
    for (let i = 0; i < n; i++) { const d = planes['lidar:dsm'][i] - planes['lidar:dtm'][i]; chm[i] = d === d ? Math.max(0, d) : NaN; }
    merged = crowns(smooth3(chm, grid.w, grid.h), grid.w, grid.h, { cellM: grid.cellM, minTreeM: params.minTreeM, seedFrac: 0.45 });
    names = ['tree crowns from the canopy height model'];
  } else {
    const f = featuresOf(planes, n);
    if (!f.list.length) throw new Error('nothing to segment on: needs the LiDAR (canopy height) or an orthophoto');
    const step = params.sizeM / grid.cellM;
    // A 3 × 3 mean first: pixel-to-pixel photo noise otherwise makes ragged, stringy segments.
    const smooth = f.list.map(x => boxMean(x, grid.w, grid.h));
    const sp = slic(smooth, grid.w, grid.h, { step, compactness: params.compactness });
    merged = mergeRegions(sp.labels, sp.count, grid.w, grid.h, smooth, params.merge * step * step);
    names = f.names;
  }
  const objs = objectPlanes(merged.labels, merged.count, grid.w, grid.h, planes, grid.cellM);
  if (params.heightStat === 'p90') useP90Height(objs);
  const classes = product?.classes && style ? classifyObjects(product, objs, style) : null;
  return { grid, labels: merged.labels, count: merged.count, objs, product, classes, features: names };
}

/**
 * Make an object's canopy height its 90th percentile rather than its mean:
 * the surface is raised so DSM − DTM reads P90 for every rule, stratum and
 * attribute. A stand with gaps is then classed by its canopy, not by the
 * average of canopy and gaps.
 */
export function useP90Height(objs: ObjectSet) {
  const dsm = objs.planes['lidar:dsm'], dtm = objs.planes['lidar:dtm'], p90 = objs.planes['obj:chm_p90'];
  if (!dsm || !dtm || !p90) return;
  const out = dsm.slice();
  for (let k = 0; k < out.length; k++) if (p90[k] === p90[k] && dtm[k] === dtm[k]) out[k] = dtm[k] + p90[k];
  objs.planes['lidar:dsm'] = out;
}

/** The result as an RGBA image: class colours (or none) with the object boundaries drawn dark. */
export function segmentImage(r: SegmentResult, fill: boolean): ImageData {
  const { w, h } = r.grid;
  const img = new ImageData(w, h);
  const hex = (c: string) => [1, 3, 5].map(k => parseInt(c.slice(k, k + 2), 16));
  const colour = new Map((r.product?.classes ?? []).map(c => [c.value, hex(c.colour)]));
  const L = r.labels, d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, k = L[i];
    if (k < 0) continue;
    const edge = (x < w - 1 && L[i + 1] !== k) || (y < h - 1 && L[i + w] !== k);
    if (edge) { d[4 * i] = 30; d[4 * i + 1] = 30; d[4 * i + 2] = 30; d[4 * i + 3] = fill ? 110 : 200; continue; }
    const c = fill && r.classes ? colour.get(r.classes[k]) : undefined;
    if (c) { d[4 * i] = c[0]; d[4 * i + 1] = c[1]; d[4 * i + 2] = c[2]; d[4 * i + 3] = 255; }
  }
  return img;
}

/** Area share (0–1) of each class value, over the classified objects. */
export function classShares(r: SegmentResult): Map<number, number> {
  const out = new Map<number, number>();
  if (!r.classes) return out;
  let total = 0;
  for (let k = 0; k < r.count; k++) { const c = r.classes[k]; if (c === c) { out.set(c, (out.get(c) ?? 0) + r.objs.sizes[k]); total += r.objs.sizes[k]; } }
  for (const [c, v] of out) out.set(c, total ? v / total : 0);
  return out;
}

/** Every variable that can be evaluated on these objects, with its value per object. */
export function objectAttributes(r: SegmentResult, style: ProductStyle): { id: string; label: string; values: Float32Array }[] {
  const have = new Set(Object.keys(r.objs.planes));
  return FUSION_VARIABLES
    .filter(v => !v.sharpenKeys && v.inputs.every(k => have.has(k)))
    .map(v => {
      const values = new Float32Array(r.count);
      for (let k = 0; k < r.count; k++) values[k] = v.channel.fn(r.objs.planes, k, style);
      return { id: v.id, label: v.label, values };
    })
    .filter(a => a.values.some(Number.isFinite));
}

/** The objects as GeoJSON polygons, each carrying its class and every attribute. */
export function segmentGeoJSON(r: SegmentResult, style: ProductStyle): GeoJSON.FeatureCollection {
  const attrs = objectAttributes(r, style);
  const label = new Map((r.product?.classes ?? []).map(c => [c.value, c.label]));
  const rings = traceRings(r.labels, r.grid.w, r.grid.h);
  const round = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);
  const features: GeoJSON.Feature[] = [];
  for (const [k, rs] of rings) {
    const polys = ringsToPolygons(rs).map(poly => poly.map(ring => ring.map(([x, y]) => r.grid.lonLat(x, y))));
    const props: Record<string, string | number | null> = { id: k, class: r.classes ? label.get(r.classes[k]) ?? null : null, area_m2: round(r.objs.planes['obj:area'][k]) };
    for (const a of attrs) props[a.id] = round(a.values[k]);
    features.push({ type: 'Feature', properties: props, geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys } });
  }
  return { type: 'FeatureCollection', features };
}
