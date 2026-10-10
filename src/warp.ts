// The pure half of drawing a projected COG into Web Mercator map tiles: tile
// geometry, the control-grid inverse mapping, overview choice, and the paint
// functions. No DOM, no network — unit-tested under `node --test`.
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

/** lon/lat of a Web Mercator pixel corner, at fractional tile coordinates. */
export function tileToLonLat(x: number, y: number, z: number): [number, number] {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}

/** The lon/lat box of tile z/x/y. */
export function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const [w, n] = tileToLonLat(x, y, z);
  const [e, s] = tileToLonLat(x + 1, y + 1, z);
  return [w, s, e, n];
}

/** Ground metres per output pixel at a latitude and zoom (for overview choice and hillshade). */
export function metresPerPixel(lat: number, z: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z);
}

/**
 * Source-pixel coordinates of the control grid for a tile with `pad` extra
 * output pixels on every side. `toSrc` maps lon/lat to source CRS; `geo` is
 * the base image's origin and pixel size. Returns (CELLS+1)² points as a flat
 * [col, row, col, row, …] array, with the grid size.
 */
export function controlGrid(
  z: number, x: number, y: number, pad: number,
  toSrc: (lonlat: [number, number]) => [number, number],
  geo: { originX: number; originY: number; resX: number; resY: number },
): { pts: Float64Array; n: number; size: number } {
  const size = TILE + 2 * pad;
  const cells = Math.ceil(size / CELL);
  const n = cells + 1;
  const pts = new Float64Array(n * n * 2);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const px = Math.min(i * CELL, size) - pad;
      const py = Math.min(j * CELL, size) - pad;
      const [sx, sy] = toSrc(tileToLonLat(x + px / TILE, y + py / TILE, z));
      const k = (j * n + i) * 2;
      pts[k] = (sx - geo.originX) / geo.resX;
      pts[k + 1] = (sy - geo.originY) / geo.resY;
    }
  }
  return { pts, n, size };
}

/** Bilinear interpolation of the control grid at output pixel (px, py). */
export function interpGrid(g: { pts: Float64Array; n: number }, px: number, py: number, out: [number, number]): void {
  const fi = px / CELL, fj = py / CELL;
  const i = Math.min(Math.floor(fi), g.n - 2), j = Math.min(Math.floor(fj), g.n - 2);
  const u = fi - i, v = fj - j;
  const k00 = (j * g.n + i) * 2, k10 = k00 + 2, k01 = k00 + g.n * 2, k11 = k01 + 2;
  const p = g.pts;
  out[0] = (1 - v) * ((1 - u) * p[k00] + u * p[k10]) + v * ((1 - u) * p[k01] + u * p[k11]);
  out[1] = (1 - v) * ((1 - u) * p[k00 + 1] + u * p[k10 + 1]) + v * ((1 - u) * p[k01 + 1] + u * p[k11 + 1]);
}

/** The bounding window, in base pixels, of a control grid (unclamped). */
export function gridWindow(g: { pts: Float64Array }): [number, number, number, number] {
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

// ── Painting ────────────────────────────────────────────────────────────────

export type Ramp = [number, number, number][];

/** A short terrain ramp (low → high). */
export const TERRAIN: Ramp = [
  [38, 115, 77], [114, 164, 92], [196, 196, 120], [204, 160, 102], [170, 120, 90], [240, 240, 240],
];

export function rampColour(ramp: Ramp, t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.min(Math.floor(x), ramp.length - 2), f = x - i;
  const a = ramp[i], b = ramp[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * Hillshade (Horn) of a padded elevation grid, value 0–1 per inner pixel, NaN
 * where any neighbour is missing. `w` includes the 1-pixel pad on each side.
 */
export function hillshade(elev: Float32Array, w: number, h: number, cellM: number, azimuthDeg = 315, altitudeDeg = 45): Float32Array {
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

/**
 * The [lo, hi] percentiles of the finite values, rounded outward to whole
 * metres — the default stretch for an elevation ramp. Null when nothing is
 * finite. Pure.
 */
export function percentileRange(values: ArrayLike<number>, isValid: (v: number) => boolean, lo = 0.02, hi = 0.98): [number, number] | null {
  const v: number[] = [];
  for (let i = 0; i < values.length; i++) if (isValid(values[i])) v.push(values[i]);
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const at = (q: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))];
  let a = Math.floor(at(lo)), b = Math.ceil(at(hi));
  if (b <= a) b = a + 1;
  return [a, b];
}
