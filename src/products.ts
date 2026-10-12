// Every product the viewer can draw, as data: which inputs it reads, how each
// output channel is computed from them, and how it is painted. Imagery,
// LiDAR rasters and their fusion are all the same shape, which is what lets
// one engine (engine.ts) draw any of them and let a fusion product mix a 10 m
// UTM band with a 1 m Lambert DSM per pixel. Pure; unit-tested.
//
// Inputs are named `s2:<asset>` (a Sentinel-2 L2A asset, sample 0),
// `s2:visual#<n>` (one sample of the TCI COG) and `lidar:dtm` / `lidar:dsm`.
// Sentinel-2 values arrive as REFLECTANCE: the engine applies each asset's
// STAC `raster:bands` scale and offset (0.0001 and −0.1 on baseline ≥ 04.00
// scenes), so the indices are computed on reflectance, not on raw DN.

import type { Curve, PaintSpec, Render } from './paint.ts';
import { DEFAULT_UNMIX, type UnmixParams } from './unmix.ts';
import { coniferVariables } from './coniferIndex.ts';

export type Planes = Record<string, Float32Array>;
export type ChannelFn = (p: Planes, i: number, s: ProductStyle) => number;

export interface Channel {
  label: string;
  unit: string;
  fn: ChannelFn;
  /** A fixed scale (an index's −1..1): the histogram spans it and the handles open at `seed`. */
  domain?: [number, number];
  /** How the handles open: the view's 2nd–98th percentile, 0..98th, or fixed values. */
  seed: 'p2p98' | 'zero-p98' | [number, number];
  step: number;
}

export interface ClassDef { value: number; label: string; colour: string }

export interface Thresholds {
  /** NDWI above this (and low canopy) is water. */
  water: number;
  /** NIR reflectance below this (and low canopy) is also water: dark water has no usable index. */
  darkNir: number;
  /** NDVI at or above this is vegetated. */
  veg: number;
  /** Canopy height (m) at or above which vegetation is trees. */
  tree: number;
  /** Canopy height (m) at or above which vegetation is shrub. */
  shrub: number;
  /** Height (m) at or above which non-vegetated ground is a structure. */
  building: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { water: 0.05, darkNir: 0.04, veg: 0.35, tree: 5, shrub: 1, building: 2.5 };

export interface ProductStyle {
  ranges: [number, number][];
  curve: Curve;
  gamma: number;
  thresholds: Thresholds;
  /** Relief products: exaggeration and sun azimuth. */
  zFactor: number;
  azimuth: number;
}

export interface Product {
  id: string;
  label: string;
  group: string;
  inputs: string[];
  render: Render;
  channels: Channel[];
  ramp?: string[];
  relief?: 'hillshade' | 'shaded';
  classes?: ClassDef[];
  /** TCI: ESA's own 8-bit stretch, shown as is — no stretch controls. */
  identity?: boolean;
  /** Extra output pixels needed on each side (relief: 1). */
  pad: number;
  /** RGB: a pixel with one channel missing still paints (that channel dark). For fusion, where an index can be undefined over dark water while the others are not. */
  partial?: boolean;
  /** Two-axis classes (strata × cover): how the legend lays the classes out as a table. */
  matrix?: {
    rows: { label: string; colour: string }[];
    cols: { label: string; range: string }[];
    value: (row: number, col: number) => number;
    unclassified?: (col: number) => number;
  };
  /** A class layer drawn some other way (a tint over the orthophoto): the class of a pixel, for the legend's shares. */
  classOf?: ChannelFn;
  /** Sharpen these imagery inputs with the CHM before the channels are computed (unmix.ts); channels read them as `u:<key>`. */
  sharpen?: { keys: string[]; params: UnmixParams };
  /** One line under the picker: what the product is, and its formula. */
  note: string;
}

// ── Sentinel-2 bands ────────────────────────────────────────────────────────

export interface BandDef { asset: string; esa: string; label: string; nm: number | null; res: number }

export const S2_BANDS: BandDef[] = [
  { asset: 'coastal', esa: 'B01', label: 'Coastal aerosol', nm: 443, res: 60 },
  { asset: 'blue', esa: 'B02', label: 'Blue', nm: 490, res: 10 },
  { asset: 'green', esa: 'B03', label: 'Green', nm: 560, res: 10 },
  { asset: 'red', esa: 'B04', label: 'Red', nm: 665, res: 10 },
  { asset: 'rededge1', esa: 'B05', label: 'Red edge 1', nm: 705, res: 20 },
  { asset: 'rededge2', esa: 'B06', label: 'Red edge 2', nm: 740, res: 20 },
  { asset: 'rededge3', esa: 'B07', label: 'Red edge 3', nm: 783, res: 20 },
  { asset: 'nir', esa: 'B08', label: 'NIR', nm: 842, res: 10 },
  { asset: 'nir08', esa: 'B8A', label: 'Narrow NIR', nm: 865, res: 20 },
  { asset: 'nir09', esa: 'B09', label: 'Water vapour', nm: 945, res: 60 },
  { asset: 'swir16', esa: 'B11', label: 'SWIR 1', nm: 1610, res: 20 },
  { asset: 'swir22', esa: 'B12', label: 'SWIR 2', nm: 2190, res: 20 },
];
const bandByAsset = new Map(S2_BANDS.map(b => [b.asset, b]));
export const bandTitle = (asset: string) => {
  const b = bandByAsset.get(asset);
  return b ? `${b.esa} ${b.label}${b.nm ? ` ${b.nm} nm` : ''} · ${b.res} m` : asset;
};

/** Which scene an input comes from: `s2` the (leaf-on) scene, `s2b` the optional second, leaf-off one. */
export type Scene = 's2' | 's2b';

/** `pre` = 'u:' reads the LiDAR-sharpened plane of the input (unmix.ts) instead of the raw one. */
const band = (asset: string, scene: Scene = 's2', pre = ''): Channel => {
  const key = `${pre}${scene}:${asset}`;
  return { label: bandByAsset.get(asset)?.esa ?? asset, unit: 'reflectance', step: 0.001, seed: 'p2p98', fn: (p, i) => p[key][i] };
};

// ── Indices ─────────────────────────────────────────────────────────────────

const BRBG = ['#8c510a', '#f5f5f5', '#01665e'];
const WATER = ['#a6611a', '#f5f5f5', '#0571b0'];
const BURN = ['#b2182b', '#f7f7f7', '#1a9850'];
const BUILT = ['#1a9850', '#f7f7f7', '#762a83'];

const nd = (a: number, b: number) => (a - b) / (a + b);

export interface IndexDef {
  id: string;
  label: string;
  group: 'Vegetation' | 'Moisture and water' | 'Burn and built-up';
  bands: string[];
  formula: string;
  ramp: string[];
  value: (v: Record<string, number>) => number;
}

export const INDICES: IndexDef[] = [
  { id: 'ndvi', label: 'NDVI', group: 'Vegetation', bands: ['nir', 'red'], formula: '(B08 − B04) / (B08 + B04)', ramp: BRBG, value: v => nd(v.nir, v.red) },
  { id: 'evi', label: 'EVI', group: 'Vegetation', bands: ['nir', 'red', 'blue'], formula: '2.5 (B08 − B04) / (B08 + 6 B04 − 7.5 B02 + 1)', ramp: BRBG, value: v => (2.5 * (v.nir - v.red)) / (v.nir + 6 * v.red - 7.5 * v.blue + 1) },
  { id: 'savi', label: 'SAVI', group: 'Vegetation', bands: ['nir', 'red'], formula: '1.5 (B08 − B04) / (B08 + B04 + 0.5)', ramp: BRBG, value: v => (1.5 * (v.nir - v.red)) / (v.nir + v.red + 0.5) },
  { id: 'gndvi', label: 'GNDVI', group: 'Vegetation', bands: ['nir', 'green'], formula: '(B08 − B03) / (B08 + B03)', ramp: BRBG, value: v => nd(v.nir, v.green) },
  { id: 'ndre', label: 'NDRE (red edge)', group: 'Vegetation', bands: ['nir08', 'rededge1'], formula: '(B8A − B05) / (B8A + B05)', ramp: BRBG, value: v => nd(v.nir08, v.rededge1) },
  { id: 'ndmi', label: 'NDMI (moisture)', group: 'Moisture and water', bands: ['nir', 'swir16'], formula: '(B08 − B11) / (B08 + B11)', ramp: WATER, value: v => nd(v.nir, v.swir16) },
  { id: 'ndwi', label: 'NDWI (water)', group: 'Moisture and water', bands: ['green', 'nir'], formula: '(B03 − B08) / (B03 + B08), McFeeters', ramp: WATER, value: v => nd(v.green, v.nir) },
  { id: 'mndwi', label: 'MNDWI', group: 'Moisture and water', bands: ['green', 'swir16'], formula: '(B03 − B11) / (B03 + B11)', ramp: WATER, value: v => nd(v.green, v.swir16) },
  { id: 'nbr', label: 'NBR (burn)', group: 'Burn and built-up', bands: ['nir', 'swir22'], formula: '(B08 − B12) / (B08 + B12)', ramp: BURN, value: v => nd(v.nir, v.swir22) },
  { id: 'ndbi', label: 'NDBI (built-up)', group: 'Burn and built-up', bands: ['swir16', 'nir'], formula: '(B11 − B08) / (B11 + B08)', ramp: BUILT, value: v => nd(v.swir16, v.nir) },
];
const indexById = new Map(INDICES.map(x => [x.id, x]));

/** Summed reflectance of an index's bands below which the ratio is noise. */
export const MIN_INDEX_SIGNAL = 0.01;

/** A channel computing an index per pixel from reflectance planes. */
function indexChannel(ix: IndexDef, seed: Channel['seed'] = [-1, 1], scene: Scene = 's2', pre = ''): Channel {
  const keys = ix.bands.map(b => [b, `${pre}${scene}:${b}`] as const);
  const v: Record<string, number> = {};
  return {
    label: ix.label, unit: 'index', step: 0.01, domain: [-1, 1], seed,
    // Sen2Cor's correction pushes the darkest pixels (deep water above all)
    // slightly BELOW zero reflectance, and a ratio over a negative value is
    // nonsense — NDVI ≈ 1 on Bedford Basin. A negative reflectance is read as
    // 0 (no light), and where the bands together are too dark to carry a
    // ratio at all the pixel has no index rather than a made-up one.
    fn: (p, i) => {
      let sum = 0;
      for (const [b, k] of keys) { const x = p[k][i]; if (x !== x) return NaN; v[b] = x > 0 ? x : 0; sum += v[b]; }
      if (sum < MIN_INDEX_SIGNAL) return NaN;
      const r = ix.value(v);
      return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : NaN;
    },
  };
}

// ── Imagery products ────────────────────────────────────────────────────────

const rgbProduct = (id: string, label: string, assets: [string, string, string], note: string): Product => ({
  id, label, group: 'Band combinations', inputs: [...new Set(assets)].map(a => `s2:${a}`),
  render: 'rgb', channels: assets.map(a => band(a)), pad: 0, note,
});

export const SCL_CLASSES: ClassDef[] = [
  { value: 1, label: 'Saturated / defective', colour: '#ff0000' },
  { value: 2, label: 'Dark area', colour: '#2f2f2f' },
  { value: 3, label: 'Cloud shadow', colour: '#643200' },
  { value: 4, label: 'Vegetation', colour: '#00a000' },
  { value: 5, label: 'Not vegetated', colour: '#ffe65a' },
  { value: 6, label: 'Water', colour: '#0000ff' },
  { value: 7, label: 'Unclassified', colour: '#808080' },
  { value: 8, label: 'Cloud, medium probability', colour: '#c0c0c0' },
  { value: 9, label: 'Cloud, high probability', colour: '#ffffff' },
  { value: 10, label: 'Thin cirrus', colour: '#64c8ff' },
  { value: 11, label: 'Snow / ice', colour: '#ff96ff' },
];

export const IMAGERY_PRODUCTS: Product[] = [
  {
    id: 'tci', label: 'True colour (TCI)', group: 'Band combinations', inputs: ['s2:visual#0', 's2:visual#1', 's2:visual#2'],
    render: 'rgb', identity: true, pad: 0,
    channels: [0, 1, 2].map(n => ({ label: ['R', 'G', 'B'][n], unit: 'DN', step: 1, seed: [0, 255] as [number, number], fn: (p: Planes, i: number) => p[`s2:visual#${n}`][i] })),
    note: "ESA's own 8-bit stretch of B04/B03/B02. Pick a composite or an index for stretch controls.",
  },
  rgbProduct('natural', 'Natural colour', ['red', 'green', 'blue'], 'B04 / B03 / B02 from reflectance, with your stretch.'),
  rgbProduct('fcir', 'False colour IR', ['nir', 'red', 'green'], 'B08 / B04 / B03: vegetation red, water dark, urban cyan.'),
  rgbProduct('agri', 'Agriculture', ['swir16', 'nir', 'blue'], 'B11 / B08 / B02: healthy crops bright green, bare soil magenta.'),
  rgbProduct('swir', 'SWIR', ['swir22', 'nir08', 'red'], 'B12 / B8A / B04: vegetation green, burn scars and bare ground red-brown.'),
  rgbProduct('geology', 'Geology', ['swir22', 'swir16', 'blue'], 'B12 / B11 / B02: rock and soil differences, vegetation dark.'),
  ...INDICES.map((ix): Product => ({
    id: ix.id, label: ix.label, group: `${ix.group} indices`, inputs: ix.bands.map(b => `s2:${b}`),
    render: 'ramp', ramp: ix.ramp, channels: [indexChannel(ix)], pad: 0,
    note: `${ix.label} = ${ix.formula}, on reflectance. Ramp fixed over −1..1; the handles narrow it.`,
  })),
  {
    id: 'scl', label: 'Scene classification (SCL)', group: 'Classes', inputs: ['s2:scl'], render: 'classes', classes: SCL_CLASSES, pad: 0,
    channels: [{ label: 'SCL', unit: 'class', step: 1, seed: [0, 11], fn: (p, i) => p['s2:scl'][i] }],
    note: "Sen2Cor's per-pixel scene classes, 20 m.",
  },
];

/** One band in grey. */
export function singleBandProduct(asset: string): Product {
  return {
    id: `single:${asset}`, label: `Single band: ${bandTitle(asset)}`, group: 'Single band', inputs: [`s2:${asset}`],
    render: 'gray', channels: [band(asset)], pad: 0, note: `${bandTitle(asset)}, reflectance.`,
  };
}

/** Any three bands as red, green and blue. */
export function customRgbProduct(assets: [string, string, string]): Product {
  return { ...rgbProduct(`custom:${assets.join(',')}`, 'Custom RGB', assets, assets.map(a => bandByAsset.get(a)?.esa ?? a).join(' / ') + ', reflectance.'), group: 'Custom' };
}

export function imageryProduct(id: string): Product | undefined {
  return IMAGERY_PRODUCTS.find(p => p.id === id);
}

// ── LiDAR raster products ───────────────────────────────────────────────────

export const TERRAIN = ['#26734d', '#72a45c', '#c4c478', '#cca066', '#aa785a', '#f0f0f0'];
export const CANOPY = ['#f7fcf5', '#c7e9c0', '#74c476', '#238b45', '#00441b'];

const height = (key: 'lidar:dtm' | 'lidar:dsm', label: string): Channel => ({ label, unit: 'm', step: 1, seed: 'p2p98', fn: (p, i) => p[key][i] });
const chmChannel: Channel = {
  label: 'Canopy height', unit: 'm', step: 0.5, seed: 'zero-p98',
  fn: (p, i) => { const d = p['lidar:dsm'][i] - p['lidar:dtm'][i]; return d !== d ? NaN : Math.max(0, d); },
};

const SURF = { dtm: { name: 'DTM', what: 'bare earth' }, dsm: { name: 'DSM', what: 'surface incl. trees and buildings' } } as const;
const MODE = {
  hillshade: { name: 'hillshade', what: 'relief, lit from the north-west' },
  elevation: { name: 'elevation', what: 'height as a colour ramp' },
  shaded: { name: 'shaded elevation', what: 'colour ramp over hillshade' },
} as const;

export const RASTER_PRODUCTS: Product[] = [
  ...(['dtm', 'dsm'] as const).flatMap(s => (['hillshade', 'elevation', 'shaded'] as const).map((m): Product => ({
    id: `${s}-${m}`, label: `${SURF[s].name} ${MODE[m].name}`, group: SURF[s].name,
    inputs: [`lidar:${s}`], channels: [height(`lidar:${s}`, SURF[s].name)],
    render: m === 'elevation' ? 'ramp' : 'relief', relief: m === 'hillshade' ? 'hillshade' : m === 'shaded' ? 'shaded' : undefined,
    ramp: TERRAIN, pad: m === 'elevation' ? 0 : 1,
    note: `${SURF[s].what}; ${MODE[m].what}. Heights on CGVD2013.`,
  }))),
  {
    id: 'chm', label: 'Canopy height model (DSM − DTM)', group: 'Derived', inputs: ['lidar:dsm', 'lidar:dtm'],
    channels: [chmChannel], render: 'ramp', ramp: CANOPY, pad: 0,
    note: 'Height of whatever stands on the ground — trees, shrubs and buildings alike — in metres. Negative differences read as 0.',
  },
];

export const rasterProduct = (id: string) => RASTER_PRODUCTS.find(p => p.id === id);

/** The raster products an HRDEM item can supply (DSM and CHM need a DSM asset). */
export function rasterProductsFor(item: { dsm: string | null }): Product[] {
  return RASTER_PRODUCTS.filter(p => item.dsm || !p.inputs.includes('lidar:dsm'));
}

// ── Fusion: LiDAR × imagery ─────────────────────────────────────────────────

/** A variable a custom fusion channel can draw on. */
export interface Variable {
  id: string; label: string; group: string; inputs: string[]; channel: Channel;
  /** The imagery inputs this variable reads LiDAR-sharpened (its channel reads `u:<key>`). */
  sharpenKeys?: string[];
}

const FUSION_BANDS = S2_BANDS.filter(b => b.res <= 20);

/** On-minus-off: how much a variable FALLS between the leaf-on and the leaf-off scene. */
function deltaVariable(id: string, label: string, on: Channel, off: Channel, inputs: string[]): Variable {
  return {
    id: `d_${id}`, label: `Δ ${label} (leaf-on − leaf-off)`, group: 'Seasonal change', inputs,
    channel: { label: `Δ ${label}`, unit: on.unit, step: on.step, seed: 'p2p98', fn: (p, i, s) => on.fn(p, i, s) - off.fn(p, i, s) },
  };
}

export const FUSION_VARIABLES: Variable[] = [
  { id: 'chm', label: 'Canopy height (DSM − DTM)', group: 'LiDAR', inputs: ['lidar:dsm', 'lidar:dtm'], channel: chmChannel },
  { id: 'dtm', label: 'Ground elevation (DTM)', group: 'LiDAR', inputs: ['lidar:dtm'], channel: height('lidar:dtm', 'DTM') },
  { id: 'dsm', label: 'Surface elevation (DSM)', group: 'LiDAR', inputs: ['lidar:dsm'], channel: height('lidar:dsm', 'DSM') },
  ...INDICES.map(ix => ({ id: ix.id, label: ix.label, group: 'Leaf-on indices', inputs: ix.bands.map(b => `s2:${b}`), channel: indexChannel(ix, 'p2p98') })),
  ...FUSION_BANDS.map(b => ({ id: b.asset, label: `${b.esa} ${b.label}`, group: 'Leaf-on bands', inputs: [`s2:${b.asset}`], channel: band(b.asset) })),
  ...INDICES.map(ix => ({ id: `${ix.id}_off`, label: `${ix.label} (leaf-off)`, group: 'Leaf-off indices', inputs: ix.bands.map(b => `s2b:${b}`), channel: indexChannel(ix, 'p2p98', 's2b') })),
  ...FUSION_BANDS.map(b => ({ id: `${b.asset}_off`, label: `${b.esa} ${b.label} (leaf-off)`, group: 'Leaf-off bands', inputs: [`s2b:${b.asset}`], channel: band(b.asset, 's2b') })),
  ...['ndvi', 'evi', 'ndmi', 'ndre'].map(id => {
    const ix = indexById.get(id)!;
    return deltaVariable(id, ix.label, indexChannel(ix, 'p2p98'), indexChannel(ix, 'p2p98', 's2b'), [...ix.bands.map(b => `s2:${b}`), ...ix.bands.map(b => `s2b:${b}`)]);
  }),
  ...['nir', 'swir16'].map(a => deltaVariable(a, bandByAsset.get(a)!.esa, band(a), band(a, 's2b'), [`s2:${a}`, `s2b:${a}`])),
];
/** The LiDAR-sharpened twin of an imagery variable: same formula, read on the unmixed bands. */
function sharpenedTwins(): Variable[] {
  const LIDAR = ['lidar:dsm', 'lidar:dtm'];
  const out: Variable[] = [];
  const twin = (base: Variable, channel: Channel): Variable => {
    const keys = base.inputs.filter(k => k.startsWith('s2'));
    return { id: `s_${base.id}`, label: `${base.label} · sharpened`, group: `LiDAR-sharpened ${base.group.toLowerCase()}`, inputs: [...new Set([...base.inputs, ...LIDAR])], channel, sharpenKeys: keys };
  };
  for (const v of FUSION_VARIABLES) {
    if (v.group === 'LiDAR') continue;
    const off = v.id.endsWith('_off'), scene: Scene = off ? 's2b' : 's2';
    const baseId = v.id.replace(/_off$/, '').replace(/^d_/, '');
    const ix = indexById.get(baseId), b = bandByAsset.get(baseId);
    let ch: Channel | null = null;
    if (v.id.startsWith('d_')) {
      const on = ix ? indexChannel(ix, 'p2p98', 's2', 'u:') : band(baseId, 's2', 'u:');
      const of = ix ? indexChannel(ix, 'p2p98', 's2b', 'u:') : band(baseId, 's2b', 'u:');
      ch = { ...v.channel, fn: (p, i, st) => on.fn(p, i, st) - of.fn(p, i, st) };
    } else if (ix) ch = indexChannel(ix, 'p2p98', scene, 'u:');
    else if (b) ch = band(baseId, scene, 'u:');
    if (ch) out.push(twin(v, { ...ch, label: `${v.channel.label} · sharpened` }));
  }
  return out;
}
FUSION_VARIABLES.push(...sharpenedTwins());

// ── Point-cloud and orthophoto evidence ─────────────────────────────────────

const plane = (key: string, label: string, unit: string, step: number): Channel => ({ label, unit, step, seed: 'p2p98', fn: (p, i) => p[key][i] });

/** Point-cloud metrics (pcMetrics.ts), per 2–16 m cell by zoom. Intensity is uncalibrated: compare within one acquisition. */
export const PC_VARIABLES: Variable[] = ([
  { id: 'pc_ivg', label: 'Vegetation intensity (laser NIR)', inputs: ['pc:ivg'], channel: plane('pc:ivg', 'Vegetation intensity', 'DN', 1) },
  { id: 'pc_int', label: 'First-return intensity', inputs: ['pc:int'], channel: plane('pc:int', 'First-return intensity', 'DN', 1) },
  { id: 'pc_igr', label: 'Ground intensity', inputs: ['pc:igr'], channel: plane('pc:igr', 'Ground intensity', 'DN', 1) },
  { id: 'pc_pen', label: 'Penetration (share of pulses reaching ground)', inputs: ['pc:pen'], channel: { ...plane('pc:pen', 'Penetration', 'ratio', 0.01), domain: [0, 1] } },
  { id: 'pc_att', label: 'Canopy attenuation (per m)', inputs: ['pc:att'], channel: plane('pc:att', 'Canopy attenuation', '/m', 0.005) },
  { id: 'pc_den', label: 'First-return density (per m²)', inputs: ['pc:den'], channel: plane('pc:den', 'First-return density', '/m²', 0.1) },
] as Omit<Variable, 'group'>[]).map(v => ({ ...v, group: 'LiDAR point cloud' }));

const ORTHO_RGB = ['ortho:r', 'ortho:g', 'ortho:b'];
/** Orthophoto evidence: what a sub-metre colour photo adds — crown brightness, greenness and shadow texture. */
export const ORTHO_VARIABLES: Variable[] = ([
  { id: 'o_bright', label: 'Ortho brightness', inputs: ORTHO_RGB, channel: { label: 'Ortho brightness', unit: '0–1', step: 0.01, seed: 'p2p98', domain: [0, 1], fn: (p: Planes, i: number) => (p['ortho:r'][i] + p['ortho:g'][i] + p['ortho:b'][i]) / 765 } },
  {
    id: 'o_exg', label: 'Ortho excess green', inputs: ORTHO_RGB, channel: {
      label: 'Ortho excess green', unit: 'index', step: 0.01, seed: 'p2p98', domain: [-1, 1],
      fn: (p: Planes, i: number) => { const r = p['ortho:r'][i], g = p['ortho:g'][i], b = p['ortho:b'][i], t = r + g + b; return t >= 15 ? (2 * g - r - b) / t : NaN; },
    },
  },
  { id: 'o_tex', label: 'Ortho texture (brightness s.d., ±5 m)', inputs: ['ortho:tex'], channel: plane('ortho:tex', 'Ortho texture', '0–1', 0.005) },
  { id: 'o_r', label: 'Ortho red', inputs: ['ortho:r'], channel: { ...plane('ortho:r', 'Ortho red', 'DN', 1), seed: [0, 255] } },
  { id: 'o_g', label: 'Ortho green', inputs: ['ortho:g'], channel: { ...plane('ortho:g', 'Ortho green', 'DN', 1), seed: [0, 255] } },
  { id: 'o_b', label: 'Ortho blue', inputs: ['ortho:b'], channel: { ...plane('ortho:b', 'Ortho blue', 'DN', 1), seed: [0, 255] } },
] as Omit<Variable, 'group'>[]).map(v => ({ ...v, group: 'Orthophoto (RGB)' }));

/**
 * Measures of a SEGMENT, not a pixel (segment/objects.ts): they have values
 * only when a product is classified per object ("Segment this view"); on the
 * pixel map they are missing, so a condition on one is false there.
 */
const objPlane = (key: string, label: string, unit: string, step: number): Channel => ({ label, unit, step, seed: 'p2p98', fn: (p, i) => p[key]?.[i] ?? NaN });
export const OBJECT_VARIABLES: Variable[] = ([
  { id: 'obj_area', label: 'Object area (m²)', inputs: ['obj:area'], channel: objPlane('obj:area', 'Object area', 'm²', 1) },
  { id: 'obj_compact', label: 'Object compactness (1 = disc)', inputs: ['obj:compact'], channel: objPlane('obj:compact', 'Compactness', '', 0.01) },
  { id: 'obj_chm_p90', label: 'Object canopy height, 90th percentile', inputs: ['obj:chm_p90'], channel: objPlane('obj:chm_p90', 'Canopy height P90', 'm', 0.5) },
  { id: 'obj_chm_sd', label: 'Object canopy height spread (s.d.)', inputs: ['obj:chm_sd'], channel: objPlane('obj:chm_sd', 'Canopy height s.d.', 'm', 0.1) },
  { id: 'obj_tex', label: 'Object photo texture (brightness s.d.)', inputs: ['obj:tex'], channel: objPlane('obj:tex', 'Photo texture', '0–1', 0.005) },
] as Omit<Variable, 'group'>[]).map(v => ({ ...v, group: 'Objects (segmentation only)' }));

FUSION_VARIABLES.push(...PC_VARIABLES, ...ORTHO_VARIABLES, ...coniferVariables(), ...OBJECT_VARIABLES);

export const variableById = new Map(FUSION_VARIABLES.map(v => [v.id, v]));

/** The sharpening a set of variables needs (null: none). */
export function sharpeningFor(vars: Variable[], params: UnmixParams = DEFAULT_UNMIX): Product['sharpen'] {
  const keys = [...new Set(vars.flatMap(v => v.sharpenKeys ?? []))];
  return keys.length ? { keys, params } : undefined;
}
/** Whether a variable needs the second (leaf-off) scene. */
export const needsLeafOff = (v: Variable) => v.inputs.some(k => k.startsWith('s2b:'));

const NDVI = indexById.get('ndvi')!, NDWI = indexById.get('ndwi')!;
const ndviCh = indexChannel(NDVI), ndwiCh = indexChannel(NDWI);

/**
 * NDWI, with the classifier's dark-water rule: where the bands are too dark
 * for a ratio but NIR is below the dark-water threshold, the pixel is water
 * (+1). Keeps the composite and the classes telling the same story.
 */
const waterChannel: Channel = {
  ...ndwiCh, label: 'NDWI (dark NIR = water)',
  fn: (p, i, s) => { const w = ndwiCh.fn(p, i, s); if (w === w) return w; const n = p['s2:nir'][i]; return n === n && n < s.thresholds.darkNir ? 1 : NaN; },
};

export const FUSION_PRODUCTS: Product[] = [
  {
    id: 'fusion-sgw', label: 'Structure · greenness · water (CHM · NDVI · NDWI)', group: 'Fusion composites',
    inputs: ['lidar:dsm', 'lidar:dtm', 's2:nir', 's2:red', 's2:green'], render: 'rgb', pad: 0, partial: true,
    channels: [{ ...chmChannel, seed: [0, 15] }, { ...ndviCh, seed: [0, 0.9] }, { ...waterChannel, seed: [-0.6, 0.3] }],
    note: 'Red = canopy height, green = NDVI, blue = NDWI. Yellow: trees. Green: low vegetation. Red/orange: tall and not green (buildings). Blue: water. Dark: bare or paved.',
  },
];

FUSION_PRODUCTS.push({
  id: 'fusion-sharp-fcir', label: 'LiDAR-sharpened false colour (B08 · B04 · B03)', group: 'Fusion composites',
  inputs: ['s2:nir', 's2:red', 's2:green', 'lidar:dsm', 'lidar:dtm'], render: 'rgb', pad: 0, partial: true,
  sharpen: { keys: ['s2:nir', 's2:red', 's2:green'], params: DEFAULT_UNMIX },
  channels: (['nir', 'red', 'green'] as const).map(a => band(a, 's2', 'u:')),
  note: 'Sentinel-2 false colour unmixed by LiDAR height class: each 1 m pixel takes the spectrum of its height class (ground, shrub, canopy) in its neighbourhood, and every 10 m pixel still averages to what Sentinel-2 measured. From zoom 15.',
});

const pcVar = (id: string) => PC_VARIABLES.find(v => v.id === id)!.channel;
FUSION_PRODUCTS.push(
  {
    id: 'fusion-pcir', label: 'Pseudo colour-infrared (LiDAR intensity · ortho red · ortho green)', group: 'Fusion composites',
    inputs: ['pc:int', 'ortho:r', 'ortho:g'], render: 'rgb', pad: 0, partial: true,
    channels: [{ ...pcVar('pc_int'), label: 'LiDAR intensity (1064 nm)' }, { ...plane('ortho:r', 'Ortho red', 'DN', 1), seed: [0, 255] }, { ...plane('ortho:g', 'Ortho green', 'DN', 1), seed: [0, 255] }],
    note: 'The laser is near-infrared, so its intensity can stand in for the NIR band a colour orthophoto lacks: red = LiDAR first-return intensity (2–16 m cells by zoom), green = ortho red, blue = ortho green. Vegetation reads red as in a CIR photo. Point clouds read from zoom 13.',
  },
  {
    id: 'fusion-pc-evidence', label: 'Point-cloud evidence (vegetation intensity · penetration · attenuation)', group: 'Fusion composites',
    inputs: ['pc:ivg', 'pc:pen', 'pc:att'], render: 'rgb', pad: 0, partial: true,
    channels: [pcVar('pc_ivg'), { ...pcVar('pc_pen'), seed: [0, 1] }, pcVar('pc_att')],
    note: 'Red = vegetation intensity (bright: broadleaf leaves, grass), green = share of pulses reaching the ground (open canopy, bare ground), blue = canopy attenuation (dense crowns that stop pulses: conifer). Uncalibrated: compare within the view.',
  },
);

/**
 * A class product drawn as a TINT over the orthophoto — the candidate cover
 * classes as a "fourth band" on a sub-metre photo: each pixel is the photo's
 * colour mixed with its class colour at `alpha`; unclassified pixels show the
 * photo alone.
 */
export function tintProduct(base: Product, alpha: number): Product {
  if (!base.classes) throw new Error(`${base.label} has no classes to tint with`);
  const rgbOf = (hex: string) => [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16));
  const colours = new Map(base.classes.map(c => [c.value, rgbOf(c.colour)]));
  const cls = base.channels[0].fn;
  // The class is evaluated once per pixel, not once per colour channel.
  const memo = new WeakMap<Planes, Float32Array>();
  const classAt: ChannelFn = (p, i, s) => {
    let a = memo.get(p);
    if (!a) { a = new Float32Array(p['ortho:r'].length).fill(-1); memo.set(p, a); }
    if (a[i] === -1) a[i] = cls(p, i, s);
    return a[i];
  };
  return {
    ...base, id: `tint:${alpha}:${base.id}`, label: `${base.label} — tint over the orthophoto`, render: 'rgb', identity: true, partial: true,
    inputs: [...new Set([...base.inputs, ...ORTHO_RGB])], classOf: classAt,
    channels: (['r', 'g', 'b'] as const).map((c, j): Channel => ({
      label: c.toUpperCase(), unit: 'DN', step: 1, seed: [0, 255],
      fn: (p, i, s) => {
        const o = p[`ortho:${c}`][i], k = classAt(p, i, s), col = k === k ? colours.get(k) : undefined;
        if (!col) return o;
        return o === o ? (1 - alpha) * o + alpha * col[j] : col[j];
      },
    })),
    note: `${base.note} Drawn over the orthophoto at ${Math.round(alpha * 100)} % tint.`,
  };
}

/** A custom fusion composite: any three variables as red, green and blue. */
export function customFusionProduct(ids: [string, string, string]): Product {
  const vars = ids.map(id => variableById.get(id)!);
  return {
    id: `fusion-custom:${ids.join(',')}`, label: 'Custom fusion RGB', group: 'Fusion composites',
    inputs: [...new Set(vars.flatMap(v => v.inputs))], render: 'rgb', pad: 0, partial: true, sharpen: sharpeningFor(vars),
    channels: vars.map(v => ({ ...v.channel, label: v.label })),
    note: `Red = ${vars[0].label}, green = ${vars[1].label}, blue = ${vars[2].label}.`,
  };
}

/** The paint spec for a product under a style. */
export function paintSpec(p: Product, s: ProductStyle): PaintSpec {
  return { render: p.render, ranges: s.ranges, curve: s.curve, gamma: s.gamma, ramp: p.ramp, relief: p.relief, classes: p.classes, partial: p.partial, zFactor: s.zFactor, azimuth: s.azimuth };
}

/** Whether a product exposes a stretch (range handles). */
export const hasStretch = (p: Product) => !p.identity && p.render !== 'classes' && p.relief !== 'hillshade';
/** Whether the curve and gamma apply (bands, not ramps — a ramp has a zero point the curve would move). */
export const hasCurve = (p: Product) => !p.identity && (p.render === 'rgb' || p.render === 'gray');

export function defaultStyle(p: Product): ProductStyle {
  return {
    ranges: p.channels.map(c => (Array.isArray(c.seed) ? [...c.seed] as [number, number] : [0, 1])),
    curve: 'linear', gamma: 1, thresholds: { ...DEFAULT_THRESHOLDS }, zFactor: 1, azimuth: 315,
  };
}

/** The handles a product opens at, from the view's statistics (null stats: keep the current ranges). Pure. */
export function seedRanges(p: Product, current: [number, number][], stats: ({ p2: number; p98: number } | null)[] | null): [number, number][] {
  return p.channels.map((c, i) => {
    if (Array.isArray(c.seed)) return [...c.seed] as [number, number];
    const s = stats?.[i];
    if (!s) return current[i] ?? [0, 1];
    const lo = c.seed === 'zero-p98' ? 0 : s.p2;
    return [lo, s.p98 > lo ? s.p98 : lo + c.step];
  });
}

const VARIABLE_RAMP = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];

/** Any one fusion variable as a colour ramp (the toolbox's "Variable map"). */
export function variableProduct(v: Variable): Product {
  return {
    id: `var:${v.id}`, label: v.label, group: 'Variable', inputs: v.inputs, render: 'ramp', ramp: VARIABLE_RAMP,
    channels: [v.sharpenKeys ? { ...v.channel } : v.channel], pad: 0, sharpen: v.sharpenKeys ? sharpeningFor([v]) : undefined,
    note: `${v.label}${v.channel.unit ? ` (${v.channel.unit})` : ''}, stretched over the view's 2nd–98th percentile.`,
  };
}
