// The class schema, object labels with provenance and undo/redo, and the
// import of reference polygons and points (spec §2, §8). Pure;
// test/obiaModel.test.ts.
//
// ORIGINAL references are kept apart from object labels: a reference polygon
// is stored as imported, and the label it produces names it as its source.
// Imported polygons label an object only when ONE class covers at least
// `threshold` (default 80 %) of it and no two classes overlap inside it;
// anything else is listed for review. A point labels the object it falls in
// only when the user has stated that the point represents its object.
//
// Roles: a `training` label may be used to fit and cross-validate the model;
// a `validation` label is HELD OUT — never fitted on, never queried by
// "uncertain objects", used only to report against. A reviewed correction is
// a `review` entry, NOT a training observation, until explicitly included.

import { polygonMask } from '../aoi.ts';
import { gridXY, type AnalysisGrid } from './grid.ts';

export interface ClassDef { id: string; label: string; colour: string; description?: string; parent?: string }
export type LabelRole = 'training' | 'validation' | 'review';
export type LabelSource = 'manual' | 'reference-polygon' | 'reference-point' | 'review-correction';

export interface LabelEntry {
  objectId: string;
  classId: string;
  role: LabelRole;
  source: LabelSource;
  at: string;
  /** For imported references: which feature, and the class's share of the object. */
  referenceId?: string;
  coverage?: number;
  /** Where the labelled object was (analysis CRS centroid), so a label can be carried to a new segmentation. */
  x?: number;
  y?: number;
  /** Set on a label carried over from an earlier segmentation: excluded from training until confirmed. */
  pending?: string;
}

/** The structural classes (level 1). */
export const STRUCTURE_CLASSES: ClassDef[] = [
  { id: 'forest', label: 'Forest (> 8 m)', colour: '#1b7837', description: 'Closed or open tree canopy above 8 m.' },
  { id: 'shrub', label: 'Shrub / regeneration (0.5–8 m)', colour: '#7fbc41', description: 'Woody vegetation 0.5–8 m.' },
  { id: 'herb', label: 'Low vegetation (< 0.5 m)', colour: '#e6c84f', description: 'Ground layer: herbs, graminoids, dwarf shrubs, mosses, lichens, seedlings.' },
  { id: 'water', label: 'Open water', colour: '#2166ac', description: 'Standing or flowing water.' },
  { id: 'built', label: 'Built / bare', colour: '#8c8c8c', description: 'Roads, roofs, gravel, exposed soil or rock.' },
];

/**
 * Composition classes (level 2), each under its structural parent, with what
 * tells it apart. Label at either level: a level-2 label also teaches level 1.
 */
export const COMPOSITION_CLASSES: ClassDef[] = [
  { id: 'forest-conifer', parent: 'forest', label: 'Coniferous forest', colour: '#0b4f2e', description: '≥ 75 % of canopy cover needle-leaved. Evidence: stays green leaf-off (small Δ NDVI), low leaf-on NIR, dark crowns, sharp crown apices.' },
  { id: 'forest-broadleaf', parent: 'forest', label: 'Broadleaf forest', colour: '#5aae61', description: '≥ 75 % broadleaf. Evidence: large Δ NDVI leaf-on → leaf-off, high leaf-on NIR, bright green rounded crowns.' },
  { id: 'forest-mixed', parent: 'forest', label: 'Mixed forest', colour: '#2f8a4c', description: 'Neither type ≥ 75 % of canopy cover. Expect intermediate evidence and conifer scores near the split.' },
  { id: 'shrub-conifer', parent: 'shrub', label: 'Coniferous regeneration / shrub', colour: '#3f7f2a', description: 'Young spruce, fir, pine. Evidence as for coniferous forest, crowns smaller. Tamarack drops its needles: in a leaf-off scene it reads as broadleaf.' },
  { id: 'shrub-broadleaf', parent: 'shrub', label: 'Broadleaf shrub / regeneration', colour: '#a6d96a', description: 'Alder, willow, birch, maple regeneration. Large seasonal change.' },
  { id: 'shrub-ericaceous', parent: 'shrub', label: 'Tall ericaceous shrub', colour: '#b2506b', description: 'Rhodora, Labrador tea, sheep laurel, highbush blueberry, mostly 0.5–1.5 m. Evidence: red in autumn (reddish pixels, hue), evergreen species keep NDVI leaf-off.' },
  { id: 'shrub-mixed', parent: 'shrub', label: 'Mixed shrub', colour: '#86b84a', description: 'No type dominant.' },
  { id: 'herb-graminoid', parent: 'herb', label: 'Graminoid (grass, sedge, rush)', colour: '#d9c36a', description: 'Evidence: strong senescence (large Δ NDVI, straw-coloured, high yellow hue in autumn), smooth CHM.' },
  { id: 'herb-ericaceous', parent: 'herb', label: 'Ericaceous dwarf shrub (heath)', colour: '#9e3d5a', description: 'Lowbush blueberry, huckleberry, crowberry, sheep laurel under 0.5 m. Evidence: red in autumn; slight CHM roughness; moderate NDVI.' },
  { id: 'herb-moss', parent: 'herb', label: 'Moss / Sphagnum', colour: '#7a8f3a', description: 'Bryophyte carpet, often wet. Evidence: high NDMI (wet), little seasonal change, green, red or brown hue, flat CHM. Hard to separate from wet graminoid.' },
  { id: 'herb-lichen', parent: 'herb', label: 'Lichen', colour: '#c8c8b4', description: 'Cladonia mats and lichen-covered rock. Evidence: pale grey (pale-pixel share), low NDVI, bright in every band, flat.' },
  { id: 'herb-conifer', parent: 'herb', label: 'Conifer seedlings', colour: '#4c7a3a', description: 'Conifers under 0.5 m. Rarely separable from the ground layer at 1 m; label only where seen.' },
  { id: 'herb-broadleaf', parent: 'herb', label: 'Broadleaf seedlings / forbs', colour: '#c7e57a', description: 'Broadleaf seedlings and forbs under 0.5 m.' },
];

export const DEFAULT_CLASSES: ClassDef[] = [...STRUCTURE_CLASSES, ...COMPOSITION_CLASSES];

/** Add any composition class missing from a schema whose parent it has (a schema made before level 2 existed). */
export function withComposition(classes: ClassDef[]): ClassDef[] {
  const ids = new Set(classes.map(c => c.id));
  return [...classes, ...COMPOSITION_CLASSES.filter(c => !ids.has(c.id) && ids.has(c.parent!)).map(c => ({ ...c }))];
}

/** Labels by object id, with a history of whole operations for undo/redo. */
export class LabelStore {
  labels = new Map<string, LabelEntry>();
  private undoStack: { before: (LabelEntry | null)[]; after: (LabelEntry | null)[]; ids: string[] }[] = [];
  private redoStack: typeof this.undoStack = [];

  constructor(initial: LabelEntry[] = []) { for (const e of initial) this.labels.set(e.objectId, e); }

  /** Set (entry) or clear (null) several objects as ONE undoable step. */
  apply(ids: string[], make: (id: string) => LabelEntry | null): void {
    const before = ids.map(id => this.labels.get(id) ?? null);
    const after = ids.map(make);
    if (ids.every((_, i) => JSON.stringify(before[i]) === JSON.stringify(after[i]))) return;
    this.write(ids, after);
    this.undoStack.push({ before, after, ids });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  private write(ids: string[], vals: (LabelEntry | null)[]) { ids.forEach((id, i) => { const v = vals[i]; if (v) this.labels.set(id, v); else this.labels.delete(id); }); }
  undo(): boolean { const op = this.undoStack.pop(); if (!op) return false; this.write(op.ids, op.before); this.redoStack.push(op); return true; }
  redo(): boolean { const op = this.redoStack.pop(); if (!op) return false; this.write(op.ids, op.after); this.undoStack.push(op); return true; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  all(): LabelEntry[] { return [...this.labels.values()]; }
  byRole(role: LabelRole): LabelEntry[] { return this.all().filter(e => e.role === role); }
}

export interface PolygonAssignment {
  /** Labels to apply (one class covers ≥ threshold, no overlap conflict). */
  labels: LabelEntry[];
  /** Objects touched but not labelled, with the reason. */
  review: { objectId: string; reason: string; shares: Record<string, number> }[];
}

/**
 * Assign imported reference polygons (already in the analysis CRS, each with
 * a class id) to objects by coverage. `labels` is the authoritative label
 * raster on `grid`; `objectIds[k]` names label k.
 */
export function assignFromPolygons(
  grid: AnalysisGrid, labels: Int32Array, objectIds: string[],
  polys: { id: string; classId: string; geometry: GeoJSON.Polygon }[],
  threshold: number, role: LabelRole, at: string,
): PolygonAssignment {
  const n = grid.width * grid.height;
  const cls = new Int32Array(n).fill(-1);   // −1 none, −2 conflict, else index into classIds
  const classIds = [...new Set(polys.map(p => p.classId))].sort();
  const refOf = new Int32Array(n).fill(-1);
  const mg = { w: grid.width, h: grid.height, box: grid.bounds, lonLat: (px: number, py: number) => gridXY(grid, px, py) };
  polys.forEach((p, pi) => {
    const m = polygonMask(mg, p.geometry), c = classIds.indexOf(p.classId);
    for (let i = 0; i < n; i++) if (m[i]) { if (cls[i] === -1) { cls[i] = c; refOf[i] = pi; } else if (cls[i] !== c) cls[i] = -2; }
  });
  const count = objectIds.length;
  const size = new Float64Array(count), conflict = new Float64Array(count);
  const by = Array.from({ length: count }, () => new Float64Array(classIds.length));
  const ref = new Int32Array(count).fill(-1);
  for (let i = 0; i < n; i++) {
    const k = labels[i];
    if (k < 0) continue;
    size[k]++;
    if (cls[i] === -2) conflict[k]++;
    else if (cls[i] >= 0) { by[k][cls[i]]++; if (ref[k] < 0) ref[k] = refOf[i]; }
  }
  const out: PolygonAssignment = { labels: [], review: [] };
  for (let k = 0; k < count; k++) {
    const touched = conflict[k] + by[k].reduce((a, b) => a + b, 0);
    if (!touched) continue;
    const shares: Record<string, number> = {};
    classIds.forEach((c, j) => { if (by[k][j]) shares[c] = by[k][j] / size[k]; });
    let best = 0;
    for (let j = 1; j < classIds.length; j++) if (by[k][j] > by[k][best]) best = j;
    const share = by[k][best] / size[k];
    if (conflict[k] > 0) out.review.push({ objectId: objectIds[k], reason: 'overlapping references of different classes', shares });
    else if (Object.keys(shares).length > 1) out.review.push({ objectId: objectIds[k], reason: 'covered by more than one class', shares });
    else if (share < threshold) out.review.push({ objectId: objectIds[k], reason: `${Math.round(share * 100)} % covered (needs ${Math.round(threshold * 100)} %)`, shares });
    else out.labels.push({ objectId: objectIds[k], classId: classIds[best], role, source: 'reference-polygon', at, referenceId: polys[ref[k]]?.id, coverage: share });
  }
  return out;
}
