// Unsupervised classification over a study area: read the chosen variables at
// every pixel of the area's analysis grid (as Class areas does), cluster them
// with k-means (cluster.ts, pure and tested), and tally the clusters.

import { sampleGrid, type InputSource } from '../engine.ts';
import { defaultStyle, sharpeningFor, variableById, variableProduct, type ClassDef, type Planes, type Variable } from '../products.ts';
import { aoiBox, polygonMask } from '../aoi.ts';
import { mercatorGrid, type SegmentGrid } from '../segment/segmentView.ts';
import { CLASS_AREA_MAX_CELL_M } from './classAreas.ts';
import { tallyClasses, type ClassTally } from './tally.ts';
import { CLUSTER_COLOURS, assignClusters, fitKMeans, type ClusterModel } from './cluster.ts';

export interface ClusterParams { vars: string[]; k: number; seed: number; standardise: boolean }

export interface ClusterResult {
  grid: SegmentGrid;
  mask: Uint8Array;
  /** Class value (cluster number, 1…k) per pixel; NaN outside the area or where a variable is missing. */
  classOf: Float32Array;
  planes: Planes;
  /** The variables, in the order of the model's columns. */
  vars: Variable[];
  model: ClusterModel;
  /** Editable: the names and colours the user gives the clusters. */
  classes: ClassDef[];
  tally: ClassTally;
  /** Share of the area's pixels missing a chosen variable (left unclassified). */
  missingShare: number;
  /** Per variable, the share of the area's pixels where it has a value — which variable left pixels out. */
  coverage: number[];
}

/** The variables a clustering reads, refusing unknown ids and the per-object measures. */
export function clusterVariables(ids: string[]): Variable[] {
  const vars = ids.map(id => variableById.get(id)).filter((v): v is Variable => !!v);
  if (!vars.length) throw new Error('choose at least one variable to cluster on');
  const obj = vars.find(v => v.inputs.some(k => k.startsWith('obj:')));
  if (obj) throw new Error(`${obj.label} exists only for objects, not pixels`);
  return vars;
}

/** Every input the variables read. */
export const clusterInputs = (vars: Variable[]) => [...new Set(vars.flatMap(v => v.inputs))];

export async function runClusters(area: GeoJSON.Polygon, sources: Record<string, InputSource>, p: ClusterParams, stage: (m: string) => void): Promise<ClusterResult> {
  const vars = clusterVariables(p.vars);
  const grid = mercatorGrid(aoiBox(area), 2);
  if (grid.cellM > CLASS_AREA_MAX_CELL_M) throw new Error(`the study area is too large to cluster here (it would need ${grid.cellM.toFixed(0)} m pixels)`);
  const mask = polygonMask(grid, area);
  stage(`Reading ${vars.length} variable${vars.length === 1 ? '' : 's'} over the study area at ${grid.cellM.toFixed(1)} m (${grid.w} × ${grid.h} pixels)…`);
  const planes = await sampleGrid(sources, grid, sharpeningFor(vars));
  const n = grid.w * grid.h, d = vars.length;
  const X = new Float32Array(n * d).fill(NaN);
  const styles = vars.map(v => defaultStyle(variableProduct(v)));
  let inside = 0, complete = 0;
  const have = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    inside++;
    let ok = true;
    for (let j = 0; j < d; j++) { const x = vars[j].channel.fn(planes, i, styles[j]); X[i * d + j] = x; if (Number.isFinite(x)) have[j]++; else ok = false; }
    if (ok) complete++;
  }
  stage(`Clustering ${complete.toLocaleString()} pixels into ${p.k} clusters…`);
  await new Promise(r => setTimeout(r, 0));
  const model = fitKMeans(X, n, d, { k: p.k, seed: p.seed, standardise: p.standardise }, mask);
  const lab = assignClusters(model, X, n, mask);
  const classOf = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) if (lab[i] >= 0) classOf[i] = lab[i] + 1;
  const classes: ClassDef[] = model.centres.map((_, k) => ({ value: k + 1, label: `Cluster ${k + 1}`, colour: CLUSTER_COLOURS[k % CLUSTER_COLOURS.length] }));
  return { grid, mask, classOf, planes, vars, model, classes, tally: tallyClasses(classOf, mask, classes, grid.cellM * grid.cellM), missingShare: inside ? 1 - complete / inside : 0, coverage: have.map(c => (inside ? c / inside : 0)) };
}
