// The OBJECTS stage as one pure function — segmentation, fine features, and
// Sentinel statistics at native support — so the worker, the preview and the
// tests all run exactly the same code. test/obiaPipeline.test.ts.
//
// Sentinel enters AFTER segmentation and only as object attributes: the
// segmentation call below is made before the Sentinel rasters are even
// looked at, and nothing it is handed depends on them (spec invariant 1,
// acceptance 2).

import { projector } from './grid.ts';
import { fineFeatureDefs, fineFeatures } from './features.ts';
import { segment, segmentationChannels, type FinePlanes } from './segment.ts';
import { areaWeighted, fineToNative, normalizedDifference, sclInvalid, sentinelFeatureDefs, S2_INDICES, type NativeRaster } from './sentinel.ts';
import type { SegmentParams } from './recipe.ts';
import type { FeatureDefinition, ObjectRecord } from './types.ts';

export interface FineGridSpec { w: number; h: number; x0: number; y0: number; cellM: number; epsg: number }

export interface SentinelInput {
  sourceId: string;
  /** Native rasters (typically the scene's 10 m and 20 m grids); band planes named as Earth Search assets, plus `scl` on the 20 m grid. */
  rasters: NativeRaster[];
  bands: string[];
  indices: string[];
  sclInvalid: number[];
  maskBufferPx: number;
}

export interface ObjectsJob {
  grid: FineGridSpec;
  planes: FinePlanes;
  /** 1 inside the study area (and where the boundary inputs are valid). */
  mask: Uint8Array;
  params: SegmentParams;
  windowEdge: boolean;
  heightBandsM: number[];
  segmentationVersion: string;
  sources: { rgb: string | null; chm: string | null; dtm: string | null };
  sentinel?: SentinelInput | null;
}

export interface ObjectsResult {
  labels: Int32Array;
  count: number;
  objects: ObjectRecord[];
  featureDefs: FeatureDefinition[];
  seedSpacingPx: number;
  /** Per object, the ids of the COARSEST native pixels it touches (for leakage-safe folds). */
  coarsePixels: Int32Array[] | null;
  sentinelExact: boolean | null;
  stageMs: Record<string, number>;
}

export function runObjects(job: ObjectsJob, progress: (stage: string) => void = () => {}): ObjectsResult {
  const { grid: g } = job;
  const t = { start: performance.now() };
  const stageMs: Record<string, number> = {};
  const lap = (name: string) => { const now = performance.now(); stageMs[name] = now - t.start; t.start = now; };
  progress('segmenting');
  const channels = segmentationChannels(job.planes, g.w, g.h, g.cellM, job.params, job.mask);
  const seg = segment(channels, g.w, g.h, g.cellM, job.params, job.mask, job.windowEdge);
  lap('segmentation');
  progress('object features');
  const objects = fineFeatures({
    labels: seg.labels, count: seg.count, w: g.w, h: g.h, cellM: g.cellM, x0: g.x0, y0: g.y0, planes: job.planes,
    heightBandsM: job.heightBandsM, segmentationVersion: job.segmentationVersion, flags: seg.flags, sources: job.sources,
  });
  const featureDefs = fineFeatureDefs({ cellM: g.cellM, heightBandsM: job.heightBandsM, sources: job.sources, planes: job.planes });
  lap('features');
  let coarsePixels: Int32Array[] | null = null, sentinelExact: boolean | null = null;
  if (job.sentinel && job.sentinel.rasters.length) {
    progress('Sentinel-2 at native support');
    const r = sentinelStats(job, seg.labels, seg.count, objects);
    featureDefs.push(...r.defs);
    coarsePixels = r.coarsePixels; sentinelExact = r.exact;
    lap('sentinel');
  }
  return { labels: seg.labels, count: seg.count, objects, featureDefs, seedSpacingPx: seg.seedSpacingPx, coarsePixels, sentinelExact, stageMs };
}

function sentinelStats(job: ObjectsJob, labels: Int32Array, count: number, objects: ObjectRecord[]) {
  const s = job.sentinel!, g = job.grid;
  const byRes = [...s.rasters].sort((a, b) => a.res - b.res);
  // The SCL mask, on its own 20 m grid, applied to every raster through coordinates.
  const sclR = s.rasters.find(r => r.values.scl);
  let invalidAt: ((x: number, y: number) => boolean) | null = null;
  if (sclR) {
    const bad = sclInvalid(sclR.values.scl, sclR.w, sclR.h, s.sclInvalid, s.maskBufferPx);
    invalidAt = (x, y) => {
      const c = Math.floor((x - sclR.originX) / sclR.res), r = Math.floor((sclR.originY - y) / sclR.res);
      return c < 0 || r < 0 || c >= sclR.w || r >= sclR.h || bad[r * sclR.w + c] === 1;
    };
  }
  const defs = sentinelFeatureDefs(s.sourceId, s.bands, s.indices);
  let exact = true;
  let coarse: { res: number; pixels: Int32Array[] } | null = null;
  for (const r of byRes) {
    const names = s.bands.filter(b => r.values[b]);
    // Mask every band plane of this raster (copies: the input stays as read).
    const planes: Record<string, Float32Array> = {};
    for (const b of names) {
      const v = r.values[b].slice();
      if (invalidAt) for (let rr = 0; rr < r.h; rr++) for (let c = 0; c < r.w; c++) {
        if (invalidAt(r.originX + (c + 0.5) * r.res, r.originY - (rr + 0.5) * r.res)) v[rr * r.w + c] = NaN;
      }
      planes[b] = v;
    }
    for (const id of s.indices) {
      const ix = S2_INDICES[id];
      if (ix && ix.res === r.res && planes[ix.a] && planes[ix.b]) planes[id] = normalizedDifference(planes[ix.a], planes[ix.b]);
    }
    const names2 = Object.keys(planes);
    if (!names2.length) continue;
    const masked: NativeRaster = { ...r, values: planes };
    const toNative = g.epsg === r.epsg ? undefined : (() => { const a = projector(g.epsg), b = projector(r.epsg); return (p: [number, number]) => b.forward(a.inverse(p)); })();
    const fn = fineToNative({ w: g.w, h: g.h, x0: g.x0, y0: g.y0, cellM: g.cellM, epsg: g.epsg }, masked, toNative);
    exact &&= fn.exact;
    const stats = areaWeighted(labels, count, fn.index, g.cellM * g.cellM, masked, names2);
    const supportKey = `sentinel_${r.res}m`;
    for (const o of objects) {
      for (const name of names2) o.featureValues[`s2_${name}`] = Number.isFinite(stats[name].mean[o.index]) ? stats[name].mean[o.index] : null;
      const sup = stats[names2[0]].support[o.index];
      // Validity is shared by every plane of one raster (one mask), so one support record per raster.
      o.support[supportKey] = { ...sup, qualityFlags: [...sup.qualityFlags, ...(fn.exact ? [] : ['approximate-intersection'])] };
      for (const f of sup.qualityFlags) if (!o.flags.includes(f)) o.flags.push(f);
    }
    for (const d of defs) if (names2.includes(d.id.replace(/^s2_/, ''))) d.parameters = { ...d.parameters, supportKey, intersection: fn.exact ? 'exact' : 'approximate (fine-grid)' };
    if (!coarse || r.res > coarse.res) coarse = { res: r.res, pixels: stats._pixels };
  }
  return { defs: defs.filter(d => objects.length === 0 || d.id in objects[0].featureValues), coarsePixels: coarse?.pixels ?? null, exact };
}
