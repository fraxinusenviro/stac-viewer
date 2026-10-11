// User-editable classification rules: an ordered list of rules, each a class
// name, a colour and a list of conditions that must ALL hold. A pixel takes
// the first rule it satisfies; one that satisfies none is left unclassified
// (transparent). Rules that share a name and a colour are ONE class — that is
// how an OR is written ("Water" by NDWI, and "Water" by dark NIR).
//
// A condition on a variable that has no value at the pixel (no LiDAR there,
// an index over water too dark to compute) is FALSE, never true by default:
// a rule cannot claim a pixel it cannot see.
//
// Pure; unit-tested. A rule set is plain JSON so it can be saved, exported and
// shared; `parseRuleSet` refuses anything it does not understand rather than
// guessing.

import { variableById, needsLeafOff, sharpeningFor, type ClassDef, type Planes, type Product, type ProductStyle, type Variable } from './products.ts';
import { DEFAULT_UNMIX, type UnmixParams } from './unmix.ts';

export type Op = '<' | '<=' | '>' | '>=' | 'between';
export const OPS: Op[] = ['>=', '>', '<', '<=', 'between'];

export interface Condition { v: string; op: Op; a: number; b?: number }
export interface Rule { label: string; colour: string; when: Condition[]; off?: boolean }
export interface RuleSet {
  name: string; maskClouds: boolean; rules: Rule[];
  /** How LiDAR-sharpened variables are unmixed (absent: the defaults). */
  sharpen?: UnmixParams;
}

/** The variables an enabled rule reads. */
export function ruleVariables(rs: RuleSet): Variable[] {
  const ids = new Set<string>();
  for (const r of rs.rules) if (!r.off) for (const c of r.when) ids.add(c.v);
  return [...ids].map(id => variableById.get(id)).filter((v): v is Variable => !!v);
}

/** The class value a masked pixel takes. */
export const MASKED = 255;
export const MASK_CLASS: ClassDef = { value: MASKED, label: 'Cloud, shadow or snow (masked)', colour: '#f0f0ff' };
const SCL_MASKED = new Set([3, 8, 9, 10, 11]);

export function test(op: Op, x: number, a: number, b = a): boolean {
  if (x !== x) return false;
  switch (op) {
    case '<': return x < a;
    case '<=': return x <= a;
    case '>': return x > a;
    case '>=': return x >= a;
    case 'between': return x >= Math.min(a, b) && x <= Math.max(a, b);
  }
}

export const describeCondition = (c: Condition) => {
  const name = variableById.get(c.v)?.label ?? c.v;
  return c.op === 'between' ? `${name} between ${c.a} and ${c.b}` : `${name} ${c.op.replace('>=', '≥').replace('<=', '≤')} ${c.a}`;
};

/** The distinct classes of a rule set: one per enabled (name, colour) pair, in first-use order. */
export function ruleClasses(rs: RuleSet): { classes: ClassDef[]; valueOf: number[] } {
  const classes: ClassDef[] = [];
  const key = new Map<string, number>();
  const valueOf = rs.rules.map(r => {
    if (r.off) return 0;
    const k = `${r.label.trim().toLowerCase()}|${r.colour.toLowerCase()}`;
    let v = key.get(k);
    if (v === undefined) {
      v = classes.length + 1;
      if (v >= MASKED) throw new Error('too many classes (254 at most)');
      key.set(k, v);
      classes.push({ value: v, label: r.label.trim() || 'Unnamed', colour: r.colour });
    }
    return v;
  });
  return { classes, valueOf };
}

/** Every input the rule set reads (the SCL of each scene it uses when masking). */
export function ruleInputs(rs: RuleSet): string[] {
  const set = new Set<string>();
  let leafOff = false;
  for (const r of rs.rules) if (!r.off) for (const c of r.when) {
    const v = variableById.get(c.v);
    if (!v) continue;
    v.inputs.forEach(k => set.add(k));
    if (needsLeafOff(v)) leafOff = true;
  }
  if (rs.maskClouds) { set.add('s2:scl'); if (leafOff) set.add('s2b:scl'); }
  return [...set];
}

/** Whether a rule set uses the second (leaf-off) scene. */
export const usesLeafOff = (rs: RuleSet) => ruleInputs(rs).some(k => k.startsWith('s2b:'));

/** The product that draws a rule set. */
export function compileRuleSet(rs: RuleSet): Product {
  const { classes, valueOf } = ruleClasses(rs);
  const inputs = ruleInputs(rs);
  const compiled = rs.rules.map((r, i) => ({
    value: valueOf[i],
    conds: r.when.map(c => ({ fn: variableById.get(c.v)!.channel.fn, op: c.op, a: c.a, b: c.b ?? c.a })),
  })).filter(r => r.value);
  const maskKeys = rs.maskClouds ? inputs.filter(k => k.endsWith(':scl')) : [];
  return {
    id: `rules:${JSON.stringify(rs)}`, label: rs.name || 'Rule-based classes', group: 'Fusion classes',
    inputs, render: 'classes', pad: 0, sharpen: sharpeningFor(ruleVariables(rs), rs.sharpen ?? DEFAULT_UNMIX),
    classes: maskKeys.length ? [...classes, MASK_CLASS] : classes,
    channels: [{
      label: 'Class', unit: 'class', step: 1, seed: [0, 255],
      fn: (p: Planes, i: number, s: ProductStyle) => {
        for (const k of maskKeys) { const v = p[k][i]; if (v === v && SCL_MASKED.has(v)) return MASKED; }
        for (const r of compiled) {
          let ok = true;
          for (const c of r.conds) if (!test(c.op, c.fn(p, i, s), c.a, c.b)) { ok = false; break; }
          if (ok) return r.value;
        }
        return NaN;
      },
    }],
    note: 'Each pixel takes the first rule whose conditions all hold. Rules sharing a name and colour are one class.',
  };
}

/** Validate an imported rule set; throws naming the first problem. */
export function parseRuleSet(x: unknown): RuleSet {
  const o = x as Partial<RuleSet>;
  if (!o || typeof o !== 'object' || !Array.isArray(o.rules)) throw new Error('not a rule set (no "rules" list)');
  const rules = o.rules.map((r, i): Rule => {
    const where = `rule ${i + 1}`;
    if (typeof r?.label !== 'string') throw new Error(`${where}: no name`);
    if (typeof r.colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(r.colour)) throw new Error(`${where}: colour must be #rrggbb`);
    if (!Array.isArray(r.when)) throw new Error(`${where}: no conditions list`);
    const when = r.when.map((c, j): Condition => {
      if (!variableById.has(c?.v)) throw new Error(`${where}, condition ${j + 1}: unknown variable "${c?.v}"`);
      if (!OPS.includes(c.op)) throw new Error(`${where}, condition ${j + 1}: unknown operator "${c.op}"`);
      if (!Number.isFinite(c.a) || (c.op === 'between' && !Number.isFinite(c.b))) throw new Error(`${where}, condition ${j + 1}: value must be a number`);
      return c.op === 'between' ? { v: c.v, op: c.op, a: c.a, b: c.b } : { v: c.v, op: c.op, a: c.a };
    });
    return { label: r.label, colour: r.colour, when, ...(r.off ? { off: true } : {}) };
  });
  let sharpen: UnmixParams | undefined;
  if (o.sharpen !== undefined) {
    const sp = o.sharpen as Partial<UnmixParams>;
    const breaks = Array.isArray(sp.breaks) ? sp.breaks : [];
    if (!breaks.length || breaks.some((b, i) => !Number.isFinite(b) || (i && b <= breaks[i - 1]))) throw new Error('sharpen.breaks must be ascending numbers');
    if (!Number.isInteger(sp.radius) || sp.radius! < 1 || sp.radius! > 6) throw new Error('sharpen.radius must be a whole number from 1 to 6');
    if (!Number.isFinite(sp.ridge) || sp.ridge! < 0) throw new Error('sharpen.ridge must be a number ≥ 0');
    sharpen = { breaks, radius: sp.radius!, ridge: sp.ridge! };
  }
  return { name: typeof o.name === 'string' ? o.name : 'Imported rules', maskClouds: o.maskClouds !== false, rules, ...(sharpen ? { sharpen } : {}) };
}

// ── Presets ─────────────────────────────────────────────────────────────────

const c = (v: string, op: Op, a: number, b?: number): Condition => (b === undefined ? { v, op, a } : { v, op, a, b });

export const PRESETS: RuleSet[] = [
  {
    name: 'Land cover', maskClouds: true, rules: [
      { label: 'Water', colour: '#2c7fb8', when: [c('chm', '<', 1), c('ndwi', '>', 0.05)] },
      { label: 'Water', colour: '#2c7fb8', when: [c('chm', '<', 1), c('nir', '<', 0.04)] },
      { label: 'Trees', colour: '#1b7837', when: [c('ndvi', '>=', 0.35), c('chm', '>=', 5)] },
      { label: 'Shrub or regeneration', colour: '#7fbc41', when: [c('ndvi', '>=', 0.35), c('chm', '>=', 1)] },
      { label: 'Grass, crops or low vegetation', colour: '#d9f0a3', when: [c('ndvi', '>=', 0.35), c('chm', '>=', 0)] },
      { label: 'Building or structure', colour: '#d6604d', when: [c('ndvi', '<', 0.35), c('chm', '>=', 2.5)] },
      { label: 'Bare ground or pavement', colour: '#bababa', when: [c('ndvi', '<', 0.35), c('chm', '>=', 0)] },
    ],
  },
  {
    // Leaf-on, broadleaf canopy reflects far more near infrared than conifer
    // (≈0.35–0.45 against ≈0.15–0.28). 0.30 is a starting point; calibrate it
    // with samples for the scene in hand.
    name: 'Forest type — one leaf-on scene', maskClouds: true, rules: [
      { label: 'Coniferous', colour: '#00441b', when: [c('chm', '>=', 5), c('ndvi', '>=', 0.5), c('nir', '<', 0.3)] },
      { label: 'Broadleaf', colour: '#78c679', when: [c('chm', '>=', 5), c('ndvi', '>=', 0.5), c('nir', '>=', 0.3)] },
      { label: 'Other trees (low NDVI)', colour: '#c2a5cf', when: [c('chm', '>=', 5), c('ndvi', '>=', 0.3)] },
    ],
  },
  {
    // Between leaf-on and leaf-off, broadleaf canopy loses most of its NDVI and
    // conifer keeps it. Needs a snow-free leaf-off scene: late April to mid May,
    // or November before the snow, in Nova Scotia.
    name: 'Forest type — leaf-on and leaf-off scenes', maskClouds: true, rules: [
      { label: 'Coniferous', colour: '#00441b', when: [c('chm', '>=', 5), c('ndvi', '>=', 0.5), c('d_ndvi', '<', 0.15)] },
      { label: 'Mixedwood', colour: '#41ab5d', when: [c('chm', '>=', 5), c('ndvi', '>=', 0.5), c('d_ndvi', 'between', 0.15, 0.3)] },
      { label: 'Broadleaf', colour: '#c2e699', when: [c('chm', '>=', 5), c('ndvi', '>=', 0.5), c('d_ndvi', '>', 0.3)] },
    ],
  },
  {
    // FieldMapper's conifer index, calibrated to the view: positive leans
    // coniferous, negative broadleaf; ±0.25 is FieldMapper's own transition
    // width. Press "Calibrate to this view" first.
    name: 'Forest type — conifer index (FieldMapper method)', maskClouds: true, rules: [
      { label: 'Coniferous', colour: '#00441b', when: [c('ci', '>=', 0.25)] },
      { label: 'Mixed or uncertain', colour: '#41ab5d', when: [c('ci', 'between', -0.25, 0.25)] },
      { label: 'Broadleaf', colour: '#c2e699', when: [c('ci', '<=', -0.25)] },
    ],
  },
  {
    // The two-scene rules on LiDAR-sharpened spectra: each 1 m canopy pixel
    // reads the unmixed canopy spectrum of its neighbourhood rather than the
    // 10 m mixture of crowns, gaps and ground.
    name: 'Forest type — two scenes, LiDAR-sharpened', maskClouds: true, rules: [
      { label: 'Coniferous', colour: '#00441b', when: [c('chm', '>=', 5), c('s_ndvi', '>=', 0.5), c('s_d_ndvi', '<', 0.15)] },
      { label: 'Mixedwood', colour: '#41ab5d', when: [c('chm', '>=', 5), c('s_ndvi', '>=', 0.5), c('s_d_ndvi', 'between', 0.15, 0.3)] },
      { label: 'Broadleaf', colour: '#c2e699', when: [c('chm', '>=', 5), c('s_ndvi', '>=', 0.5), c('s_d_ndvi', '>', 0.3)] },
    ],
  },
  {
    // Candidate cover from every source at once: LiDAR height (HRDEM), the
    // laser's own returns (point cloud), Sentinel-2 spectra and the
    // orthophoto. Laser dropout marks water the imagery misses; leaf type is
    // the six-term conifer index (calibrate it first, or woody pixels stay
    // "leaf type undetermined"); low cover is split by ortho greenness.
    name: 'Candidate cover — LiDAR intensity + orthophoto + Sentinel', maskClouds: true, rules: [
      { label: 'Water', colour: '#2c7fb8', when: [c('chm', '<', 1), c('ndwi', '>', 0.05)] },
      { label: 'Water', colour: '#2c7fb8', when: [c('chm', '<', 1), c('nir', '<', 0.04)] },
      { label: 'Water', colour: '#2c7fb8', when: [c('chm', '<', 1), c('pc_den', '<', 0.5)] },
      // Roofs: tall, not green, and solid — no pulse gets through a roof, while a
      // shadowed crown that the photo also sees as grey still lets some reach the
      // ground. 10 m NDVI cannot do this: it mixes the roof with the yard trees.
      { label: 'Built structure', colour: '#d6604d', when: [c('chm', '>=', 2.5), c('o_exg', '<', 0.02), c('pc_pen', '<', 0.05)] },
      { label: 'Built structure', colour: '#d6604d', when: [c('chm', '>=', 2.5), c('ndvi', '<', 0.3)] },
      { label: 'Coniferous', colour: '#00441b', when: [c('chm', '>=', 2), c('ci6', '>=', 0.25)] },
      { label: 'Mixed or uncertain', colour: '#41ab5d', when: [c('chm', '>=', 2), c('ci6', 'between', -0.25, 0.25)] },
      { label: 'Deciduous', colour: '#a6d96a', when: [c('chm', '>=', 2), c('ci6', '<=', -0.25)] },
      { label: 'Woody, leaf type undetermined', colour: '#7f7f3f', when: [c('chm', '>=', 2), c('ndvi', '>=', 0.4)] },
      { label: 'Herbaceous', colour: '#ecd66e', when: [c('chm', '<', 2), c('ndvi', '>=', 0.3), c('o_exg', '>=', 0.05)] },
      // Roads and paving are grey in the orthophoto even where a 10 m Sentinel pixel is mostly roadside trees.
      { label: 'Bare or impervious', colour: '#c4a478', when: [c('chm', '<', 2), c('o_exg', '<', 0.02)] },
      { label: 'Low ground cover', colour: '#966e96', when: [c('chm', '<', 2), c('ndvi', '>=', 0.25)] },
      { label: 'Bare or impervious', colour: '#c4a478', when: [c('chm', '<', 2), c('ndvi', '<', 0.25)] },
    ],
  },
  { name: 'Empty', maskClouds: true, rules: [] },
];

export const clonePreset = (i: number): RuleSet => JSON.parse(JSON.stringify(PRESETS[i]));
