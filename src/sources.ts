// Turning a Sentinel-2 scene and/or an HRDEM item into the named inputs a
// product reads (products.ts → engine.ts). Pure.

import type { InputSource } from './engine.ts';
import type { HrdemItem, S2Item } from './stac.ts';

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
export function resolveInputs(inputs: string[], s2: S2Item | null, lidar: HrdemItem | null, opts: SourceOptions = { nodataAuto: true }): Record<string, InputSource> {
  const out: Record<string, InputSource> = {};
  for (const key of inputs) {
    const [kind, rest] = key.split(':');
    if (kind === 's2') {
      if (!s2) throw new Error('this product needs a Sentinel-2 scene');
      const [asset, sample] = rest.split('#');
      const a = s2.assets[asset];
      if (!a) throw new Error(`the scene has no ${asset} asset`);
      out[key] = { url: a.href, sample: sample ? Number(sample) : 0, scale: a.scale, offset: a.offset, nodata: opts.nodataAuto ? a.nodata : null };
    } else if (kind === 'lidar') {
      if (!lidar) throw new Error('this product needs a LiDAR raster source');
      const href = rest === 'dsm' ? lidar.dsm : lidar.dtm;
      if (!href) throw new Error(`${lidar.id} has no ${rest.toUpperCase()}`);
      out[key] = { url: href, sample: 0, scale: 1, offset: 0, nodata: HRDEM_NODATA, minValid: -1000 };
    } else {
      throw new Error(`unknown input ${key}`);
    }
  }
  return out;
}
