// Cloud-Optimized GeoTIFFs on the map with no tile server: a MapLibre custom
// protocol, `cog://<id>/{z}/{x}/{y}`, fills each Web Mercator tile by range-
// reading a window of the best overview (geotiff.js) and warping it through
// proj4 (warp.ts). Used for the HRDEM elevation COGs (EPSG:3979) and the
// Sentinel-2 true-colour COGs (UTM).
//
// A COG in a CRS src/crs.ts does not define is REFUSED, not drawn as if it
// were something else.

import maplibregl from 'maplibre-gl';
import proj4 from 'proj4';
import { fromUrl, type GeoTIFF, type GeoTIFFImage } from 'geotiff';
import { projDef } from './crs.ts';
import {
  TILE, TERRAIN, chooseLevel, controlGrid, gridWindow, hillshade, interpGrid, metresPerPixel,
  percentileRange, rampColour, tileBounds,
} from './warp.ts';

/** `rgb`: a 3-band picture. The rest read band 1 as heights: `hillshade` relief,
 * `elevation` a colour ramp, `shaded` the ramp over the hillshade. */
export type CogMode = 'rgb' | 'hillshade' | 'elevation' | 'shaded';

export interface CogStyle {
  mode: CogMode;
  /** Colour-ramp range, metres (elevation and shaded modes). */
  min: number;
  max: number;
}

interface CogSource {
  url: string;
  style: CogStyle;
  tiff: GeoTIFF;
  images: GeoTIFFImage[];
  factors: number[];
  geo: { originX: number; originY: number; resX: number; resY: number };
  width: number;
  height: number;
  toSrc: (ll: [number, number]) => [number, number];
  nodata: number | null;
  /** lon/lat bounds, for the MapLibre source. */
  bounds: [number, number, number, number];
}

const sources = new Map<string, CogSource>();
/** Above this many source pixels a tile is left blank rather than read (zoomed far out on a file with no overviews). */
const MAX_WINDOW_PX = 4_000_000;

export interface OpenedCog {
  id: string;
  bounds: [number, number, number, number];
  epsg: number;
  width: number;
  height: number;
  resolution: number;
  levels: number;
}

/** Open a COG, read its header, and register it under `id`. */
export async function openCog(id: string, url: string, style: CogStyle): Promise<OpenedCog> {
  const tiff = await fromUrl(url, { allowFullFile: false });
  const count = await tiff.getImageCount();
  const all: GeoTIFFImage[] = [];
  for (let i = 0; i < count; i++) all.push(await tiff.getImage(i));
  const base = all[0];
  // Overviews are the reduced-resolution subfiles; masks (same size, 1 band) are skipped.
  const images = [base, ...all.slice(1).filter(im => im.getWidth() < base.getWidth())];
  images.sort((a, b) => b.getWidth() - a.getWidth());
  const factors = images.map(im => base.getWidth() / im.getWidth());

  const keys = (base.getGeoKeys() ?? {}) as Record<string, number>;
  const epsg = keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey;
  const def = epsg ? projDef(epsg) : null;
  if (!def) throw new Error(`the COG is in ${epsg ? `EPSG:${epsg}` : 'an unstated CRS'}, which this viewer does not define`);
  const conv = proj4('EPSG:4326', def);
  const [originX, originY] = base.getOrigin();
  const [resX, resY] = base.getResolution();
  const w = base.getWidth(), h = base.getHeight();
  const corners: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h], [w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
  const ll = corners.map(([c, r]) => conv.inverse([originX + c * resX, originY + r * resY]) as [number, number]);
  const bounds: [number, number, number, number] = [
    Math.min(...ll.map(p => p[0])), Math.min(...ll.map(p => p[1])),
    Math.max(...ll.map(p => p[0])), Math.max(...ll.map(p => p[1])),
  ];
  const nd = base.getGDALNoData();
  sources.set(id, {
    url, style, tiff, images, factors, geo: { originX, originY, resX, resY }, width: w, height: h,
    toSrc: (p) => conv.forward(p) as [number, number], nodata: nd ?? null, bounds,
  });
  return { id, bounds, epsg, width: w, height: h, resolution: Math.abs(resX), levels: images.length };
}

export function setCogStyle(id: string, style: Partial<CogStyle>): void {
  const s = sources.get(id);
  if (s) s.style = { ...s.style, ...style };
}

export function closeCog(id: string): void { sources.delete(id); }

/** A height is real: not the file's nodata, not NaN, not HRDEM's -32767 fill. */
const validHeight = (nd: number | null) => (v: number) => v !== nd && Number.isFinite(v) && v > -1000;

/**
 * The 2nd–98th percentile of heights inside a lon/lat box, from an overview
 * no wider than ~512 px over that box — the "fit to view" stretch. Null when
 * the box holds no data.
 */
export async function sampleRange(id: string, box: [number, number, number, number]): Promise<[number, number] | null> {
  const src = sources.get(id);
  if (!src) return null;
  const pts: [number, number][] = [];
  for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) pts.push([box[0] + fx * (box[2] - box[0]), box[1] + fy * (box[3] - box[1])]);
  const px = pts.map(p => { const [x, y] = src.toSrc(p); return [(x - src.geo.originX) / src.geo.resX, (y - src.geo.originY) / src.geo.resY]; });
  const c0 = Math.max(0, Math.min(...px.map(p => p[0]))), c1 = Math.min(src.width, Math.max(...px.map(p => p[0])));
  const r0 = Math.max(0, Math.min(...px.map(p => p[1]))), r1 = Math.min(src.height, Math.max(...px.map(p => p[1])));
  if (c1 <= c0 || r1 <= r0) return null;
  const level = chooseLevel(src.factors, Math.max(c1 - c0, r1 - r0) / 512);
  const f = src.factors[level], img = src.images[level];
  const win = [Math.floor(c0 / f), Math.floor(r0 / f), Math.max(Math.floor(c0 / f) + 1, Math.ceil(c1 / f)), Math.max(Math.floor(r0 / f) + 1, Math.ceil(r1 / f))];
  const data = (await img.readRasters({ window: win, samples: [0], interleave: false })) as unknown as ArrayLike<number>[];
  return percentileRange(data[0], validHeight(src.nodata));
}

// A transparent tile. MapLibre fails (and logs) on an empty body, and it may
// transfer the buffer it is handed, so every caller gets a fresh copy.
let blank: Promise<ArrayBuffer> | null = null;
async function emptyTile(): Promise<ArrayBuffer> {
  blank ??= (() => {
    const c = new OffscreenCanvas(1, 1);
    c.getContext('2d'); // convertToBlob refuses a canvas with no context
    return c.convertToBlob({ type: 'image/png' }).then(b => b.arrayBuffer());
  })();
  return (await blank).slice(0);
}

async function renderTile(src: CogSource, z: number, x: number, y: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const shade = src.style.mode !== 'rgb';
  const pad = shade ? 1 : 0;
  const tb = tileBounds(z, x, y);
  if (tb[2] < src.bounds[0] || tb[0] > src.bounds[2] || tb[3] < src.bounds[1] || tb[1] > src.bounds[3]) return emptyTile();

  const grid = controlGrid(z, x, y, pad, src.toSrc, src.geo);
  const [c0, r0, c1, r1] = gridWindow(grid);
  if (c1 < 0 || r1 < 0 || c0 > src.width || r0 > src.height) return emptyTile();

  // Source base pixels per output pixel, measured off the grid's diagonal.
  const srcPerOut = Math.hypot(c1 - c0, r1 - r0) / Math.hypot(grid.size, grid.size);
  const level = chooseLevel(src.factors, srcPerOut);
  const f = src.factors[level];
  const img = src.images[level];
  const W = img.getWidth(), H = img.getHeight();
  const win = [
    Math.max(0, Math.floor(c0 / f)), Math.max(0, Math.floor(r0 / f)),
    Math.min(W, Math.ceil(c1 / f)), Math.min(H, Math.ceil(r1 / f)),
  ];
  const ww = win[2] - win[0], wh = win[3] - win[1];
  if (ww <= 0 || wh <= 0 || ww * wh > MAX_WINDOW_PX) return emptyTile();

  const samples = shade ? [0] : [0, 1, 2].slice(0, img.getSamplesPerPixel());
  // No abort signal into geotiff: a block read cancelled mid-flight can leave a
  // short buffer in its shared block cache, and every later tile that touches
  // the block then fails to decode. A superseded tile finishes its read (the
  // block is wanted by its neighbours anyway) and is discarded here.
  const data = (await img.readRasters({ window: win, samples, interleave: false })) as unknown as ArrayLike<number>[];
  if (signal.aborted) throw new DOMException('superseded', 'AbortError');
  const size = grid.size;
  const p: [number, number] = [0, 0];
  const nd = src.nodata;

  // Sample the source (nearest) onto the padded output grid.
  const at = (px: number, py: number): number => {
    interpGrid(grid, px, py, p);
    const col = Math.floor(p[0] / f) - win[0], row = Math.floor(p[1] / f) - win[1];
    return col < 0 || row < 0 || col >= ww || row >= wh ? -1 : row * ww + col;
  };

  const rgba = new Uint8ClampedArray(TILE * TILE * 4);
  if (!shade) {
    const [rb, gb, bb] = [data[0], data[1] ?? data[0], data[2] ?? data[0]];
    for (let py = 0; py < TILE; py++) for (let px = 0; px < TILE; px++) {
      const k = at(px + 0.5, py + 0.5);
      if (k < 0) continue;
      const r = rb[k], g = gb[k], b = bb[k];
      if (r === 0 && g === 0 && b === 0) continue; // TCI nodata
      const o = (py * TILE + px) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  } else {
    const elev = new Float32Array(size * size);
    const valid = validHeight(nd);
    const band = data[0];
    for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
      const k = at(px + 0.5, py + 0.5);
      const v = k < 0 ? NaN : band[k];
      elev[py * size + px] = valid(v) ? v : NaN;
    }
    const lat = (tb[1] + tb[3]) / 2;
    const hs = hillshade(elev, size, size, metresPerPixel(lat, z));
    const { min, max } = src.style;
    for (let i = 0; i < TILE * TILE; i++) {
      const s = hs[i];
      const e = elev[(Math.floor(i / TILE) + 1) * size + (i % TILE) + 1];
      if (!Number.isFinite(e)) continue;
      const o = i * 4;
      const light = Number.isFinite(s) ? 0.35 + 0.65 * s : 0.75;
      if (src.style.mode === 'elevation') {
        const [r, g, b] = rampColour(TERRAIN, (e - min) / (max - min || 1));
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
      } else if (src.style.mode === 'shaded') {
        const [r, g, b] = rampColour(TERRAIN, (e - min) / (max - min || 1));
        rgba[o] = r * light; rgba[o + 1] = g * light; rgba[o + 2] = b * light;
      } else {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = 255 * light;
      }
      rgba[o + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(TILE, TILE);
  canvas.getContext('2d')!.putImageData(new ImageData(rgba, TILE, TILE), 0, 0);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

let registered = false;

/** Install the `cog://` protocol once. */
export function registerCogProtocol(): void {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol('cog', async (params, abort) => {
    const m = /^cog:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    const src = m && sources.get(decodeURIComponent(m[1]));
    if (!m || !src) return { data: await emptyTile() };
    // One retry: geotiff occasionally decodes a block from a short buffer when
    // several tiles fetch overlapping blocks at once ("ran off the end of the
    // buffer", a DataView RangeError). The second read is served cleanly.
    for (let attempt = 0; ; attempt++) {
      try {
        return { data: await renderTile(src, +m[2], +m[3], +m[4], abort.signal) };
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        if (attempt === 0) continue;
        console.warn(`[cog] ${src.url.split('/').pop()} ${m[2]}/${m[3]}/${m[4]}:`, e);
        return { data: await emptyTile() };
      }
    }
  });
}
