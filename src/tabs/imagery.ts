// The Imagery tab: Sentinel-2 L2A scenes from Earth Search, drawn as any band
// combination, index, scene classification, single band or custom RGB, with
// the stretch controls of taylor-geospatial's explorer (histogram, 2–98 % /
// Min/Max, curve, gamma, nodata).

import type { GeoJSONSource } from 'maplibre-gl';
import { h, clear, fmtDate } from '../dom.ts';
import { viewStats } from '../engine.ts';
import { hideLayer, restyle, showLayer } from '../mapLayers.ts';
import {
  IMAGERY_PRODUCTS, S2_BANDS, bandTitle, customRgbProduct, defaultStyle, imageryProduct, singleBandProduct,
  type Product, type ProductStyle,
} from '../products.ts';
import { resolveInputs } from '../sources.ts';
import { searchS2, type S2Item } from '../stac.ts';
import { stretchPanel, type StretchPanel } from '../ui/stretch.ts';
import { ANCHOR, shared, type Ctx } from './ctx.ts';

const LAYER = 's2-scene';

export function initImagery(ctx: Ctx) {
  const { map, say } = ctx;
  const listEl = document.getElementById('img-list')!;
  const controlsEl = document.getElementById('img-controls')!;
  const fromIn = document.getElementById('img-from') as HTMLInputElement;
  const toIn = document.getElementById('img-to') as HTMLInputElement;
  const cloudIn = document.getElementById('img-cloud') as HTMLInputElement;
  const cloudOut = document.getElementById('img-cloud-out')!;
  const today = new Date();
  toIn.value = today.toISOString().slice(0, 10);
  fromIn.value = new Date(today.getTime() - 90 * 864e5).toISOString().slice(0, 10);
  cloudIn.addEventListener('input', () => { cloudOut.textContent = `${cloudIn.value}%`; });

  // What is shown, and how. The choice of product survives a change of scene.
  let scene: S2Item | null = null;
  let choice = 'tci';
  let single = 'nir';
  let custom: [string, string, string] = ['swir16', 'nir', 'red'];
  let nodataAuto = true;
  let opacity = 1;
  let product: Product | null = null;
  let style: ProductStyle | null = null;
  let panel: StretchPanel | null = null;

  const productFor = (): Product =>
    choice === 'single' ? singleBandProduct(single) : choice === 'custom' ? customRgbProduct(custom) : imageryProduct(choice)!;

  document.getElementById('img-search')!.addEventListener('click', async () => {
    say('Searching Earth Search for Sentinel-2…');
    try {
      const items = await searchS2({ bbox: ctx.viewBox(), from: fromIn.value, to: toIn.value, maxCloud: +cloudIn.value });
      shared.setScenes(items);
      (map.getSource('s2-footprints') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: items.filter(i => i.geometry).map((i, n) => ({ type: 'Feature', id: n, properties: { id: i.id }, geometry: i.geometry! })),
      });
      say(`${items.length} Sentinel-2 scene${items.length === 1 ? '' : 's'} at ≤ ${cloudIn.value}% cloud.`);
    } catch (e) { say(`Imagery search failed: ${(e as Error).message}`, 'error'); }
  });

  function renderList() {
    clear(listEl);
    const items = shared.scenes;
    if (!items.length) { listEl.append(h('p', { class: 'muted' }, 'No scenes match. Widen the dates or the cloud limit.')); return; }
    items.forEach((it, n) => {
      const card = h('button', { class: `card scene${scene?.id === it.id ? ' on' : ''}`, onclick: () => void select(it) },
        it.thumbnail ? h('img', { src: it.thumbnail, alt: '', loading: 'lazy' }) : h('span', { class: 'thumb-missing' }),
        h('span', { class: 'card-body' },
          h('strong', {}, fmtDate(it.datetime)),
          h('span', { class: 'muted' }, `${it.cloud !== null ? `${it.cloud.toFixed(1)}% cloud` : 'cloud n/a'}${it.nodata ? ` · ${it.nodata.toFixed(0)}% empty` : ''}`),
          h('span', { class: 'muted small' }, `${it.mgrs ?? ''} · ${it.id.split('_')[0]}${it.baseline ? ` · baseline ${it.baseline}` : ''}`)));
      card.addEventListener('mouseenter', () => map.setFeatureState({ source: 's2-footprints', id: n }, { hover: true }));
      card.addEventListener('mouseleave', () => map.setFeatureState({ source: 's2-footprints', id: n }, { hover: false }));
      listEl.append(card);
    });
  }

  async function select(it: S2Item) {
    if (scene?.id === it.id) { scene = null; hideLayer(map, LAYER); renderControls(); renderList(); say('Scene hidden.'); return; }
    scene = it;
    renderList();
    await draw(true);
  }

  /** (Re)build the layer for the current scene and product; `reseed` re-fits the stretch to the view. */
  async function draw(reseed: boolean) {
    if (!scene) return;
    const p = productFor();
    const keepStyle = !reseed && style && product?.id === p.id;
    product = p;
    style = keepStyle ? style! : defaultStyle(p);
    say(`Opening ${fmtDate(scene.datetime)} · ${p.label}…`);
    try {
      await showLayer(map, LAYER, { product: p, sources: resolveInputs(p.inputs, scene, null, { nodataAuto }), style }, ANCHOR.imagery, opacity, 16);
      const st = style;
      panel = p.identity ? null : stretchPanel({ product: p, style: st, stats: () => viewStats(LAYER, ctx.viewBox()), apply: () => restyle(map, LAYER, st) });
      renderControls();
      if (panel && !keepStyle) { await panel.seed(); restyle(map, LAYER, st); } else void panel?.refresh();
      say(`${fmtDate(scene.datetime)} · ${p.label}. Tap the scene again to hide it.`);
    } catch (e) { hideLayer(map, LAYER); say(`Could not draw the scene: ${(e as Error).message}`, 'error'); }
  }

  function renderControls() {
    clear(controlsEl);
    if (!scene || !product) return;
    const groups = new Map<string, Product[]>();
    for (const p of IMAGERY_PRODUCTS) (groups.get(p.group) ?? groups.set(p.group, []).get(p.group)!).push(p);
    const show = h('select', { 'aria-label': 'Show', onchange: (e: Event) => { choice = (e.target as HTMLSelectElement).value; void draw(true); } },
      ...[...groups].map(([g, ps]) => h('optgroup', { label: g }, ...ps.map(p => h('option', { value: p.id, selected: choice === p.id }, p.label)))),
      h('optgroup', { label: 'Other' },
        h('option', { value: 'single', selected: choice === 'single' }, 'Single band…'),
        h('option', { value: 'custom', selected: choice === 'custom' }, 'Custom RGB…')));
    const bandSelect = (value: string, label: string, onPick: (v: string) => void) => h('select', { 'aria-label': label, onchange: (e: Event) => { onPick((e.target as HTMLSelectElement).value); void draw(true); } },
      ...S2_BANDS.map(b => h('option', { value: b.asset, selected: b.asset === value }, bandTitle(b.asset))));
    const offsetNote = (() => {
      const a = scene.assets.red;
      if (!a) return '';
      if (a.from === 'stac') return `Reflectance = DN × ${a.scale} ${a.offset < 0 ? '−' : '+'} ${Math.abs(a.offset)} (the scene's own STAC scale and offset).`;
      if (a.from === 'baseline') return `Baseline ${scene.baseline}: reflectance = DN × 0.0001${a.offset ? ' − 0.1 (BOA offset)' : ''}.`;
      return 'No processing baseline on this scene: the ≥ 04.00 BOA offset is not applied.';
    })();
    controlsEl.append(h('details', { class: 'panel', open: true },
      h('summary', {}, 'Bands & stretch'),
      h('label', { class: 'field' }, 'Show', show),
      choice === 'single' ? h('label', { class: 'field' }, 'Band', bandSelect(single, 'Band', v => { single = v; })) : null,
      choice === 'custom' ? h('div', { class: 'rgbpick' }, ...(['Red', 'Green', 'Blue'] as const).map((c, i) => h('label', { class: 'field' }, c, bandSelect(custom[i], c, v => { custom = [...custom] as [string, string, string]; custom[i] = v; })))) : null,
      h('p', { class: 'muted small' }, product.note, product.identity ? '' : ` ${offsetNote}`),
      panel ? panel.el : null,
      h('label', { class: 'field' }, 'Nodata',
        h('select', { onchange: (e: Event) => { nodataAuto = (e.target as HTMLSelectElement).value === 'auto'; void draw(false); } },
          h('option', { value: 'auto', selected: nodataAuto }, 'Auto (0 in any band is transparent)'),
          h('option', { value: 'none', selected: !nodataAuto }, 'None (draw every pixel)'))),
      h('label', { class: 'row' }, 'Opacity', h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(opacity), oninput: (e: Event) => { opacity = +(e.target as HTMLInputElement).value; if (map.getLayer(LAYER)) map.setPaintProperty(LAYER, 'raster-opacity', opacity); } }))));
  }

  shared.events.addEventListener('scenes', renderList);
  map.on('moveend', () => { void panel?.refresh(); });
}
