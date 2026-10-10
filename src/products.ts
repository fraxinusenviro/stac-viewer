// The raster products the Rasters tab offers for one HRDEM item. Both
// surfaces are LiDAR-derived: the DTM is bare earth (ground returns), the DSM
// the first surface the pulse met (canopy, roofs). Each can be drawn three
// ways. Pure, unit-tested.

import type { CogMode } from './cog.ts';
import type { HrdemItem } from './stac.ts';

export type Surface = 'dtm' | 'dsm';

export interface RasterProduct {
  id: string;
  surface: Surface;
  mode: Exclude<CogMode, 'rgb'>;
  label: string;
  hint: string;
}

const SURFACE = {
  dtm: { name: 'DTM', what: 'bare earth' },
  dsm: { name: 'DSM', what: 'surface incl. trees and buildings' },
} as const;

const MODES = {
  hillshade: { name: 'hillshade', what: 'relief, lit from the north-west' },
  elevation: { name: 'elevation', what: 'height as a colour ramp' },
  shaded: { name: 'shaded elevation', what: 'colour ramp over hillshade' },
} as const;

export const RASTER_PRODUCTS: RasterProduct[] = (['dtm', 'dsm'] as const).flatMap(surface =>
  (['hillshade', 'elevation', 'shaded'] as const).map(mode => ({
    id: `${surface}-${mode}`, surface, mode,
    label: `${SURFACE[surface].name} ${MODES[mode].name}`,
    hint: `${SURFACE[surface].what}; ${MODES[mode].what}`,
  })));

/** The products an item can actually supply (a DSM product needs a DSM asset). */
export function productsFor(item: Pick<HrdemItem, 'dsm'>): RasterProduct[] {
  return RASTER_PRODUCTS.filter(p => p.surface === 'dtm' || !!item.dsm);
}

export const productById = (id: string) => RASTER_PRODUCTS.find(p => p.id === id);

/** Whether a rendering needs an elevation range. */
export const usesRange = (mode: CogMode) => mode === 'elevation' || mode === 'shaded';
