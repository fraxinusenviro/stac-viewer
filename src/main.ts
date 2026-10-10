// STAC Viewer — LiDAR point clouds, LiDAR-derived rasters (HRDEM) and Sentinel-2
// imagery, searched and drawn entirely in the browser. Static files on GitHub
// Pages; every byte of data comes straight from public object storage.

import maplibregl, { type GeoJSONSource, type LngLatBoundsLike, type Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { LidarIndex, type LidarTile, type LonLatBox } from './lidarIndex.ts';
import { closeCog, openCog, registerCogProtocol, sampleRange, setCogStyle } from './cog.ts';
import { productById, productsFor, usesRange, type RasterProduct } from './products.ts';
import { coverageTouches, fetchExtent, searchHrdem, searchS2, type HrdemItem, type S2Item } from './stac.ts';
import { h, clear, fmtBytes, fmtCount, fmtDate } from './dom.ts';

interface Project {
  id: string; label: string; jurisdiction: string; year: number; crs: string; verticalDatum: string;
  provider: string; licence: string; urlTemplate: string; tiles: number; points: number; bytes: number;
  bbox: LonLatBox;
}

const DATA = new URL('data/', document.baseURI).href;
const TILE_MIN_ZOOM = 10;
const index = new LidarIndex(DATA + 'lidar-tiles.parquet');
let projects: Project[] = [];
const projectById = new Map<string, Project>();

const tileUrl = (t: LidarTile) => projectById.get(t.project)?.urlTemplate.replace('{name}', t.key) ?? '';
const tileId = (t: LidarTile) => `${t.project}/${t.key}`;

// ── Map ─────────────────────────────────────────────────────────────────────

const BASEMAPS: Record<string, { tiles: string[]; attribution: string; maxzoom: number }> = {
  // CARTO's keyless tiles now carry an "API key required" watermark.
  light: {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors',
    maxzoom: 16,
  },
  imagery: {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    maxzoom: 19,
  },
};

registerCogProtocol();

const map: MlMap = new maplibregl.Map({
  container: 'map',
  hash: true,
  center: [-63.4, 44.72],
  zoom: 9,
  maxPitch: 0,
  style: {
    version: 8,
    sources: Object.fromEntries(Object.entries(BASEMAPS).map(([k, b]) => [`bm-${k}`, { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution }])),
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e8e6e1' } },
      { id: 'bm-light', type: 'raster', source: 'bm-light' },
      { id: 'bm-imagery', type: 'raster', source: 'bm-imagery', layout: { visibility: 'none' } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const viewBox = (): LonLatBox => {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
};

const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const YEAR_COLOURS: maplibregl.ExpressionSpecification = [
  'interpolate', ['linear'], ['get', 'year'], 2008, '#9e9ac8', 2014, '#6baed6', 2018, '#41ab5d', 2022, '#fd8d3c', 2026, '#e6550d',
];

map.on('load', async () => {
  // Draw order, bottom to top: basemap · imagery · elevation · footprints.
  // `anchor-elev` and `anchor-lidar` are empty layers the rasters insert below.
  map.addSource('s2-footprints', { type: 'geojson', data: empty });
  map.addSource('hrdem-footprints', { type: 'geojson', data: empty });
  map.addSource('coverage', { type: 'geojson', data: DATA + 'lidar-coverage.geojson' });
  map.addSource('tiles', { type: 'geojson', data: empty, promoteId: 'id' });
  map.addLayer({ id: 'anchor-elev', type: 'background', layout: { visibility: 'none' } });
  map.addLayer({ id: 'anchor-lidar', type: 'background', layout: { visibility: 'none' } });
  map.addLayer({ id: 'hrdem-footprints', type: 'line', source: 'hrdem-footprints', paint: { 'line-color': '#8c510a', 'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 3, 1.2], 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 's2-footprints', type: 'line', source: 's2-footprints', paint: { 'line-color': '#3182bd', 'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 3, 0] } });
  map.addLayer({ id: 'coverage-fill', type: 'fill', source: 'coverage', maxzoom: TILE_MIN_ZOOM, paint: { 'fill-color': YEAR_COLOURS, 'fill-opacity': 0.35 } });
  map.addLayer({ id: 'coverage-line', type: 'line', source: 'coverage', paint: { 'line-color': YEAR_COLOURS, 'line-width': 1 } });
  map.addLayer({ id: 'tiles-fill', type: 'fill', source: 'tiles', minzoom: TILE_MIN_ZOOM, paint: { 'fill-color': YEAR_COLOURS, 'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.55, 0.12] } });
  map.addLayer({ id: 'tiles-line', type: 'line', source: 'tiles', minzoom: TILE_MIN_ZOOM, paint: { 'line-color': YEAR_COLOURS, 'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.5, 0.6] } });

  try {
    const pj = await (await fetch(DATA + 'lidar-projects.json')).json();
    projects = pj.projects;
    projects.forEach(p => projectById.set(p.id, p));
  } catch (e) { say(`The point-cloud project list could not be read: ${(e as Error).message}`, 'error'); }

  wireLidar();
  scheduleLidarSearch();
});

// ── Sidebar shell ───────────────────────────────────────────────────────────

const statusEl = document.getElementById('status')!;
function say(msg: string, kind: 'info' | 'error' = 'info') {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
}

let activeTab = 'pc';
document.querySelectorAll<HTMLButtonElement>('.tab').forEach(btn => btn.addEventListener('click', () => {
  activeTab = btn.dataset.tab!;
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b === btn)));
  document.querySelectorAll<HTMLElement>('.pane').forEach(p => { p.hidden = p.id !== `pane-${activeTab}`; });
  // The point-cloud footprints belong to their tab: over a raster or a scene
  // they are a grid of lines on top of the thing being looked at.
  for (const id of ['coverage-fill', 'coverage-line', 'tiles-fill', 'tiles-line']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', activeTab === 'pc' ? 'visible' : 'none');
  }
  if (activeTab === 'pc') scheduleLidarSearch();
}));

document.getElementById('basemap')!.addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  for (const k of Object.keys(BASEMAPS)) map.setLayoutProperty(`bm-${k}`, 'visibility', k === v ? 'visible' : 'none');
});

// ── Point clouds (CanElevation COPC) ────────────────────────────────────────

const lidarList = document.getElementById('lidar-list')!;
const lidarStats = document.getElementById('lidar-stats')!;
let lidarTimer = 0;
let lidarSeq = 0;
let lidarTiles: LidarTile[] = [];
let selectedTile: string | null = null;

function scheduleLidarSearch() {
  clearTimeout(lidarTimer);
  lidarTimer = window.setTimeout(runLidarSearch, 350);
}

async function runLidarSearch() {
  if (activeTab !== 'pc' || !map.isStyleLoaded()) return;
  const seq = ++lidarSeq;
  const vb = viewBox();
  if (map.getZoom() < TILE_MIN_ZOOM) {
    lidarTiles = [];
    (map.getSource('tiles') as GeoJSONSource).setData(empty);
    renderProjectsOverview(vb);
    return;
  }
  try {
    const { tiles, stats } = await index.search(vb);
    if (seq !== lidarSeq) return;
    lidarTiles = tiles;
    (map.getSource('tiles') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: tiles.map(t => ({
        type: 'Feature', id: tileId(t), properties: { id: tileId(t), project: t.project, key: t.key, year: t.year },
        geometry: { type: 'Polygon', coordinates: [[[t.xmin, t.ymin], [t.xmax, t.ymin], [t.xmax, t.ymax], [t.xmin, t.ymax], [t.xmin, t.ymin]]] },
      })),
    });
    lidarStats.textContent = `${fmtCount(tiles.length)} tiles · read ${stats.groupsRead} of ${stats.groupsTotal} row groups, ${fmtBytes(stats.bytesRead)} in ${stats.requests} request${stats.requests === 1 ? '' : 's'}, ${(stats.ms / 1000).toFixed(2)} s`;
    renderTileList(tiles);
  } catch (e) {
    if (seq === lidarSeq) say(`Point-cloud search failed: ${(e as Error).message}`, 'error');
  }
}

function renderProjectsOverview(vb: LonLatBox) {
  clear(lidarList);
  const here = projects.filter(p => p.bbox[0] <= vb[2] && p.bbox[2] >= vb[0] && p.bbox[1] <= vb[3] && p.bbox[3] >= vb[1]);
  lidarStats.textContent = `Zoom in past level ${TILE_MIN_ZOOM} to list individual tiles.`;
  if (!here.length) {
    lidarList.append(h('p', { class: 'muted' }, 'No indexed point-cloud project in this view. The index currently covers the Halifax County 2018 acquisitions.'));
    return;
  }
  for (const p of here) lidarList.append(projectCard(p, p.tiles, p.points, p.bytes, () => map.fitBounds(p.bbox as LngLatBoundsLike, { padding: 40 })));
}

function projectCard(p: Project, tiles: number, points: number, bytes: number, onClick: () => void) {
  return h('button', { class: 'card', onclick: onClick },
    h('span', { class: 'swatch', style: `--c:${yearColour(p.year)}` }),
    h('span', { class: 'card-body' },
      h('strong', {}, p.label),
      h('span', { class: 'muted' }, `${p.year} · ${fmtCount(tiles)} tiles · ${fmtCount(points)} points · ${fmtBytes(bytes)}`),
      h('span', { class: 'muted' }, `${p.crs} · ${p.verticalDatum}`)));
}

function renderTileList(tiles: LidarTile[]) {
  clear(lidarList);
  if (!tiles.length) { lidarList.append(h('p', { class: 'muted' }, 'No point-cloud tiles in this view.')); return; }
  const byProject = new Map<string, LidarTile[]>();
  for (const t of tiles) (byProject.get(t.project) ?? byProject.set(t.project, []).get(t.project)!).push(t);
  for (const [pid, ts] of byProject) {
    const p = projectById.get(pid);
    if (!p) continue;
    lidarList.append(projectCard(p, ts.length, ts.reduce((s, t) => s + t.points, 0), ts.reduce((s, t) => s + t.bytes, 0),
      () => map.fitBounds([Math.min(...ts.map(t => t.xmin)), Math.min(...ts.map(t => t.ymin)), Math.max(...ts.map(t => t.xmax)), Math.max(...ts.map(t => t.ymax))], { padding: 40 })));
  }
  lidarList.append(h('p', { class: 'muted small' }, 'Tap a tile on the map for its details and download link.'));
}

function yearColour(y: number) {
  const stops: [number, string][] = [[2008, '#9e9ac8'], [2014, '#6baed6'], [2018, '#41ab5d'], [2022, '#fd8d3c'], [2026, '#e6550d']];
  let c = stops[0][1];
  for (const [yy, cc] of stops) if (y >= yy) c = cc;
  return c;
}

function wireLidar() {
  map.on('moveend', scheduleLidarSearch);
  map.on('mouseenter', 'tiles-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'tiles-fill', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', 'tiles-fill', (e) => {
    const id = e.features?.[0]?.properties?.id as string | undefined;
    const t = id && lidarTiles.find(x => tileId(x) === id);
    if (!t) return;
    if (selectedTile) map.setFeatureState({ source: 'tiles', id: selectedTile }, { selected: false });
    selectedTile = id;
    map.setFeatureState({ source: 'tiles', id }, { selected: true });
    const p = projectById.get(t.project)!;
    const url = tileUrl(t);
    const areaKm2 = areaKm2Of(t);
    const body = h('div', { class: 'popup' },
      h('strong', {}, `${t.key}`),
      h('div', { class: 'muted' }, p.label),
      h('table', {},
        row('Points', fmtCount(t.points)),
        row('Density', areaKm2 > 0 ? `${(t.points / (areaKm2 * 1e6)).toFixed(1)} pts/m²` : '—'),
        row('File', fmtBytes(t.bytes)),
        row('CRS', `${p.crs} · ${p.verticalDatum}`),
        row('Source', p.provider)),
      h('div', { class: 'links' },
        h('a', { href: url, download: '' }, 'Download COPC'),
        h('a', { href: `https://viewer.copc.io/?copc=${encodeURIComponent(url)}`, target: '_blank', rel: 'noopener' }, 'Open in 3D ↗')));
    new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(e.lngLat).setDOMContent(body).addTo(map)
      .on('close', () => { if (selectedTile === id) { map.setFeatureState({ source: 'tiles', id }, { selected: false }); selectedTile = null; } });
  });
}

const row = (k: string, v: string) => h('tr', {}, h('th', {}, k), h('td', {}, v));

/** Approximate ground area of a tile's lon/lat box, km². */
function areaKm2Of(t: LidarTile) {
  const lat = ((t.ymin + t.ymax) / 2) * Math.PI / 180;
  return (t.xmax - t.xmin) * 111.32 * Math.cos(lat) * (t.ymax - t.ymin) * 110.57;
}

// ── Rasters (HRDEM) ─────────────────────────────────────────────────────────
// LiDAR-derived rasters: each HRDEM item offers DTM and DSM products, each
// drawn as hillshade, elevation or shaded elevation. Every product added is
// its own map layer, listed under "On the map" with its own controls.

const rasterList = document.getElementById('raster-list')!;
const rasterLayersEl = document.getElementById('raster-layers')!;
let hrdemItems: HrdemItem[] = [];
let hrdemElsewhere: HrdemItem[] = [];

interface RasterLayer { id: string; item: HrdemItem; product: RasterProduct; min: number; max: number; opacity: number; v: number }
/** Layers on the map, in the order added (last is drawn on top). */
const rasterLayers: RasterLayer[] = [];
const layerId = (it: HrdemItem, p: RasterProduct) => `hrdem:${it.id}:${p.id}`;
const itemName = (it: HrdemItem) => (it.kind === 'project' ? it.id : `National ${it.kind.replace('mosaic-', '')} mosaic`);

document.getElementById('raster-search')!.addEventListener('click', async () => {
  say('Searching the NRCan STAC…');
  try {
    const vb = viewBox();
    const found = await searchHrdem(vb);
    // A project's STAC geometry is its ENVELOPE; a coastal survey's envelope
    // covers a lot of ground it never flew. Each project's `extent` asset is
    // its true coverage, so only projects whose coverage meets the view are
    // offered; the rest are named under "Elsewhere nearby".
    say(`Checking the coverage of ${found.filter(i => i.kind === 'project').length} LiDAR projects…`);
    const extents = await Promise.all(found.map(async (i) => (i.kind === 'project' && i.extent ? fetchExtent(i.extent).catch(() => null) : null)));
    hrdemItems = []; hrdemElsewhere = [];
    const features: GeoJSON.Feature[] = [];
    found.forEach((it, n) => {
      const g = extents[n];
      if (it.kind === 'project' && g && !coverageTouches(g, vb)) { hrdemElsewhere.push(it); return; }
      hrdemItems.push(it);
      if (g) features.push({ type: 'Feature', id: hrdemItems.length - 1, properties: { id: it.id }, geometry: g });
    });
    (map.getSource('hrdem-footprints') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    say(`${hrdemItems.length} raster source${hrdemItems.length === 1 ? '' : 's'} cover this view.`);
    renderRasterList();
  } catch (e) { say(`Raster search failed: ${(e as Error).message}`, 'error'); }
});

function renderRasterList() {
  clear(rasterList);
  if (!hrdemItems.length) { rasterList.append(h('p', { class: 'muted' }, 'No HRDEM rasters here.')); return; }
  hrdemItems.forEach((it, n) => {
    const products = productsFor(it);
    const pick = h('select', { 'aria-label': `Product from ${itemName(it)}` },
      ...products.map(p => h('option', { value: p.id, title: p.hint }, p.label)));
    const card = h('div', { class: 'card static' },
      h('span', { class: 'card-body' },
        h('strong', {}, itemName(it)),
        h('span', { class: 'muted' }, `${it.kind === 'project' ? 'LiDAR project' : 'Mosaic'}${it.datetime ? ` · ${fmtDate(it.datetime)}` : ''} · ${it.kind === 'mosaic-2m' ? '2' : '1'} m · CGVD2013${it.dsm ? '' : ' · DTM only'}`),
        h('span', { class: 'row' }, pick,
          h('button', { class: 'btn', onclick: () => void addRaster(it, productById(pick.value)!) }, 'Add'))));
    if (it.kind === 'project') {
      card.addEventListener('mouseenter', () => map.setFeatureState({ source: 'hrdem-footprints', id: n }, { hover: true }));
      card.addEventListener('mouseleave', () => map.setFeatureState({ source: 'hrdem-footprints', id: n }, { hover: false }));
    }
    rasterList.append(card);
  });
  if (hrdemElsewhere.length) {
    rasterList.append(h('details', { class: 'muted small' },
      h('summary', {}, `Elsewhere nearby (${hrdemElsewhere.length})`),
      h('p', {}, 'Their bounding boxes reach this view but their surveys do not: ' + hrdemElsewhere.map(i => i.id).join(', ') + '.')));
  }
}

function renderRasterLayers() {
  clear(rasterLayersEl);
  if (!rasterLayers.length) return;
  rasterLayersEl.append(h('h2', {}, 'On the map'));
  for (const L of [...rasterLayers].reverse()) rasterLayersEl.append(rasterLayerCard(L));
}

function rasterLayerCard(L: RasterLayer) {
  const refresh = () => {
    setCogStyle(L.id, { min: L.min, max: L.max });
    L.v++;
    (map.getSource(L.id) as maplibregl.RasterTileSource).setTiles([`cog://${encodeURIComponent(L.id)}/{z}/{x}/{y}?v=${L.v}`]);
  };
  const minIn = h('input', { type: 'number', value: String(L.min), step: '1', 'aria-label': 'Ramp minimum (m)', onchange: (e: Event) => { L.min = +(e.target as HTMLInputElement).value; refresh(); } });
  const maxIn = h('input', { type: 'number', value: String(L.max), step: '1', 'aria-label': 'Ramp maximum (m)', onchange: (e: Event) => { L.max = +(e.target as HTMLInputElement).value; refresh(); } });
  const fit = async () => {
    const r = await sampleRange(L.id, viewBox()).catch(() => null);
    if (!r) { say(`${L.product.label}: no data in this view to fit to.`); return; }
    [L.min, L.max] = r;
    minIn.value = String(L.min); maxIn.value = String(L.max);
    refresh();
  };
  return h('div', { class: 'card static on-map' },
    h('span', { class: 'card-body' },
      h('span', { class: 'row spread' },
        h('strong', { title: L.product.hint }, L.product.label),
        h('button', { class: 'btn ghost small-btn', onclick: () => removeRaster(L) }, 'Remove')),
      h('span', { class: 'muted' }, itemName(L.item)),
      usesRange(L.product.mode) ? h('span', { class: 'row' },
        h('label', {}, 'Min ', minIn), h('label', {}, 'Max ', maxIn), h('span', { class: 'muted' }, 'm'),
        h('button', { class: 'btn ghost small-btn', onclick: () => void fit() }, 'Fit to view')) : null,
      h('label', { class: 'row' }, 'Opacity',
        h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(L.opacity), oninput: (e: Event) => { L.opacity = +(e.target as HTMLInputElement).value; map.setPaintProperty(L.id, 'raster-opacity', L.opacity); } }))));
}

async function addRaster(it: HrdemItem, p: RasterProduct) {
  const id = layerId(it, p);
  if (rasterLayers.some(L => L.id === id)) { say(`${p.label} from ${itemName(it)} is already on the map.`); return; }
  say(`Opening ${itemName(it)} ${p.surface.toUpperCase()}…`);
  try {
    const L: RasterLayer = { id, item: it, product: p, min: 0, max: 150, opacity: 1, v: 0 };
    const cog = await openCog(id, p.surface === 'dsm' ? it.dsm! : it.dtm, { mode: p.mode, min: L.min, max: L.max });
    // A colour ramp starts stretched to what is in view, not to a fixed range.
    if (usesRange(p.mode)) {
      const r = await sampleRange(id, viewBox()).catch(() => null);
      if (r) { [L.min, L.max] = r; setCogStyle(id, { min: L.min, max: L.max }); }
    }
    map.addSource(id, { type: 'raster', tiles: [`cog://${encodeURIComponent(id)}/{z}/{x}/{y}`], tileSize: 256, bounds: cog.bounds, maxzoom: 18 });
    map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': L.opacity, 'raster-fade-duration': 0 } }, 'anchor-lidar');
    rasterLayers.push(L);
    say(`${p.label}: ${cog.width.toLocaleString()} × ${cog.height.toLocaleString()} px at ${cog.resolution} m, EPSG:${cog.epsg}.`);
    renderRasterLayers();
  } catch (e) { closeCog(id); say(`Could not open ${itemName(it)}: ${(e as Error).message}`, 'error'); }
}

function removeRaster(L: RasterLayer) {
  if (map.getLayer(L.id)) map.removeLayer(L.id);
  if (map.getSource(L.id)) map.removeSource(L.id);
  closeCog(L.id);
  rasterLayers.splice(rasterLayers.indexOf(L), 1);
  renderRasterLayers();
}

// ── Imagery (Sentinel-2) ────────────────────────────────────────────────────

const imgList = document.getElementById('img-list')!;
const fromIn = document.getElementById('img-from') as HTMLInputElement;
const toIn = document.getElementById('img-to') as HTMLInputElement;
const cloudIn = document.getElementById('img-cloud') as HTMLInputElement;
const cloudOut = document.getElementById('img-cloud-out')!;
const today = new Date();
toIn.value = today.toISOString().slice(0, 10);
fromIn.value = new Date(today.getTime() - 90 * 864e5).toISOString().slice(0, 10);
cloudIn.addEventListener('input', () => { cloudOut.textContent = `${cloudIn.value}%`; });

let s2Items: S2Item[] = [];
let s2Shown: string | null = null;
const S2_LAYER = 's2-scene';

document.getElementById('img-search')!.addEventListener('click', async () => {
  say('Searching Earth Search for Sentinel-2…');
  try {
    s2Items = await searchS2({ bbox: viewBox(), from: fromIn.value, to: toIn.value, maxCloud: +cloudIn.value });
    (map.getSource('s2-footprints') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: s2Items.filter(i => i.geometry).map((i, n) => ({ type: 'Feature', id: n, properties: { id: i.id }, geometry: i.geometry! })),
    });
    say(`${s2Items.length} Sentinel-2 scene${s2Items.length === 1 ? '' : 's'} at ≤ ${cloudIn.value}% cloud.`);
    renderImgList();
  } catch (e) { say(`Imagery search failed: ${(e as Error).message}`, 'error'); }
});

function renderImgList() {
  clear(imgList);
  if (!s2Items.length) { imgList.append(h('p', { class: 'muted' }, 'No scenes match. Widen the dates or the cloud limit.')); return; }
  s2Items.forEach((it, n) => {
    const card = h('button', { class: `card scene${s2Shown === it.id ? ' on' : ''}`, onclick: () => void showScene(it) },
      it.thumbnail ? h('img', { src: it.thumbnail, alt: '', loading: 'lazy' }) : h('span', { class: 'thumb-missing' }),
      h('span', { class: 'card-body' },
        h('strong', {}, fmtDate(it.datetime)),
        h('span', { class: 'muted' }, `${it.cloud !== null ? `${it.cloud.toFixed(1)}% cloud` : 'cloud n/a'}${it.nodata ? ` · ${it.nodata.toFixed(0)}% empty` : ''}`),
        h('span', { class: 'muted small' }, `${it.mgrs ?? ''} · ${it.id.split('_')[0]}`)));
    card.addEventListener('mouseenter', () => map.setFeatureState({ source: 's2-footprints', id: n }, { hover: true }));
    card.addEventListener('mouseleave', () => map.setFeatureState({ source: 's2-footprints', id: n }, { hover: false }));
    imgList.append(card);
  });
}

async function showScene(it: S2Item) {
  if (map.getLayer(S2_LAYER)) map.removeLayer(S2_LAYER);
  if (map.getSource(S2_LAYER)) map.removeSource(S2_LAYER);
  if (s2Shown) closeCog(`s2:${s2Shown}`);
  if (s2Shown === it.id) { s2Shown = null; renderImgList(); return; }
  const id = `s2:${it.id}`;
  say(`Opening ${it.id}…`);
  try {
    const cog = await openCog(id, it.visual, { mode: 'rgb', min: 0, max: 255 });
    map.addSource(S2_LAYER, { type: 'raster', tiles: [`cog://${encodeURIComponent(id)}/{z}/{x}/{y}`], tileSize: 256, bounds: cog.bounds, maxzoom: 16 });
    map.addLayer({ id: S2_LAYER, type: 'raster', source: S2_LAYER, paint: { 'raster-fade-duration': 0, 'raster-opacity': +(document.getElementById('img-opacity') as HTMLInputElement).value } }, 'anchor-elev');
    s2Shown = it.id;
    say(`Showing ${fmtDate(it.datetime)} true colour (10 m). Tap the scene again to hide it.`);
    renderImgList();
  } catch (e) { say(`Could not open the scene: ${(e as Error).message}`, 'error'); }
}

document.getElementById('img-opacity')!.addEventListener('input', (e) => {
  if (map.getLayer(S2_LAYER)) map.setPaintProperty(S2_LAYER, 'raster-opacity', +(e.target as HTMLInputElement).value);
});
