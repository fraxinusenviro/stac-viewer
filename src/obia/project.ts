// The OBIA PROJECT: everything one study needs to be resumed, reviewed or
// handed on — recipe, sources, grid, the authoritative label raster, object
// records, labels with their provenance, original references, model,
// evaluation — and its exports (spec §10). Pure; test/obiaExport.test.ts.
//
// The INTEGER LABEL RASTER on the analysis grid is the authoritative
// partition: object polygons are traced from it on export (pixel edges, no
// simplification), so a polygon and its raster cell can never disagree.

import { ringsToPolygons, traceRings } from '../segment/objects.ts';
import { gridXY, type AnalysisGrid, type Projector } from './grid.ts';
import type { ClassDef, LabelEntry } from './labels.ts';
import type { Forest } from './rf.ts';
import type { ClassifyResult } from './classify.ts';
import { OBIA_ALGORITHM_VERSION, type Recipe } from './recipe.ts';
import type { FeatureDefinition, FeatureGroup, ObjectRecord, SourceAsset } from './types.ts';

export const PROJECT_SCHEMA = 'stac-viewer-obia/1';

export interface ReferenceFeature {
  id: string;
  kind: 'polygon' | 'point';
  classId: string;
  role: 'training' | 'validation';
  /** As imported, lon/lat. */
  geometry: GeoJSON.Polygon | GeoJSON.Point;
  file: string;
  properties: Record<string, unknown>;
}

export interface ClassificationRecord {
  settings: { groups: FeatureGroup[]; blockM: number; folds: number; forest: Forest['options'] };
  features: string[];
  cv: ClassifyResult['cv'];
  ablation: ClassifyResult['ablation'];
  validation: ClassifyResult['validation'];
  trainedOn: number;
  /** Level-2 composition models (their forests are stored here, not in `model`). Absent on pre-hierarchy projects. */
  sublevels?: ClassifyResult['sublevels'];
  skipped?: ClassifyResult['skipped'];
  /** Labels and recipe the model was fitted against, so staleness can be stated. */
  labelsHash: string;
  segmentationVersion: string;
  at: string;
}

export interface ObiaProject {
  schema: typeof PROJECT_SCHEMA;
  created: string;
  updated: string;
  recipe: Recipe;
  recipeHash: string;
  segmentationVersion: string;
  sources: SourceAsset[];
  grid: AnalysisGrid;
  /** The analysis CRS in full (proj4), so the bundle states it without a lookup. */
  crsDefinition: string;
  labels: Int32Array;
  count: number;
  objects: ObjectRecord[];
  featureDefs: FeatureDefinition[];
  coarsePixels: Int32Array[] | null;
  classes: ClassDef[];
  labelEntries: LabelEntry[];
  references: ReferenceFeature[];
  model: Forest | null;
  classification: ClassificationRecord | null;
  /** The within-run conifer score's calibration (absent before it existed). */
  coniferScore?: import('./composition.ts').ScoreReport;
  /** Measured stage times and sizes, for the performance report. */
  measured: Record<string, number | string>;
}

// ── Run-length coding of the label raster ───────────────────────────────────

export function rle(a: Int32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length;) { let j = i; while (j < a.length && a[j] === a[i]) j++; out.push(a[i], j - i); i = j; }
  return out;
}
export function unrle(r: number[], n: number): Int32Array {
  const out = new Int32Array(n);
  let p = 0;
  for (let i = 0; i < r.length; i += 2) { out.fill(r[i], p, p + r[i + 1]); p += r[i + 1]; }
  if (p !== n) throw new Error('the label raster in this bundle is truncated');
  return out;
}

// ── Bundle (reloadable project) ─────────────────────────────────────────────

export function toBundle(p: ObiaProject): string {
  return JSON.stringify({
    ...p,
    labels: { rle: rle(p.labels), n: p.labels.length },
    coarsePixels: p.coarsePixels ? p.coarsePixels.map(a => Array.from(a)) : null,
    manifest: manifest(p),
  });
}

export function fromBundle(text: string): ObiaProject {
  const j = JSON.parse(text);
  if (j.schema !== PROJECT_SCHEMA) throw new Error(`not a ${PROJECT_SCHEMA} bundle${j.schema ? ` (it says ${j.schema})` : ''}`);
  const n = j.grid.width * j.grid.height;
  if (j.labels?.n !== n) throw new Error('the bundle\'s label raster does not match its grid');
  delete j.manifest;
  return { ...j, labels: unrle(j.labels.rle, n), coarsePixels: j.coarsePixels ? j.coarsePixels.map((a: number[]) => Int32Array.from(a)) : null };
}

export function manifest(p: ObiaProject) {
  return {
    schema: p.schema, algorithm: OBIA_ALGORITHM_VERSION, recipeHash: p.recipeHash, segmentationVersion: p.segmentationVersion,
    analysisCrs: { code: p.grid.crs, proj4: p.crsDefinition, transform: p.grid.transform, transformOrder: 'GDAL GeoTransform [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight], top-left pixel corner', pixelConvention: p.grid.pixelConvention, width: p.grid.width, height: p.grid.height },
    datumNote: 'NAD83(CSRS) and WGS 84 are related by a null shift in this application (~1.4 m from ITRF in Nova Scotia).',
    geojsonCrs: 'EPSG:4326 (RFC 7946 lon/lat), 7 decimal places',
    sources: p.sources.map(s => ({ id: s.id, role: s.role, collectionId: s.collectionId, itemId: s.itemId, assetKey: s.assetKey, uri: s.uriReference, acquired: [s.acquiredStart, s.acquiredEnd], nativeResolutionM: s.nativeResolutionM, access: s.access, accessNote: s.accessNote, attribution: s.attribution })),
    featureDefinitions: p.featureDefs,
    created: p.created, updated: p.updated, measured: p.measured,
    caveat: 'Classes are candidate mapped units. They do not establish regulatory wetland boundaries or confirm ecological communities without field validation. Random Forest scores are vote shares, not calibrated probabilities.',
  };
}

// ── Vector exports ──────────────────────────────────────────────────────────

const r7 = (v: number) => Math.round(v * 1e7) / 1e7;
const round = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6);

function polygonsOf(rings: [number, number][][], g: AnalysisGrid, proj: Projector): GeoJSON.Polygon | GeoJSON.MultiPolygon {
  const polys = ringsToPolygons(rings).map(poly => poly.map(ring => ring.map(([x, y]) => { const ll = proj.inverse(gridXY(g, x, y)); return [r7(ll[0]), r7(ll[1])]; })));
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

/** Every object as a polygon with its class, scores, support and feature values. */
export function objectsGeoJSON(p: ObiaProject, proj: Projector): GeoJSON.FeatureCollection {
  const rings = traceRings(p.labels, p.grid.width, p.grid.height);
  const labelBy = new Map(p.labelEntries.map(e => [e.objectId, e]));
  const features: GeoJSON.Feature[] = [];
  for (const o of p.objects) {
    const rs = rings.get(o.index);
    if (!rs) continue;
    const lab = labelBy.get(o.id);
    const props: Record<string, unknown> = {
      object_id: o.id, segmentation_version: o.segmentationVersion, area_m2: round(o.areaM2),
      predicted: o.predictedClass ?? null, predicted_structure: o.predictedParent ?? null, reviewed: o.reviewedClass ?? null,
      label: lab && lab.role !== 'review' ? lab.classId : null, label_role: lab?.role ?? null, label_source: lab?.source ?? null,
      score_margin: o.classScores ? round(margin(o.classScores)) : null,
      flags: o.flags.join(';'),
    };
    for (const [c, v] of Object.entries(o.classScores ?? {})) props[`score_${c}`] = round(v);
    for (const [k, s] of Object.entries(o.support)) {
      props[`support_${k}_valid`] = round(s.validFraction);
      if (s.nativePixelCount !== undefined) props[`support_${k}_native_px`] = s.nativePixelCount;
      if (s.effectivePixelCount !== undefined) props[`support_${k}_n_eff`] = round(s.effectivePixelCount);
    }
    for (const d of p.featureDefs) props[d.id] = round(o.featureValues[d.id]);
    features.push({ type: 'Feature', id: o.id, properties: props, geometry: polygonsOf(rs, p.grid, proj) });
  }
  return { type: 'FeatureCollection', features };
}

const margin = (s: Record<string, number>) => { const v = Object.values(s).sort((a, b) => b - a); return v[0] - (v[1] ?? 0); };

/** The objects dissolved by class (reviewed class where there is one, else the prediction): a separate, derived layer. */
export function dissolvedGeoJSON(p: ObiaProject, proj: Projector): GeoJSON.FeatureCollection {
  const classOf = new Map(p.objects.map(o => [o.index, o.reviewedClass ?? o.predictedClass ?? null]));
  const ids = [...new Set([...classOf.values()].filter((c): c is string => !!c))].sort();
  const lab = new Int32Array(p.labels.length).fill(-1);
  for (let i = 0; i < lab.length; i++) { const k = p.labels[i]; if (k >= 0) { const c = classOf.get(k); if (c) lab[i] = ids.indexOf(c); } }
  const rings = traceRings(lab, p.grid.width, p.grid.height);
  return {
    type: 'FeatureCollection',
    features: ids.map((c, k) => ({ type: 'Feature', properties: { class: c, label: p.classes.find(x => x.id === c)?.label ?? c, source: 'dissolved by class (reviewed, else predicted)' }, geometry: rings.get(k) ? polygonsOf(rings.get(k)!, p.grid, proj) : { type: 'MultiPolygon', coordinates: [] } })),
  };
}

const csvCell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** One row per object: identity, class, centroid (analysis CRS), support, every feature. */
export function featuresCsv(p: ObiaProject): string {
  const supKeys = [...new Set(p.objects.flatMap(o => Object.keys(o.support)))].sort();
  const head = ['object_id', 'segmentation_version', 'area_m2', 'cx', 'cy', 'predicted', 'predicted_structure', 'reviewed', 'flags', ...supKeys.flatMap(k => [`support_${k}_valid`, `support_${k}_native_px`, `support_${k}_n_eff`]), ...p.featureDefs.map(d => d.id)];
  const rows = p.objects.map(o => [o.id, o.segmentationVersion, round(o.areaM2), round(o.cx), round(o.cy), o.predictedClass ?? '', o.predictedParent ?? '', o.reviewedClass ?? '', o.flags.join(';'),
    ...supKeys.flatMap(k => [round(o.support[k]?.validFraction), o.support[k]?.nativePixelCount ?? '', round(o.support[k]?.effectivePixelCount)]),
    ...p.featureDefs.map(d => round(o.featureValues[d.id]))].map(csvCell).join(','));
  // Plain RFC 4180: cx/cy are in the analysis CRS (stated in the bundle manifest); a blank cell is missing, never zero.
  return [head.join(','), ...rows].join('\n');
}

/** The fitted model with everything needed to apply it again: features, imputer, classes, provenance. */
export function modelBundle(p: ObiaProject): string {
  if (!p.model) throw new Error('no model has been trained');
  return JSON.stringify({
    kind: 'stac-viewer-obia-model/1', model: p.model, compositionModels: (p.classification?.sublevels ?? []).map(l => ({ parent: l.parent, model: l.model })), classes: p.classes, classification: p.classification,
    featureDefinitions: p.featureDefs.filter(d => p.model!.features.includes(d.id)), recipeHash: p.recipeHash, segmentationVersion: p.segmentationVersion,
    note: 'Scores are Random Forest vote shares, not calibrated probabilities. Missing values are imputed with the stored training medians.',
  });
}

/** Per-pixel class index raster (0 = none, k + 1 = classes[k]) from reviewed-else-predicted classes. */
export function classRaster(p: ObiaProject): { data: Uint8Array; legend: string[] } {
  const legend = p.classes.map(c => c.id);
  const byIndex = new Map(p.objects.map(o => [o.index, o.reviewedClass ?? o.predictedClass ?? null]));
  const data = new Uint8Array(p.labels.length);
  for (let i = 0; i < data.length; i++) { const k = p.labels[i]; if (k < 0) continue; const c = byIndex.get(k); const j = c ? legend.indexOf(c) : -1; data[i] = j >= 0 ? j + 1 : 0; }
  return { data, legend };
}
