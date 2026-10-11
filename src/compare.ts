// Which variable separates two sets of labelled samples (say, broadleaf and
// coniferous crowns tapped on the map), and where to cut it. Pure; tested.
//
// Per variable: each label's mean and standard deviation, Cohen's d (the
// difference of the means in pooled standard deviations — about 0.8 is
// "large", and above 2 the two groups barely overlap), and the single cut
// that classifies the samples best, scored by BALANCED accuracy so that
// tapping twice as many conifers cannot make a variable look better.
//
// These are numbers about the samples, not about the map: a handful of taps
// in one stand describes that stand. The accuracy is training accuracy, and
// says so wherever it is shown.

export interface Sample { id: string; label: string; lon: number; lat: number; values: Record<string, number> }

export interface Separation {
  v: string;
  a: { n: number; mean: number; sd: number };
  b: { n: number; mean: number; sd: number };
  /** Cohen's d, signed: positive when label A is higher. */
  d: number;
  /** The best single cut, and which side label A falls on. */
  threshold: number;
  aAbove: boolean;
  /** Balanced accuracy of that cut on the samples (0.5 = chance). */
  accuracy: number;
}

function moments(xs: number[]) {
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd };
}

/** The cut maximising balanced accuracy, trying every midpoint between sorted values. */
export function bestSplit(a: number[], b: number[]): { threshold: number; aAbove: boolean; accuracy: number } {
  const all = [...a.map(x => [x, 0] as const), ...b.map(x => [x, 1] as const)].sort((p, q) => p[0] - q[0]);
  let best = { threshold: all[0]?.[0] ?? 0, aAbove: true, accuracy: 0.5 };
  let aBelow = 0, bBelow = 0;
  for (let i = 0; i < all.length - 1; i++) {
    if (all[i][1] === 0) aBelow++; else bBelow++;
    if (all[i][0] === all[i + 1][0]) continue;
    const t = (all[i][0] + all[i + 1][0]) / 2;
    // A above the cut: A correct = A above; B correct = B below.
    const accAbove = ((a.length - aBelow) / a.length + bBelow / b.length) / 2;
    const accBelow = (aBelow / a.length + (b.length - bBelow) / b.length) / 2;
    if (accAbove > best.accuracy) best = { threshold: t, aAbove: true, accuracy: accAbove };
    if (accBelow > best.accuracy) best = { threshold: t, aAbove: false, accuracy: accBelow };
  }
  return best;
}

/**
 * Rank variables by how well they separate label A from label B, strongest
 * first. A variable needs at least two finite values on each side.
 */
export function compareLabels(samples: Sample[], labelA: string, labelB: string, vars: string[]): Separation[] {
  const out: Separation[] = [];
  for (const v of vars) {
    const xa = samples.filter(s => s.label === labelA).map(s => s.values[v]).filter(Number.isFinite);
    const xb = samples.filter(s => s.label === labelB).map(s => s.values[v]).filter(Number.isFinite);
    if (xa.length < 2 || xb.length < 2) continue;
    const a = moments(xa), b = moments(xb);
    const pooled = Math.sqrt(((a.n - 1) * a.sd ** 2 + (b.n - 1) * b.sd ** 2) / (a.n + b.n - 2));
    const d = pooled > 0 ? (a.mean - b.mean) / pooled : a.mean === b.mean ? 0 : Math.sign(a.mean - b.mean) * Infinity;
    out.push({ v, a, b, d, ...bestSplit(xa, xb) });
  }
  return out.sort((p, q) => q.accuracy - p.accuracy || Math.abs(q.d) - Math.abs(p.d));
}

/** Round a threshold to a precision a person would type (3 significant figures). */
export const niceThreshold = (t: number) => (t === 0 ? 0 : Number(t.toPrecision(3)));
