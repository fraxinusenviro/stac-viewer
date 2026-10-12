// Tree crowns from the canopy height model: treetops as local maxima, crowns
// grown from them by marker-controlled region growing (the scheme of Dalponte
// & Coomes 2016, as in lidR's `dalponte2016`). Pure; unit-tested.
//
//   1. The CHM is smoothed (3 × 3 mean) so one crown's lumps are one top.
//   2. A pixel is a treetop when it is at least `minTreeM` tall and the
//      highest within a window that widens with height (taller trees have
//      wider crowns): radius = max(1.5, 0.6 + 0.08 h) m.
//   3. Crowns grow from their tops downhill, tallest first: a pixel joins the
//      crown of the neighbour that reached it when it is above `minTreeM`,
//      above `seedFrac` × its treetop's height, and within `maxRadius(h)` of
//      it. What no crown reaches stays unlabelled (−1): ground, low
//      vegetation, gaps.
//
// At 1 m a crown of a few metres is a few pixels; the method finds dominant
// and co-dominant crowns, not suppressed understorey trees the top surface
// cannot see.

export interface CrownOptions {
  /** Pixel size, metres. */
  cellM: number;
  /** Minimum tree height, m. */
  minTreeM: number;
  /** A crown pixel must be at least this fraction of its treetop's height. */
  seedFrac: number;
}
export const DEFAULT_CROWNS: Omit<CrownOptions, 'cellM'> = { minTreeM: 3, seedFrac: 0.45 };

export const topRadiusM = (h: number) => Math.max(1.5, 0.6 + 0.08 * h);
export const maxCrownRadiusM = (h: number) => Math.max(2.5, 1.5 + 0.2 * h);

/** 3 × 3 NaN-aware mean. */
export function smooth3(f: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(f.length).fill(NaN);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (f[y * w + x] !== f[y * w + x]) continue;
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const v = f[yy * w + xx];
      if (v === v) { s += v; n++; }
    }
    out[y * w + x] = s / n;
  }
  return out;
}

/** Treetop pixel indices. */
export function treetops(chm: Float32Array, w: number, h: number, o: CrownOptions): number[] {
  const tops: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, v = chm[i];
    if (!(v >= o.minTreeM)) continue;
    const r = Math.max(1, Math.round(topRadiusM(v) / o.cellM)), r2 = r * r;
    let top = true;
    for (let dy = -r; dy <= r && top; dy++) for (let dx = -r; dx <= r; dx++) {
      if ((dx || dy) && dx * dx + dy * dy <= r2) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const u = chm[yy * w + xx];
        // Ties go to the earlier pixel, so a flat top yields one treetop, not several.
        if (u > v || (u === v && yy * w + xx < i)) { top = false; break; }
      }
    }
    if (top) tops.push(i);
  }
  return tops;
}

/** A max-heap of pixel indices by value. */
class Heap {
  private a: number[] = [];
  private key: Float32Array;
  constructor(key: Float32Array) { this.key = key; }
  get size() { return this.a.length; }
  push(i: number) {
    const a = this.a, k = this.key;
    a.push(i);
    let c = a.length - 1;
    while (c > 0) { const p = (c - 1) >> 1; if (k[a[p]] >= k[a[c]]) break; [a[p], a[c]] = [a[c], a[p]]; c = p; }
  }
  pop(): number {
    const a = this.a, k = this.key, top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < a.length && k[a[l]] > k[a[m]]) m = l;
        if (r < a.length && k[a[r]] > k[a[m]]) m = r;
        if (m === p) break;
        [a[p], a[m]] = [a[m], a[p]]; p = m;
      }
    }
    return top;
  }
}

/** Crown labels 0..n−1 (−1 outside every crown). `chm` should already be smoothed. */
export function crowns(chm: Float32Array, w: number, h: number, o: CrownOptions): { labels: Int32Array; count: number; tops: number[] } {
  const tops = treetops(chm, w, h, o);
  const labels = new Int32Array(w * h).fill(-1);
  const heap = new Heap(chm);
  tops.forEach((t, k) => { labels[t] = k; heap.push(t); });
  while (heap.size) {
    const i = heap.pop(), k = labels[i], t = tops[k];
    const tx = t % w, ty = (t - tx) / w, th = chm[t];
    const rMax = maxCrownRadiusM(th) / o.cellM;
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx, v = chm[j];
      if (labels[j] >= 0 || !(v >= o.minTreeM) || v < o.seedFrac * th) continue;
      if ((xx - tx) ** 2 + (yy - ty) ** 2 > rMax * rMax) continue;
      labels[j] = k;
      heap.push(j);
    }
  }
  return { labels, count: tops.length, tops };
}
