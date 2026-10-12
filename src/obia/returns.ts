// LiDAR RETURNS per object: the point cloud's own measurements — intensity
// above all — summarized at their native support. Pure;
// test/obiaReturns.test.ts.
//
// The point cloud is reduced (pointcloud/pcMetrics.ts, in its worker) to
// metric grids on a fixed lattice in the TILES' OWN CRS — 2 m cells where the
// study area allows, coarser for a large one — and each object is then
// sampled against those cells exactly as against Sentinel-2's native pixels
// (sentinel.ts: area-weighted, valid cells only, with valid fraction and
// pixel counts). The cells are never resampled onto the analysis grid, and
// like Sentinel the returns play no part in segmentation.
//
// Per object, on FIRST returns (one pulse each):
//
//   pc_int     mean intensity of all first returns
//   pc_ivg     mean intensity of first returns on vegetation > 0.5 m — the
//              laser is near-infrared (1064 nm), so this is a fine NIR band of
//              the crowns: broadleaf foliage returns more than needles
//   pc_ivg_sd  spread of that across the object's cells (crown heterogeneity)
//   pc_igr     mean intensity of first returns reaching the ground layer — a
//              wet surface, Sphagnum and dark peat return little; lichen,
//              dry graminoid litter and bare mineral soil return more
//   pc_pen     share of first returns reaching the ground layer (openness)
//   pc_att     Beer–Lambert canopy attenuation per metre under ≥ 2 m of
//              canopy: needle-leaved crowns stop more pulses per metre
//   pc_den     first returns per m² (a property of the survey, kept as support
//              rather than recommended as a predictor)
//
// INTENSITY IS UNCALIBRATED. Gain, range and the sensor set it, so it is only
// comparable within one acquisition: a run that reads tiles of more than one
// acquisition is flagged on every object (`returns-multiple-acquisitions`) and
// on the run, and the model's figures then describe that mixture.

import { areaWeighted, fineToNative, type FineGrid, type NativeRaster } from './sentinel.ts';
import type { FeatureDefinition, ObjectRecord } from './types.ts';

export interface ReturnsInput {
  sourceId: string;
  /** One raster: planes `int` `ivg` `igr` `pen` `att` `den` (pcMetrics.ts names). */
  raster: NativeRaster;
  /** Acquisitions read; more than one makes intensity incomparable across the area. */
  acquisitions: string[];
}

export const RETURN_METRICS: { id: string; plane: string; label: string; unit: string; predictor: boolean; note: string }[] = [
  { id: 'pc_int', plane: 'int', label: 'LiDAR first-return intensity', unit: 'DN (uncalibrated)', predictor: true, note: 'mean intensity of first returns' },
  { id: 'pc_ivg', plane: 'ivg', label: 'LiDAR vegetation intensity (1064 nm)', unit: 'DN (uncalibrated)', predictor: true, note: 'mean intensity of first returns on vegetation more than 0.5 m above ground' },
  { id: 'pc_igr', plane: 'igr', label: 'LiDAR ground-layer intensity', unit: 'DN (uncalibrated)', predictor: true, note: 'mean intensity of first returns at most 0.5 m above ground' },
  { id: 'pc_pen', plane: 'pen', label: 'LiDAR penetration (share of pulses reaching ground)', unit: 'ratio', predictor: true, note: 'ground-layer first returns ÷ all first returns' },
  { id: 'pc_att', plane: 'att', label: 'LiDAR canopy attenuation', unit: 'per m', predictor: true, note: 'Beer–Lambert −ln T over the canopy depth, under ≥ 2 m of canopy only' },
  { id: 'pc_den', plane: 'den', label: 'LiDAR first-return density', unit: 'per m²', predictor: false, note: 'a property of the survey (flight-line overlap), recorded as support, not used as a predictor' },
];

export function returnsFeatureDefs(sourceId: string, cellM: number): FeatureDefinition[] {
  const base = (id: string, label: string, unit: string, op: string, params: Record<string, unknown>, predictor: boolean): FeatureDefinition => ({
    id, label, sourceIds: [sourceId], group: 'returns', operation: op, parameters: { ...params, cellM, firstReturnsOnly: true, intensity: 'uncalibrated: comparable within one acquisition only' },
    unit, processingResolutionM: cellM, effectiveSupportM: cellM, sampling: 'native-area-weighted', useForSegmentation: false, useForClassification: predictor,
  });
  const defs = RETURN_METRICS.map(m => base(m.id, m.label, m.unit, `per-cell ${m.note}, then area-weighted mean over the object's cells`, { metric: m.plane }, m.predictor));
  defs.push(base('pc_ivg_sd', 'LiDAR vegetation intensity spread', 'DN (uncalibrated)', 'area-weighted standard deviation of the per-cell vegetation intensity over the object', { metric: 'ivg' }, true));
  return defs;
}

/** Writes the return metrics onto `objects` (null where an object has no valid cell) and returns their definitions and whether the intersections were exact. */
export function returnsStats(grid: FineGrid, labels: Int32Array, count: number, objects: ObjectRecord[], input: ReturnsInput, toNative?: (xy: [number, number]) => [number, number]) {
  const r = input.raster;
  const fn = fineToNative(grid, r, toNative);
  const planes = RETURN_METRICS.map(m => m.plane).filter(p => r.values[p]);
  const stats = areaWeighted(labels, count, fn.index, grid.cellM * grid.cellM, r, planes);
  const multi = input.acquisitions.length > 1;
  const supportKey = `returns_${r.res}m`;
  for (const o of objects) {
    for (const m of RETURN_METRICS) {
      const s = stats[m.plane];
      if (s) o.featureValues[m.id] = Number.isFinite(s.mean[o.index]) ? s.mean[o.index] : null;
    }
    const ivg = stats.ivg;
    if (ivg) o.featureValues.pc_ivg_sd = Number.isFinite(ivg.sd[o.index]) ? ivg.sd[o.index] : null;
    // Validity differs by metric (intensity needs ≥ 4 returns of its kind); the support record is the first-return intensity's.
    const sup = (stats.int ?? stats[planes[0]]).support[o.index];
    const den = stats.den?.mean[o.index];
    const flags = sup.qualityFlags.map(f => f.replace('coarse-', 'returns-'));
    if (multi) flags.push('returns-multiple-acquisitions');
    if (!fn.exact) flags.push('approximate-intersection');
    o.support[supportKey] = { ...sup, pointCount: Number.isFinite(den) ? Math.round(den! * o.areaM2 * sup.validFraction) : undefined, qualityFlags: flags };
    for (const f of flags) if (f.startsWith('returns-no-valid') || f === 'returns-multiple-acquisitions') if (!o.flags.includes(f)) o.flags.push(f);
  }
  const defs = returnsFeatureDefs(input.sourceId, r.res).map(d => ({ ...d, parameters: { ...d.parameters, supportKey, intersection: fn.exact ? 'exact' : 'approximate (fine-grid)', acquisitions: input.acquisitions } }));
  return { defs: defs.filter(d => objects.length === 0 || d.id in objects[0].featureValues), exact: fn.exact };
}
