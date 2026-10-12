// Study areas: a named piece of ground an analysis is run OVER, as in
// FieldMapper's HabLab. The analysis tools used to take "this view" — the
// map's bounding box at the moment the button was pressed — so a result
// could not be repeated, compared with another run, or confined to the
// parcel actually being studied.
//
// A study area is a polygon (drawn, a rectangle, or a view kept on purpose),
// saved in this browser under a name. A run records the area it was made on,
// by value, so a result still says what ground it covers after the area is
// renamed or deleted. The analysis grid is laid over the area's BOUNDING BOX
// and then MASKED to the polygon: pixels outside it are not part of any
// object, any cell or any class tally.
//
// Pure: no DOM, no MapLibre. Unit-tested in test/aoi.test.ts.

import type { LonLatBox } from './warp.ts';

/** How the polygon was made. */
export type AoiSource = 'view' | 'drawn' | 'rect';

export interface Aoi {
  id: string;
  name: string;
  /** One outer ring, closed, lon/lat (holes are allowed and honoured). */
  geometry: GeoJSON.Polygon;
  source: AoiSource;
  createdAt: string;
}

/** A pixel grid laid over a lon/lat box (segmentView's SegmentGrid satisfies it). */
export interface MaskGrid {
  w: number;
  h: number;
  box: LonLatBox;
  lonLat: (px: number, py: number) => [number, number];
}

const R = 6378137;

/** The polygon's lon/lat bounding box. */
export function aoiBox(g: GeoJSON.Polygon): LonLatBox {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of g.coordinates[0]) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return [w, s, e, n];
}

/** A box as a closed polygon. */
export function boxPolygon([w, s, e, n]: LonLatBox): GeoJSON.Polygon {
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

/** Planar ring area on a local equirectangular projection, m² (signed: counter-clockwise positive). */
function ringAreaM2(ring: GeoJSON.Position[], lat0: number): number {
  const kx = (Math.PI / 180) * R * Math.cos((lat0 * Math.PI) / 180), ky = (Math.PI / 180) * R;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * kx * ring[i][1] * ky - ring[i][0] * kx * ring[j][1] * ky;
  return a / 2;
}

/** Ground area of the polygon, m² (outer ring less holes). Good to well under 1 % at study-area sizes. */
export function aoiAreaM2(g: GeoJSON.Polygon): number {
  const b = aoiBox(g), lat0 = (b[1] + b[3]) / 2;
  const [outer, ...holes] = g.coordinates;
  return Math.max(0, Math.abs(ringAreaM2(outer, lat0)) - holes.reduce((s, h) => s + Math.abs(ringAreaM2(h, lat0)), 0));
}

/** "12.4 ha" under a square kilometre, "3.21 km²" above. */
export function fmtArea(m2: number): string {
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(m2 >= 1e7 ? 1 : 2)} km²`;
  const ha = m2 / 1e4;
  return `${ha >= 100 ? ha.toFixed(0) : ha >= 10 ? ha.toFixed(1) : ha.toFixed(2)} ha`;
}

/** Even–odd point in polygon (holes included). */
export function pointInAoi(g: GeoJSON.Polygon, lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of g.coordinates) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * 1 for every grid pixel whose CENTRE lies in the polygon, else 0. A
 * scanline fill: per row, the crossings of every edge with the row's
 * latitude, filled pairwise (even–odd, so holes come out). The grid's
 * columns are linear in longitude, which is what lets a crossing become a
 * column index directly; its rows may be any monotone latitude spacing
 * (segmentView's are linear in Web Mercator).
 */
export function polygonMask(grid: MaskGrid, g: GeoJSON.Polygon): Uint8Array {
  const { w, h, box } = grid;
  const mask = new Uint8Array(w * h);
  const dx = (box[2] - box[0]) / w;
  const xs: number[] = [];
  for (let py = 0; py < h; py++) {
    const lat = grid.lonLat(0.5, py + 0.5)[1];
    xs.length = 0;
    for (const ring of g.coordinates) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat)) xs.push(xi + ((lat - yi) * (xj - xi)) / (yj - yi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // Columns whose centre lon box0 + (px + 0.5)·dx lies in [xs[k], xs[k+1]).
      const c0 = Math.max(0, Math.ceil((xs[k] - box[0]) / dx - 0.5));
      const c1 = Math.min(w - 1, Math.ceil((xs[k + 1] - box[0]) / dx - 0.5) - 1);
      for (let px = c0; px <= c1; px++) mask[py * w + px] = 1;
    }
  }
  return mask;
}

/**
 * Drop every labelled pixel outside the mask and renumber what is left
 * 0…count−1 in first-seen order, so an object that lay wholly outside the
 * area does not survive as an empty record, and one cut by the boundary
 * keeps only its inside pixels (its attributes are then averaged over those).
 */
export function maskLabels(labels: Int32Array, mask: Uint8Array): { labels: Int32Array; count: number } {
  const out = new Int32Array(labels.length).fill(-1);
  const remap = new Map<number, number>();
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i];
    if (k < 0 || !mask[i]) continue;
    let r = remap.get(k);
    if (r === undefined) { r = remap.size; remap.set(k, r); }
    out[i] = r;
  }
  return { labels: out, count: remap.size };
}

/** "Name", or "Name 2", "Name 3"… — the first not already taken (case-insensitive). */
export function uniqueAoiName(existing: string[], base: string): string {
  const taken = new Set(existing.map(s => s.trim().toLowerCase()));
  const b = base.trim() || 'Study area';
  if (!taken.has(b.toLowerCase())) return b;
  for (let n = 2; ; n++) if (!taken.has(`${b} ${n}`.toLowerCase())) return `${b} ${n}`;
}

const finitePair = (p: unknown): p is [number, number] => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/**
 * A stored study area, or null when it cannot be one. Refused rather than
 * repaired: a ring with fewer than three distinct corners has no ground, and
 * an area quietly "fixed" would be ground nobody drew.
 */
export function parseAoi(v: unknown): Aoi | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const g = o.geometry as GeoJSON.Polygon | undefined;
  if (!g || g.type !== 'Polygon' || !Array.isArray(g.coordinates) || !g.coordinates.length) return null;
  const rings: GeoJSON.Position[][] = [];
  for (const ring of g.coordinates) {
    if (!Array.isArray(ring) || !ring.every(finitePair)) return null;
    rings.push(closeRing(ring.map(p => [p[0], p[1]])));
  }
  if (new Set(rings[0].slice(0, -1).map(p => `${p[0]},${p[1]}`)).size < 3) return null;
  const geometry: GeoJSON.Polygon = { type: 'Polygon', coordinates: rings };
  if (!(aoiAreaM2(geometry) > 0)) return null;
  const id = typeof o.id === 'string' && o.id ? o.id : null;
  if (!id) return null;
  const source: AoiSource = o.source === 'view' || o.source === 'rect' ? o.source : 'drawn';
  return {
    id, geometry, source,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : 'Study area',
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
  };
}

/** Every valid study area of a stored list, invalid entries dropped. */
export function parseAois(v: unknown): Aoi[] {
  return Array.isArray(v) ? v.map(parseAoi).filter((a): a is Aoi => a !== null) : [];
}

/** A ring with its first point repeated at the end. */
export function closeRing(ring: GeoJSON.Position[]): GeoJSON.Position[] {
  if (!ring.length) return ring;
  const [a, b] = [ring[0], ring[ring.length - 1]];
  return a[0] === b[0] && a[1] === b[1] ? ring : [...ring, [a[0], a[1]]];
}
