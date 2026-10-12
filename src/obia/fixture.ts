// SYNTHETIC TEST FIXTURE — not real data, and nothing computed from it is a
// real result. A small deterministic scene with known geometry, used by the
// unit tests and by the OBIA tab's "Load the test fixture" so the whole
// workflow can be exercised without network access (spec §12, Milestone A).
//
// 240 × 160 m at 1 m, WGS 84 / UTM 20N, near Halifax, in four 60 m stands:
//   • x   0–60   CONIFER forest: cone crowns on a 5 m lattice (sharp apices),
//                dark blue-green, low leaf-on NIR, stays green leaf-off
//   • x  60–120  GRAMINOID meadow: CHM ~0.3 m, yellow-green, browns leaf-off
//   • x 120–180  BROADLEAF forest: dome crowns on an 8 m lattice, bright
//                green, high leaf-on NIR, loses NDVI leaf-off
//   • x 180–240  LICHEN (y < 80: pale grey, flat, low NDVI) over ERICACEOUS
//                heath (y ≥ 80: reddish, 0.2–0.5 m)
//   • six 3 × 3 m ponds; a 10 × 6 m NoData corner (top right);
//   • Sentinel-2 main (leaf-on) and second (leaf-off) dates, 10 m and 20 m
//     rasters aligned to the fine grid, one cloudy SCL pixel in the main date;
//   • reference polygons at the COMPOSITION level in every stand.
// The contrasts are deliberately clean: what the fixture proves is that the
// machinery works, not that real vegetation separates this well.

import { projector } from './grid.ts';
import { DEFAULT_SENTINEL, type SegmentParams } from './recipe.ts';
import type { NativeRaster } from './sentinel.ts';
import type { SentinelInput } from './pipeline.ts';

export const FIXTURE_LABEL = 'SYNTHETIC TEST FIXTURE (not real data)';

const PONDS: [number, number][] = [[90, 40], [75, 100], [105, 130], [200, 30], [215, 90], [190, 140]];
type Cover = 'conifer' | 'graminoid' | 'broadleaf' | 'lichen' | 'ericaceous';
const coverAt = (x: number, y: number): Cover => { const k = Math.floor(x / 60); return k === 0 ? 'conifer' : k === 1 ? 'graminoid' : k === 2 ? 'broadleaf' : y < 80 ? 'lichen' : 'ericaceous'; };
/** Forest in the 60 m stands at x 0–60 and 120–180. */
const forestAt = (x: number) => Math.floor(x / 60) % 2 === 0;

const noise = (x: number, y: number, k = 0) => { const s = Math.sin(x * 12.9898 + y * 78.233 + k * 37.719) * 43758.5453; return s - Math.floor(s) - 0.5; };

/** Distance to the nearest point of a square lattice of spacing `d`. */
const toLattice = (x: number, y: number, d: number) => { const fx = ((x % d) + d) % d - d / 2, fy = ((y % d) + d) % d - d / 2; return Math.hypot(fx, fy); };

// Leaf-on / leaf-off reflectance per cover: [blue, green, red, nir, re1, re2, re3, nir08, swir16].
const ON: Record<Cover, number[]> = {
  conifer: [0.02, 0.035, 0.022, 0.24, 0.06, 0.15, 0.21, 0.25, 0.10],
  broadleaf: [0.025, 0.06, 0.03, 0.40, 0.07, 0.25, 0.34, 0.41, 0.17],
  graminoid: [0.04, 0.08, 0.06, 0.34, 0.11, 0.24, 0.30, 0.35, 0.24],
  lichen: [0.12, 0.16, 0.18, 0.30, 0.20, 0.25, 0.28, 0.31, 0.30],
  ericaceous: [0.03, 0.05, 0.07, 0.27, 0.09, 0.19, 0.24, 0.28, 0.16],
};
const OFF: Record<Cover, number[]> = {
  conifer: [0.02, 0.03, 0.025, 0.21, 0.06, 0.14, 0.19, 0.22, 0.10],
  broadleaf: [0.04, 0.06, 0.07, 0.18, 0.09, 0.14, 0.17, 0.19, 0.20],
  graminoid: [0.06, 0.09, 0.11, 0.17, 0.13, 0.15, 0.17, 0.18, 0.28],
  lichen: [0.12, 0.16, 0.18, 0.29, 0.20, 0.25, 0.27, 0.30, 0.30],
  ericaceous: [0.03, 0.05, 0.06, 0.21, 0.08, 0.15, 0.19, 0.22, 0.16],
};
const BANDS = ['blue', 'green', 'red', 'nir', 'rededge1', 'rededge2', 'rededge3', 'nir08', 'swir16'];

export function fixtureScene() {
  const w = 240, h = 160, cellM = 1, epsg = 32620, x0 = 454000, y0 = 4945160;
  const n = w * h;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), chm = new Float32Array(n);
  const pond = (x: number, y: number) => PONDS.some(([px, py]) => x >= px && x < px + 3 && y >= py && y < py + 3);
  const nodata = (x: number, y: number) => x >= w - 10 && y < 6;
  const set = (i: number, R: number, G: number, B: number, e: number) => { r[i] = R + 8 * e; g[i] = G + 8 * e; b[i] = B + 6 * e; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (nodata(x, y)) { r[i] = g[i] = b[i] = chm[i] = NaN; continue; }
    const e = noise(x, y), cv = coverAt(x, y);
    if (pond(x, y)) { r[i] = 20; g[i] = 35; b[i] = 70; chm[i] = 0; continue; }
    if (cv === 'conifer') { const d = toLattice(x + 0.5, y + 0.5, 5); set(i, 30, 55, 45, e); chm[i] = Math.max(2, 17 - 2.6 * d) + 0.3 * noise(x, y, 1); }
    else if (cv === 'broadleaf') { const d = toLattice(x + 0.5, y + 0.5, 8); set(i, 75, 115, 45, e); chm[i] = Math.max(8, 16 - 0.12 * d * d) + 0.3 * noise(x, y, 1); }
    else if (cv === 'graminoid') { set(i, 170, 185, 100, e); chm[i] = Math.max(0, 0.3 + 0.15 * noise(x, y, 2)); }
    else if (cv === 'lichen') { set(i, 205, 205, 190, e); chm[i] = Math.max(0, 0.05 + 0.05 * noise(x, y, 2)); }
    else { set(i, 150, 85, 75, e); chm[i] = Math.max(0, 0.35 + 0.2 * noise(x, y, 2)); }
  }
  const mask = new Uint8Array(n).fill(1);
  // Sentinel at native support, aligned to the fine grid's origin; the cover of a native pixel is that of its centre.
  const scene = (table: Record<Cover, number[]>, key: string, cloudy: boolean): SentinelInput => {
    const s10: NativeRaster = { key: `${key}:10m`, epsg, originX: x0, originY: y0, res: 10, w: 24, h: 16, values: {} };
    const s20: NativeRaster = { key: `${key}:20m`, epsg, originX: x0, originY: y0, res: 20, w: 12, h: 8, values: {} };
    const band = (R: NativeRaster, k: number) => Float32Array.from({ length: R.w * R.h }, (_, j) => {
      const c = j % R.w, rr = Math.floor(j / R.w);
      return table[coverAt((c + 0.5) * R.res, (rr + 0.5) * R.res)][k] + 0.004 * noise(c, rr, k + (cloudy ? 0 : 20));
    });
    BANDS.forEach((bnd, k) => { const R = k < 4 ? s10 : s20; R.values[bnd] = band(R, k); });
    s20.values.scl = Float32Array.from({ length: 96 }, (_, j) => (cloudy && j === 3 ? 9 : 4));
    return { sourceId: key, rasters: [s10, s20], bands: BANDS, indices: ['ndvi', 'ndre', 'ndmi'], sclInvalid: DEFAULT_SENTINEL.sclInvalid, maskBufferPx: 0 };
  };
  const sentinel = scene(ON, 'fixture:sentinel-2', true);
  const sentinelB = scene(OFF, 'fixture:sentinel-2-leaf-off', false);
  const params: SegmentParams = { targetAreaM2: 64, compactness: 1, imageryWeight: 1, structureWeight: 1, terrainWeight: 0, mergeSimilarity: 0.6, minPatchAreaM2: 25, keepDistinctAbove: 3 };
  return {
    w, h, cellM, epsg, x0, y0, planes: { r, g, b, chm }, mask, params, sentinel, sentinelB,
    pondIndex: 41 * w + 91,
    isForest: (i: number) => forestAt(i % w),
    coverOf: (i: number) => coverAt(i % w, Math.floor(i / w)),
  };
}

/** The fixture's reference polygons, in lon/lat, with a `class` property. */
export function fixtureReferences(): GeoJSON.FeatureCollection {
  const { x0, y0, epsg } = fixtureScene();
  const p = projector(epsg);
  const rect = (cls: string, xa: number, xb: number, ya: number, yb: number): GeoJSON.Feature => ({
    type: 'Feature', properties: { class: cls },
    geometry: { type: 'Polygon', coordinates: [[[xa, ya], [xb, ya], [xb, yb], [xa, yb], [xa, ya]].map(([x, y]) => p.inverse([x0 + x, y0 - y]))] },
  });
  return {
    type: 'FeatureCollection', features: [
      rect('forest-conifer', 5, 55, 10, 70), rect('forest-conifer', 5, 55, 95, 150),
      rect('forest-broadleaf', 125, 175, 10, 70), rect('forest-broadleaf', 125, 175, 95, 150),
      rect('herb-graminoid', 65, 85, 5, 35), rect('herb-graminoid', 65, 115, 60, 90),
      rect('herb-lichen', 185, 235, 10, 25), rect('herb-lichen', 185, 235, 45, 75),
      rect('herb-ericaceous', 185, 235, 100, 135), rect('herb-ericaceous', 185, 210, 145, 158),
      ...PONDS.map(([px, py]) => rect('water', px, px + 3, py, py + 3)),
    ],
  };
}
