// The Fusion tab's "Segment this view" panel: segments the view into objects,
// classifies them with the class product the tab has selected (rules or
// strata), draws them over the map, tells you about the object you tap, and
// exports them as GeoJSON with every attribute.

import maplibregl, { type ImageSource, type MapMouseEvent } from 'maplibre-gl';
import { h } from '../dom.ts';
import { defaultStyle, type Product } from '../products.ts';
import type { InputSource } from '../engine.ts';
import { DEFAULT_SEGMENT, classShares, objectAttributes, pixelAt, segmentGeoJSON, segmentImage, segmentView, type SegmentParams, type SegmentResult } from '../segment/segmentView.ts';
import type { Ctx } from './ctx.ts';

const SRC = 'segments';
const LS = 'sv.segment';

export interface SegmentHost {
  ctx: Ctx;
  panel: (key: string, title: string, open: boolean) => HTMLDetailsElement;
  /** The class product to classify objects with (rules or strata), or null. */
  classProduct: () => Product | null;
  /** Sources for these inputs plus every input the inputs in hand can supply. */
  sources: (inputs: string[]) => Record<string, InputSource>;
  isSampling: () => boolean;
  beforeId: string;
}

export function segmentPanel(host: SegmentHost) {
  const { map, say } = host.ctx;
  let params: SegmentParams = (() => { try { return { ...DEFAULT_SEGMENT, ...JSON.parse(localStorage.getItem(LS) ?? '{}') }; } catch { return { ...DEFAULT_SEGMENT }; } })();
  let result: SegmentResult | null = null;
  let fill = true, opacity = 0.75, busy = false;
  let rerender: () => void = () => {};
  const saveParams = () => { try { localStorage.setItem(LS, JSON.stringify(params)); } catch { /* private mode */ } };

  function draw() {
    if (!result) return;
    const img = segmentImage(result, fill);
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
    const url = c.toDataURL('image/png');
    const [W, S, E, N] = result.grid.box;
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [[W, N], [E, N], [E, S], [W, S]];
    const src = map.getSource(SRC) as ImageSource | undefined;
    if (src) src.updateImage({ url, coordinates });
    else {
      map.addSource(SRC, { type: 'image', url, coordinates });
      map.addLayer({ id: SRC, type: 'raster', source: SRC, paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, host.beforeId);
    }
  }

  function remove() {
    if (map.getLayer(SRC)) map.removeLayer(SRC);
    if (map.getSource(SRC)) map.removeSource(SRC);
    result = null;
  }

  async function run() {
    if (busy) return;
    busy = true; rerender();
    try {
      const product = host.classProduct();
      const style = product ? defaultStyle(product) : null;
      const sources = host.sources(product?.inputs ?? []);
      const t0 = performance.now();
      result = await segmentView(host.ctx.viewBox(), sources, product, style, params, msg => say(msg));
      draw();
      say(`${result.count.toLocaleString()} objects from ${result.features.join(', ')} in ${((performance.now() - t0) / 1000).toFixed(1)} s${product ? `, classified by "${product.label}"` : ' (no class product: choose rules or strata to classify them)'}.`);
    } catch (e) { say(`Could not segment: ${(e as Error).message}`, 'error'); }
    busy = false; rerender();
  }

  map.on('click', (e: MapMouseEvent) => {
    if (!result || host.isSampling() || !map.getLayer(SRC) || document.getElementById('pane-fusion')!.hidden) return;
    const i = pixelAt(result.grid, e.lngLat.lng, e.lngLat.lat);
    const k = i >= 0 ? result.labels[i] : -1;
    if (k < 0) return;
    const style = result.product ? defaultStyle(result.product) : defaultStyle({ channels: [] } as unknown as Product);
    const cls = result.classes ? result.product?.classes?.find(c => c.value === result!.classes![k]) : undefined;
    const want = ['obj_area', 'chm', 'obj_chm_p90', 'obj_chm_sd', 'ndvi', 'o_exg', 'obj_tex', 'pc_ivg', 'pc_pen', 'pc_att', 'obj_compact', 'ci6', 'ci'];
    const attrs = objectAttributes(result, style).filter(a => want.includes(a.id)).sort((a, b) => want.indexOf(a.id) - want.indexOf(b.id));
    const fmt = (v: number) => (!Number.isFinite(v) ? '—' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3));
    new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(e.lngLat).setDOMContent(h('div', { class: 'popup' },
      h('strong', {}, cls ? cls.label : 'Unclassified object'),
      h('table', {}, ...attrs.map(a => h('tr', {}, h('th', {}, a.label), h('td', {}, fmt(a.values[k]))))))).addTo(map);
  });

  /** The panel's element (re-rendered by the Fusion tab with everything else). */
  function el(onChange: () => void): HTMLElement {
    rerender = onChange;
    const wrap = host.panel('segment', 'Segment this view (objects)', !!result);
    wrap.append(h('p', { class: 'muted small' }, 'Splits the view into objects on canopy height and the orthophoto (superpixels, then neighbours merged), averages every input over each object, adds object measures (area, compactness, canopy height P90 and spread, photo texture) and classifies each object with the rules or strata above. Objects replace speckle, and a 10 m Sentinel value is averaged over an object rather than claimed for a 2 m cell. From zoom ~15.'));
    const slider = (label: string, key: 'sizeM' | 'merge' | 'compactness' | 'minTreeM', min: number, max: number, step: number, show: (v: number) => string) => {
      const out = h('output', {}, show(params[key]));
      return h('label', { class: 'row' }, `${label} `, h('input', {
        type: 'range', min: String(min), max: String(max), step: String(step), value: String(params[key]), class: 'grow', 'aria-label': label,
        oninput: (e: Event) => { params = { ...params, [key]: +(e.target as HTMLInputElement).value }; out.textContent = show(params[key]); },
        onchange: () => saveParams(),
      }), out);
    };
    const pick = (label: string, key: 'method' | 'heightStat', opts: [string, string][]) => h('label', { class: 'row' }, `${label} `,
      h('select', { class: 'grow', 'aria-label': label, onchange: (e: Event) => { params = { ...params, [key]: (e.target as HTMLSelectElement).value }; saveParams(); onChange(); } },
        ...opts.map(([v, t]) => h('option', { value: v, selected: params[key] === v }, t))));
    wrap.append(
      pick('Objects', 'method', [['patches', 'Patches (superpixels merged)'], ['crowns', 'Tree crowns (canopy height model, zoom 17)']]),
      pick('Object height', 'heightStat', [['mean', 'Mean canopy height'], ['p90', '90th percentile (the canopy, not its gaps)']]));
    if (params.method === 'crowns') wrap.append(slider('Minimum tree height', 'minTreeM', 2, 10, 0.5, v => `${v} m`));
    else wrap.append(
      slider('Superpixel size', 'sizeM', 4, 40, 1, v => `${v} m`),
      slider('Merge', 'merge', 0, 3, 0.1, v => (v ? v.toFixed(1) : 'off')),
      slider('Compactness', 'compactness', 0.2, 2, 0.1, v => v.toFixed(1)));
    wrap.append(h('div', { class: 'row' },
      h('button', { class: 'btn small-btn', disabled: busy, onclick: () => void run() }, busy ? 'Segmenting…' : result ? 'Segment again' : 'Segment this view'),
      result ? h('button', { class: 'btn ghost small-btn', onclick: () => { remove(); onChange(); } }, 'Remove') : null));
    if (result) {
      const r = result;
      wrap.append(h('div', { class: 'row' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: fill, onchange: (e: Event) => { fill = (e.target as HTMLInputElement).checked; draw(); } }), 'Fill by class'),
        h('label', { class: 'row grow' }, 'Opacity ', h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(opacity), class: 'grow', oninput: (e: Event) => { opacity = +(e.target as HTMLInputElement).value; if (map.getLayer(SRC)) map.setPaintProperty(SRC, 'raster-opacity', opacity); } }))));
      const shares = classShares(r);
      if (r.product?.classes && shares.size) {
        const list = h('ul', { class: 'legend' });
        for (const c of r.product.classes) {
          const f = shares.get(c.value);
          if (!f) continue;
          list.append(h('li', {}, h('span', { class: 'swatch', style: `--c:${c.colour}` }), h('span', { class: 'grow' }, c.label), h('span', { class: 'muted share' }, `${(f * 100).toFixed(f < 0.01 ? 1 : 0)} %`)));
        }
        wrap.append(h('p', { class: 'small' }, `${r.count.toLocaleString()} objects · ${r.grid.cellM.toFixed(1)} m pixels · share of classified area:`), list);
      }
      wrap.append(h('div', { class: 'row' }, h('button', { class: 'chip', onclick: () => {
        say('Tracing object outlines…');
        setTimeout(() => {
          const fc = segmentGeoJSON(r, r.product ? defaultStyle(r.product) : defaultStyle({ channels: [] } as unknown as Product));
          const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' })), download: 'segments.geojson' });
          a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          say(`Exported ${fc.features.length.toLocaleString()} objects with ${Object.keys(fc.features[0]?.properties ?? {}).length} attributes each.`);
        }, 0);
      } }, 'Download GeoJSON (objects + attributes)')));
      wrap.append(h('p', { class: 'muted small' }, 'Tap an object for its values. The objects were classified when segmented: after editing rules, press "Segment again".'));
    }
    return wrap;
  }

  return { el, remove };
}
