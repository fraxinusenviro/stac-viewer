// The RECIPE: everything a result depends on, so that a result can be
// reproduced and a derived asset can be keyed by what made it. `recipeHash`
// is a stable hash of the recipe (keys sorted, so field order is irrelevant)
// together with the algorithm version. Pure; test/obiaRecipe.test.ts.

export const OBIA_ALGORITHM_VERSION = 'obia/1.0.0';

export interface SegmentParams {
  /** Approximate object area aimed for, m² (sets the SLIC seed spacing). NOT the minimum mapping unit. */
  targetAreaM2: number;
  /** Space against features: at 1, one reference difference costs as much as one seed spacing. */
  compactness: number;
  /** Group influences (0 switches a group off). */
  imageryWeight: number;
  structureWeight: number;
  terrainWeight: number;
  /** Region-merge tolerance in reference differences (0: no merging). */
  mergeSimilarity: number;
  /** Minimum patch area, m²: a target, with distinct small objects kept and flagged rather than forced into a neighbour. */
  minPatchAreaM2: number;
  /** A small object differing from EVERY neighbour by more than this (reference differences) is kept, not merged. */
  keepDistinctAbove: number;
}

export interface Preset {
  id: string;
  label: string;
  cellM: number;
  cells: number[];
  segment: SegmentParams;
  boundary: string;
  context: string;
}

/** Spec §11. Editable starting points, conditional on the sources actually present. */
export const PRESETS: Preset[] = [
  {
    id: 'fine-patches', label: 'Fine vegetation patches', cellM: 1, cells: [0.5, 1],
    segment: { targetAreaM2: 50, compactness: 1, imageryWeight: 1, structureWeight: 1, terrainWeight: 0, mergeSimilarity: 0.6, minPatchAreaM2: 25, keepDistinctAbove: 3 },
    boundary: 'RGB + CHM', context: 'Structure, optional Sentinel',
  },
  {
    id: 'habitat-stands', label: 'Habitat stands', cellM: 2, cells: [1, 2],
    segment: { targetAreaM2: 800, compactness: 1.2, imageryWeight: 1, structureWeight: 1, terrainWeight: 0.5, mergeSimilarity: 1, minPatchAreaM2: 250, keepDistinctAbove: 3 },
    boundary: 'RGB + CHM + limited terrain', context: 'Structure, terrain, seasonal Sentinel',
  },
  {
    id: 'wetland-mosaics', label: 'Wetland mosaics', cellM: 1, cells: [0.5, 1, 2],
    segment: { targetAreaM2: 200, compactness: 0.8, imageryWeight: 1, structureWeight: 1, terrainWeight: 0, mergeSimilarity: 0.8, minPatchAreaM2: 50, keepDistinctAbove: 3 },
    boundary: 'RGB + CHM', context: 'Hydrology (not yet implemented), structure, seasonal spectra',
  },
];

/**
 * Reference differences: one unit of each segmentation channel after
 * normalization. FIXED physical scales rather than per-tile statistics, so a
 * preview window and the full area are normalized identically, and recorded
 * in every recipe.
 */
export const REFERENCE_SCALES: Record<string, { scale: number; unit: string; group: 'rgb' | 'structure' | 'terrain' }> = {
  lab_l: { scale: 8, unit: 'CIE L*', group: 'rgb' },
  lab_a: { scale: 6, unit: 'CIE a*', group: 'rgb' },
  lab_b: { scale: 6, unit: 'CIE b*', group: 'rgb' },
  chm: { scale: 2, unit: 'm', group: 'structure' },
  slope: { scale: 5, unit: '°', group: 'terrain' },
};

export interface SentinelSettings {
  itemId: string | null;
  /** The optional second date (leaf-off or senescence). */
  secondItemId?: string | null;
  bands: string[];
  indices: string[];
  /** SCL classes treated as invalid, and the dilation applied to cloud/shadow classes in SCL pixels. */
  sclInvalid: number[];
  maskBufferPx: number;
}

export const DEFAULT_SENTINEL: Omit<SentinelSettings, 'itemId'> = {
  bands: ['blue', 'green', 'red', 'nir', 'rededge1', 'rededge2', 'rededge3', 'nir08', 'swir16'],
  indices: ['ndvi', 'ndre', 'ndmi'],
  sclInvalid: [0, 1, 3, 8, 9, 10, 11],
  maskBufferPx: 1,
};

export interface Recipe {
  algorithm: string;
  aoi: { id: string; name: string; geometry: GeoJSON.Polygon };
  objective: string;
  epsg: number;
  cellM: number;
  bufferM: number;
  segment: SegmentParams;
  referenceScales: typeof REFERENCE_SCALES;
  /** Source ids (SourceAsset.id) per role. */
  sources: { rgb: string | null; chm: string | null; dtm: string | null; sentinel: string | null; returns?: string | null };
  sourceVersions: Record<string, string>;
  sentinel: SentinelSettings;
  heightBandsM: number[];
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/** FNV-1a 64-bit of a string, hex. */
export function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const p = 0x100000001b3n, m = (1n << 64n) - 1n;
  for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * p) & m; }
  return h.toString(16).padStart(16, '0');
}

export const recipeHash = (r: Recipe | Record<string, unknown>) => fnv1a64(stableStringify(r));

/** The part of a recipe the SEGMENTATION depends on — Sentinel is deliberately not in it (spec invariant 1). */
export function segmentationKey(r: Recipe): string {
  return recipeHash({ algorithm: r.algorithm, aoi: r.aoi.geometry, epsg: r.epsg, cellM: r.cellM, bufferM: r.bufferM, segment: r.segment, scales: r.referenceScales, rgb: r.sources.rgb, chm: r.sources.chm, dtm: r.sources.dtm, v: [r.sources.rgb, r.sources.chm, r.sources.dtm].map(id => (id ? r.sourceVersions[id] ?? '' : '')) });
}
