// The Rasters tab: LiDAR-derived HRDEM rasters. Each source offers the DTM
// and DSM products (hillshade, elevation, shaded elevation) and the canopy
// height model (DSM − DTM); every product added is its own map layer, with
// its own stretch, under "On the map".

import type { GeoJSONSource } from 'maplibre-gl';
import { h, clear, fmtDate } from '../dom.ts';
import { viewStats } from '../engine.ts';
import { hideLayer, restyle, showLayer } from '../mapLayers.ts';
import { defaultStyle, hasStretch, rasterProduct, rasterProductsFor, type Product, type ProductStyle } from '../products.ts';
import { resolveInputs } from '../sources.ts';
import { coverageTouches, fetchExtent, searchHrdem, type HrdemItem } from '../stac.ts';
import { stretchPanel, type StretchPanel } from '../ui/stretch.ts';
import type { LonLatBox } from '../warp.ts';
import { ANCHOR, itemName, shared, type Ctx } from './ctx.ts';

interface RasterLayer { id: string; item: HrdemItem; product: Product; style: ProductStyle; opacity: number; panel: StretchPanel | null }

/**
 * HRDEM items whose TRUE coverage meets the box. A project's STAC geometry is
 * its envelope (a coastal survey's envelope covers a lot of ground it never
 * flew); its `extent` asset is the real footprint.
 */
export async function findHrdem(vb: LonLatBox, onProgress?: (msg: string) => void) {
  const found = await searchHrdem(vb);
  onProgress?.(`Checking the coverage of ${found.filter(i => i.kind === 'project').length} LiDAR projects…`);
  const extents = await Promise.all(found.map(async (i) => (i.kind === 'project' && i.extent ? fetchExtent(i.extent).catch(() => null) : null)));
  const items: HrdemItem[] = [], elsewhere: HrdemItem[] = [], footprints: GeoJSON.Feature[] = [];
  found.forEach((it, n) => {
    const g = extents[n];
    if (it.kind === 'project' && g && !coverageTouches(g, vb)) { elsewhere.push(it); return; }
    items.push(it);
    if (g) footprints.push({ type: 'Feature', id: items.length - 1, properties: { id: it.id }, geometry: g });
  });
  return { items, elsewhere, footprints };
}

export function initRasters(ctx: Ctx) {
  const { map, say } = ctx;
  const listEl = document.getElementById('raster-list')!;
  const layersEl = document.getElementById('raster-layers')!;
  let elsewhere: HrdemItem[] = [];
  const layers: RasterLayer[] = [];

  document.getElementById('raster-search')!.addEventListener('click', async () => {
    say('Searching the NRCan STAC…');
    try {
      const r = await findHrdem(ctx.viewBox(), say);
      elsewhere = r.elsewhere;
      (map.getSource('hrdem-footprints') as GeoJSONSource).setData({ type: 'FeatureCollection', features: r.footprints });
      shared.setHrdem(r.items);
      say(`${r.items.length} raster source${r.items.length === 1 ? '' : 's'} cover this view.`);
    } catch (e) { say(`Raster search failed: ${(e as Error).message}`, 'error'); }
  });

  function renderList() {
    clear(listEl);
    const items = shared.hrdem;
    if (!items.length) { listEl.append(h('p', { class: 'muted' }, 'No HRDEM rasters here.')); return; }
    items.forEach((it, n) => {
      const pick = h('select', { 'aria-label': `Product from ${itemName(it)}` },
        ...rasterProductsFor(it).map(p => h('option', { value: p.id, title: p.note }, p.label)));
      const card = h('div', { class: 'card static' },
        h('span', { class: 'card-body' },
          h('strong', {}, itemName(it)),
          h('span', { class: 'muted' }, `${it.kind === 'project' ? 'LiDAR project' : 'Mosaic'}${it.datetime ? ` · ${fmtDate(it.datetime)}` : ''} · ${it.kind === 'mosaic-2m' ? '2' : '1'} m · CGVD2013${it.dsm ? '' : ' · DTM only'}`),
          h('span', { class: 'row' }, pick, h('button', { class: 'btn', onclick: () => void add(it, rasterProduct(pick.value)!) }, 'Add'))));
      if (it.kind === 'project') {
        card.addEventListener('mouseenter', () => map.setFeatureState({ source: 'hrdem-footprints', id: n }, { hover: true }));
        card.addEventListener('mouseleave', () => map.setFeatureState({ source: 'hrdem-footprints', id: n }, { hover: false }));
      }
      listEl.append(card);
    });
    if (elsewhere.length) {
      listEl.append(h('details', { class: 'muted small' },
        h('summary', {}, `Elsewhere nearby (${elsewhere.length})`),
        h('p', {}, 'Their bounding boxes reach this view but their surveys do not: ' + elsewhere.map(i => i.id).join(', ') + '.')));
    }
  }

  function renderLayers() {
    clear(layersEl);
    if (!layers.length) return;
    layersEl.append(h('h2', {}, 'On the map'));
    for (const L of [...layers].reverse()) {
      layersEl.append(h('div', { class: 'card static on-map' },
        h('span', { class: 'card-body' },
          h('span', { class: 'row spread' }, h('strong', { title: L.product.note }, L.product.label), h('button', { class: 'btn ghost small-btn', onclick: () => remove(L) }, 'Remove')),
          h('span', { class: 'muted' }, itemName(L.item)),
          L.panel ? h('details', { open: true }, h('summary', {}, 'Stretch'), L.panel.el, h('button', { class: 'btn ghost small-btn', onclick: () => void L.panel!.seed().then(() => restyle(map, L.id, L.style)) }, 'Fit to view')) : null,
          h('label', { class: 'row' }, 'Opacity', h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(L.opacity), oninput: (e: Event) => { L.opacity = +(e.target as HTMLInputElement).value; map.setPaintProperty(L.id, 'raster-opacity', L.opacity); } })))));
    }
  }

  async function add(it: HrdemItem, p: Product) {
    const id = `hrdem:${it.id}:${p.id}`;
    if (layers.some(L => L.id === id)) { say(`${p.label} from ${itemName(it)} is already on the map.`); return; }
    say(`Opening ${itemName(it)}…`);
    try {
      const style = defaultStyle(p);
      await showLayer(map, id, { product: p, sources: resolveInputs(p.inputs, { lidar: it }), style }, ANCHOR.rasters);
      const L: RasterLayer = { id, item: it, product: p, style, opacity: 1, panel: null };
      if (hasStretch(p) || p.render === 'relief') {
        L.panel = stretchPanel({ product: p, style, stats: () => viewStats(id, ctx.viewBox()), apply: () => restyle(map, id, style) });
        await L.panel.seed();
        restyle(map, id, style);
      }
      layers.push(L);
      say(`${p.label} from ${itemName(it)}.`);
      renderLayers();
      L.panel?.refresh();
    } catch (e) { hideLayer(map, id); say(`Could not open ${itemName(it)}: ${(e as Error).message}`, 'error'); }
  }

  function remove(L: RasterLayer) {
    hideLayer(map, L.id);
    layers.splice(layers.indexOf(L), 1);
    renderLayers();
  }

  shared.events.addEventListener('hrdem', renderList);
  map.on('moveend', () => { for (const L of layers) void L.panel?.refresh(); });
}
