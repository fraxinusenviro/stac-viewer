// Segmentation, step 3: OBJECTS. Each segment becomes one record holding the
// mean of every sampled input over its pixels, plus measures that only exist
// for a region (area, compactness, canopy-height spread and 90th percentile,
// photo texture), and is classified by the SAME product the pixel map uses:
// the product's class function is evaluated once per object, on planes whose
// "pixels" are objects. So the rule and strata editors work unchanged, with an
// index computed from an object's mean reflectance, a stratum from its mean
// canopy height. Sentinel scene classes (SCL) take the object's majority
// instead of a mean, which would be meaningless for a class code. Pure.

import type { Planes, Product, ProductStyle } from '../products.ts';

export interface ObjectSet {
  count: number;
  /** One value per object for every input key, plus the `obj:*` measures. */
  planes: Planes;
  /** Pixels per object. */
  sizes: Float64Array;
}

const quantile = (s: number[], p: number) => { if (!s.length) return NaN; const q = p * (s.length - 1), lo = Math.floor(q), hi = Math.ceil(q); return s[lo] + (s[hi] - s[lo]) * (q - lo); };

/** Object records from a label image and the pixel planes. `cellM` is the pixel size in metres. */
export function objectPlanes(labels: Int32Array, count: number, w: number, h: number, planes: Planes, cellM: number): ObjectSet {
  const out: Planes = {};
  const sizes = new Float64Array(count);
  for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) sizes[labels[i]]++;
  for (const [key, a] of Object.entries(planes)) {
    if (key.startsWith('px:') || key.startsWith('pxw:') || a.length !== labels.length) continue;
    const o = new Float32Array(count).fill(NaN);
    if (key.endsWith(':scl')) {
      // Majority class per object.
      const votes = new Map<number, Map<number, number>>();
      for (let i = 0; i < labels.length; i++) {
        const k = labels[i], v = a[i];
        if (k < 0 || v !== v) continue;
        const m = votes.get(k) ?? votes.set(k, new Map()).get(k)!;
        m.set(v, (m.get(v) ?? 0) + 1);
      }
      for (const [k, m] of votes) o[k] = [...m].sort((x, y) => y[1] - x[1])[0][0];
    } else {
      const sum = new Float64Array(count), num = new Float64Array(count);
      for (let i = 0; i < labels.length; i++) { const k = labels[i], v = a[i]; if (k >= 0 && v === v) { sum[k] += v; num[k]++; } }
      for (let k = 0; k < count; k++) if (num[k]) o[k] = sum[k] / num[k];
    }
    out[key] = o;
  }
  // Region measures.
  const area = new Float32Array(count), perim = new Float64Array(count);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, k = labels[i];
    if (k < 0) continue;
    if (x === 0 || labels[i - 1] !== k) perim[k]++;
    if (x === w - 1 || labels[i + 1] !== k) perim[k]++;
    if (y === 0 || labels[i - w] !== k) perim[k]++;
    if (y === h - 1 || labels[i + w] !== k) perim[k]++;
  }
  const compact = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    area[k] = sizes[k] * cellM * cellM;
    const p = perim[k] * cellM;
    // 4πA / P², 1 for a disc; a pixel staircase reads lower, so compare objects with each other.
    compact[k] = p > 0 ? (4 * Math.PI * area[k]) / (p * p) : NaN;
  }
  out['obj:area'] = area;
  out['obj:compact'] = compact;
  // Per-object distributions: canopy height spread and P90, photo texture.
  const order = Int32Array.from({ length: labels.length }, (_, i) => i).filter(i => labels[i] >= 0).sort((a, b) => labels[a] - labels[b]);
  const dsm = planes['lidar:dsm'], dtm = planes['lidar:dtm'];
  const r = planes['ortho:r'], g = planes['ortho:g'], b = planes['ortho:b'];
  const chmSd = new Float32Array(count).fill(NaN), chmP90 = new Float32Array(count).fill(NaN), tex = new Float32Array(count).fill(NaN);
  let s = 0;
  while (s < order.length) {
    const k = labels[order[s]];
    let e = s;
    while (e < order.length && labels[order[e]] === k) e++;
    if (dsm && dtm) {
      const v: number[] = [];
      for (let j = s; j < e; j++) { const i = order[j], d = dsm[i] - dtm[i]; if (d === d) v.push(Math.max(0, d)); }
      v.sort((x, y) => x - y);
      chmP90[k] = quantile(v, 0.9);
      if (v.length > 1) { const m = v.reduce((x, y) => x + y, 0) / v.length; chmSd[k] = Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / v.length); }
    }
    if (r && g && b) {
      let n = 0, m = 0, m2 = 0;
      for (let j = s; j < e; j++) { const i = order[j], br = (r[i] + g[i] + b[i]) / 765; if (br === br) { n++; m += br; m2 += br * br; } }
      if (n > 1) { m /= n; tex[k] = Math.sqrt(Math.max(0, m2 / n - m * m)); }
    }
    s = e;
  }
  out['obj:chm_sd'] = chmSd;
  out['obj:chm_p90'] = chmP90;
  out['obj:tex'] = tex;
  return { count, planes: out, sizes };
}

/** The class of every object under a class product (NaN: unclassified). */
export function classifyObjects(product: Product, objs: ObjectSet, style: ProductStyle): Float32Array {
  const fn = product.channels[0].fn;
  const out = new Float32Array(objs.count);
  for (let k = 0; k < objs.count; k++) out[k] = fn(objs.planes, k, style);
  return out;
}

// ── Vectorising ─────────────────────────────────────────────────────────────

/**
 * The outline of every object as polygon rings in PIXEL-CORNER coordinates
 * (x right, y down), traced along pixel edges: outer rings and holes, each
 * closed. A vertex where two of an object's pixels touch only diagonally is
 * passed by turning right, so the rings there separate rather than cross.
 */
export function traceRings(labels: Int32Array, w: number, h: number): Map<number, [number, number][][]> {
  // Directed boundary edges with the object on the RIGHT (y down): top edge
  // runs west→east, right edge north→south, bottom east→west, left south→north.
  const W = w + 1;
  const out = new Map<number, Map<number, number[]>>();
  const add = (k: number, a: number, b: number) => {
    const m = out.get(k) ?? out.set(k, new Map()).get(k)!;
    (m.get(a) ?? m.set(a, []).get(a)!).push(b);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, k = labels[i];
    if (k < 0) continue;
    if (y === 0 || labels[i - w] !== k) add(k, y * W + x, y * W + x + 1);
    if (x === w - 1 || labels[i + 1] !== k) add(k, y * W + x + 1, (y + 1) * W + x + 1);
    if (y === h - 1 || labels[i + w] !== k) add(k, (y + 1) * W + x + 1, (y + 1) * W + x);
    if (x === 0 || labels[i - 1] !== k) add(k, (y + 1) * W + x, y * W + x);
  }
  const rings = new Map<number, [number, number][][]>();
  const dir = (a: number, b: number) => { const dx = (b % W) - (a % W), dy = Math.floor(b / W) - Math.floor(a / W); return dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3; }; // E S W N
  for (const [k, edges] of out) {
    const list: [number, number][][] = [];
    for (const start of [...edges.keys()]) {
      while ((edges.get(start)?.length ?? 0) > 0) {
        const ring: [number, number][] = [];
        let a = start, b = edges.get(a)!.pop()!;
        ring.push([a % W, Math.floor(a / W)]);
        for (let guard = 0; guard < 4 * labels.length; guard++) {
          ring.push([b % W, Math.floor(b / W)]);
          if (b === start) break;
          const outs = edges.get(b)!;
          const d = dir(a, b);
          // Prefer a right turn, then straight, then left (y down: right of E is S).
          let pick = 0;
          if (outs.length > 1) {
            const rank = (c: number) => { const t = (dir(b, c) - d + 4) % 4; return t === 1 ? 0 : t === 0 ? 1 : 2; };
            pick = outs.reduce((best, c, j) => (rank(c) < rank(outs[best]) ? j : best), 0);
          }
          const c = outs.splice(pick, 1)[0];
          a = b; b = c;
        }
        list.push(dropCollinear(ring));
      }
    }
    rings.set(k, list);
  }
  return rings;
}

/** Remove the middle vertex of every straight run (rings stay closed). */
function dropCollinear(r: [number, number][]): [number, number][] {
  if (r.length < 4) return r;
  const out: [number, number][] = [r[0]];
  for (let i = 1; i < r.length - 1; i++) {
    const p = out[out.length - 1], q = r[i], s = r[i + 1];
    if ((q[0] - p[0]) * (s[1] - q[1]) - (q[1] - p[1]) * (s[0] - q[0]) !== 0) out.push(q);
  }
  out.push(r[r.length - 1]);
  return out;
}

/** Twice the signed area in pixel coordinates (y down): positive = clockwise on screen = an outer ring. */
export function ringArea2(r: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return s;
}

function inRing(pt: [number, number], r: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Rings → polygons (outer ring + its holes), still in pixel coordinates. */
export function ringsToPolygons(rings: [number, number][][]): [number, number][][][] {
  const outers = rings.filter(r => ringArea2(r) > 0), holes = rings.filter(r => ringArea2(r) < 0);
  const polys = outers.map(o => [o]);
  for (const hole of holes) {
    // A point just inside the hole's first edge, off any vertex.
    const [a, b] = hole;
    const probe: [number, number] = [(a[0] + b[0]) / 2 + (b[1] - a[1]) * 0.25, (a[1] + b[1]) / 2 - (b[0] - a[0]) * 0.25];
    const owner = polys.find(p => inRing(probe, p[0]));
    (owner ?? polys[0])?.push(hole);
  }
  return polys;
}
