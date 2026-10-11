// The pure geometry of drawing a projected COG onto a lon/lat-addressed grid
// of output pixels — a Web Mercator map tile, or a sample grid over the view
// for statistics. No DOM, no network — unit-tested under `node --test`.
//
// The method is s2-stac-geoparquet's (cog.js): every output pixel is placed by
// inverse-mapping its own lon/lat into the source raster's pixel grid. Doing
// that through proj4 per pixel is 65 536 projections a tile, so the mapping is
// computed exactly on a coarse control grid and bilinearly interpolated
// between. UTM and Lambert are smooth, so across a 16-pixel cell the error is
// far below one source pixel.

export const TILE = 256;
/** Control-grid spacing, output pixels. */
export const CELL = 16;

export type LonLatBox = [number, number, number, number];

/** lon/lat of a Web Mercator pixel corner, at fractional tile coordinates. */
export function tileToLonLat(x: number, y: number, z: number): [number, number] {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}

/** The lon/lat box of tile z/x/y. */
export function tileBounds(z: number, x: number, y: number): LonLatBox {
  const [w, n] = tileToLonLat(x, y, z);
  const [e, s] = tileToLonLat(x + 1, y + 1, z);
  return [w, s, e, n];
}

/** Ground metres per output pixel at a latitude and zoom (for overview choice and hillshade). */
export function metresPerPixel(lat: number, z: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z);
}

/** An output grid: its size in pixels, and the lon/lat of any (fractional) pixel position. */
export interface OutGrid {
  w: number;
  h: number;
  lonLat: (px: number, py: number) => [number, number];
}

/** Tile z/x/y with `pad` extra pixels on every side (for neighbourhood operations). */
export function tileGrid(z: number, x: number, y: number, pad = 0): OutGrid {
  const size = TILE + 2 * pad;
  return { w: size, h: size, lonLat: (px, py) => tileToLonLat(x + (px - pad) / TILE, y + (py - pad) / TILE, z) };
}

/** A w × h grid spread linearly over a lon/lat box, north up (for view statistics). */
export function boxGrid(box: LonLatBox, w: number, h: number): OutGrid {
  return { w, h, lonLat: (px, py) => [box[0] + (px / w) * (box[2] - box[0]), box[3] - (py / h) * (box[3] - box[1])] };
}

export interface Geo { originX: number; originY: number; resX: number; resY: number }
export interface ControlGrid { pts: Float64Array; nx: number; ny: number }

/**
 * Base-image pixel coordinates of the control grid of `out`: points every
 * CELL output pixels (and at the far edges), as a flat [col, row, …] array.
 */
export function controlGrid(out: OutGrid, toSrc: (lonlat: [number, number]) => [number, number], geo: Geo): ControlGrid {
  const nx = Math.ceil(out.w / CELL) + 1, ny = Math.ceil(out.h / CELL) + 1;
  const pts = new Float64Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [sx, sy] = toSrc(out.lonLat(Math.min(i * CELL, out.w), Math.min(j * CELL, out.h)));
      const k = (j * nx + i) * 2;
      pts[k] = (sx - geo.originX) / geo.resX;
      pts[k + 1] = (sy - geo.originY) / geo.resY;
    }
  }
  return { pts, nx, ny };
}

/** Bilinear interpolation of the control grid at output pixel (px, py). */
export function interpGrid(g: ControlGrid, px: number, py: number, out: [number, number]): void {
  const fi = px / CELL, fj = py / CELL;
  const i = Math.min(Math.floor(fi), g.nx - 2), j = Math.min(Math.floor(fj), g.ny - 2);
  const u = fi - i, v = fj - j;
  const k00 = (j * g.nx + i) * 2, k10 = k00 + 2, k01 = k00 + g.nx * 2, k11 = k01 + 2;
  const p = g.pts;
  out[0] = (1 - v) * ((1 - u) * p[k00] + u * p[k10]) + v * ((1 - u) * p[k01] + u * p[k11]);
  out[1] = (1 - v) * ((1 - u) * p[k00 + 1] + u * p[k10 + 1]) + v * ((1 - u) * p[k01 + 1] + u * p[k11 + 1]);
}

/** The bounding window, in base pixels, of a control grid (unclamped). */
export function gridWindow(g: ControlGrid): [number, number, number, number] {
  let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
  for (let k = 0; k < g.pts.length; k += 2) {
    c0 = Math.min(c0, g.pts[k]); c1 = Math.max(c1, g.pts[k]);
    r0 = Math.min(r0, g.pts[k + 1]); r1 = Math.max(r1, g.pts[k + 1]);
  }
  return [Math.floor(c0), Math.floor(r0), Math.ceil(c1) + 1, Math.ceil(r1) + 1];
}

/**
 * Which image to read: the COARSEST overview still at least as fine as the
 * output (so nothing is upsampled that a finer level could have drawn), else
 * the finest there is. `factors` are each level's size divisor vs. the base
 * (1 for the base itself), sorted ascending.
 */
export function chooseLevel(factors: number[], srcPerOutPixel: number): number {
  let best = 0;
  for (let i = 0; i < factors.length; i++) if (factors[i] <= srcPerOutPixel) best = i;
  return best;
}

/**
 * Hillshade (Horn) of a padded elevation grid, value 0–1 per inner pixel, NaN
 * where any neighbour is missing. `w` includes the 1-pixel pad on each side.
 */
export function hillshade(elev: ArrayLike<number>, w: number, h: number, cellM: number, azimuthDeg = 315, altitudeDeg = 45): Float32Array {
  const iw = w - 2, ih = h - 2;
  const out = new Float32Array(iw * ih);
  const az = ((360 - azimuthDeg + 90) * Math.PI) / 180;
  const zen = ((90 - altitudeDeg) * Math.PI) / 180;
  for (let r = 1; r <= ih; r++) {
    for (let c = 1; c <= iw; c++) {
      const e = (dr: number, dc: number) => elev[(r + dr) * w + (c + dc)];
      const a = e(-1, -1), b = e(-1, 0), cc = e(-1, 1), d = e(0, -1), f = e(0, 1), g = e(1, -1), hh = e(1, 0), i = e(1, 1);
      let v = NaN;
      if (Number.isFinite(a + b + cc + d + f + g + hh + i)) {
        const dzdx = ((cc + 2 * f + i) - (a + 2 * d + g)) / (8 * cellM);
        const dzdy = ((g + 2 * hh + i) - (a + 2 * b + cc)) / (8 * cellM);
        const slope = Math.atan(Math.hypot(dzdx, dzdy));
        const aspect = Math.atan2(dzdy, -dzdx);
        v = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect);
        v = Math.max(0, v);
      }
      out[(r - 1) * iw + (c - 1)] = v;
    }
  }
  return out;
}
