// The OBIA data contract (docs/OBIA.md): every asset keeps its own grid and
// sampling support, every feature says where it came from and at what
// support, and every object carries its values beside the support behind
// them. Types only.

export type AssetRole = 'boundary-imagery' | 'lidar-points' | 'lidar-feature'
  | 'terrain-feature' | 'spectral-context' | 'quality-mask' | 'reference';

/**
 * A raster grid. `transform` is GDAL GeoTransform order —
 * [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight]
 * with pixelHeight NEGATIVE for a north-up grid — and maps a pixel's
 * top-left CORNER: x = t0 + col·t1 + row·t2, y = t3 + col·t4 + row·t5.
 * A pixel's centre is (col + 0.5, row + 0.5). `pixelConvention: 'area'`
 * (GeoTIFF PixelIsArea) is the only one this code produces.
 */
export interface GridDefinition {
  crs: string;
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
  pixelConvention: 'area' | 'point';
}

export interface SourceAsset {
  /** Stable identity (collection/item/asset, or a local file's name + hash), never an expiring URL. */
  id: string;
  role: AssetRole;
  label: string;
  collectionId?: string;
  itemId?: string;
  assetKey?: string;
  /** Where the bytes are read from; no embedded secrets. A local file is `local:<id>`. */
  uriReference: string;
  acquiredStart?: string;
  acquiredEnd?: string;
  /** Native ground resolution; omitted when unknown (a tile service's zoom is not a native resolution). */
  nativeResolutionM?: [number, number];
  grid?: GridDefinition;
  bands?: Array<{ name: string; unit?: string; scale?: number; offset?: number; noData?: number }>;
  verticalDatum?: string;
  horizontalAccuracyM?: number;
  pointDensityPerM2?: number;
  access: 'analytical' | 'reference-only' | 'unavailable';
  /** Why access is what it is (a probe result, a licence position). */
  accessNote?: string;
  contentVersion?: string;
  attribution?: string;
}

export type FeatureGroup = 'rgb' | 'structure' | 'terrain' | 'sentinel' | 'quality' | 'geometry' | 'index' | 'returns';

export interface FeatureDefinition {
  id: string;
  label: string;
  sourceIds: string[];
  group: FeatureGroup;
  operation: string;
  parameters: Record<string, unknown>;
  unit: string;
  processingResolutionM?: number;
  /** Omitted when unknown; never fabricated. */
  effectiveSupportM?: number;
  sampling: 'fine-grid' | 'native-area-weighted' | 'point-within-object' | 'parent-context' | 'neighbourhood-context';
  useForSegmentation: boolean;
  useForClassification: boolean;
}

export interface SupportRecord {
  /** Share of the object's area where this group had a valid value. */
  validFraction: number;
  /** Distinct native pixels the object intersects (coarse inputs). */
  nativePixelCount?: number;
  /** (Σw)² / Σw² over the valid intersections: how concentrated the weights are, NOT independent observations. */
  effectivePixelCount?: number;
  pointCount?: number;
  qualityFlags: string[];
}

export interface ObjectRecord {
  /** `<segmentationVersion>:<index>` — unique within a segmentation version. */
  id: string;
  /** Index into the label raster (0…count−1). */
  index: number;
  segmentationVersion: string;
  parentId?: string;
  areaM2: number;
  /** Centroid in the analysis CRS. */
  cx: number;
  cy: number;
  featureValues: Record<string, number | null>;
  support: Record<string, SupportRecord>;
  referenceClass?: string;
  /** The deepest class predicted (composition where a level-2 model exists). */
  predictedClass?: string;
  classScores?: Record<string, number>;
  /** The level-1 (structural) prediction and its scores. */
  predictedParent?: string;
  parentScores?: Record<string, number>;
  reviewedClass?: string;
  flags: string[];
}
