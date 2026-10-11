// The Fusion tab: LiDAR structure and Sentinel-2 spectra in one product, per
// pixel, for land-cover reading. Three products: a CHM · NDVI · NDWI
// composite, a custom composite of any three variables, and a rule-based
// land-cover classification with editable thresholds and a class tally.
//
// The two inputs are rarely the same date — the LiDAR may be years older than
// the scene — and are never the same resolution (1 m against 10–20 m), so
// both dates are stated beside the product, and the classification calls
// itself what it is: a screening, not a validated map.

import { h, clear, fmtDate } from '../dom.ts';
import { viewStats } from '../engine.ts';
import { hideLayer, restyle, showLayer } from '../mapLayers.ts';
import {
  DEFAULT_THRESHOLDS, FUSION_PRODUCTS, FUSION_VARIABLES, customFusionProduct, defaultStyle,
  type Product, type ProductStyle, type Thresholds,
} from '../products.ts';
import { resolveInputs } from '../sources.ts';
import { searchS2, type HrdemItem, type S2Item } from '../stac.ts';
import { stretchPanel, type StretchPanel } from '../ui/stretch.ts';
import { findHrdem } from './rasters.ts';
import { ANCHOR, itemName, shared, type Ctx } from './ctx.ts';

const LAYER = 'fusion';

const THRESHOLD_FIELDS: { key: keyof Thresholds; label: string; step: number; unit: string }[] = [
  { key: 'veg', label: 'Vegetated at NDVI ≥', step: 0.05, unit: '' },
  { key: 'tree', label: 'Trees at canopy ≥', step: 0.5, unit: 'm' },
  { key: 'shrub', label: 'Shrub at canopy ≥', step: 0.5, unit: 'm' },
  { key: 'building', label: 'Structure (not green) at ≥', step: 0.5, unit: 'm' },
  { key: 'water', label: 'Water at NDWI >', step: 0.05, unit: '' },
  { key: 'darkNir', label: 'or water at NIR <', step: 0.01, unit: '' },
];

export function initFusion(ctx: Ctx) {
  const { map, say } = ctx;
  const el = document.getElementById('fusion-body')!;
  let sceneId: string | null = null;
  let lidarId: string | null = null;
  let choice = 'fusion-sgw';
  let custom: [string, string, string] = ['chm', 'ndvi', 'swir16'];
  let thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };
  let opacity = 1;
  let product: Product | null = null;
  let style: ProductStyle | null = null;
  let panel: StretchPanel | null = null;
  let shown = false;

  const scene = (): S2Item | null => shared.scenes.find(s => s.id === sceneId) ?? null;
  const lidar = (): HrdemItem | null => shared.hrdem.find(s => s.id === lidarId) ?? null;
  const lidarChoices = () => shared.hrdem.filter(i => i.dsm);

  shared.events.addEventListener('scenes', () => { if (!scene()) sceneId = shared.scenes[0]?.id ?? null; render(); });
  shared.events.addEventListener('hrdem', () => { if (!lidar()) lidarId = lidarChoices()[0]?.id ?? null; render(); });

  /** Pick inputs for the view: the newest LiDAR source with a DSM, and the clearest recent leaf-on scene. */
  async function findInputs() {
    say('Finding LiDAR and imagery for this view…');
    try {
      const vb = ctx.viewBox();
      const [lid, scenes] = await Promise.all([
        findHrdem(vb),
        // Leaf-on (June–September) reads vegetation best; the last three summers.
        (async () => {
          const y = new Date().getFullYear();
          const all = (await Promise.all([y, y - 1, y - 2].map(yy => searchS2({ bbox: vb, from: `${yy}-06-01`, to: `${yy}-09-30`, maxCloud: 10, limit: 50 }).catch(() => [])))).flat();
          return all.sort((a, b) => (a.nodata ?? 0) - (b.nodata ?? 0) || (a.cloud ?? 100) - (b.cloud ?? 100));
        })(),
      ]);
      shared.setHrdem(lid.items);
      shared.setScenes(scenes.sort((a, b) => (b.datetime).localeCompare(a.datetime)));
      const best = [...scenes].sort((a, b) => ((a.nodata ?? 0) > 5 ? 1 : 0) - ((b.nodata ?? 0) > 5 ? 1 : 0) || (a.cloud ?? 100) - (b.cloud ?? 100))[0];
      sceneId = best?.id ?? null;
      lidarId = lidarChoices()[0]?.id ?? null;
      render();
      if (!sceneId || !lidarId) say(`${lidarId ? '' : 'No LiDAR source with a DSM here. '}${sceneId ? '' : 'No clear leaf-on scene here.'}`, 'error');
      else say('Inputs chosen: the newest LiDAR project and the clearest leaf-on scene. Change either below.');
    } catch (e) { say(`Could not find inputs: ${(e as Error).message}`, 'error'); }
  }

  const productFor = (): Product => (choice === 'fusion-custom' ? customFusionProduct(custom) : FUSION_PRODUCTS.find(p => p.id === choice)!);

  async function draw(reseed: boolean) {
    const s = scene(), l = lidar();
    if (!s || !l) { say('Choose a scene and a LiDAR source first.', 'error'); return; }
    const p = productFor();
    const keep = !reseed && style && product?.id === p.id;
    product = p;
    style = keep ? style! : { ...defaultStyle(p), thresholds };
    say(`Fusing ${itemName(l)} with ${fmtDate(s.datetime)}…`);
    try {
      await showLayer(map, LAYER, { product: p, sources: resolveInputs(p.inputs, s, l), style }, ANCHOR.fusion, opacity);
      shown = true;
      const st = style;
      panel = stretchPanel({ product: p, style: st, stats: () => viewStats(LAYER, ctx.viewBox()), apply: () => restyle(map, LAYER, st) });
      render();
      if (!keep && p.render !== 'classes') { await panel.seed(); restyle(map, LAYER, st); } else void panel.refresh();
      say(`${p.label}: LiDAR ${l.datetime ? fmtDate(l.datetime) : 'undated'}, imagery ${fmtDate(s.datetime)}.`);
    } catch (e) { hideLayer(map, LAYER); shown = false; say(`Could not draw the fusion: ${(e as Error).message}`, 'error'); }
  }

  function render() {
    clear(el);
    const scenes = shared.scenes, lids = lidarChoices();
    el.append(h('button', { class: 'btn wide', onclick: () => void findInputs() }, 'Find inputs for this view'));

    const sceneSel = h('select', { 'aria-label': 'Imagery scene', onchange: (e: Event) => { sceneId = (e.target as HTMLSelectElement).value; if (shown) void draw(false); } },
      ...(scenes.length ? scenes.map(s => h('option', { value: s.id, selected: s.id === sceneId }, `${fmtDate(s.datetime)} · ${s.cloud?.toFixed(1) ?? '?'}% cloud · ${s.mgrs ?? ''}`)) : [h('option', { value: '' }, 'Search in Imagery, or Find inputs')]));
    const lidSel = h('select', { 'aria-label': 'LiDAR source', onchange: (e: Event) => { lidarId = (e.target as HTMLSelectElement).value; if (shown) void draw(false); } },
      ...(lids.length ? lids.map(i => h('option', { value: i.id, selected: i.id === lidarId }, `${itemName(i)}${i.datetime ? ` · ${fmtDate(i.datetime)}` : ''}`)) : [h('option', { value: '' }, 'Search in Rasters, or Find inputs')]));
    const groups = new Map<string, Product[]>();
    for (const p of FUSION_PRODUCTS) (groups.get(p.group) ?? groups.set(p.group, []).get(p.group)!).push(p);
    const prodSel = h('select', { 'aria-label': 'Fusion product', onchange: (e: Event) => { choice = (e.target as HTMLSelectElement).value; if (shown) void draw(true); else render(); } },
      ...[...groups].map(([g, ps]) => h('optgroup', { label: g }, ...ps.map(p => h('option', { value: p.id, selected: p.id === choice }, p.label)),
        ...(g === 'Fusion composites' ? [h('option', { value: 'fusion-custom', selected: choice === 'fusion-custom' }, 'Custom fusion RGB…')] : []))));

    el.append(h('div', { class: 'form1' },
      h('label', { class: 'field' }, 'LiDAR (structure)', lidSel),
      h('label', { class: 'field' }, 'Imagery (spectra)', sceneSel),
      h('label', { class: 'field' }, 'Product', prodSel)));

    if (choice === 'fusion-custom') {
      const groupsV = new Map<string, typeof FUSION_VARIABLES>();
      for (const v of FUSION_VARIABLES) (groupsV.get(v.group) ?? groupsV.set(v.group, []).get(v.group)!).push(v);
      el.append(h('div', { class: 'rgbpick' }, ...(['Red', 'Green', 'Blue'] as const).map((c, i) => h('label', { class: 'field' }, c,
        h('select', { onchange: (e: Event) => { custom = [...custom] as [string, string, string]; custom[i] = (e.target as HTMLSelectElement).value; if (shown) void draw(true); } },
          ...[...groupsV].map(([g, vs]) => h('optgroup', { label: g }, ...vs.map(v => h('option', { value: v.id, selected: custom[i] === v.id }, v.label)))))))));
    }

    const p = productFor();
    el.append(h('p', { class: 'muted small' }, p.note));
    el.append(h('button', { class: 'btn wide', onclick: () => void draw(true) }, shown ? 'Update' : 'Show on map'));

    if (shown && product && panel) {
      const s = scene(), l = lidar();
      if (s && l) el.append(h('p', { class: 'note small' }, `LiDAR ${l.datetime ? fmtDate(l.datetime) : '(undated)'} · imagery ${fmtDate(s.datetime)}. Anything built, cleared or grown between the two dates will read wrongly, and the imagery is 10–20 m against the LiDAR's 1 m.`));
      if (product.render === 'classes') {
        el.append(h('details', { class: 'panel', open: true }, h('summary', {}, 'Thresholds'),
          ...THRESHOLD_FIELDS.map(f => h('label', { class: 'row spread' }, f.label,
            h('span', { class: 'row' }, h('input', {
              type: 'number', step: String(f.step), value: String(thresholds[f.key]),
              onchange: (e: Event) => { const v = +(e.target as HTMLInputElement).value; if (!Number.isFinite(v)) return; thresholds = { ...thresholds, [f.key]: v }; style!.thresholds = thresholds; restyle(map, LAYER, style!); void panel?.refresh(); },
            }), f.unit ? h('span', { class: 'muted' }, f.unit) : null))),
          h('button', { class: 'btn ghost small-btn', onclick: () => { thresholds = { ...DEFAULT_THRESHOLDS }; style!.thresholds = thresholds; restyle(map, LAYER, style!); render(); void panel?.refresh(); } }, 'Reset thresholds')));
        el.append(h('details', { class: 'panel', open: true }, h('summary', {}, 'Classes (share of this view)'), panel.el,
          h('button', { class: 'btn ghost small-btn', onclick: () => void panel?.refresh() }, 'Recount this view')));
      } else {
        el.append(h('details', { class: 'panel', open: true }, h('summary', {}, 'Stretch'), panel.el));
      }
      el.append(h('label', { class: 'row' }, 'Opacity', h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(opacity), oninput: (e: Event) => { opacity = +(e.target as HTMLInputElement).value; if (map.getLayer(LAYER)) map.setPaintProperty(LAYER, 'raster-opacity', opacity); } })),
        h('button', { class: 'btn ghost small-btn', onclick: () => { hideLayer(map, LAYER); shown = false; panel = null; render(); } }, 'Remove from map'));
    }
  }

  render();
  map.on('moveend', () => { if (shown) void panel?.refresh(); });
}
