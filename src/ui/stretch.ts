// The stretch controls, shared by every tab: per channel a histogram of the
// view with the current handles marked, the two values, and 2–98 % / Min/Max
// buttons; then the curve and gamma where they apply (bands, not ramps).
// Plus the legend a product needs: a ramp bar, or class swatches with each
// class's share of the view.

import { h, clear } from '../dom.ts';
import { HIST_BINS, rampTable, type ChannelStats, type Curve } from '../paint.ts';
import { hasCurve, hasStretch, seedRanges, type Product, type ProductStyle } from '../products.ts';
import type { ViewStats } from '../engine.ts';

export interface StretchHost {
  product: Product;
  style: ProductStyle;
  /** Statistics of the layer over the current view. */
  stats: () => Promise<ViewStats | null>;
  /** The style changed: repaint. */
  apply: () => void;
}

const fmt = (v: number, step: number) => (step >= 1 ? String(Math.round(v)) : v.toFixed(step >= 0.01 ? 2 : 3));

export interface StretchPanel {
  el: HTMLElement;
  /** Re-read the view's statistics and redraw the histograms (and the class shares). */
  refresh: () => Promise<void>;
  /** Re-seed every handle from the view (2–98 %, or the product's fixed values). */
  seed: () => Promise<void>;
}

export function stretchPanel(host: StretchHost): StretchPanel {
  const { product: p } = host;
  const el = h('div', { class: 'stretch' });
  let last: ViewStats | null = null;
  const canvases: HTMLCanvasElement[] = [];
  const inputs: [HTMLInputElement, HTMLInputElement][] = [];
  const shares = new Map<number, HTMLElement>();

  const setRange = (c: number, lo: number, hi: number) => {
    host.style.ranges[c] = [lo, hi];
    inputs[c][0].value = fmt(lo, p.channels[c].step);
    inputs[c][1].value = fmt(hi, p.channels[c].step);
    drawHist(c);
    rampLegend?.update();
  };

  const drawHist = (c: number) => {
    const cv = canvases[c];
    if (!cv) return;
    const s: ChannelStats | null = last?.channels[c] ?? null;
    const ctx = cv.getContext('2d')!;
    const W = (cv.width = cv.clientWidth * devicePixelRatio || 300), H = (cv.height = 44 * devicePixelRatio);
    ctx.clearRect(0, 0, W, H);
    if (!s) { ctx.fillStyle = '#888'; ctx.font = `${11 * devicePixelRatio}px system-ui`; ctx.fillText('no data in view', 6, H / 2); return; }
    const peak = Math.max(1, ...s.hist);
    ctx.fillStyle = getComputedStyle(el).getPropertyValue('--hist') || '#6b8fd6';
    const bw = W / HIST_BINS;
    s.hist.forEach((n, i) => { const bh = Math.max(n ? 1 : 0, (Math.sqrt(n) / Math.sqrt(peak)) * (H - 4)); ctx.fillRect(i * bw, H - bh, Math.max(1, bw - 1), bh); });
    const [lo, hi] = host.style.ranges[c];
    const x = (v: number) => ((v - s.lo) / ((s.hi - s.lo) || 1)) * W;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 0, Math.max(0, x(lo)), H);
    ctx.fillRect(Math.min(W, x(hi)), 0, W, H);
    ctx.fillStyle = getComputedStyle(el).getPropertyValue('--handle') || '#2b6e4f';
    for (const v of [lo, hi]) ctx.fillRect(Math.min(W - 2, Math.max(0, x(v) - 1)), 0, 2 * devicePixelRatio, H);
  };

  if (hasStretch(p)) {
    p.channels.forEach((ch, c) => {
      const cv = h('canvas', { class: 'hist', 'aria-hidden': 'true' });
      canvases[c] = cv;
      const mk = (which: 0 | 1) => h('input', {
        type: 'number', step: String(ch.step), value: fmt(host.style.ranges[c][which], ch.step), 'aria-label': `${ch.label} ${which ? 'maximum' : 'minimum'}`,
        onchange: (e: Event) => {
          const v = +(e.target as HTMLInputElement).value;
          if (!Number.isFinite(v)) return;
          const r = [...host.style.ranges[c]] as [number, number];
          r[which] = v;
          setRange(c, r[0], r[1]);
          host.apply();
        },
      });
      const pair: [HTMLInputElement, HTMLInputElement] = [mk(0), mk(1)];
      inputs[c] = pair;
      const pct = h('button', { class: 'chip', title: '2nd to 98th percentile of the view', onclick: () => { const s = last?.channels[c]; if (s) { setRange(c, s.p2, s.p98); host.apply(); } } }, '2–98 %');
      const mm = h('button', { class: 'chip', title: 'Full range of the view', onclick: () => { const s = last?.channels[c]; if (s) { setRange(c, s.min, s.max); host.apply(); } } }, 'Min/Max');
      const chName = p.render === 'rgb' ? ['Red', 'Green', 'Blue'][c] : '';
      el.append(h('div', { class: 'chan' },
        h('div', { class: 'row spread' },
          h('span', {}, chName ? h('strong', {}, `${chName} `) : null, h('span', { class: chName ? 'muted' : '' }, ch.label), ch.unit === 'reflectance' || ch.unit === 'index' || ch.unit === 'class' ? null : h('span', { class: 'muted' }, ` (${ch.unit})`)),
          h('span', { class: 'row' }, pct, mm)),
        cv,
        h('div', { class: 'row' }, pair[0], h('span', { class: 'muted' }, '–'), pair[1])));
    });
  }

  let rampLegend: { update: () => void } | null = null;
  if ((p.render === 'ramp' || p.relief === 'shaded') && p.ramp) {
    const t = rampTable(p.ramp);
    const stops = [0, 0.25, 0.5, 0.75, 1].map(f => { const k = Math.round(f * 255) * 3; return `rgb(${t[k]},${t[k + 1]},${t[k + 2]}) ${f * 100}%`; }).join(',');
    const lo = h('span', {}), hi = h('span', {});
    el.append(h('div', { class: 'ramp' }, h('div', { class: 'ramp-bar', style: `background: linear-gradient(to right, ${stops})` }), h('div', { class: 'row spread small' }, lo, hi)));
    rampLegend = { update: () => { const [a, b] = host.style.ranges[0]; const u = p.channels[0].unit; const sfx = u === 'm' ? ' m' : ''; lo.textContent = fmt(a, p.channels[0].step) + sfx; hi.textContent = fmt(b, p.channels[0].step) + sfx; } };
    rampLegend.update();
  }

  if (p.classes && p.matrix) {
    const m = p.matrix;
    const colour = new Map(p.classes.map(c => [c.value, c.colour]));
    // Each cell is painted its class colour with the share printed on it, in
    // black or white by the colour's lightness: a matrix to be read at a glance.
    const ink = (hex = '#888888') => {
      const [r, g, b] = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16));
      return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#111' : '#fff';
    };
    const cell = (v: number) => {
      const share = h('span', { class: 'share' });
      shares.set(v, share);
      const c = colour.get(v);
      return h('td', { title: p.classes!.find(k => k.value === v)?.label ?? '', style: `background:${c};color:${ink(c)}` }, share);
    };
    const table = h('table', { class: 'matrix' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), ...m.cols.map(c => h('th', {}, c.label, h('br', {}), h('span', { class: 'muted' }, c.range))))),
      h('tbody', {},
        ...m.rows.map((r, ri) => h('tr', {}, h('th', {}, r.label), ...m.cols.map((_, ci) => cell(m.value(ri, ci))))),
        ...(m.unclassified ? [h('tr', { class: 'muted' }, h('th', {}, 'Unclassified'), ...m.cols.map((_, ci) => cell(m.unclassified!(ci))))] : [])));
    el.append(h('div', { class: 'cmp-wrap' }, table));
    const masked = p.classes.find(c => c.value === 255);
    if (masked) {
      const share = h('span', { class: 'muted share' });
      shares.set(255, share);
      el.append(h('ul', { class: 'legend' }, h('li', {}, h('span', { class: 'swatch', style: `--c:${masked.colour}` }), h('span', { class: 'grow' }, masked.label), share)));
    }
    el.append(h('p', { class: 'muted small' }, 'Each cell: its share (%) of the classified pixels in view, in the colour it is drawn. Rows are cover types, columns height strata.'));
  } else if (p.classes) {
    const list = h('ul', { class: 'legend' });
    for (const c of p.classes) {
      const share = h('span', { class: 'muted share' });
      shares.set(c.value, share);
      list.append(h('li', {}, h('span', { class: 'swatch', style: `--c:${c.colour}` }), h('span', { class: 'grow' }, c.label), share));
    }
    el.append(list);
  }

  if (p.render === 'relief') el.append(reliefControls(host.style, host.apply));

  if (hasCurve(p)) {
    const curve = h('select', { 'aria-label': 'Stretch curve', onchange: (e: Event) => { host.style.curve = (e.target as HTMLSelectElement).value as Curve; host.apply(); } },
      ...(['linear', 'sqrt', 'log'] as const).map(v => h('option', { value: v, selected: host.style.curve === v }, v === 'linear' ? 'Linear' : v === 'sqrt' ? 'Square root' : 'Logarithmic')));
    const gOut = h('output', {}, host.style.gamma.toFixed(2));
    const gamma = h('input', {
      type: 'range', min: '0.2', max: '3', step: '0.05', value: String(host.style.gamma), 'aria-label': 'Gamma',
      oninput: (e: Event) => { host.style.gamma = +(e.target as HTMLInputElement).value; gOut.textContent = host.style.gamma.toFixed(2); },
      onchange: () => host.apply(),
    });
    el.append(h('div', { class: 'row' }, h('label', { class: 'row' }, 'Curve ', curve), h('label', { class: 'row grow' }, 'Gamma ', gamma, gOut)));
  }

  const refresh = async () => {
    last = await host.stats().catch(() => null);
    canvases.forEach((_, c) => drawHist(c));
    if (p.classes) for (const [v, el2] of shares) { const f = last?.classes?.get(v); el2.textContent = f ? (p.matrix ? `${(f * 100).toFixed(f < 0.01 ? 1 : 0)}` : `${(f * 100).toFixed(f < 0.01 ? 1 : 0)} %`) : ''; }
  };
  const seed = async () => {
    await refresh();
    const next = seedRanges(p, host.style.ranges, last?.channels ?? null);
    next.forEach(([a, b], c) => { host.style.ranges[c] = [a, b]; if (inputs[c]) { inputs[c][0].value = fmt(a, p.channels[c].step); inputs[c][1].value = fmt(b, p.channels[c].step); } });
    canvases.forEach((_, c) => drawHist(c));
    rampLegend?.update();
  };
  return { el, refresh, seed };
}

/** Swap a panel's element in a slot. */
export function mount(slot: HTMLElement, panel: StretchPanel | null) {
  clear(slot);
  if (panel) slot.append(panel.el);
}

/** Z-factor and sun azimuth, for anything drawn as relief. */
export function reliefControls(style: { zFactor: number; azimuth: number }, apply: () => void): HTMLElement {
  const zOut = h('output', {}, `× ${style.zFactor}`);
  const aOut = h('output', {}, `${style.azimuth}°`);
  return h('div', { class: 'relief' },
    h('label', { class: 'row' }, 'Z-factor ',
      h('input', {
        type: 'range', min: '0', max: '1', step: '0.01', value: String(Math.log10(style.zFactor) / Math.log10(20)), 'aria-label': 'Z-factor',
        oninput: (e: Event) => { style.zFactor = zFromSlider(+(e.target as HTMLInputElement).value); zOut.textContent = `× ${style.zFactor}`; },
        onchange: () => apply(),
      }), zOut),
    h('label', { class: 'row' }, 'Sun azimuth ',
      h('input', {
        type: 'range', min: '0', max: '360', step: '15', value: String(style.azimuth), 'aria-label': 'Sun azimuth',
        oninput: (e: Event) => { style.azimuth = +(e.target as HTMLInputElement).value; aOut.textContent = `${style.azimuth}°`; },
        onchange: () => apply(),
      }), aOut));
}

/** The Z-factor slider is logarithmic, 1 to 20 (0 → ×1, 1 → ×20), rounded to a value a person would type. */
export function zFromSlider(t: number): number {
  const z = Math.pow(20, Math.min(1, Math.max(0, t)));
  return z < 3 ? Math.round(z * 4) / 4 : z < 10 ? Math.round(z * 2) / 2 : Math.round(z);
}
