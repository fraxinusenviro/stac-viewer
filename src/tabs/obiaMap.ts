// The OBIA tab's map layers: input previews (RGB, CHM), the objects (edges
// and a fill chosen by the step), the quality mask, source footprints, the
// Sentinel native-pixel grid and imported references. Raster layers are
// image sources placed by the analysis grid's four corners (the grid is UTM,
// the map Web Mercator; over a study area the warp between them is far below
// a pixel).

import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { gridCornersLonLat, gridXY, type AnalysisGrid, type Projector } from '../obia/grid.ts';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
export const RASTERS = ['obia-rgb', 'obia-chm', 'obia-quality', 'obia-objects'] as const;
export type RasterLayer = typeof RASTERS[number];

export function addObiaLayers(map: MlMap) {
  for (const id of ['obia-footprints', 'obia-s2grid', 'obia-refs']) map.addSource(id, { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'obia-s2grid', type: 'line', source: 'obia-s2grid', paint: { 'line-color': '#e66101', 'line-width': 0.8, 'line-opacity': 0.8 }, layout: { visibility: 'none' } });
  map.addLayer({ id: 'obia-refs', type: 'line', source: 'obia-refs', paint: { 'line-color': '#5e3c99', 'line-width': 2, 'line-dasharray': [1, 1] } });
  map.addLayer({ id: 'obia-footprints', type: 'line', source: 'obia-footprints', paint: { 'line-color': ['get', 'colour'], 'line-width': 1.5, 'line-dasharray': [3, 2] } });
}

export function setGeoJSON(map: MlMap, id: string, fc: GeoJSON.FeatureCollection) {
  (map.getSource(id) as GeoJSONSource | undefined)?.setData(fc);
}

export function showImage(map: MlMap, id: RasterLayer, img: ImageData | string, g: AnalysisGrid, proj: Projector, opacity: number, visible: boolean) {
  let url: string;
  if (typeof img === 'string') url = img;
  else {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
    url = c.toDataURL('image/png');
  }
  const coordinates = gridCornersLonLat(g, proj);
  // Replaced rather than updateImage()d: an update while the previous image is
  // still decoding aborts it with an uncatchable rejection.
  const op = map.getLayer(id) ? (map.getPaintProperty(id, 'raster-opacity') as number) : opacity;
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
  map.addSource(id, { type: 'image', url, coordinates });
  map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': op, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, 'obia-s2grid');
  // Keep the stacking RGB < CHM < quality < objects whatever order they arrive in.
  for (const r of RASTERS) if (map.getLayer(r)) map.moveLayer(r, 'obia-s2grid');
  map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  return url;
}

export function removeImage(map: MlMap, id: RasterLayer) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}

/** RGB planes (0–255) as an image; NaN transparent. */
export function rgbImage(r: Float32Array, g: Float32Array, b: Float32Array, w: number, h: number): ImageData {
  const img = new ImageData(w, h), d = img.data;
  for (let i = 0; i < w * h; i++) { if (r[i] !== r[i]) continue; d[4 * i] = r[i]; d[4 * i + 1] = g[i]; d[4 * i + 2] = b[i]; d[4 * i + 3] = 255; }
  return img;
}

const CANOPY = [[247, 252, 245], [199, 233, 192], [116, 196, 118], [35, 139, 69], [0, 68, 27]];
/** CHM 0–25 m on a green ramp; NaN transparent. */
export function chmImage(chm: Float32Array, w: number, h: number): ImageData {
  const img = new ImageData(w, h), d = img.data;
  for (let i = 0; i < w * h; i++) {
    const v = chm[i];
    if (v !== v) continue;
    const t = Math.max(0, Math.min(1, v / 25)) * (CANOPY.length - 1), k = Math.min(CANOPY.length - 2, Math.floor(t)), f = t - k;
    for (let c = 0; c < 3; c++) d[4 * i + c] = CANOPY[k][c] + (CANOPY[k + 1][c] - CANOPY[k][c]) * f;
    d[4 * i + 3] = 255;
  }
  return img;
}

/** Missing inputs inside the study area: red = no imagery, blue = no CHM, purple = neither. */
export function qualityImage(rgbOk: Uint8Array | null, chmOk: Uint8Array | null, mask: Uint8Array, w: number, h: number): ImageData {
  const img = new ImageData(w, h), d = img.data;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    const noR = rgbOk ? !rgbOk[i] : false, noC = chmOk ? !chmOk[i] : false;
    if (!noR && !noC) continue;
    d[4 * i] = noR ? 220 : 60; d[4 * i + 1] = 40; d[4 * i + 2] = noC ? 220 : 60; d[4 * i + 3] = 200;
  }
  return img;
}

const hex = (c: string) => [1, 3, 5].map(k => parseInt(c.slice(k, k + 2), 16));

/**
 * The objects: dark edges, an optional fill per object, a bright outline on
 * selected objects.
 */
export function objectsImage(labels: Int32Array, w: number, h: number, fillOf: (k: number) => string | null, selected: Set<number>, fillAlpha = 170): ImageData {
  const img = new ImageData(w, h), d = img.data;
  const cache = new Map<string, number[]>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, k = labels[i];
    if (k < 0) continue;
    // One pixel per boundary (the right/bottom side of each edge), not two.
    const edge = (x < w - 1 && labels[i + 1] !== k) || (y < h - 1 && labels[i + w] !== k);
    if (selected.has(k) && edge) { d[4 * i] = 255; d[4 * i + 1] = 230; d[4 * i + 2] = 0; d[4 * i + 3] = 255; continue; }
    if (edge) { d[4 * i] = 25; d[4 * i + 1] = 25; d[4 * i + 2] = 25; d[4 * i + 3] = 170; continue; }
    const f = fillOf(k);
    if (f) { const c = cache.get(f) ?? (cache.set(f, hex(f)), cache.get(f)!); d[4 * i] = c[0]; d[4 * i + 1] = c[1]; d[4 * i + 2] = c[2]; d[4 * i + 3] = selected.has(k) ? 230 : fillAlpha; }
    else if (selected.has(k)) { d[4 * i] = 255; d[4 * i + 1] = 230; d[4 * i + 2] = 0; d[4 * i + 3] = 90; }
  }
  return img;
}

/** Native pixel edges of a raster over a projected box, as lon/lat lines (capped). */
export function nativeGridLines(origin: [number, number], res: number, epsg: number, box: [number, number, number, number], toLonLat: (xy: [number, number]) => [number, number], maxLines = 600): GeoJSON.FeatureCollection {
  void epsg;
  const c0 = Math.floor((box[0] - origin[0]) / res), c1 = Math.ceil((box[2] - origin[0]) / res);
  const r0 = Math.floor((origin[1] - box[3]) / res), r1 = Math.ceil((origin[1] - box[1]) / res);
  if ((c1 - c0) + (r1 - r0) > maxLines) return { type: 'FeatureCollection', features: [] };
  const x = (c: number) => origin[0] + c * res, y = (r: number) => origin[1] - r * res;
  const features: GeoJSON.Feature[] = [];
  for (let c = c0; c <= c1; c++) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [toLonLat([x(c), y(r0)]), toLonLat([x(c), y(r1)])] } });
  for (let r = r0; r <= r1; r++) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [toLonLat([x(c0), y(r)]), toLonLat([x(c1), y(r)])] } });
  return { type: 'FeatureCollection', features };
}

/** The pixel index of a lon/lat on the grid, or −1. */
export function pixelOfLonLat(g: AnalysisGrid, proj: Projector, lon: number, lat: number): number {
  const [x, y] = proj.forward([lon, lat]);
  const col = Math.floor((x - g.transform[0]) / g.transform[1]), row = Math.floor((y - g.transform[3]) / g.transform[5]);
  return col < 0 || row < 0 || col >= g.width || row >= g.height ? -1 : row * g.width + col;
}

export { gridXY };
