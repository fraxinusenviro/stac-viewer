// The two live STAC APIs the viewer searches straight from the browser — both
// answer with CORS `*`, and their assets are COGs on S3 buckets that allow
// ranged reads from any origin (checked 2026-10-10).
//
//  - NRCan datacube STAC: HRDEM 1 m DTM/DSM, per LiDAR project and as the
//    national 1 m / 2 m mosaics, EPSG:3979, heights on CGVD2013.
//  - Element 84 Earth Search: Sentinel-2 Collection 1 Level-2A, UTM COGs.
//
// Parsing is pure (`parseHrdem`, `parseS2`) and unit-tested; the fetches are not.

import type { LonLatBox } from './lidarIndex.ts';

export const HRDEM_STAC = 'https://datacube.services.geo.ca/stac/api';
export const HRDEM_COLLECTIONS = ['hrdem-lidar', 'hrdem-mosaic-1m', 'hrdem-mosaic-2m'] as const;
export const EARTH_SEARCH = 'https://earth-search.aws.element84.com/v1';
export const S2_COLLECTION = 'sentinel-2-c1-l2a';

interface StacFeature {
  id: string;
  collection?: string;
  bbox?: number[];
  geometry?: GeoJSON.Geometry;
  properties?: Record<string, unknown>;
  assets?: Record<string, { href?: string; 'raster:bands'?: { scale?: number; offset?: number; nodata?: number }[] }>;
}

export interface HrdemItem {
  id: string;
  collection: string;
  kind: 'project' | 'mosaic-1m' | 'mosaic-2m';
  datetime: string | null;
  dtm: string;
  dsm: string | null;
  thumbnail: string | null;
  /** The project's TRUE coverage (a lon/lat GeoJSON Feature on S3); the STAC geometry is only its envelope. */
  extent: string | null;
  bbox: LonLatBox | null;
  geometry: GeoJSON.Geometry | null;
}

export interface S2Asset {
  href: string;
  scale: number;
  offset: number;
  nodata: number | null;
  /** Where scale/offset came from: the item's own raster:bands, or the baseline rule. */
  from: 'stac' | 'baseline' | 'none';
}

/** Reflectance assets (uint16 DN; reflectance = DN × scale + offset). */
const REFLECTANCE = new Set(['coastal', 'blue', 'green', 'red', 'rededge1', 'rededge2', 'rededge3', 'nir', 'nir08', 'nir09', 'swir16', 'swir22']);

/**
 * How one asset's DN becomes a value. The item's own `raster:bands` wins.
 * Without it, a reflectance band takes 0.0001 and the BOA offset ESA adds
 * from processing baseline 04.00 (January 2022): DN = 10000 ρ + 1000, so
 * offset −0.1. A row with no baseline gets no offset. Pure.
 */
export function s2AssetScaling(key: string, rb: { scale?: number; offset?: number; nodata?: number } | undefined, baseline: string | null): Omit<S2Asset, 'href'> {
  if (rb && (rb.scale !== undefined || rb.offset !== undefined)) {
    return { scale: rb.scale ?? 1, offset: rb.offset ?? 0, nodata: rb.nodata ?? 0, from: 'stac' };
  }
  if (REFLECTANCE.has(key)) {
    const b = baseline ? parseFloat(baseline) : NaN;
    return { scale: 0.0001, offset: Number.isFinite(b) && b >= 4 ? -0.1 : 0, nodata: rb?.nodata ?? 0, from: Number.isFinite(b) ? 'baseline' : 'none' };
  }
  return { scale: 1, offset: 0, nodata: rb?.nodata ?? 0, from: 'stac' };
}

export interface S2Item {
  id: string;
  datetime: string;
  cloud: number | null;
  /** Percent of the tile with no data (the scene's swath edge). */
  nodata: number | null;
  mgrs: string | null;
  visual: string;
  /** Processing baseline (`s2:processing_baseline`), e.g. "05.13". */
  baseline: string | null;
  /** Every COG asset, with how its DN becomes a value. */
  assets: Record<string, S2Asset>;
  thumbnail: string | null;
  bbox: LonLatBox | null;
  geometry: GeoJSON.Geometry | null;
}

const RANK: Record<string, number> = { 'hrdem-lidar': 0, 'hrdem-mosaic-1m': 1, 'hrdem-mosaic-2m': 2 };

const box = (b?: number[]): LonLatBox | null => (b && b.length >= 4 ? [b[0], b[1], b[2], b[3]] : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** HRDEM items, per-project first (newest first), then the 1 m and 2 m mosaics. */
export function parseHrdem(json: unknown): HrdemItem[] {
  const feats = ((json as { features?: StacFeature[] })?.features ?? []);
  const out: HrdemItem[] = [];
  for (const f of feats) {
    const dtm = f.assets?.dtm?.href;
    if (!dtm || !f.collection || !(f.collection in RANK)) continue;
    out.push({
      id: f.id, collection: f.collection,
      kind: f.collection === 'hrdem-lidar' ? 'project' : (f.collection.replace('hrdem-', '') as HrdemItem['kind']),
      datetime: (f.properties?.datetime ?? f.properties?.start_datetime ?? null) as string | null,
      dtm, dsm: f.assets?.dsm?.href ?? null, thumbnail: f.assets?.thumbnail?.href ?? null,
      extent: f.assets?.extent?.href ?? null, bbox: box(f.bbox), geometry: f.geometry ?? null,
    });
  }
  return out.sort((a, b) => RANK[a.collection] - RANK[b.collection] || (b.datetime ?? '').localeCompare(a.datetime ?? ''));
}

/** Sentinel-2 scenes, newest first. A scene with no true-colour COG is dropped. */
export function parseS2(json: unknown): S2Item[] {
  const feats = ((json as { features?: StacFeature[] })?.features ?? []);
  const out: S2Item[] = [];
  for (const f of feats) {
    const visual = f.assets?.visual?.href;
    const dt = f.properties?.datetime as string | undefined;
    if (!visual || !dt) continue;
    const baseline = (f.properties?.['s2:processing_baseline'] as string | undefined) ?? null;
    const assets: Record<string, S2Asset> = {};
    for (const [k, a] of Object.entries(f.assets ?? {})) {
      if (!a.href || !/\.tif$/i.test(a.href)) continue;
      assets[k] = { href: a.href, ...s2AssetScaling(k, a['raster:bands']?.[0], baseline) };
    }
    out.push({
      id: f.id, datetime: dt, cloud: num(f.properties?.['eo:cloud_cover']),
      nodata: num(f.properties?.['s2:nodata_pixel_percentage']),
      mgrs: (f.properties?.['grid:code'] as string | undefined)?.replace(/^MGRS-/, '') ?? null,
      visual, baseline, assets, thumbnail: f.assets?.thumbnail?.href ?? null, bbox: box(f.bbox), geometry: f.geometry ?? null,
    });
  }
  return out.sort((a, b) => b.datetime.localeCompare(a.datetime));
}

/** A project's true coverage geometry, from its `extent` asset. */
export async function fetchExtent(href: string, signal?: AbortSignal): Promise<GeoJSON.Geometry> {
  const r = await fetch(href, { signal });
  if (!r.ok) throw new Error(`extent answered HTTP ${r.status}`);
  const j = await r.json() as GeoJSON.Feature | GeoJSON.FeatureCollection | GeoJSON.Geometry;
  if (j.type === 'Feature') return j.geometry;
  if (j.type === 'FeatureCollection') return { type: 'GeometryCollection', geometries: j.features.map(f => f.geometry) };
  return j;
}

function polygonsOf(g: GeoJSON.Geometry): GeoJSON.Position[][][] {
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  if (g.type === 'GeometryCollection') return g.geometries.flatMap(polygonsOf);
  return [];
}

function inRing(x: number, y: number, ring: GeoJSON.Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Whether a coverage geometry meets a box: a vertex of it inside the box, or a
 * box corner or centre inside it (holes respected). A polygon whose edge alone
 * crosses the box with no vertex in it and no sample point inside reads as
 * not touching — at a viewport's scale against a survey boundary, rare, and
 * the cost is one listing missed, never one invented. Pure.
 */
export function coverageTouches(g: GeoJSON.Geometry, b: LonLatBox): boolean {
  const pts: [number, number][] = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]];
  for (const poly of polygonsOf(g)) {
    for (const ring of poly) for (const [x, y] of ring) if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) return true;
    for (const [x, y] of pts) if (inRing(x, y, poly[0]) && !poly.slice(1).some(h => inRing(x, y, h))) return true;
  }
  return false;
}

const bboxParam = (b: LonLatBox) => b.map(v => v.toFixed(5)).join(',');

export async function searchHrdem(b: LonLatBox, signal?: AbortSignal): Promise<HrdemItem[]> {
  const url = `${HRDEM_STAC}/search?collections=${HRDEM_COLLECTIONS.join(',')}&bbox=${bboxParam(b)}&limit=100`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`NRCan STAC answered HTTP ${r.status}`);
  return parseHrdem(await r.json());
}

export interface S2Query {
  bbox: LonLatBox;
  from: string; // YYYY-MM-DD
  to: string;
  maxCloud: number;
  limit?: number;
}

export async function searchS2(q: S2Query, signal?: AbortSignal): Promise<S2Item[]> {
  const r = await fetch(`${EARTH_SEARCH}/search`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      collections: [S2_COLLECTION], bbox: q.bbox, limit: q.limit ?? 100,
      datetime: `${q.from}T00:00:00Z/${q.to}T23:59:59Z`,
      query: { 'eo:cloud_cover': { lte: q.maxCloud } },
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    }),
  });
  if (!r.ok) throw new Error(`Earth Search answered HTTP ${r.status}`);
  return parseS2(await r.json());
}

/** The HRDEM national-mosaic tiles meeting a box: 1 m where any exists, else 2 m. */
export async function searchHrdemMosaic(b: LonLatBox, signal?: AbortSignal): Promise<HrdemItem[]> {
  const url = `${HRDEM_STAC}/search?collections=hrdem-mosaic-1m,hrdem-mosaic-2m&bbox=${bboxParam(b)}&limit=50`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`NRCan STAC answered HTTP ${r.status}`);
  const items = parseHrdem(await r.json());
  const one = items.filter(i => i.kind === 'mosaic-1m');
  return one.length ? one : items.filter(i => i.kind === 'mosaic-2m');
}
