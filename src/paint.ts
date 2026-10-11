// Pixel math: the stretch lookup, colour ramps, view statistics, and the
// painter that turns per-pixel channel values into RGBA. No I/O, no DOM.
//
// The stretch and the curve follow taylor-geospatial/s2-stac-geoparquet
// (apps/explorer/bands.js, Apache-2.0): a 1024-entry lookup from the
// normalised value t in 0..1 to a byte, the curve first (linear t; sqrt;
// log10(1 + 9t), which keeps 0 -> 0 and 1 -> 1), then gamma as t^(1/gamma),
// so gamma above 1 brightens the mid-tones.

import { hillshade } from './warp.ts';

export type Curve = 'linear' | 'sqrt' | 'log';

export const LUT_N = 1024;

export function makeLut(curve: Curve = 'linear', gamma = 1): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(LUT_N);
  const g = 1 / Math.max(0.05, Number(gamma) || 1);
  for (let i = 0; i < LUT_N; i++) {
    let t = i / (LUT_N - 1);
    if (curve === 'sqrt') t = Math.sqrt(t);
    else if (curve === 'log') t = Math.log10(1 + 9 * t);
    lut[i] = Math.round(255 * Math.pow(t, g));
  }
  return lut;
}

const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/** A 256-entry RGB table through the ramp's stops, evenly spaced. */
export function rampTable(stops: string[]): Uint8ClampedArray {
  const rgb = stops.map(hex), out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const f = (i / 255) * (rgb.length - 1), j = Math.min(rgb.length - 2, Math.floor(f)), t = f - j;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = rgb[j][c] * (1 - t) + rgb[j + 1][c] * t;
  }
  return out;
}

/** A class table: value (0–255) → RGB, with `known` marking the values that have a colour. */
export function classTable(classes: { value: number; colour: string }[]): { rgb: Uint8ClampedArray; known: Uint8Array } {
  const rgb = new Uint8ClampedArray(256 * 3), known = new Uint8Array(256);
  for (const c of classes) { rgb.set(hex(c.colour), c.value * 3); known[c.value] = 1; }
  return { rgb, known };
}

// ── Statistics ──────────────────────────────────────────────────────────────

export const HIST_BINS = 64;

export interface ChannelStats {
  n: number;
  min: number;
  max: number;
  p2: number;
  p98: number;
  /** Histogram over [lo, hi]. */
  hist: Uint32Array;
  lo: number;
  hi: number;
}

/**
 * Percentiles and a histogram of the finite values. The histogram spans
 * `domain` when given (an index's −1..1), else the data's own min..max.
 */
export function channelStats(values: ArrayLike<number>, domain?: [number, number]): ChannelStats | null {
  const v = new Float32Array(values.length);
  let n = 0;
  for (let i = 0; i < values.length; i++) { const x = values[i]; if (Number.isFinite(x)) v[n++] = x; }
  if (!n) return null;
  const sorted = v.subarray(0, n).sort();
  const at = (q: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
  const min = sorted[0], max = sorted[n - 1];
  const lo = domain ? domain[0] : min, hi = domain ? domain[1] : max;
  const hist = new Uint32Array(HIST_BINS), span = hi - lo || 1;
  for (let i = 0; i < n; i++) {
    const b = Math.floor(((sorted[i] - lo) / span) * HIST_BINS);
    hist[Math.min(HIST_BINS - 1, Math.max(0, b))]++;
  }
  return { n, min, max, p2: at(0.02), p98: at(0.98), hist, lo, hi };
}

/** Count of each class value among the finite values (for a class tally). */
export function classCounts(values: ArrayLike<number>): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (Number.isFinite(x)) m.set(x, (m.get(x) ?? 0) + 1);
  }
  return m;
}

// ── Painting ────────────────────────────────────────────────────────────────

export type Render = 'rgb' | 'gray' | 'ramp' | 'classes' | 'relief';

export interface PaintSpec {
  render: Render;
  /** Per channel stretch range (rgb: 3, others: 1). */
  ranges: [number, number][];
  curve: Curve;
  gamma: number;
  /** ramp and shaded relief. */
  ramp?: string[];
  /** relief: plain hillshade, or the ramp lit by it. */
  relief?: 'hillshade' | 'shaded';
  classes?: { value: number; colour: string }[];
  /** rgb: paint a pixel with SOME channels missing (those dark); only all-missing is transparent. */
  partial?: boolean;
}

/**
 * Paint a TILE × TILE RGBA from channel values. `chan[c]` holds channel c's
 * value for every pixel of the (possibly padded) grid of side `size`; a NaN
 * value is transparent. Relief needs a 1-pixel pad and the cell size.
 */
export function paint(chan: Float32Array[], size: number, pad: number, spec: PaintSpec, cellM: number): Uint8ClampedArray {
  const T = size - 2 * pad;
  const out = new Uint8ClampedArray(T * T * 4);
  const idx = (i: number) => (Math.floor(i / T) + pad) * size + (i % T) + pad;
  const N = T * T;

  if (spec.render === 'classes') {
    const { rgb, known } = classTable(spec.classes ?? []);
    for (let i = 0; i < N; i++) {
      const v = chan[0][idx(i)];
      if (v !== v || v < 0 || v > 255 || !known[v | 0]) continue;
      const k = (v | 0) * 3, o = i * 4;
      out[o] = rgb[k]; out[o + 1] = rgb[k + 1]; out[o + 2] = rgb[k + 2]; out[o + 3] = 255;
    }
    return out;
  }

  if (spec.render === 'ramp' || spec.render === 'relief') {
    const [lo, hi] = spec.ranges[0];
    const scale = 255 / ((hi - lo) || 1e-9);
    const table = rampTable(spec.ramp ?? ['#000000', '#ffffff']);
    const hs = spec.render === 'relief' ? hillshade(chan[0], size, size, cellM) : null;
    for (let i = 0; i < N; i++) {
      const v = chan[0][idx(i)];
      if (v !== v) continue;
      const o = i * 4;
      if (hs) {
        const s = hs[i];
        const light = s === s ? 0.35 + 0.65 * s : 0.75;
        if (spec.relief === 'hillshade') {
          out[o] = out[o + 1] = out[o + 2] = 255 * light;
          out[o + 3] = 255;
          continue;
        }
        let t = (v - lo) * scale; t = t < 0 ? 0 : t > 255 ? 255 : t;
        const k = (t | 0) * 3;
        out[o] = table[k] * light; out[o + 1] = table[k + 1] * light; out[o + 2] = table[k + 2] * light; out[o + 3] = 255;
        continue;
      }
      let t = (v - lo) * scale; t = t < 0 ? 0 : t > 255 ? 255 : t;
      const k = (t | 0) * 3;
      out[o] = table[k]; out[o + 1] = table[k + 1]; out[o + 2] = table[k + 2]; out[o + 3] = 255;
    }
    return out;
  }

  // rgb, or gray (one channel to all three), through the stretch and the curve.
  const lut = makeLut(spec.curve, spec.gamma);
  const chans = spec.render === 'gray' ? [0, 0, 0] : [0, 1, 2];
  const lo = chans.map(c => spec.ranges[c][0]);
  const sc = chans.map(c => (LUT_N - 1) / ((spec.ranges[c][1] - spec.ranges[c][0]) || 1e-9));
  for (let i = 0; i < N; i++) {
    const o = i * 4, j = idx(i);
    let missing = 0;
    for (let c = 0; c < 3; c++) {
      const v = chan[chans[c]][j];
      if (v !== v) { missing++; if (!spec.partial) break; continue; }
      let t = (v - lo[c]) * sc[c];
      t = t < 0 ? 0 : t > LUT_N - 1 ? LUT_N - 1 : t;
      out[o + c] = lut[t | 0];
    }
    if (spec.partial ? missing < 3 : missing === 0) out[o + 3] = 255;
  }
  return out;
}
