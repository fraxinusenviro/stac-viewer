// Class areas: the class product (strata or rules) evaluated at every pixel of
// a study area, and the ground each class covers, in hectares. The pixel map
// on screen only ever reports shares of whatever the VIEW holds, read off
// overview pixels; this is the figure for the area, at the analysis grid's
// resolution, with the pixels outside the polygon left out.
//
// The tally itself is pure and lives in tally.ts; this module reads the inputs.

import { sampleGrid, type InputSource } from '../engine.ts';
import type { Planes, Product, ProductStyle } from '../products.ts';
import { tallyClasses, type ClassTally } from './tally.ts';
import { aoiBox, polygonMask } from '../aoi.ts';
import { mercatorGrid, type SegmentGrid } from '../segment/segmentView.ts';

export interface ClassAreaResult {
  grid: SegmentGrid;
  mask: Uint8Array;
  classOf: Float32Array;
  planes: Planes;
  tally: ClassTally;
  product: Product;
}

/** Coarsest pixel the tool will use: past it the area is too large to read here. */
export const CLASS_AREA_MAX_CELL_M = 10;

export async function runClassAreas(area: GeoJSON.Polygon, sources: Record<string, InputSource>, product: Product, style: ProductStyle, stage: (m: string) => void): Promise<ClassAreaResult> {
  if (!product.classes) throw new Error('class areas need a class product: choose strata or rules');
  const grid = mercatorGrid(aoiBox(area), 2);
  if (grid.cellM > CLASS_AREA_MAX_CELL_M) throw new Error(`the study area is too large to classify here (it would need ${grid.cellM.toFixed(0)} m pixels; keep it under about ${Math.round((1.2e6 * CLASS_AREA_MAX_CELL_M ** 2) / 1e6)} km²)`);
  const mask = polygonMask(grid, area);
  stage(`Reading every input over the study area at ${grid.cellM.toFixed(1)} m (${grid.w} × ${grid.h} pixels)…`);
  const planes = await sampleGrid(sources, grid, product.sharpen);
  stage('Classifying…');
  await new Promise(r => setTimeout(r, 0));
  const n = grid.w * grid.h, fn = product.classOf ?? product.channels[0].fn;
  const classOf = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) if (mask[i]) classOf[i] = fn(planes, i, style);
  return { grid, mask, classOf, planes, tally: tallyClasses(classOf, mask, product.classes, grid.cellM * grid.cellM), product };
}
