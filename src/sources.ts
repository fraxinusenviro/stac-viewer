// Turning a Sentinel-2 scene and/or an HRDEM item into the named inputs a
// product reads (products.ts → engine.ts). Pure.

import type { InputSource } from './engine.ts';
import type { HrdemItem, S2Item } from './stac.ts';
import { PC_METRICS, type PcMetric } from './pointcloud/pcMetrics.ts';
import type { XyzService } from './xyz.ts';

const ORTHO_CHANNELS = ['r', 'g', 'b', 'tex'];

/** HRDEM fills no-data with −32767; nothing this low is ground anywhere in Canada. */
const HRDEM_NODATA = -32767;

export interface SourceOptions {
  /** Treat Sentinel-2 DN 0 as no data (the files' own nodata). */
  nodataAuto: boolean;
}

/**
 * The InputSource for every input a product names, or an error naming the
 * first one these items cannot supply.
 */
export interface InputItems {
  /** The Sentinel-2 scene (leaf-on, for fusion). */
  s2?: S2Item | null;
  /** The optional second, leaf-off scene. */
  s2b?: S2Item | null;
  lidar?: HrdemItem | null;
  /** The orthophoto tile service (`ortho:*` inputs). */
  ortho?: XyzService | null;
  /** Whether point-cloud metrics (`pc:*` inputs) may be read. */
  pointCloud?: boolean;
}

export function resolveInputs(inputs: string[], items: InputItems, opts: SourceOptions = { nodataAuto: true }): Record<string, InputSource> {
  const out: Record<string, InputSource> = {};
  for (const key of inputs) {
    const [kind, rest] = key.split(':');
    if (kind === 's2' || kind === 's2b') {
      const scene = kind === 's2' ? items.s2 : items.s2b;
      if (!scene) throw new Error(kind === 's2' ? 'this product needs a Sentinel-2 scene' : 'this product needs a leaf-off scene');
      const [asset, sample] = rest.split('#');
      const a = scene.assets[asset];
      if (!a) throw new Error(`the ${kind === 's2b' ? 'leaf-off ' : ''}scene has no ${asset} asset`);
      out[key] = { url: a.href, sample: sample ? Number(sample) : 0, scale: a.scale, offset: a.offset, nodata: opts.nodataAuto ? a.nodata : null };
    } else if (kind === 'lidar') {
      const lidar = items.lidar;
      if (!lidar) throw new Error('this product needs a LiDAR raster source');
      const href = rest === 'dsm' ? lidar.dsm : lidar.dtm;
      if (!href) throw new Error(`${lidar.id} has no ${rest.toUpperCase()}`);
      out[key] = { url: href, sample: 0, scale: 1, offset: 0, nodata: HRDEM_NODATA, minValid: -1000 };
    } else if (kind === 'pc') {
      if (!items.pointCloud) throw new Error('this product needs the LiDAR point cloud (switched off)');
      if (!PC_METRICS.includes(rest as PcMetric)) throw new Error(`unknown point-cloud metric ${rest}`);
      out[key] = { kind: 'pc', url: 'pc', metric: rest as PcMetric, sample: 0, scale: 1, offset: 0, nodata: null };
    } else if (kind === 'ortho') {
      const svc = items.ortho;
      if (!svc) throw new Error('this product needs an orthophoto (choose one above)');
      const ch = ORTHO_CHANNELS.indexOf(rest);
      if (ch < 0) throw new Error(`unknown orthophoto channel ${rest}`);
      out[key] = { kind: 'xyz', url: svc.template, maxZoom: svc.maxZoom, sample: ch, scale: 1, offset: 0, nodata: null };
    } else {
      throw new Error(`unknown input ${key}`);
    }
  }
  return out;
}
