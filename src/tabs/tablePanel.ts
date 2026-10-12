// The Fusion tab's "Feature table" panel: builds the multi-source table for
// the view on Sentinel-2's grid (segment/featureTable.ts), previews any column
// on the map, and downloads GeoParquet or CSV.

import maplibregl, { type ImageSource, type MapMouseEvent } from 'maplibre-gl';
import { h } from '../dom.ts';
import { defaultStyle, type Product } from '../products.ts';
import type { InputSource } from '../engine.ts';
import { rampTable } from '../paint.ts';
import { buildFeatureTable, type FeatureTable } from '../segment/featureTable.ts';
import { tableCsv, tableGeoParquet } from '../segment/featureTableExport.ts';
import { pixelAt } from '../segment/segmentView.ts';
import type { Ctx } from './ctx.ts';

const SRC = 'feature-table';
const VIRIDIS = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];

export interface TableHost {
  ctx: Ctx;
  panel: (key: string, title: string, open: boolean) => HTMLDetailsElement;
  classProduct: () => Product | null;
  sources: (inputs: string[]) => Record<string, InputSource>;
  isSampling: () => boolean;
  beforeId: string;
}

export function tablePanel(host: TableHost) {
  const { map, say } = host.ctx;
  let table: FeatureTable | null = null;
  let cellM: 10 | 20 = 10, busy = false, column = 'chm', opacity = 0.8;
  let rerender: () => void = () => {};

  const allColumns = () => (table ? [...table.columns, ...table.shares] : []);

  function draw() {
    const col = allColumns().find(c => c.name === column) ?? allColumns()[0];
    if (!table || !col) return;
    column = col.name;
    const v = [...col.values].filter(Number.isFinite).sort((a, b) => a - b);
    const lo = v[Math.floor(0.02 * (v.length - 1))] ?? 0, hi = v[Math.ceil(0.98 * (v.length - 1))] ?? 1;
    const lut = rampTable(VIRIDIS);
    const { w, h: hh } = table.grid;
    const img = new ImageData(w, hh);
    for (let i = 0; i < w * hh; i++) {
      const r = table.rowOf[i];
      if (r < 0) continue;
      const x = col.values[r];
      if (x !== x) continue;
      const t = Math.max(0, Math.min(255, Math.round(((x - lo) / (hi - lo || 1)) * 255)));
      img.data[4 * i] = lut[3 * t]; img.data[4 * i + 1] = lut[3 * t + 1]; img.data[4 * i + 2] = lut[3 * t + 2]; img.data[4 * i + 3] = 255;
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = hh;
    c.getContext('2d')!.putImageData(img, 0, 0);
    const [W, S, E, N] = table.grid.box;
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [[W, N], [E, N], [E, S], [W, S]];
    const url = c.toDataURL('image/png');
    const src = map.getSource(SRC) as ImageSource | undefined;
    if (src) src.updateImage({ url, coordinates });
    else {
      map.addSource(SRC, { type: 'image', url, coordinates });
      map.addLayer({ id: SRC, type: 'raster', source: SRC, paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, host.beforeId);
    }
    rangeText = `${col.label}: ${fmt(lo)} → ${fmt(hi)} (2nd–98th percentile)`;
  }
  let rangeText = '';
  const fmt = (x: number) => (!Number.isFinite(x) ? '—' : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3));

  function remove() {
    if (map.getLayer(SRC)) map.removeLayer(SRC);
    if (map.getSource(SRC)) map.removeSource(SRC);
    table = null;
  }

  async function build() {
    if (busy) return;
    busy = true; rerender();
    try {
      const product = host.classProduct();
      const t0 = performance.now();
      table = await buildFeatureTable(host.ctx.viewBox(), host.sources(product?.inputs ?? []), cellM, product, product ? defaultStyle(product) : null, m => say(m));
      draw();
      say(`Feature table: ${table.rows.length.toLocaleString()} cells × ${allColumns().length + 8} columns on the ${table.lattice}, in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
    } catch (e) { say(`Could not build the table: ${(e as Error).message}`, 'error'); }
    busy = false; rerender();
  }

  const download = async (kind: 'parquet' | 'csv') => {
    if (!table) return;
    try {
      say(`Writing ${kind === 'parquet' ? 'GeoParquet' : 'CSV'}…`);
      const body = kind === 'parquet' ? await tableGeoParquet(table) : await tableCsv(table);
      const a = h('a', { href: URL.createObjectURL(new Blob([body], { type: kind === 'parquet' ? 'application/vnd.apache.parquet' : 'text/csv' })), download: `features_${table.cellM}m.${kind === 'parquet' ? 'parquet' : 'csv'}` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      say(`Downloaded ${table.rows.length.toLocaleString()} cells.`);
    } catch (e) { say(`Could not write: ${(e as Error).message}`, 'error'); }
  };

  map.on('click', (e: MapMouseEvent) => {
    if (!table || host.isSampling() || !map.getLayer(SRC) || map.getLayer('segments') || document.getElementById('pane-fusion')!.hidden) return;
    const i = pixelAt(table.grid, e.lngLat.lng, e.lngLat.lat), r = i >= 0 ? table.rowOf[i] : -1;
    if (r < 0) return;
    const cols = allColumns();
    const show = [column, 'chm', 'ndvi', 'pc_ivg', 'pc_pen', 'pc_att', 'o_exg', 'obj_chm_p90', ...table.shares.map(s => s.name)];
    const seen = new Set<string>();
    const rows = show.filter(n => !seen.has(n) && seen.add(n)).map(n => cols.find(c => c.name === n)).filter(Boolean).map(c => h('tr', {}, h('th', {}, c!.label), h('td', {}, fmt(c!.values[r]))));
    const row = table.rows[r];
    new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(e.lngLat).setDOMContent(h('div', { class: 'popup' },
      h('strong', {}, `Cell ${table.epsg}:${table.cellM}:${row.ix}:${row.iy}`), h('table', {}, ...rows))).addTo(map);
  });

  function el(onChange: () => void): HTMLElement {
    rerender = onChange;
    const wrap = host.panel('table', 'Feature table (grid export)', !!table);
    wrap.append(h('p', { class: 'muted small' }, "One row per cell of Sentinel-2's own pixel grid (so the imagery is never resampled), one column per variable: every finer input — 1 m LiDAR, point-cloud metrics, orthophoto — averaged into the cell, plus canopy-height P90 and spread, photo texture, the share of the cell in each class of the rules or strata above, and H3 ids. GeoParquet (opens in DuckDB, QGIS, pandas) or CSV."));
    wrap.append(h('div', { class: 'row' },
      h('label', { class: 'row' }, 'Cell ', h('select', { 'aria-label': 'Cell size', onchange: (e: Event) => { cellM = +(e.target as HTMLSelectElement).value as 10 | 20; } },
        h('option', { value: '10', selected: cellM === 10 }, '10 m (Sentinel-2 10 m pixels)'),
        h('option', { value: '20', selected: cellM === 20 }, '20 m (Sentinel-2 20 m pixels)'))),
      h('button', { class: 'btn small-btn', disabled: busy, onclick: () => void build() }, busy ? 'Building…' : table ? 'Build again' : 'Build for this view'),
      table ? h('button', { class: 'btn ghost small-btn', onclick: () => { remove(); onChange(); } }, 'Remove') : null));
    if (table) {
      wrap.append(h('label', { class: 'field' }, 'Show column on the map', h('select', { onchange: (e: Event) => { column = (e.target as HTMLSelectElement).value; draw(); onChange(); } },
        ...allColumns().map(c => h('option', { value: c.name, selected: c.name === column }, c.label)))));
      const stops = VIRIDIS.map((c, i) => `${c} ${(i / (VIRIDIS.length - 1)) * 100}%`).join(',');
      wrap.append(h('div', { class: 'ramp' }, h('div', { class: 'ramp-bar', style: `background: linear-gradient(to right, ${stops})` })), h('p', { class: 'muted small' }, rangeText));
      wrap.append(h('label', { class: 'row' }, 'Opacity ', h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(opacity), class: 'grow', oninput: (e: Event) => { opacity = +(e.target as HTMLInputElement).value; if (map.getLayer(SRC)) map.setPaintProperty(SRC, 'raster-opacity', opacity); } })));
      wrap.append(h('p', { class: 'small' }, `${table.rows.length.toLocaleString()} cells · ${allColumns().length} variables + id, centre (UTM and lon/lat), H3 r13 and r11, coverage · ${table.lattice}`));
      wrap.append(h('div', { class: 'row' },
        h('button', { class: 'chip', onclick: () => void download('parquet') }, 'Download GeoParquet'),
        h('button', { class: 'chip', onclick: () => void download('csv') }, 'Download CSV')));
    }
    return wrap;
  }
  return { el, remove };
}
