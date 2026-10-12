// SYNTHETIC TEST FIXTURE — not real data, and nothing computed from it is a
// real result. A small deterministic scene with known geometry, used by the
// unit tests and by the OBIA tab's "Load the test fixture" so the whole
// workflow can be exercised without network access (spec §12, Milestone A).
//
// 240 × 160 m at 1 m, WGS 84 / UTM 20N, near Halifax:
//   • 60 m wide stands alternating forest (CHM ~15 m, dark green) and
//     meadow (CHM ~0.3 m, light yellow-green), so each class occurs in
//     spatially separate places — what spatial cross-validation needs;
//   • six 3 × 3 m ponds in the meadows: CHM 0, dark blue (below the minimum
//     patch area, and unlike every neighbour);
//   • a 10 × 6 m NoData corner (top right): no RGB, no CHM;
//   • Sentinel-2: a 10 m raster (blue, green, red, nir) and a 20 m raster
//     (nir08, swir16, scl), aligned to the fine grid, with one cloudy SCL pixel;
//   • reference polygons inside every stand and over every pond.

import { projector } from './grid.ts';
import { DEFAULT_SENTINEL, type SegmentParams } from './recipe.ts';
import type { NativeRaster } from './sentinel.ts';
import type { SentinelInput } from './pipeline.ts';

export const FIXTURE_LABEL = 'SYNTHETIC TEST FIXTURE (not real data)';

const PONDS: [number, number][] = [[90, 40], [75, 100], [105, 130], [200, 30], [215, 90], [190, 140]];
/** Forest in the 60 m stands at x 0–60 and 120–180; meadow in 60–120 and 180–240. */
const forestAt = (x: number) => Math.floor(x / 60) % 2 === 0;

const noise = (x: number, y: number, k = 0) => { const s = Math.sin(x * 12.9898 + y * 78.233 + k * 37.719) * 43758.5453; return s - Math.floor(s) - 0.5; };

export function fixtureScene() {
  const w = 240, h = 160, cellM = 1, epsg = 32620, x0 = 454000, y0 = 4945160;
  const n = w * h;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), chm = new Float32Array(n);
  const pond = (x: number, y: number) => PONDS.some(([px, py]) => x >= px && x < px + 3 && y >= py && y < py + 3);
  const nodata = (x: number, y: number) => x >= w - 10 && y < 6;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (nodata(x, y)) { r[i] = g[i] = b[i] = chm[i] = NaN; continue; }
    const e = noise(x, y);
    if (pond(x, y)) { r[i] = 20; g[i] = 35; b[i] = 70; chm[i] = 0; }
    else if (forestAt(x)) { r[i] = 40 + 8 * e; g[i] = 70 + 10 * e; b[i] = 35 + 6 * e; chm[i] = 15 + 2 * noise(x, y, 1); }
    else { r[i] = 170 + 8 * e; g[i] = 185 + 8 * e; b[i] = 100 + 6 * e; chm[i] = Math.max(0, 0.3 + 0.15 * noise(x, y, 2)); }
  }
  const mask = new Uint8Array(n).fill(1);
  // Sentinel at native support, aligned to the fine grid's origin.
  const s10: NativeRaster = { key: 'fixture:10m', epsg, originX: x0, originY: y0, res: 10, w: 24, h: 16, values: {} };
  const s20: NativeRaster = { key: 'fixture:20m', epsg, originX: x0, originY: y0, res: 20, w: 12, h: 8, values: {} };
  const band = (R: NativeRaster, forest: number, meadow: number, k: number) => Float32Array.from({ length: R.w * R.h }, (_, j) => {
    const c = j % R.w, cx = (c + 0.5) * R.res;
    return (forestAt(cx) ? forest : meadow) + 0.005 * noise(c, Math.floor(j / R.w), k);
  });
  s10.values = { blue: band(s10, 0.02, 0.05, 3), green: band(s10, 0.04, 0.08, 4), red: band(s10, 0.03, 0.07, 5), nir: band(s10, 0.32, 0.38, 6) };
  s20.values = { nir08: band(s20, 0.33, 0.39, 7), swir16: band(s20, 0.12, 0.22, 8), scl: Float32Array.from({ length: 96 }, (_, j) => (j === 3 ? 9 : 4)) };
  const sentinel: SentinelInput = { sourceId: 'fixture:sentinel-2', rasters: [s10, s20], bands: ['blue', 'green', 'red', 'nir', 'nir08', 'swir16'], indices: ['ndvi', 'ndmi'], sclInvalid: DEFAULT_SENTINEL.sclInvalid, maskBufferPx: 0 };
  const params: SegmentParams = { targetAreaM2: 64, compactness: 1, imageryWeight: 1, structureWeight: 1, terrainWeight: 0, mergeSimilarity: 0.6, minPatchAreaM2: 25, keepDistinctAbove: 3 };
  return {
    w, h, cellM, epsg, x0, y0, planes: { r, g, b, chm }, mask, params, sentinel,
    pondIndex: 41 * w + 91,
    isForest: (i: number) => forestAt(i % w),
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
      rect('Forest', 5, 55, 10, 70), rect('Forest', 5, 55, 95, 150), rect('Forest', 125, 175, 10, 70), rect('Forest', 125, 175, 95, 150),
      rect('Meadow', 65, 85, 5, 35), rect('Meadow', 65, 115, 60, 90), rect('Meadow', 185, 235, 45, 80), rect('Meadow', 185, 235, 100, 130),
      ...PONDS.map(([px, py]) => rect('Water', px, px + 3, py, py + 3)),
    ],
  };
}
