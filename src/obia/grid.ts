// The ANALYSIS GRID: a north-up grid in a metric projected CRS (UTM), over a
// study area plus a processing buffer, on which objects are segmented. It is
// the segmentation grid only — coarser predictors keep their own grids
// (sentinel.ts) and are never resampled onto it.
//
// Conventions (also docs/OBIA.md):
//  • transform: GDAL GeoTransform order, pixel CORNER (types.ts GridDefinition);
//  • pixel (col, row) covers [x0 + col·d, x0 + (col+1)·d) × (y0 − (row+1)·d, y0 − row·d];
//  • the origin is snapped to a whole multiple of the cell size, so two runs
//    over overlapping areas at one cell size share one lattice;
//  • lon/lat ⇄ grid goes through proj4 (crs.ts), with NAD83(CSRS) on a null
//    datum shift as everywhere in this viewer (~1.4 m from ITRF in Nova Scotia).
//
// Areas are planar areas in the projected CRS (UTM scale factor 0.9996–1.0010,
// so within 0.1 % of the ellipsoidal area); distances likewise.
//
// Pure apart from proj4. Unit-tested in test/obiaGrid.test.ts.

import proj4 from 'proj4';
import { projDef } from '../crs.ts';
import type { GridDefinition } from './types.ts';

export type Datum = 'wgs84' | 'csrs';

/** The UTM zone EPSG code for a lon/lat (north only: this viewer covers Canada). */
export function utmEpsgFor(lon: number, lat: number, datum: Datum): number {
  if (lat < 0) throw new Error('southern-hemisphere study areas are not supported');
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  if (datum === 'wgs84') return 32600 + zone;
  const csrs: Record<number, number> = { 7: 3154, 8: 3155, 9: 3156, 10: 3157, 11: 2955, 12: 2956, 13: 2957, 14: 3158, 15: 3159, 16: 3160, 17: 2958, 18: 2959, 19: 2960, 20: 2961, 21: 2962, 22: 3761 };
  if (!csrs[zone]) throw new Error(`NAD83(CSRS) UTM zone ${zone} is not defined here`);
  return csrs[zone];
}

export interface Projector {
  epsg: number;
  def: string;
  forward: (lonLat: [number, number]) => [number, number];
  inverse: (xy: [number, number]) => [number, number];
}

export function projector(epsg: number): Projector {
  const def = projDef(epsg);
  if (!def) throw new Error(`EPSG:${epsg} is not defined here`);
  const c = proj4('EPSG:4326', def);
  return { epsg, def, forward: p => c.forward(p) as [number, number], inverse: p => c.inverse(p) as [number, number] };
}

/** A polygon's rings projected to the CRS. */
export function projectPolygon(g: GeoJSON.Polygon, p: Projector): GeoJSON.Polygon {
  return { type: 'Polygon', coordinates: g.coordinates.map(r => r.map(q => p.forward([q[0], q[1]]))) };
}

export interface AnalysisGrid extends GridDefinition {
  epsg: number;
  cellM: number;
  /** Projected bounds [xmin, ymin, xmax, ymax] of the whole grid. */
  bounds: [number, number, number, number];
}

/**
 * A grid at `cellM` covering the projected study area plus `bufferM` on
 * every side, origin snapped to the cell lattice.
 */
export function analysisGrid(areaProjected: GeoJSON.Polygon, epsg: number, cellM: number, bufferM: number): AnalysisGrid {
  if (!(cellM > 0)) throw new Error('the cell size must be positive');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of areaProjected.coordinates[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  x0 = Math.floor((x0 - bufferM) / cellM) * cellM; y0 = Math.floor((y0 - bufferM) / cellM) * cellM;
  x1 = Math.ceil((x1 + bufferM) / cellM) * cellM; y1 = Math.ceil((y1 + bufferM) / cellM) * cellM;
  const width = Math.round((x1 - x0) / cellM), height = Math.round((y1 - y0) / cellM);
  return { crs: `EPSG:${epsg}`, epsg, cellM, transform: [x0, cellM, 0, y1, 0, -cellM], width, height, pixelConvention: 'area', bounds: [x0, y0, x1, y1] };
}

/** Projected coordinate of a (fractional) pixel position. (col, row) = (0, 0) is the top-left corner. */
export const gridXY = (g: GridDefinition, col: number, row: number): [number, number] =>
  [g.transform[0] + col * g.transform[1] + row * g.transform[2], g.transform[3] + col * g.transform[4] + row * g.transform[5]];

/** The pixel containing a projected coordinate, or −1. */
export function gridIndexOf(g: GridDefinition, x: number, y: number): number {
  const col = Math.floor((x - g.transform[0]) / g.transform[1]), row = Math.floor((y - g.transform[3]) / g.transform[5]);
  return col < 0 || row < 0 || col >= g.width || row >= g.height ? -1 : row * g.width + col;
}

/** The engine's OutGrid view of an analysis grid: lon/lat of a fractional pixel position. */
export function lonLatOf(g: AnalysisGrid, p: Projector) {
  return (px: number, py: number): [number, number] => p.inverse(gridXY(g, px, py));
}

/** The grid's four corners in lon/lat, [TL, TR, BR, BL] (a MapLibre image source's order). */
export function gridCornersLonLat(g: AnalysisGrid, p: Projector): [[number, number], [number, number], [number, number], [number, number]] {
  return [p.inverse(gridXY(g, 0, 0)), p.inverse(gridXY(g, g.width, 0)), p.inverse(gridXY(g, g.width, g.height)), p.inverse(gridXY(g, 0, g.height))];
}
