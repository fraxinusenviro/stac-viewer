// The basemap picker: two web basemaps, and a HILLSHADE of the NRCan HRDEM
// national mosaic (DTM — bare earth — or DSM — surface), with an adjustable
// Z-factor and sun azimuth.
//
// The national mosaic is ~56 regional COGs per resolution, so the hillshade
// basemap is not one layer: on every settled move it asks the STAC which
// mosaic tiles meet the view and keeps exactly those drawn (1 m where it
// exists, 2 m elsewhere). The light basemap stays underneath, so ground
// outside HRDEM coverage is still a map.

import { h, clear } from '../dom.ts';
import { hideLayer, restyle, showLayer } from '../mapLayers.ts';
import { defaultStyle, rasterProduct, type ProductStyle } from '../products.ts';
import { resolveInputs } from '../sources.ts';
import { searchHrdemMosaic, type HrdemItem } from '../stac.ts';
import { reliefControls } from '../ui/stretch.ts';
import type { Ctx } from './ctx.ts';

/** Below this zoom a regional mosaic is drawn from overviews too coarse to be worth the reads. */
const MIN_ZOOM = 8;
const MAX_TILES = 4;
export const BASE_ANCHOR = 'anchor-base';

export function initBasemap(ctx: Ctx, webBasemaps: string[]) {
  const { map, say } = ctx;
  const select = document.getElementById('basemap') as HTMLSelectElement;
  const controls = document.getElementById('basemap-controls')!;
  select.append(
    h('option', { value: 'dtm-hillshade' }, 'Hillshade — DTM (bare earth)'),
    h('option', { value: 'dsm-hillshade' }, 'Hillshade — DSM (surface)'));

  const style: ProductStyle = { ...defaultStyle(rasterProduct('dtm-hillshade')!), zFactor: 2 };
  const drawn = new Map<string, HrdemItem>();
  let mode = 'light';
  let timer = 0, seq = 0;

  const layerId = (it: HrdemItem) => `base-hs:${it.id}`;
  const clearHillshade = () => { for (const it of drawn.values()) hideLayer(map, layerId(it)); drawn.clear(); };

  async function sync() {
    if (!mode.endsWith('hillshade')) return;
    const my = ++seq;
    if (map.getZoom() < MIN_ZOOM) { clearHillshade(); renderControls(`Zoom in past level ${MIN_ZOOM} for the hillshade.`); return; }
    try {
      const items = (await searchHrdemMosaic(ctx.viewBox())).slice(0, MAX_TILES);
      if (my !== seq) return;
      const product = rasterProduct(mode)!;
      const want = new Set(items.map(layerId));
      for (const [id, it] of drawn) if (!want.has(id)) { hideLayer(map, layerId(it)); drawn.delete(id); }
      for (const it of items) {
        const id = layerId(it);
        if (drawn.has(id)) continue;
        if (mode === 'dsm-hillshade' && !it.dsm) continue;
        drawn.set(id, it);
        await showLayer(map, id, { product, sources: resolveInputs(product.inputs, { lidar: it }), style }, BASE_ANCHOR, 1, 18);
      }
      renderControls(items.length ? `NRCan HRDEM ${items[0].kind.replace('mosaic-', '')} national mosaic, CGVD2013.` : 'No HRDEM coverage in this view.');
    } catch (e) { say(`Hillshade basemap: ${(e as Error).message}`, 'error'); }
  }

  function renderControls(note = '') {
    clear(controls);
    if (!mode.endsWith('hillshade')) return;
    controls.append(reliefControls(style, () => { for (const it of drawn.values()) restyle(map, layerId(it), style); }));
    if (note) controls.append(h('p', { class: 'muted small' }, note));
  }

  select.addEventListener('change', () => {
    const prev = mode;
    mode = select.value;
    for (const k of webBasemaps) map.setLayoutProperty(`bm-${k}`, 'visibility', k === mode || (mode.endsWith('hillshade') && k === 'light') ? 'visible' : 'none');
    if (prev !== mode && prev.endsWith('hillshade')) clearHillshade();
    renderControls();
    void sync();
  });
  map.on('moveend', () => { clearTimeout(timer); timer = window.setTimeout(() => void sync(), 400); });
}
