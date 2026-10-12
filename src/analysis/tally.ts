// Class tallies over a study area, and their CSV. Pure (no engine, no DOM):
// unit-tested in test/classAreas.test.ts. The runner is classAreas.ts.

import type { ClassDef } from '../products.ts';

export interface ClassAreaRow { value: number; label: string; colour: string; pixels: number; areaM2: number; share: number }

export interface ClassTally {
  rows: ClassAreaRow[];
  /** Pixels inside the area that no class claimed (no rule matched, or an input had no value). */
  unclassifiedM2: number;
  /** All pixels inside the area. */
  areaM2: number;
}

/**
 * Count the class of every pixel inside the mask. Shares are of the
 * CLASSIFIED area, as the on-screen legend's are; the unclassified remainder
 * is reported beside them rather than hidden in the denominator.
 */
export function tallyClasses(classOf: Float32Array, mask: Uint8Array, classes: ClassDef[], cellAreaM2: number): ClassTally {
  const counts = new Map<number, number>();
  let inside = 0, classified = 0;
  for (let i = 0; i < classOf.length; i++) {
    if (!mask[i]) continue;
    inside++;
    const c = classOf[i];
    if (c !== c) continue;
    classified++;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const rows: ClassAreaRow[] = [];
  for (const cls of classes) {
    const n = counts.get(cls.value);
    if (!n) continue;
    rows.push({ value: cls.value, label: cls.label, colour: cls.colour, pixels: n, areaM2: n * cellAreaM2, share: classified ? n / classified : 0 });
  }
  return { rows, unclassifiedM2: (inside - classified) * cellAreaM2, areaM2: inside * cellAreaM2 };
}

const csvText = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The tally as CSV: one row per class, then the unclassified remainder. `header: false` to append runs to one file. */
export function classAreasCsv(t: ClassTally, meta: { run: string; area: string; product: string }, header = true): string {
  const head = 'run,study_area,product,class,area_ha,share_of_classified';
  const pre = [csvText(meta.run), csvText(meta.area), csvText(meta.product)];
  const rows = t.rows.map(r => [...pre, csvText(r.label), (r.areaM2 / 1e4).toFixed(4), r.share.toFixed(6)].join(','));
  if (t.unclassifiedM2 > 0) rows.push([...pre, 'Unclassified', (t.unclassifiedM2 / 1e4).toFixed(4), ''].join(','));
  return (header ? [head, ...rows] : rows).join('\n');
}
