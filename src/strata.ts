// Strata × cover: a two-axis classification, the way vegetation is described
// in the field. A pixel's HEIGHT STRATUM comes from the canopy height model
// (groundcover, herbaceous/forb, low shrub, high shrub, forest — the bands are
// the user's); its COVER TYPE comes from spectral rules (coniferous, broadleaf,
// water…); the class is the pair: "Coniferous · high shrub (2–8 m)".
//
// A cover type names the strata it can occur in. Coniferous can be low shrub,
// high shrub or forest; broadleaf can be any of them; herbaceous only below
// 0.5 m. A pixel takes the first cover type whose conditions hold AND whose
// strata include the pixel's stratum — so a 0.3 m pixel with a conifer-like
// spectrum is not "coniferous groundcover" unless the scheme allows it; it
// falls through to the next cover type that fits.
//
// What the data can and cannot say, stated where it matters:
//  - The CHM is the height of the TOP surface. A pixel is classed by its
//    tallest layer; the shrubs under a forest canopy are not seen (that needs
//    the point cloud's vertical profile).
//  - HRDEM's DSM − DTM carries ~0.1–0.2 m of noise, and low herbs are often
//    classified as ground by the LiDAR provider. A 0.1 m boundary is finer
//    than the data resolves; strata below ~0.5 m lean on the cover rules.
//
// Pure; unit-tested. A scheme is plain JSON (saved, exported, imported).

import { variableById, sharpeningFor, needsLeafOff, type ClassDef, type Planes, type Product, type ProductStyle, type Variable } from './products.ts';
import { test, OPS, type Condition } from './rules.ts';
import { DEFAULT_UNMIX, type UnmixParams } from './unmix.ts';

export interface Stratum { id: string; label: string; min: number; max: number }
export interface CoverType { label: string; colour: string; when: Condition[]; strata: string[]; off?: boolean }
export interface StrataScheme {
  name: string;
  strata: Stratum[];
  covers: CoverType[];
  maskClouds: boolean;
  /** Paint pixels no cover type claims, by stratum, in greys. */
  showUnclassified: boolean;
  sharpen?: UnmixParams;
}

export const MASKED = 255;
const SCL_MASKED = new Set([3, 8, 9, 10, 11]);
const UNCLASSIFIED_BASE = 240; // 240 + stratum index

/** The stratum index of a canopy height (strata sorted by min; half-open [min, max)). −1 when none. */
export function stratumOf(chm: number, strata: Stratum[]): number {
  if (chm !== chm) return -1;
  for (let i = 0; i < strata.length; i++) if (chm >= strata[i].min && chm < strata[i].max) return i;
  return -1;
}

/** Strata must be ordered, non-overlapping and named; returns the first problem, or null. */
export function strataProblem(strata: Stratum[]): string | null {
  if (!strata.length) return 'add at least one stratum';
  if (strata.length > 12) return 'twelve strata at most';
  for (let i = 0; i < strata.length; i++) {
    const s = strata[i];
    if (!s.label.trim()) return `stratum ${i + 1} has no name`;
    if (!(s.max > s.min)) return `${s.label}: the upper height must be above the lower`;
    if (i && s.min < strata[i - 1].max) return `${s.label} overlaps ${strata[i - 1].label}`;
  }
  return null;
}

/** "0.5–2 m", "< 0.1 m", "> 8 m". */
export const stratumRange = (s: Stratum) => (s.min <= 0 && Number.isFinite(s.max) ? `< ${s.max} m` : !Number.isFinite(s.max) || s.max >= 999 ? `> ${s.min} m` : `${s.min}–${s.max} m`);

/** A cover colour, lightened for low strata and darkened for tall ones, so a stratum reads as depth. */
export function stratumShade(hex: string, i: number, n: number): string {
  const c = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16));
  const t = n > 1 ? i / (n - 1) : 0.5;        // 0 lowest … 1 tallest
  const mix = 0.55 - t * 0.9;                 // +0.55 (towards white) … −0.35 (towards black)
  const out = c.map(v => Math.round(mix >= 0 ? v + (255 - v) * mix : v * (1 + mix)));
  return '#' + out.map(v => v.toString(16).padStart(2, '0')).join('');
}

/** The distinct cover classes (rules sharing a name and colour are one, an OR), in first-use order. */
export function coverGroups(sc: StrataScheme): { labels: { label: string; colour: string }[]; groupOf: number[] } {
  const labels: { label: string; colour: string }[] = [];
  const key = new Map<string, number>();
  const groupOf = sc.covers.map(c => {
    if (c.off) return -1;
    const k = `${c.label.trim().toLowerCase()}|${c.colour.toLowerCase()}`;
    let g = key.get(k);
    if (g === undefined) { g = labels.length; key.set(k, g); labels.push({ label: c.label.trim() || 'Unnamed', colour: c.colour }); }
    return g;
  });
  return { labels, groupOf };
}

/** Class value of (cover group, stratum): 1-based, row-major. */
export const cellValue = (group: number, stratum: number, nStrata: number) => group * nStrata + stratum + 1;

export function schemeVariables(sc: StrataScheme): Variable[] {
  const ids = new Set<string>();
  for (const c of sc.covers) if (!c.off) for (const w of c.when) ids.add(w.v);
  return [...ids].map(id => variableById.get(id)).filter((v): v is Variable => !!v);
}

export function schemeInputs(sc: StrataScheme): string[] {
  const set = new Set<string>(['lidar:dsm', 'lidar:dtm']);
  let leafOff = false;
  for (const v of schemeVariables(sc)) { v.inputs.forEach(k => set.add(k)); if (needsLeafOff(v)) leafOff = true; }
  if (sc.maskClouds) { set.add('s2:scl'); if (leafOff) set.add('s2b:scl'); }
  return [...set];
}

export const schemeUsesLeafOff = (sc: StrataScheme) => schemeInputs(sc).some(k => k.startsWith('s2b:'));

/** The product drawing a scheme; `matrix` carries what the legend needs. */
export function compileScheme(sc: StrataScheme): Product {
  const problem = strataProblem(sc.strata);
  if (problem) throw new Error(problem);
  const nS = sc.strata.length;
  if (nS * coverGroups(sc).labels.length >= UNCLASSIFIED_BASE) throw new Error('too many cover types × strata (239 combinations at most)');
  const { labels, groupOf } = coverGroups(sc);
  const strataIdx = new Map(sc.strata.map((s, i) => [s.id, i]));
  const covers = sc.covers.map((c, i) => ({
    group: groupOf[i],
    allowed: (() => { const a = new Uint8Array(nS); for (const id of c.strata) { const k = strataIdx.get(id); if (k !== undefined) a[k] = 1; } return a; })(),
    conds: c.when.filter(w => variableById.has(w.v)).map(w => ({ fn: variableById.get(w.v)!.channel.fn, op: w.op, a: w.a, b: w.b ?? w.a })),
  })).filter(c => c.group >= 0);
  const inputs = schemeInputs(sc);
  const maskKeys = sc.maskClouds ? inputs.filter(k => k.endsWith(':scl')) : [];
  const classes: ClassDef[] = [];
  labels.forEach((l, g) => sc.strata.forEach((s, k) => classes.push({ value: cellValue(g, k, nS), label: `${l.label} · ${s.label}`, colour: stratumShade(l.colour, k, nS) })));
  if (sc.showUnclassified) sc.strata.forEach((s, k) => classes.push({ value: UNCLASSIFIED_BASE + k, label: `Unclassified · ${s.label}`, colour: stratumShade('#9e9e9e', k, nS) }));
  if (maskKeys.length) classes.push({ value: MASKED, label: 'Cloud, shadow or snow (masked)', colour: '#f0f0ff' });
  const strata = sc.strata;
  return {
    id: `strata:${JSON.stringify(sc)}`, label: sc.name || 'Strata × cover', group: 'Fusion classes',
    inputs, render: 'classes', pad: 0, classes,
    sharpen: sharpeningFor(schemeVariables(sc), sc.sharpen ?? DEFAULT_UNMIX),
    matrix: {
      rows: labels, cols: strata.map(s => ({ label: s.label, range: stratumRange(s) })),
      value: (r: number, c: number) => cellValue(r, c, nS),
      unclassified: sc.showUnclassified ? (c: number) => UNCLASSIFIED_BASE + c : undefined,
    },
    channels: [{
      label: 'Class', unit: 'class', step: 1, seed: [0, 255],
      fn: (p: Planes, i: number, s: ProductStyle) => {
        for (const k of maskKeys) { const v = p[k][i]; if (v === v && SCL_MASKED.has(v)) return MASKED; }
        const d = p['lidar:dsm'][i] - p['lidar:dtm'][i];
        const st = stratumOf(d !== d ? NaN : Math.max(0, d), strata);
        if (st < 0) return NaN;
        for (const c of covers) {
          if (!c.allowed[st]) continue;
          let ok = true;
          for (const w of c.conds) if (!test(w.op, w.fn(p, i, s), w.a, w.b)) { ok = false; break; }
          if (ok) return cellValue(c.group, st, strata.length);
        }
        return sc.showUnclassified ? UNCLASSIFIED_BASE + st : NaN;
      },
    }],
    note: 'Stratum from canopy height (the top surface: what is under a canopy is not seen); cover type from the first rule that holds and allows that stratum.',
  };
}

/** Validate an imported scheme; throws naming the first problem. */
export function parseScheme(x: unknown): StrataScheme {
  const o = x as Partial<StrataScheme>;
  if (!o || typeof o !== 'object' || !Array.isArray(o.strata) || !Array.isArray(o.covers)) throw new Error('not a strata scheme (needs "strata" and "covers")');
  const strata = o.strata.map((s, i): Stratum => {
    if (typeof s?.label !== 'string' || !Number.isFinite(s.min) || !(Number.isFinite(s.max) || s.max === null)) throw new Error(`stratum ${i + 1}: needs a name, min and max`);
    return { id: typeof s.id === 'string' && s.id ? s.id : `s${i}`, label: s.label, min: s.min, max: s.max ?? 999 };
  });
  const problem = strataProblem(strata);
  if (problem) throw new Error(problem);
  const ids = new Set(strata.map(s => s.id));
  const covers = o.covers.map((c, i): CoverType => {
    const where = `cover ${i + 1}`;
    if (typeof c?.label !== 'string') throw new Error(`${where}: no name`);
    if (typeof c.colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(c.colour)) throw new Error(`${where}: colour must be #rrggbb`);
    if (!Array.isArray(c.when) || !Array.isArray(c.strata)) throw new Error(`${where}: needs "when" and "strata" lists`);
    for (const id of c.strata) if (!ids.has(id)) throw new Error(`${where}: unknown stratum "${id}"`);
    const when = c.when.map((w, j): Condition => {
      if (!variableById.has(w?.v)) throw new Error(`${where}, condition ${j + 1}: unknown variable "${w?.v}"`);
      if (!OPS.includes(w.op)) throw new Error(`${where}, condition ${j + 1}: unknown operator "${w.op}"`);
      if (!Number.isFinite(w.a) || (w.op === 'between' && !Number.isFinite(w.b))) throw new Error(`${where}, condition ${j + 1}: value must be a number`);
      return w.op === 'between' ? { v: w.v, op: w.op, a: w.a, b: w.b } : { v: w.v, op: w.op, a: w.a };
    });
    return { label: c.label, colour: c.colour, when, strata: [...c.strata], ...(c.off ? { off: true } : {}) };
  });
  return { name: typeof o.name === 'string' ? o.name : 'Imported scheme', strata, covers, maskClouds: o.maskClouds !== false, showUnclassified: o.showUnclassified !== false, ...(o.sharpen ? { sharpen: o.sharpen } : {}) };
}

// ── The default scheme: the strata of the brief ─────────────────────────────

const c = (v: string, op: Condition['op'], a: number, b?: number): Condition => (b === undefined ? { v, op, a } : { v, op, a, b });
export const DEFAULT_STRATA: Stratum[] = [
  { id: 'ground', label: 'Groundcover', min: 0, max: 0.1 },
  { id: 'herb', label: 'Herbaceous / forb', min: 0.1, max: 0.5 },
  { id: 'lowshrub', label: 'Low shrub', min: 0.5, max: 2 },
  { id: 'highshrub', label: 'High shrub', min: 2, max: 8 },
  { id: 'forest', label: 'Forest', min: 8, max: 999 },
];
const ALL = DEFAULT_STRATA.map(s => s.id), LOW = ['ground', 'herb'], WOODY = ['lowshrub', 'highshrub', 'forest'];

export function defaultScheme(): StrataScheme {
  return {
    name: 'Vegetation strata × cover type', maskClouds: true, showUnclassified: true,
    strata: DEFAULT_STRATA.map(s => ({ ...s })),
    covers: [
      { label: 'Water', colour: '#2c7fb8', when: [c('ndwi', '>', 0.05)], strata: LOW },
      { label: 'Water', colour: '#2c7fb8', when: [c('nir', '<', 0.04)], strata: LOW },
      // Leaf-on NIR: broadleaf foliage reflects far more than needles. Swap to
      // ΔNDVI or a calibrated conifer index when a leaf-off scene is chosen.
      { label: 'Coniferous', colour: '#1b5e20', when: [c('ndvi', '>=', 0.5), c('nir', '<', 0.3)], strata: WOODY },
      { label: 'Broadleaf', colour: '#7cb342', when: [c('ndvi', '>=', 0.5), c('nir', '>=', 0.3)], strata: ALL },
      { label: 'Other vegetation', colour: '#c0ca33', when: [c('ndvi', '>=', 0.3)], strata: ALL },
      { label: 'Built structure', colour: '#d6604d', when: [c('ndvi', '<', 0.3)], strata: ['highshrub', 'forest'] },
      { label: 'Bare or impervious', colour: '#8d6e63', when: [c('ndvi', '<', 0.3)], strata: [...LOW, 'lowshrub'] },
    ],
  };
}
