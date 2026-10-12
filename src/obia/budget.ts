// Memory budget for the objects stage (spec §9): estimated BEFORE anything is
// read, from the grid size and the inputs, and refused over budget with the
// options named — never silently coarsened. Pure; test/obiaBudget.test.ts.
//
// Bytes per fine pixel, counted from the code that runs (pipeline.ts):
//   inputs read on the main thread       4 B × planes (R, G, B, DSM, DTM; CHM derived)
//   the same planes in the worker        transferred, not copied (0)
//   study-area mask                      1 B
//   segmentation channels                4 B × channels (≤ 5)
//   SLIC labels + distances              4 + 8 B
//   merge and minimum-patch relabels     3 × 4 B
//   feature pass: pixel lists, L*a*b*, gradient, slope   4 + 12 + 4 + 4 B
//   Sentinel: fine→native index per raster and the sort keys   2 × 4 + 8 B
//   the label raster kept for display and export, and its image   4 + 4 B
// plus the Sentinel native windows (4 B × pixels × planes) and per-object
// records (~2 kB each; the object count is estimated from the target area).

export interface BudgetInput { px: number; rgb: boolean; chm: boolean; dtm: boolean; sentinelNativePx: number; sentinelPlanes: number; targetAreaM2: number; cellM: number }

export function bytesPerPixel(i: Pick<BudgetInput, 'rgb' | 'chm' | 'dtm'>): number {
  const planes = (i.rgb ? 3 : 0) + (i.chm ? 2 : 0) + (i.dtm && !i.chm ? 1 : 0);
  const channels = (i.rgb ? 3 : 0) + (i.chm ? 1 : 0) + (i.dtm ? 1 : 0);
  return 4 * planes + 1 + 4 * channels + 12 + 12 + 24 + 16 + 8;
}

export function estimateBytes(i: BudgetInput): number {
  const objects = (i.px * i.cellM * i.cellM) / Math.max(1, i.targetAreaM2);
  return i.px * bytesPerPixel(i) + i.sentinelNativePx * i.sentinelPlanes * 4 * 2 + objects * 2048;
}

/**
 * The working budget for one job on this device: an eighth of reported device
 * memory, capped at 1 GiB (browsers commonly cap a tab well below device
 * memory). Without a report, 512 MiB.
 */
export function deviceBudget(deviceMemoryGiB: number | undefined): number {
  const gib = 1024 ** 3;
  return deviceMemoryGiB ? Math.min(gib, (deviceMemoryGiB * gib) / 8) : gib / 2;
}

export const fmtMiB = (b: number) => `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} MiB`;

/** The largest area (m²) at a cell size that fits a budget, for the "use a smaller area" advice. */
export function maxAreaM2(budget: number, cellM: number, i: Pick<BudgetInput, 'rgb' | 'chm' | 'dtm'>): number {
  return (budget / bytesPerPixel(i)) * cellM * cellM;
}
