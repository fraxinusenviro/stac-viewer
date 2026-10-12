// Segmentation, step 1 and 2: SLIC superpixels, then a graph merge of
// neighbouring superpixels into patches. Pure; unit-tested.
//
// SLIC (Achanta et al. 2012) clusters pixels by a distance that adds feature
// difference to spatial distance, each cluster searching only a 2S × 2S
// window around its centre, so the cost is linear in the pixel count. The
// features here are whatever the caller hands in, already scaled so that one
// unit is "a meaningful difference" (canopy height in units of a few metres,
// photo brightness in units of a few per cent); a missing (NaN) feature is
// left out of that pixel's distance rather than read as zero.
//
// The merge is Felzenszwalb–Huttenlocher's criterion on the superpixel
// adjacency graph: two regions join when the difference between them is no
// larger than the largest difference already inside either, plus a tolerance
// k / size that shrinks as a region grows — so uniform ground merges into
// large patches and edges in the features stay edges.

export interface SlicOptions {
  /** Superpixel spacing, pixels. */
  step: number;
  /** Weight of space against features: at 1, one feature unit costs as much as `step` pixels. */
  compactness: number;
  iterations?: number;
}

/** Superpixel labels 0..n−1 (−1 where every feature is missing), connected, small fragments absorbed. */
export function slic(features: Float32Array[], w: number, h: number, o: SlicOptions): { labels: Int32Array; count: number } {
  const S = Math.max(2, Math.round(o.step)), nF = features.length, n = w * h;
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) for (const f of features) if (f[i] === f[i]) { valid[i] = 1; break; }
  // Centres on a regular grid, at the cell centres.
  const cx: number[] = [], cy: number[] = [];
  for (let y = S / 2; y < h; y += S) for (let x = S / 2; x < w; x += S) { cx.push(x); cy.push(y); }
  const K = cx.length;
  const cf = new Float64Array(K * nF);
  const seedFeatures = () => {
    for (let k = 0; k < K; k++) {
      const i = Math.min(h - 1, Math.floor(cy[k])) * w + Math.min(w - 1, Math.floor(cx[k]));
      for (let f = 0; f < nF; f++) cf[k * nF + f] = features[f][i];
    }
  };
  seedFeatures();
  const label = new Int32Array(n).fill(-1);
  const dist = new Float64Array(n);
  const m2 = (o.compactness * o.compactness) / (S * S);
  for (let it = 0; it < (o.iterations ?? 8); it++) {
    dist.fill(Infinity);
    for (let k = 0; k < K; k++) {
      const x0 = Math.max(0, Math.floor(cx[k] - S)), x1 = Math.min(w, Math.ceil(cx[k] + S));
      const y0 = Math.max(0, Math.floor(cy[k] - S)), y1 = Math.min(h, Math.ceil(cy[k] + S));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        if (!valid[i]) continue;
        let dc = 0;
        for (let f = 0; f < nF; f++) {
          const a = features[f][i], b = cf[k * nF + f];
          if (a === a && b === b) dc += (a - b) * (a - b);
        }
        const dx = x - cx[k], dy = y - cy[k];
        const d = dc + (dx * dx + dy * dy) * m2;
        if (d < dist[i]) { dist[i] = d; label[i] = k; }
      }
    }
    // Move each centre to its members' mean position and features.
    const sx = new Float64Array(K), sy = new Float64Array(K), cnt = new Float64Array(K);
    const sf = new Float64Array(K * nF), nf = new Float64Array(K * nF);
    for (let i = 0; i < n; i++) {
      const k = label[i];
      if (k < 0) continue;
      sx[k] += i % w; sy[k] += Math.floor(i / w); cnt[k]++;
      for (let f = 0; f < nF; f++) { const a = features[f][i]; if (a === a) { sf[k * nF + f] += a; nf[k * nF + f]++; } }
    }
    for (let k = 0; k < K; k++) {
      if (!cnt[k]) continue;
      cx[k] = sx[k] / cnt[k] + 0.5; cy[k] = sy[k] / cnt[k] + 0.5;
      for (let f = 0; f < nF; f++) cf[k * nF + f] = nf[k * nF + f] ? sf[k * nF + f] / nf[k * nF + f] : NaN;
    }
  }
  return connect(label, w, h, Math.max(1, Math.floor((S * S) / 4)));
}

/**
 * Relabel so every label is ONE 4-connected component (SLIC's clusters can
 * be split), absorbing components smaller than `minSize` into a neighbour.
 */
export function connect(label: Int32Array, w: number, h: number, minSize: number): { labels: Int32Array; count: number } {
  const n = w * h;
  const out = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let count = 0;
  for (let s = 0; s < n; s++) {
    if (out[s] >= 0 || label[s] < 0) continue;
    const L = label[s];
    let head = 0, tail = 0, adjacent = -1;
    queue[tail++] = s; out[s] = count;
    while (head < tail) {
      const i = queue[head++], x = i % w, y = (i - x) / w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0) continue;
        if (label[j] === L && out[j] < 0) { out[j] = count; queue[tail++] = j; }
        else if (out[j] >= 0 && out[j] !== count) adjacent = out[j];
      }
    }
    if (tail < minSize && adjacent >= 0) { for (let q = 0; q < tail; q++) out[queue[q]] = adjacent; }
    else count++;
  }
  return { labels: out, count };
}

/** Per-region mean of each feature (NaN-aware) and pixel counts. */
export function regionMeans(labels: Int32Array, count: number, features: Float32Array[]): { means: Float64Array; sizes: Float64Array } {
  const nF = features.length;
  const sum = new Float64Array(count * nF), num = new Float64Array(count * nF), sizes = new Float64Array(count);
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i];
    if (k < 0) continue;
    sizes[k]++;
    for (let f = 0; f < nF; f++) { const a = features[f][i]; if (a === a) { sum[k * nF + f] += a; num[k * nF + f]++; } }
  }
  const means = new Float64Array(count * nF);
  for (let j = 0; j < means.length; j++) means[j] = num[j] ? sum[j] / num[j] : NaN;
  return { means, sizes };
}

/**
 * Merge neighbouring regions (Felzenszwalb–Huttenlocher on the region graph).
 * `k` is the tolerance, in feature units × pixels: a lone region of `a`
 * pixels joins a neighbour up to k / a feature units away. 0 merges nothing.
 */
export function mergeRegions(labels: Int32Array, count: number, w: number, h: number, features: Float32Array[], k: number): { labels: Int32Array; count: number } {
  if (!(k > 0) || count < 2) return { labels, count };
  const nF = features.length;
  const { means, sizes } = regionMeans(labels, count, features);
  // Adjacent pairs, once each.
  const seen = new Set<number>();
  const edges: [number, number, number][] = [];
  const addEdge = (a: number, b: number) => {
    if (a < 0 || b < 0 || a === b) return;
    const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * count + hi;
    if (seen.has(key)) return;
    seen.add(key);
    let d = 0, used = 0;
    for (let f = 0; f < nF; f++) { const x = means[lo * nF + f], y = means[hi * nF + f]; if (x === x && y === y) { d += (x - y) * (x - y); used++; } }
    edges.push([used ? Math.sqrt(d) : Infinity, lo, hi]);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x < w - 1) addEdge(labels[i], labels[i + 1]);
    if (y < h - 1) addEdge(labels[i], labels[i + w]);
  }
  edges.sort((a, b) => a[0] - b[0]);
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const size = Float64Array.from(sizes), internal = new Float64Array(count);
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (const [wgt, a0, b0] of edges) {
    const a = find(a0), b = find(b0);
    if (a === b || !Number.isFinite(wgt)) continue;
    if (wgt <= Math.min(internal[a] + k / size[a], internal[b] + k / size[b])) {
      parent[b] = a; size[a] += size[b]; internal[a] = Math.max(internal[a], internal[b], wgt);
    }
  }
  const remap = new Int32Array(count).fill(-1);
  let next = 0;
  const out = new Int32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    const L = labels[i];
    if (L < 0) { out[i] = -1; continue; }
    const r = find(L);
    if (remap[r] < 0) remap[r] = next++;
    out[i] = remap[r];
  }
  return { labels: out, count: next };
}
