// STAC Viewer — LiDAR point clouds, LiDAR-derived rasters (HRDEM) and Sentinel-2
// imagery, searched and drawn entirely in the browser. Static files on GitHub
// Pages; every byte of data comes straight from public object storage.

import maplibregl, { type GeoJSONSource, type LngLatBoundsLike, type Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { LidarIndex, type LidarTile, type LonLatBox } from './lidarIndex.ts';
import { registerProtocol } from './engine.ts';
import { h, clear, fmtBytes, fmtCount } from './dom.ts';
import type { Ctx } from './tabs/ctx.ts';
import { initRasters } from './tabs/rasters.ts';
import { initImagery } from './tabs/imagery.ts';
import { initFusion } from './tabs/fusion.ts';

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

registerProtocol();

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
  // Draw order, bottom to top: basemap · imagery · LiDAR rasters · fusion ·
  // footprints. The anchors are empty layers each family inserts below.
  map.addSource('s2-footprints', { type: 'geojson', data: empty });
  map.addSource('hrdem-footprints', { type: 'geojson', data: empty });
  map.addSource('coverage', { type: 'geojson', data: DATA + 'lidar-coverage.geojson' });
  map.addSource('tiles', { type: 'geojson', data: empty, promoteId: 'id' });
  map.addLayer({ id: 'anchor-elev', type: 'background', layout: { visibility: 'none' } });
  map.addLayer({ id: 'anchor-fusion', type: 'background', layout: { visibility: 'none' } });
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

// ── The other tabs ──────────────────────────────────────────────────────────

const ctx: Ctx = { map, say, viewBox };
initRasters(ctx);
initImagery(ctx);
initFusion(ctx);
