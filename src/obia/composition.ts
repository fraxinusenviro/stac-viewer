// The object-level CONIFER SCORE — FieldMapper's conifer-index method
// (src/coniferIndex.ts) carried from pixels to objects. Pure;
// test/obiaComposition.test.ts.
//
// Each line of evidence becomes a robust z-score (median / 1.4826·MAD) over
// the WOODY objects of this run, signed so that positive means needle-leaved,
// and the available terms are averaged by weight. An object gets a score only
// when terms carrying at least half the total weight have a value for it.
//
//   term          sign  weight  why
//   Δ NDVI          −    0.35   broadleaf loses greenness between leaf-on and leaf-off
//   2nd-date NDVI   +    0.20   conifers stay green leaf-off
//   leaf-on NIR     −    0.30   broadleaf canopies reflect far more NIR
//   NDRE            −    0.10   red-edge position is higher in broadleaf foliage
//   L* (photo)      −    0.20   conifer crowns are darker
//   excess green    −    0.15   broadleaf crowns are brighter green
//   L* texture      +    0.15   conifer crowns cast deeper, finer shadow
//   apex sharpness  +    0.20   conical crowns against rounded ones
//   LiDAR veg. int. −    0.25   the laser is NIR: broadleaf crowns return more
//   attenuation     +    0.15   needle-leaved crowns stop more pulses per metre
//
// It describes contrast WITHIN the run — re-scored on every run — not an
// absolute property. Otsu places the split and Sarle's bimodality coefficient
// (above ~0.555) says whether two groups are plausible; with one group (a pure
// stand) the split means nothing, and the report says so. It is a PREDICTOR
// for the classifier (group `index`) and a map view, never a label: a label
// made from it would be validated against itself.

import { bimodality, otsu } from '../coniferIndex.ts';
import type { FeatureDefinition, ObjectRecord } from './types.ts';

export interface ScoreTerm { id: string; label: string; sign: 1 | -1; weight: number }

export const CONIFER_TERMS: ScoreTerm[] = [
  { id: 'd_ndvi', label: 'Δ NDVI (main − second date)', sign: -1, weight: 0.35 },
  { id: 's2b_ndvi', label: 'second-date NDVI', sign: 1, weight: 0.2 },
  { id: 's2_nir', label: 'leaf-on NIR', sign: -1, weight: 0.3 },
  { id: 's2_ndre', label: 'NDRE', sign: -1, weight: 0.1 },
  { id: 'lab_l', label: 'photo L*', sign: -1, weight: 0.2 },
  { id: 'rgb_exg', label: 'photo excess green', sign: -1, weight: 0.15 },
  { id: 'rgb_l_sd', label: 'photo L* texture', sign: 1, weight: 0.15 },
  { id: 'chm_apex', label: 'crown apex sharpness', sign: 1, weight: 0.2 },
  { id: 'pc_ivg', label: 'LiDAR vegetation intensity (1064 nm)', sign: -1, weight: 0.25 },
  { id: 'pc_att', label: 'LiDAR canopy attenuation', sign: 1, weight: 0.15 },
];

/** Woody: canopy height P90 at least this, and (where known) leaf-on NDVI at least WOODY_NDVI. */
export const WOODY_P90_M = 2, WOODY_NDVI = 0.4;

export interface ScoreReport {
  terms: (ScoreTerm & { median: number; scale: number; n: number })[];
  woodyObjects: number;
  scored: number;
  threshold: number | null;
  bimodality: number | null;
  coniferShare: number | null;
  reason?: string;
}

const isWoody = (o: ObjectRecord) => {
  const p90 = o.featureValues.chm_p90 ?? o.featureValues.chm_mean;
  const nd = o.featureValues.s2_ndvi;
  return p90 !== null && p90 !== undefined && p90 >= WOODY_P90_M && (nd === null || nd === undefined || nd >= WOODY_NDVI);
};

function robust(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b), m = s[s.length >> 1];
  const dev = s.map(v => Math.abs(v - m)).sort((a, b) => a - b);
  return { median: m, scale: 1.4826 * dev[dev.length >> 1] || (s[s.length - 1] - s[0]) / 4 || 1 };
}

/** Writes `conifer_score` on every woody object it can score (null elsewhere) and returns the calibration. */
export function scoreConifer(objects: ObjectRecord[], minWoody = 20): ScoreReport {
  const woody = objects.filter(isWoody);
  for (const o of objects) o.featureValues.conifer_score = null;
  const empty = (reason: string): ScoreReport => ({ terms: [], woodyObjects: woody.length, scored: 0, threshold: null, bimodality: null, coniferShare: null, reason });
  if (woody.length < minWoody) return empty(`${woody.length} woody objects (canopy P90 ≥ ${WOODY_P90_M} m${objects.some(o => o.featureValues.s2_ndvi != null) ? `, NDVI ≥ ${WOODY_NDVI}` : ''}); at least ${minWoody} are needed`);
  const terms = CONIFER_TERMS.flatMap(t => {
    const v = woody.map(o => o.featureValues[t.id]).filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x));
    if (v.length < Math.max(10, woody.length / 2)) return [];
    return [{ ...t, ...robust(v), n: v.length }];
  });
  if (!terms.length) return empty('no line of evidence is available for the woody objects (needs Sentinel-2, a photo, a CHM or the point cloud)');
  const total = terms.reduce((a, t) => a + t.weight, 0);
  const scores: number[] = [];
  for (const o of woody) {
    let s = 0, w = 0;
    for (const t of terms) {
      const x = o.featureValues[t.id];
      if (x === null || x === undefined || !Number.isFinite(x)) continue;
      s += t.sign * t.weight * Math.max(-4, Math.min(4, (x - t.median) / t.scale));
      w += t.weight;
    }
    if (w >= total / 2) { o.featureValues.conifer_score = s / w; scores.push(s / w); }
  }
  if (scores.length < minWoody) return { ...empty(`only ${scores.length} woody objects had enough evidence to score`), terms };
  const th = otsu(scores);
  return { terms, woodyObjects: woody.length, scored: scores.length, threshold: th, bimodality: bimodality(scores), coniferShare: scores.filter(s => s > th).length / scores.length };
}

export function coniferScoreDef(): FeatureDefinition {
  return {
    id: 'conifer_score', label: 'Conifer score (within-run)', sourceIds: [], group: 'index', operation: 'weighted mean of signed robust z-scores over woody objects',
    parameters: { terms: CONIFER_TERMS, woody: `canopy P90 ≥ ${WOODY_P90_M} m and leaf-on NDVI ≥ ${WOODY_NDVI} where known` }, unit: 'z',
    sampling: 'neighbourhood-context', useForSegmentation: false, useForClassification: true,
  };
}
