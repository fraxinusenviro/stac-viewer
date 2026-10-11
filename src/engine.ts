// The render engine: draws any product (products.ts) from any set of COGs
// onto the map with no tile server, through a MapLibre custom protocol,
// `cog://<layer id>/{z}/{x}/{y}`.
//
// For each map tile, every input the product names is sampled onto the
// tile's own pixel grid — each from its own file, in its own CRS, at its own
// best overview (warp.ts). The channels are then computed per pixel from
// those planes and painted (paint.ts). That one step is what lets a fusion
// product put a 10 m UTM Sentinel-2 band and a 1 m Lambert LiDAR DSM in the
// same pixel.
//
// The sampled planes are cached per tile, so a stretch, curve or threshold
// change repaints without a byte of network: the layer's tile URL carries a
// version that the style bumps, and the plane cache does not key on it.
//
// A COG in a CRS src/crs.ts does not define is REFUSED, not drawn as if it
// were something else.

import maplibregl from 'maplibre-gl';
import proj4 from 'proj4';
import { fromUrl, type GeoTIFF, type GeoTIFFImage } from 'geotiff';
import { projDef } from './crs.ts';
import { paint, channelStats, classCounts, type ChannelStats } from './paint.ts';
import { paintSpec, type ChannelFn, type Planes, type Product, type ProductStyle } from './products.ts';
import {
  TILE, boxGrid, chooseLevel, controlGrid, gridWindow, interpGrid, metresPerPixel, tileBounds, tileGrid,
  type Geo, type LonLatBox, type OutGrid,
} from './warp.ts';

// ── Files ───────────────────────────────────────────────────────────────────

interface CogFile {
  url: string;
  images: GeoTIFFImage[];
  factors: number[];
  geo: Geo;
  width: number;
  height: number;
  toSrc: (ll: [number, number]) => [number, number];
  fileNodata: number | null;
  bounds: LonLatBox;
  epsg: number;
}

const files = new Map<string, Promise<CogFile>>();

/** Open a COG once per URL (every layer and every input shares it). */
export function openFile(url: string): Promise<CogFile> {
  let p = files.get(url);
  if (!p) {
    p = (async () => {
      const tiff: GeoTIFF = await fromUrl(url, { allowFullFile: false });
      const count = await tiff.getImageCount();
      const all: GeoTIFFImage[] = [];
      for (let i = 0; i < count; i++) all.push(await tiff.getImage(i));
      const base = all[0];
      // Overviews are the reduced-resolution subfiles; masks (same size) are skipped.
      const images = [base, ...all.slice(1).filter(im => im.getWidth() < base.getWidth())].sort((a, b) => b.getWidth() - a.getWidth());
      const keys = (base.getGeoKeys() ?? {}) as Record<string, number>;
      const epsg = keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey;
      const def = epsg ? projDef(epsg) : null;
      if (!def) throw new Error(`${url.split('/').pop()} is in ${epsg ? `EPSG:${epsg}` : 'an unstated CRS'}, which this viewer does not define`);
      const conv = proj4('EPSG:4326', def);
      const [originX, originY] = base.getOrigin();
      const [resX, resY] = base.getResolution();
      const w = base.getWidth(), h = base.getHeight();
      const corners: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h], [w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
      const ll = corners.map(([c, r]) => conv.inverse([originX + c * resX, originY + r * resY]) as [number, number]);
      return {
        url, images, factors: images.map(im => w / im.getWidth()), geo: { originX, originY, resX, resY }, width: w, height: h,
        toSrc: (q) => conv.forward(q) as [number, number], fileNodata: base.getGDALNoData() ?? null, epsg,
        bounds: [Math.min(...ll.map(q => q[0])), Math.min(...ll.map(q => q[1])), Math.max(...ll.map(q => q[0])), Math.max(...ll.map(q => q[1]))],
      };
    })();
    files.set(url, p);
    p.catch(() => files.delete(url));
  }
  return p;
}

// ── Inputs ──────────────────────────────────────────────────────────────────

/** Where one named input's numbers come from, and how to turn them into values. */
export interface InputSource {
  url: string;
  sample: number;
  /** value = DN × scale + offset (Sentinel-2 reflectance); 1 and 0 for heights. */
  scale: number;
  offset: number;
  /** DN that means "no data" (null: none). */
  nodata: number | null;
  /** Heights: HRDEM fills with −32767; anything this low is not ground. */
  minValid?: number;
}

/** Above this many source pixels per input a grid is left blank rather than read. */
const MAX_WINDOW_PX = 4_000_000;

/**
 * Sample the named inputs onto an output grid. Inputs sharing a file are
 * read together (the TCI's three samples are one window). Every requested
 * key gets a plane; a file that fails or does not cover the grid gives NaN.
 */
async function samplePlanes(sources: Record<string, InputSource>, out: OutGrid): Promise<Planes> {
  const n = out.w * out.h;
  const planes: Planes = {};
  const byUrl = new Map<string, [string, InputSource][]>();
  for (const [k, s] of Object.entries(sources)) {
    planes[k] = new Float32Array(n).fill(NaN);
    (byUrl.get(s.url) ?? byUrl.set(s.url, []).get(s.url)!).push([k, s]);
  }
  await Promise.all([...byUrl].map(async ([url, entries]) => {
    let f: CogFile;
    try { f = await openFile(url); } catch { return; }
    const grid = controlGrid(out, f.toSrc, f.geo);
    const [c0, r0, c1, r1] = gridWindow(grid);
    if (c1 < 0 || r1 < 0 || c0 > f.width || r0 > f.height) return;
    const srcPerOut = Math.hypot(c1 - c0, r1 - r0) / Math.hypot(out.w, out.h);
    const level = chooseLevel(f.factors, srcPerOut);
    const fac = f.factors[level], img = f.images[level];
    const W = img.getWidth(), H = img.getHeight();
    const win = [Math.max(0, Math.floor(c0 / fac)), Math.max(0, Math.floor(r0 / fac)), Math.min(W, Math.ceil(c1 / fac)), Math.min(H, Math.ceil(r1 / fac))];
    const ww = win[2] - win[0], wh = win[3] - win[1];
    if (ww <= 0 || wh <= 0 || ww * wh > MAX_WINDOW_PX) return;
    const samples = [...new Set(entries.map(([, s]) => s.sample))];
    // One retry: geotiff occasionally decodes a block from a short buffer when
    // several tiles fetch overlapping blocks at once. No abort signal goes in,
    // because a cancelled block read can poison geotiff's shared block cache.
    let data: ArrayLike<number>[] | null = null;
    for (let attempt = 0; attempt < 2 && !data; attempt++) {
      try { data = (await img.readRasters({ window: win, samples, interleave: false })) as unknown as ArrayLike<number>[]; } catch (e) { if (attempt) console.warn(`[cog] ${url.split('/').pop()}:`, e); }
    }
    if (!data) return;
    const p: [number, number] = [0, 0];
    const at = new Int32Array(n);
    for (let py = 0; py < out.h; py++) for (let px = 0; px < out.w; px++) {
      interpGrid(grid, px + 0.5, py + 0.5, p);
      const col = Math.floor(p[0] / fac) - win[0], row = Math.floor(p[1] / fac) - win[1];
      at[py * out.w + px] = col < 0 || row < 0 || col >= ww || row >= wh ? -1 : row * ww + col;
    }
    for (const [k, s] of entries) {
      const band = data[samples.indexOf(s.sample)];
      const plane = planes[k];
      const nd = s.nodata, min = s.minValid ?? -Infinity;
      for (let i = 0; i < n; i++) {
        const j = at[i];
        if (j < 0) continue;
        const dn = band[j];
        if (dn === nd || !Number.isFinite(dn)) continue;
        const v = dn * s.scale + s.offset;
        if (v >= min) plane[i] = v;
      }
    }
  }));
  return planes;
}

// ── Layers ──────────────────────────────────────────────────────────────────

export interface LayerDef {
  product: Product;
  sources: Record<string, InputSource>;
  style: ProductStyle;
}

interface Layer extends LayerDef { sig: string; bounds: LonLatBox | null }
const layers = new Map<string, Layer>();

const sigOf = (d: LayerDef) => JSON.stringify([d.product.pad, Object.entries(d.sources).sort()]);

/**
 * Register a layer: opens every input file (so a refused CRS fails here, not
 * per tile) and returns the union of their lon/lat bounds.
 */
export async function setLayer(id: string, def: LayerDef): Promise<LonLatBox> {
  const missing = def.product.inputs.filter(k => !def.sources[k]);
  if (missing.length) throw new Error(`no source for ${missing.join(', ')}`);
  const opened = await Promise.all([...new Set(Object.values(def.sources).map(s => s.url))].map(openFile));
  const b = opened.map(f => f.bounds);
  // The product only draws where EVERY input has data, so its bounds are the intersection.
  const bounds: LonLatBox = [Math.max(...b.map(x => x[0])), Math.max(...b.map(x => x[1])), Math.min(...b.map(x => x[2])), Math.min(...b.map(x => x[3]))];
  layers.set(id, { ...def, sig: sigOf(def), bounds });
  return bounds;
}

export function setStyle(id: string, style: Partial<ProductStyle>): void {
  const L = layers.get(id);
  if (L) L.style = { ...L.style, ...style };
}

export function removeLayer(id: string): void { layers.delete(id); }

export function layerFiles(id: string): Promise<CogFile[]> {
  const L = layers.get(id);
  return L ? Promise.all([...new Set(Object.values(L.sources).map(s => s.url))].map(openFile)) : Promise.resolve([]);
}

// The plane cache: per layer inputs and tile, never per style.
const CACHE_BYTES = 160 * 1024 * 1024;
const cache = new Map<string, { planes: Planes; bytes: number }>();
let cacheBytes = 0;
const inflight = new Map<string, Promise<Planes>>();

function cachedPlanes(L: Layer, z: number, x: number, y: number): Promise<Planes> {
  const key = `${L.sig}|${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return Promise.resolve(hit.planes); }
  let p = inflight.get(key);
  if (!p) {
    p = samplePlanes(L.sources, tileGrid(z, x, y, L.product.pad)).then(planes => {
      const bytes = Object.values(planes).reduce((s, a) => s + a.byteLength, 0);
      cache.set(key, { planes, bytes });
      cacheBytes += bytes;
      for (const [k, v] of cache) { if (cacheBytes <= CACHE_BYTES) break; cache.delete(k); cacheBytes -= v.bytes; }
      return planes;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Evaluate every channel of a product over a set of planes. */
function channelValues(product: Product, style: ProductStyle, planes: Planes, n: number): Float32Array[] {
  return product.channels.map(c => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = c.fn(planes, i, style);
    return out;
  });
}

let blank: Promise<ArrayBuffer> | null = null;
/** A transparent tile. MapLibre fails on an empty body and may transfer the buffer, so each caller gets a copy. */
async function emptyTile(): Promise<ArrayBuffer> {
  blank ??= (() => { const c = new OffscreenCanvas(1, 1); c.getContext('2d'); return c.convertToBlob({ type: 'image/png' }).then(b => b.arrayBuffer()); })();
  return (await blank).slice(0);
}

async function renderTile(L: Layer, z: number, x: number, y: number): Promise<ArrayBuffer> {
  const tb = tileBounds(z, x, y);
  const b = L.bounds;
  if (b && (tb[2] < b[0] || tb[0] > b[2] || tb[3] < b[1] || tb[1] > b[3])) return emptyTile();
  const planes = await cachedPlanes(L, z, x, y);
  const size = TILE + 2 * L.product.pad;
  const chan = channelValues(L.product, L.style, planes, size * size);
  const rgba = paint(chan, size, L.product.pad, paintSpec(L.product, L.style), metresPerPixel((tb[1] + tb[3]) / 2, z));
  if (!rgba.some((v, i) => i % 4 === 3 && v)) return emptyTile();
  const canvas = new OffscreenCanvas(TILE, TILE);
  canvas.getContext('2d')!.putImageData(new ImageData(rgba as unknown as Uint8ClampedArray<ArrayBuffer>, TILE, TILE), 0, 0);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

let registered = false;

/** Install the `cog://` protocol once. */
export function registerProtocol(): void {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol('cog', async (params, abort) => {
    const m = /^cog:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    const L = m && layers.get(decodeURIComponent(m[1]));
    if (!m || !L) return { data: await emptyTile() };
    const data = await renderTile(L, +m[2], +m[3], +m[4]);
    if (abort.signal.aborted) throw new DOMException('superseded', 'AbortError');
    return { data };
  });
}

/** The tile URL for a layer at a style version. */
export const tileUrl = (id: string, v: number) => `cog://${encodeURIComponent(id)}/{z}/{x}/{y}?v=${v}`;

// ── View statistics ─────────────────────────────────────────────────────────

export interface ViewStats {
  channels: (ChannelStats | null)[];
  /** Class value → share of classified pixels (classes products). */
  classes?: Map<number, number>;
}

/**
 * Per-channel statistics of a layer over a lon/lat box, from a ~256 px grid
 * read off overviews — the source of the histograms, the 2–98 % handles and
 * the class tally.
 */
export async function viewStats(id: string, box: LonLatBox): Promise<ViewStats | null> {
  const L = layers.get(id);
  if (!L) return null;
  const midLat = ((box[1] + box[3]) / 2) * Math.PI / 180;
  const aspect = ((box[2] - box[0]) * Math.cos(midLat)) / (box[3] - box[1] || 1e-9);
  const w = Math.max(16, Math.round(aspect >= 1 ? 256 : 256 * aspect)), h = Math.max(16, Math.round(aspect >= 1 ? 256 / aspect : 256));
  const planes = await samplePlanes(L.sources, boxGrid(box, w, h));
  const chan = channelValues(L.product, L.style, planes, w * h);
  if (L.product.render === 'classes') {
    const counts = classCounts(chan[0]);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    return { channels: [null], classes: new Map([...counts].map(([k, c]) => [k, total ? c / total : 0])) };
  }
  return { channels: chan.map((v, c) => channelStats(v, L.product.channels[c].domain)) };
}

// ── Point samples ───────────────────────────────────────────────────────────

/**
 * The mean of each function over a small square (default ±2 m, a 5 × 5 grid)
 * around a point, read at full resolution — the values behind one sample
 * tapped on the map. Averaging over a few metres keeps a 1 m canopy height
 * from landing in the gap between two crowns. NaN where nothing was finite.
 */
export async function samplePoint(sources: Record<string, InputSource>, lon: number, lat: number, fns: Record<string, ChannelFn>, style: ProductStyle, radiusM = 2): Promise<Record<string, number>> {
  const dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const n = 5;
  const planes = await samplePlanes(sources, boxGrid([lon - dLon, lat - dLat, lon + dLon, lat + dLat], n, n));
  const out: Record<string, number> = {};
  for (const [k, fn] of Object.entries(fns)) {
    let sum = 0, cnt = 0;
    for (let i = 0; i < n * n; i++) { const v = fn(planes, i, style); if (Number.isFinite(v)) { sum += v; cnt++; } }
    out[k] = cnt ? sum / cnt : NaN;
  }
  return out;
}
