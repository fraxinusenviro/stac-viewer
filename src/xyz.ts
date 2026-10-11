// Web Mercator raster TILES (an orthophoto service) as engine planes — the
// `ortho:*` inputs (products.ts). Each output pixel takes the colour of the
// tile pixel its lon/lat falls in, at the zoom matching the output's own
// resolution (so a zoomed-out view reads the service's own overviews, not a
// sea of full-resolution tiles). Fully transparent pixels and missing tiles
// are no data.
//
// One derived plane rides along: TEXTURE, the standard deviation of
// brightness within ±TEXTURE_RADIUS_M — crown-shadow texture in FieldMapper's
// conifer index. It is computed on the output grid, so it is only as
// meaningful as the output is fine: from zoom ~16 it measures crowns, at
// zoom 14 a few pixels of whatever is there.

import type { OutGrid } from './warp.ts';

export interface XyzService {
  id: string;
  label: string;
  template: string;
  maxZoom: number;
  attribution: string;
}

export const ORTHO_SERVICES: XyzService[] = [
  {
    id: 'nsodb10k', label: 'Nova Scotia orthophoto (NSODB 1:10 000)', maxZoom: 19,
    template: 'https://nsgiwa.novascotia.ca/arcgis/rest/services/BASE/BASE_NSODB_10k_WM84/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Orthophoto © Province of Nova Scotia (NSGI)',
  },
  {
    id: 'nsodb2k', label: 'Nova Scotia orthophoto (NSODB 1:2 000, urban)', maxZoom: 19,
    template: 'https://nsgiwa.novascotia.ca/arcgis/rest/services/BASE/BASE_NSODB_2k_WM84/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Orthophoto © Province of Nova Scotia (NSGI)',
  },
  {
    id: 'esri', label: 'Esri World Imagery', maxZoom: 19,
    template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
];
export const orthoService = (id: string) => ORTHO_SERVICES.find(s => s.id === id) ?? null;

export const TEXTURE_RADIUS_M = 5;
const MAX_TILES = 96;
const CACHE_TILES = 384;

const tileCache = new Map<string, Promise<Uint8ClampedArray | null>>();

function tile(template: string, z: number, x: number, y: number): Promise<Uint8ClampedArray | null> {
  const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  let p = tileCache.get(url);
  if (p) { tileCache.delete(url); tileCache.set(url, p); return p; }
  p = (async () => {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob());
      const c = new OffscreenCanvas(256, 256);
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(bmp, 0, 0, 256, 256);
      return g.getImageData(0, 0, 256, 256).data;
    } catch { return null; }
  })();
  tileCache.set(url, p);
  p.then(v => { if (!v) tileCache.delete(url); });
  for (const k of tileCache.keys()) { if (tileCache.size <= CACHE_TILES) break; tileCache.delete(k); }
  return p;
}

const worldPx = (lon: number, lat: number, z: number): [number, number] => {
  const n = 256 * 2 ** z, s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
};

/** Population s.d. of `v` over a (2r + 1)² window, NaN-aware, by integral images. Pure. */
export function focalStd(v: Float32Array, w: number, h: number, r: number): Float32Array {
  const W = w + 1;
  const s = new Float64Array(W * (h + 1)), s2 = new Float64Array(W * (h + 1)), c = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = v[y * w + x], ok = a === a;
    const k = (y + 1) * W + x + 1;
    s[k] = s[k - 1] + s[k - W] - s[k - W - 1] + (ok ? a : 0);
    s2[k] = s2[k - 1] + s2[k - W] - s2[k - W - 1] + (ok ? a * a : 0);
    c[k] = c[k - 1] + c[k - W] - c[k - W - 1] + (ok ? 1 : 0);
  }
  const out = new Float32Array(w * h).fill(NaN);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (v[y * w + x] !== v[y * w + x]) continue;
    const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    const box = (a: Float64Array) => a[y1 * W + x1] - a[y0 * W + x1] - a[y1 * W + x0] + a[y0 * W + x0];
    const nn = box(c);
    if (nn < 3) continue;
    const m = box(s) / nn;
    out[y * w + x] = Math.sqrt(Math.max(0, box(s2) / nn - m * m));
  }
  return out;
}

/** Sample a tile service onto a grid: planes for channels 0–2 (R, G, B, 0–255) and 3 (texture of brightness, 0–1). */
export async function sampleXyz(svc: { template: string; maxZoom: number }, out: OutGrid, keys: [string, number][]): Promise<Record<string, Float32Array>> {
  const n = out.w * out.h;
  const planes: Record<string, Float32Array> = Object.fromEntries(keys.map(([k]) => [k, new Float32Array(n).fill(NaN)]));
  const mid = out.lonLat(out.w / 2, out.h / 2), right = out.lonLat(out.w / 2 + 1, out.h / 2);
  const mpp = Math.abs(right[0] - mid[0]) * 111320 * Math.cos((mid[1] * Math.PI) / 180);
  const z = Math.max(0, Math.min(svc.maxZoom, Math.round(Math.log2((40075016.686 * Math.cos((mid[1] * Math.PI) / 180)) / (256 * mpp)))));
  // Tile pixel coordinates of each output pixel (exact per pixel: cheap, no projection library).
  const coords = new Float64Array(n * 2);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let py = 0; py < out.h; py++) for (let px = 0; px < out.w; px++) {
    const [lon, lat] = out.lonLat(px + 0.5, py + 0.5);
    const [wx, wy] = worldPx(lon, lat, z);
    const i = py * out.w + px;
    coords[2 * i] = wx; coords[2 * i + 1] = wy;
    if (wx < x0) x0 = wx; if (wx > x1) x1 = wx; if (wy < y0) y0 = wy; if (wy > y1) y1 = wy;
  }
  const tx0 = Math.floor(x0 / 256), tx1 = Math.floor(x1 / 256), ty0 = Math.floor(y0 / 256), ty1 = Math.floor(y1 / 256);
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > MAX_TILES) return planes;
  const tiles = new Map<string, Uint8ClampedArray | null>();
  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push(tile(svc.template, z, tx, ty).then(d => { tiles.set(`${tx},${ty}`, d); }));
  await Promise.all(jobs);
  const rgb = [new Float32Array(n).fill(NaN), new Float32Array(n).fill(NaN), new Float32Array(n).fill(NaN)];
  for (let i = 0; i < n; i++) {
    const wx = coords[2 * i], wy = coords[2 * i + 1];
    const tx = Math.floor(wx / 256), ty = Math.floor(wy / 256);
    const d = tiles.get(`${tx},${ty}`);
    if (!d) continue;
    const k = ((Math.floor(wy) - ty * 256) * 256 + (Math.floor(wx) - tx * 256)) * 4;
    if (d[k + 3] === 0) continue;
    rgb[0][i] = d[k]; rgb[1][i] = d[k + 1]; rgb[2][i] = d[k + 2];
  }
  let tex: Float32Array | null = null;
  for (const [key, ch] of keys) {
    if (ch < 3) { planes[key] = rgb[ch]; continue; }
    if (!tex) {
      const b = new Float32Array(n);
      for (let i = 0; i < n; i++) b[i] = (rgb[0][i] + rgb[1][i] + rgb[2][i]) / 765;
      tex = focalStd(b, out.w, out.h, Math.max(1, Math.min(8, Math.round(TEXTURE_RADIUS_M / mpp))));
    }
    planes[key] = tex;
  }
  return planes;
}

/** The NSODB photo year at a point ('' when not covered or unreachable). */
export async function orthoPhotoYear(svcId: string, lon: number, lat: number): Promise<string> {
  if (!svcId.startsWith('nsodb')) return '';
  try {
    const url = `https://nsgiwa.novascotia.ca/arcgis/rest/services/BASE/BASE_NSODB_10k_WM84/MapServer/0/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=PHOTODATE&returnGeometry=false&f=json`;
    const j = await (await fetch(url)).json();
    return String(j?.features?.[0]?.attributes?.PHOTODATE ?? '');
  } catch { return ''; }
}
