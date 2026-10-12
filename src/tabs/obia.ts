// The OBIA tab — object-based image analysis of a study area, as the spec
// (docs/OBIA.md) lays it out: one persistent map and a compact panel walking
//   Study area → Sources → Objects → Training → Classification → Review & export.
//
// The rules this file keeps (the rest live in src/obia/, pure and tested):
//   • fine boundaries come from RGB and the canopy height model only;
//     Sentinel-2 is read at native support AFTER segmentation, as attributes;
//   • nothing is silently coarsened: a job over the memory budget is refused
//     before a byte is read, with the options named;
//   • the heavy work runs in a worker, with progress and Cancel, and the map
//     stays usable;
//   • every stage checkpoints to IndexedDB; a reload resumes from the last
//     completed stage;
//   • a source that cannot be read analytically says why, and an unknown is
//     never guessed.

import type { MapMouseEvent } from 'maplibre-gl';
import { h, clear, fmtDate } from '../dom.ts';
import { describeFile, readNative, registerLocalFile, sampleGrid, type InputSource } from '../engine.ts';
import { aoiAreaM2, aoiBox, fmtArea, pointInAoi, polygonMask, type Aoi } from '../aoi.ts';
import { analysisGrid, gridXY, lonLatOf, projectPolygon, projector, utmEpsgFor, type AnalysisGrid, type Datum, type Projector } from '../obia/grid.ts';
import { DEFAULT_SENTINEL, OBIA_ALGORITHM_VERSION, PRESETS, REFERENCE_SCALES, recipeHash, segmentationKey, type Recipe, type SegmentParams } from '../obia/recipe.ts';
import { DEFAULT_CLASSES, LabelStore, assignFromPolygons, type ClassDef, type LabelEntry, type LabelRole } from '../obia/labels.ts';
import { PROJECT_SCHEMA, classRaster, dissolvedGeoJSON, featuresCsv, fromBundle, manifest, modelBundle, objectsGeoJSON, toBundle, type ObiaProject, type ReferenceFeature } from '../obia/project.ts';
import { STAC_PROVIDERS, capabilities, search, type NormalizedItem } from '../obia/stacAdapter.ts';
import { probeRange } from '../obia/probe.ts';
import { deviceBudget, estimateBytes, fmtMiB, maxAreaM2 } from '../obia/budget.ts';
import { runClassifyJob, runObjectsJob, type Running } from '../obia/workerClient.ts';
import { clearProject, loadProject, requestPersistence, saveProject, storageReport } from '../obia/store.ts';
import { writeGeoTiff } from '../obia/geotiffWrite.ts';
import { fixtureReferences, fixtureScene, FIXTURE_LABEL } from '../obia/fixture.ts';
import { S2_BAND_RES, type NativeRaster } from '../obia/sentinel.ts';
import type { SentinelInput } from '../obia/pipeline.ts';
import type { FeatureGroup, SourceAsset } from '../obia/types.ts';
import { fetchExtent, s2AssetScaling } from '../stac.ts';
import { ORTHO_SERVICES, type XyzService } from '../xyz.ts';
import { stepHead, segBar } from '../ui/steps.ts';
import { studyAreaStep } from './studyArea.ts';
import { addObiaLayers, chmImage, nativeGridLines, objectsImage, pixelOfLonLat, qualityImage, removeImage, rgbImage, setGeoJSON, showImage, type RasterLayer } from './obiaMap.ts';
import { mapClaim, type Ctx } from './ctx.ts';

type Step = 'area' | 'sources' | 'objects' | 'training' | 'classify' | 'review';
const STEPS: [Step, string][] = [['area', 'Study area'], ['sources', 'Sources'], ['objects', 'Objects'], ['training', 'Training'], ['classify', 'Classification'], ['review', 'Review & export']];
const LS = 'sv.obia.settings';
const GROUPS: [FeatureGroup, string][] = [['rgb', 'RGB colour & texture'], ['structure', 'LiDAR structure (CHM)'], ['terrain', 'Terrain'], ['geometry', 'Object geometry'], ['sentinel', 'Sentinel-2 (native support)']];

interface Settings {
  presetId: string; datum: Datum; cellM: number; bufferM: number; segment: SegmentParams; heightBandsM: number[];
  s2: { from: string; to: string; maxCloud: number }; groups: FeatureGroup[]; blockM: number; folds: number; trees: number;
  refThreshold: number; pointsRepresent: boolean;
}

/** A chosen source: its contract record, how to read it, where it is. */
interface Chosen { asset: SourceAsset; inputs: Record<string, InputSource>; footprint: GeoJSON.Geometry | null; fixture?: boolean }

const load = <T>(k: string, f: T): T => { try { const v = localStorage.getItem(k); return v ? { ...f, ...JSON.parse(v) } as T : f; } catch { return f; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const fmt = (x: number | null | undefined, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(d));
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(0)} %`);
const PALETTE = ['#1b7837', '#7fbc41', '#e6c84f', '#2166ac', '#8c8c8c', '#d6604d', '#762a83', '#35978f', '#bf812d', '#c51b7d'];

function download(name: string, body: BlobPart, type: string) {
  const a = h('a', { href: URL.createObjectURL(new Blob([body], { type })), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/** Share of an AOI inside a (multi)polygon footprint, from a lattice of points. */
function coverageOf(aoi: GeoJSON.Polygon, fp: GeoJSON.Geometry | null): number | null {
  if (!fp) return null;
  const polys = fp.type === 'Polygon' ? [fp] : fp.type === 'MultiPolygon' ? fp.coordinates.map(c => ({ type: 'Polygon', coordinates: c } as GeoJSON.Polygon)) : fp.type === 'GeometryCollection' ? fp.geometries.filter((g): g is GeoJSON.Polygon => g.type === 'Polygon') : [];
  if (!polys.length) return null;
  const b = aoiBox(aoi);
  let n = 0, inside = 0;
  for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) {
    const lon = b[0] + ((i + 0.5) / 30) * (b[2] - b[0]), lat = b[1] + ((j + 0.5) / 30) * (b[3] - b[1]);
    if (!pointInAoi(aoi, lon, lat)) continue;
    n++;
    if (polys.some(p => pointInAoi(p, lon, lat))) inside++;
  }
  return n ? inside / n : null;
}

const days = (a?: string | null, b?: string | null) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 864e5 : null);

export function initObia(ctx: Ctx) {
  const { map, say } = ctx;
  const el = document.getElementById('obia-body')!;
  const pane = document.getElementById('pane-obia')!;
  const preset0 = PRESETS[0];
  let S: Settings = load<Settings>(LS, {
    presetId: preset0.id, datum: 'wgs84', cellM: preset0.cellM, bufferM: 20, segment: { ...preset0.segment }, heightBandsM: [0.5, 2, 8],
    s2: { from: `${new Date().getFullYear() - 1}-06-01`, to: `${new Date().getFullYear() - 1}-09-30`, maxCloud: 20 },
    groups: ['rgb', 'structure', 'terrain', 'geometry', 'sentinel'], blockM: 100, folds: 5, trees: 100, refThreshold: 0.8, pointsRepresent: false,
  });
  const persist = () => save(LS, S);
  let step: Step = 'area';
  const area = studyAreaStep(ctx, () => render(), { prefix: 'obia-aoi', pane: 'pane-obia' });

  // Sources (session; their records are stored in the project when used).
  let rgb: Chosen | null = null, chm: Chosen | null = null, s2: NormalizedItem | null = null;
  const trueCover = new Set<string>();
  let lidarItems: NormalizedItem[] = [], s2Items: NormalizedItem[] = [], s2Truncated = false;
  let s2Probe = '', nsodbAck = false, nsodbId = 'nsodb10k';
  let searching = '';

  // Project and interaction state.
  let project: ObiaProject | null = null;
  let labels = new LabelStore();
  let proj: Projector | null = null;
  let display: { rgb?: string; chm?: string; quality?: string } = {};
  let layerOn: Record<RasterLayer, boolean> = { 'obia-rgb': true, 'obia-chm': false, 'obia-quality': true, 'obia-objects': true };
  let preview: { grid: AnalysisGrid; labels: Int32Array; count: number; edgeObjects: number } | null = null;
  let job: { label: string; stage: string; run: Running<unknown>; t0: number } | null = null;
  let jobLine: HTMLElement | null = null;
  const selected = new Set<number>();
  let activeClass = DEFAULT_CLASSES[0].id, role: LabelRole = 'training';
  let colourBy: 'none' | 'labels' | 'predicted' | 'condition' = 'labels';
  let inspected: number | null = null;
  let review: { objectId: string; reason: string; shares: Record<string, number> }[] = [];
  let refFile: { name: string; fc: GeoJSON.FeatureCollection; field: string } | null = null;
  let note = '';
  let fixtureLoaded = false;

  const setStep = (s: Step) => { step = s; render(); };

  // ── Map ───────────────────────────────────────────────────────────────────

  map.on('load', () => { addObiaLayers(map); void resume(); });
  const obiaOpen = () => !pane.hidden;
  const vis = (on: boolean) => { for (const id of ['obia-footprints', 'obia-refs']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => setTimeout(() => vis(obiaOpen()), 0)));

  function paintObjects() {
    const g = preview?.grid ?? project?.grid, L = preview?.labels ?? project?.labels;
    if (!g || !L || !proj) { removeImage(map, 'obia-objects'); return; }
    const byIndex = project && !preview ? project.objects : null;
    const classColour = new Map((project?.classes ?? DEFAULT_CLASSES).map(c => [c.id, c.colour]));
    const labelOf = new Map(labels.all().map(e => [e.objectId, e]));
    const fillOf = (k: number): string | null => {
      if (!byIndex) return null;
      const o = byIndex[k];
      if (!o) return null;
      if (colourBy === 'labels') { const e = labelOf.get(o.id); return e && e.role !== 'review' ? classColour.get(e.classId) ?? null : null; }
      if (colourBy === 'predicted') return classColour.get(o.reviewedClass ?? o.predictedClass ?? '') ?? null;
      if (colourBy === 'condition') return conditionColour(o.index);
      return null;
    };
    showImage(map, 'obia-objects', objectsImage(L, g.width, g.height, fillOf, preview ? new Set() : selected), g, proj, 0.85, layerOn['obia-objects']);
  }

  const CONDITIONS: [string, string, string][] = [
    ['missing', '#d73027', 'missing coverage (< 50 % of the object has CHM or imagery)'],
    ['coarse', '#fc8d59', 'coarse / mixed Sentinel support'],
    ['margin', '#762a83', 'low model margin (< 0.2)'],
    ['small', '#fee090', 'below the minimum patch area (kept, distinct)'],
  ];
  function conditionsOf(k: number): string[] {
    const o = project?.objects[k];
    if (!o) return [];
    const out: string[] = [];
    if ((o.support.structure && o.support.structure.validFraction < 0.5) || (o.support.rgb && o.support.rgb.validFraction < 0.5)) out.push('missing');
    if (o.flags.includes('coarse-mixed') || o.flags.includes('coarse-subpixel') || o.flags.includes('coarse-no-valid')) out.push('coarse');
    if (o.classScores) { const v = Object.values(o.classScores).sort((a, b) => b - a); if (v[0] - (v[1] ?? 0) < 0.2) out.push('margin'); }
    if (o.flags.includes('below-min-patch')) out.push('small');
    return out;
  }
  const conditionColour = (k: number) => { const c = conditionsOf(k)[0]; return c ? CONDITIONS.find(x => x[0] === c)![1] : null; };

  function paintInputs() {
    const g = project?.grid;
    if (!g || !proj) return;
    if (display.rgb) showImage(map, 'obia-rgb', display.rgb, g, proj, 1, layerOn['obia-rgb']); else removeImage(map, 'obia-rgb');
    if (display.chm) showImage(map, 'obia-chm', display.chm, g, proj, 0.9, layerOn['obia-chm']); else removeImage(map, 'obia-chm');
    if (display.quality) showImage(map, 'obia-quality', display.quality, g, proj, 0.7, layerOn['obia-quality']); else removeImage(map, 'obia-quality');
  }

  function paintFootprints() {
    const feats: GeoJSON.Feature[] = [];
    const add = (g: GeoJSON.Geometry | null | undefined, colour: string, name: string) => { if (g) feats.push({ type: 'Feature', properties: { colour, name }, geometry: g }); };
    add(rgb?.footprint, '#d01c8b', 'RGB');
    add(chm?.footprint, '#4dac26', 'LiDAR');
    add(s2?.geometry, '#2c7bb6', 'Sentinel-2');
    setGeoJSON(map, 'obia-footprints', { type: 'FeatureCollection', features: feats });
  }

  function paintS2Grid(on: boolean) {
    if (!map.getLayer('obia-s2grid')) return;
    const a = project?.sources.find(s => s.role === 'spectral-context');
    const g = a?.grid;
    if (on && g && proj && project) {
      const toLL = (xy: [number, number]) => projector(Number(g.crs.replace('EPSG:', ''))).inverse(xy);
      const b = project.grid.bounds;
      // The native grid lines over the analysis bounds, in the native CRS (same as the analysis CRS by default).
      setGeoJSON(map, 'obia-s2grid', nativeGridLines([g.transform[0], g.transform[3]], g.transform[1], 0, b, toLL));
    }
    map.setLayoutProperty('obia-s2grid', 'visibility', on ? 'visible' : 'none');
  }

  map.on('click', (e: MapMouseEvent) => {
    if (!obiaOpen() || mapClaim.owner || !project || !proj || preview) return;
    const i = pixelOfLonLat(project.grid, proj, e.lngLat.lng, e.lngLat.lat);
    const k = i >= 0 ? project.labels[i] : -1;
    if (k < 0) return;
    if (step === 'training') {
      if (e.originalEvent.shiftKey) { if (selected.has(k)) selected.delete(k); else selected.add(k); paintObjects(); render(); return; }
      applyLabel([k]);
      return;
    }
    inspected = k;
    selected.clear(); selected.add(k);
    paintObjects();
    if (step !== 'review') step = 'review';
    render();
  });

  // ── Labels ────────────────────────────────────────────────────────────────

  const labelsChanged = () => { if (project) { project.labelEntries = labels.all(); project.updated = new Date().toISOString(); void checkpoint(); } paintObjects(); render(); };

  function applyLabel(ks: number[], clear = false) {
    if (!project) return;
    const at = new Date().toISOString();
    labels.apply(ks.map(k => project!.objects[k].id), id => {
      if (clear) return null;
      const o = project!.objects.find(x => x.id === id)!;
      return { objectId: id, classId: activeClass, role, source: 'manual', at, x: o.cx, y: o.cy };
    });
    labelsChanged();
  }

  const labelsHash = () => recipeHash({ l: labels.all().filter(e => !e.pending && e.role !== 'review').map(e => [e.objectId, e.classId, e.role]).sort() });

  // ── Checkpoints ───────────────────────────────────────────────────────────

  let saveTimer = 0;
  async function checkpoint() {
    if (!project) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      try { await saveProject({ ...project!, measured: { ...project!.measured, displayRgb: display.rgb ?? '', displayChm: display.chm ?? '', displayQuality: display.quality ?? '' } }); }
      catch (e) { say((e as Error).message, 'error'); }
    }, 400);
  }

  async function resume() {
    try {
      const p = await loadProject();
      if (!p || p.schema !== PROJECT_SCHEMA) return;
      adopt(p);
      note = `Resumed the saved project (${p.recipe.aoi.name}, last saved ${p.updated.slice(0, 16).replace('T', ' ')}). Work that was running when the page closed is not in it.`;
      render();
    } catch (e) { say(`Could not read the saved project: ${(e as Error).message}`, 'error'); }
  }

  function adopt(p: ObiaProject) {
    project = p;
    proj = projector(p.grid.epsg);
    labels = new LabelStore(p.labelEntries);
    display = { rgb: (p.measured.displayRgb as string) || undefined, chm: (p.measured.displayChm as string) || undefined, quality: (p.measured.displayQuality as string) || undefined };
    preview = null; selected.clear(); inspected = null;
    fixtureLoaded = p.sources.some(s => s.id.startsWith('fixture:'));
    if (!p.classes.some(c => c.id === activeClass)) activeClass = p.classes[0]?.id ?? '';
    paintInputs(); paintObjects(); paintRefs();
  }

  function paintRefs() {
    setGeoJSON(map, 'obia-refs', { type: 'FeatureCollection', features: (project?.references ?? []).map(r => ({ type: 'Feature', properties: { cls: r.classId }, geometry: r.geometry })) });
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  async function searchLidar(aoi: Aoi) {
    searching = 'LiDAR'; render();
    try {
      const p = STAC_PROVIDERS.find(x => x.id === 'nrcan-datacube')!;
      const caps = await capabilities(p);
      const r = await search(p, { bbox: aoiBox(aoi.geometry), limit: 50 }, caps, fetch, 3);
      const rank = (c: string) => (c === 'hrdem-lidar' ? 0 : c === 'hrdem-mosaic-1m' ? 1 : 2);
      const items = r.items.filter(i => i.assets.dtm);
      // A project's STAC geometry is its envelope; its `extent` asset is its TRUE coverage. Use that where it exists.
      await Promise.all(items.slice(0, 12).map(async it => {
        if (!it.assets.extent) return;
        try { it.geometry = await fetchExtent(it.assets.extent.href); trueCover.add(it.itemId); } catch { /* envelope stands, and is labelled so */ }
      }));
      const cov = new Map(items.map(it => [it.itemId, coverageOf(aoi.geometry, it.geometry) ?? 0]));
      lidarItems = items.sort((a, b) => (cov.get(b.itemId)! >= 0.999 ? 1 : 0) - (cov.get(a.itemId)! >= 0.999 ? 1 : 0) || rank(a.collectionId) - rank(b.collectionId) || cov.get(b.itemId)! - cov.get(a.itemId)! || (b.datetime ?? '').localeCompare(a.datetime ?? ''));
      say(`${lidarItems.length} HRDEM item${lidarItems.length === 1 ? '' : 's'} meet the study area${r.truncated ? ' (more pages exist; refine the area)' : ''}.`);
    } catch (e) { say(`LiDAR search failed: ${(e as Error).message}`, 'error'); }
    searching = ''; render();
  }

  async function chooseLidar(it: NormalizedItem) {
    const dsm = it.assets.dsm, dtm = it.assets.dtm;
    if (!dsm) { say(`${it.itemId} has no DSM: a canopy height model needs one.`, 'error'); return; }
    say(`Probing ${it.itemId}…`);
    const [pd, pt] = await Promise.all([probeRange(dsm.href), probeRange(dtm.href)]);
    const bad = !pd.ok ? pd : !pt.ok ? pt : null;
    let footprint = it.geometry;
    if (it.assets.extent && !trueCover.has(it.itemId)) { try { footprint = await fetchExtent(it.assets.extent.href); trueCover.add(it.itemId); } catch { /* envelope stands */ } }
    const d = it.datetime ?? it.start ?? undefined;
    const asset: SourceAsset = {
      id: `nrcan-datacube/${it.collectionId}/${it.itemId}/dsm-dtm`, role: 'lidar-feature', label: `HRDEM ${it.itemId} (CHM = DSM − DTM)`,
      collectionId: it.collectionId, itemId: it.itemId, assetKey: 'dsm,dtm', uriReference: dsm.href, acquiredStart: d, acquiredEnd: it.end ?? d,
      nativeResolutionM: it.collectionId === 'hrdem-mosaic-2m' ? [2, 2] : [1, 1], verticalDatum: 'CGVD2013', access: bad ? 'unavailable' : 'analytical',
      accessNote: bad && !bad.ok ? bad.reason : `byte-range reads confirmed${pd.ok && pd.size ? ` (${(pd.size / 1e9).toFixed(1)} GB file, read by window)` : ''}`,
      contentVersion: pd.ok && pd.size ? `size:${pd.size}` : undefined, attribution: 'Natural Resources Canada, HRDEM, Open Government Licence – Canada',
    };
    chm = { asset, footprint, inputs: { 'lidar:dsm': { url: dsm.href, sample: 0, scale: 1, offset: 0, nodata: -32767, minValid: -1000 }, 'lidar:dtm': { url: dtm.href, sample: 0, scale: 1, offset: 0, nodata: -32767, minValid: -1000 } } };
    paintFootprints(); render();
    say(bad && !bad.ok ? `LiDAR not readable: ${bad.reason}` : `LiDAR chosen: ${asset.label}.`, bad ? 'error' : 'info');
  }

  async function searchSentinel(aoi: Aoi) {
    searching = 'Sentinel-2'; render();
    try {
      const p = STAC_PROVIDERS.find(x => x.id === 'earth-search')!;
      const caps = await capabilities(p);
      const r = await search(p, { bbox: aoiBox(aoi.geometry), datetime: `${S.s2.from}T00:00:00Z/${S.s2.to}T23:59:59Z`, limit: 50, query: { 'eo:cloud_cover': { lte: S.s2.maxCloud } }, sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }] }, caps, fetch, 3);
      const cloud = (it: NormalizedItem) => it.properties['eo:cloud_cover'] as number | undefined;
      // Without the query extension the filter is applied here, on the scenes returned, and said so.
      const filteredHere = !caps.query || r.dropped.includes('query');
      s2Items = (filteredHere ? r.items.filter(it => (cloud(it) ?? 101) <= S.s2.maxCloud) : r.items).sort((a, b) => (cloud(a) ?? 101) - (cloud(b) ?? 101));
      s2Truncated = r.truncated;
      if (filteredHere) say(`The catalogue could not filter by cloud: ${s2Items.length} of ${r.items.length} returned scenes pass ≤ ${S.s2.maxCloud} % here${r.truncated ? ', and more pages exist' : ''}.`);
      else say(`${s2Items.length} scene${s2Items.length === 1 ? '' : 's'} found${r.truncated ? ' (more pages exist; narrow the dates)' : ''}.`);
    } catch (e) { say(`Sentinel-2 search failed: ${(e as Error).message}`, 'error'); }
    searching = ''; render();
  }

  async function chooseSentinel(it: NormalizedItem | null) {
    s2 = it; s2Probe = '';
    paintFootprints(); render();
    if (!it) return;
    const missing = [...DEFAULT_SENTINEL.bands, 'scl'].filter(b => !it.assets[b]);
    if (missing.length) { s2Probe = `This scene lacks ${missing.join(', ')}: it cannot supply the declared predictors.`; render(); return; }
    const pr = await probeRange(it.assets.red.href);
    s2Probe = pr.ok ? 'Byte-range reads confirmed.' : `Not readable: ${pr.reason}`;
    if (!it.properties['s2:processing_baseline'] && !it.assets.red.bands[0]?.offset) s2Probe += ' The scene states neither a processing baseline nor a reflectance offset: values may be mis-scaled.';
    render();
  }

  async function importRaster(kind: 'rgb' | 'chm', file: File) {
    try {
      const id = `${file.name}:${file.size}:${file.lastModified}`;
      const key = registerLocalFile(id, file);
      const d = await describeFile(key);
      if (kind === 'rgb' && (d.bands < 3 || d.bitsPerSample !== 8)) throw new Error(`expected an 8-bit RGB(A) GeoTIFF; this has ${d.bands} band(s) of ${d.bitsPerSample} bits. Other encodings are not guessed at.`);
      if (kind === 'chm' && d.bands < 1) throw new Error('no band');
      const asset: SourceAsset = {
        id: `local:${id}`, role: kind === 'rgb' ? 'boundary-imagery' : 'lidar-feature', label: file.name, uriReference: key,
        nativeResolutionM: [d.resM, d.resM], access: 'analytical', accessNote: 'local file, read by window in this browser',
        contentVersion: `${file.size}:${file.lastModified}`, verticalDatum: kind === 'chm' ? 'heights above ground (as supplied)' : undefined,
        grid: { crs: `EPSG:${d.epsg}`, transform: [0, d.resM, 0, 0, 0, -d.resM], width: d.width, height: d.height, pixelConvention: 'area' },
      };
      const bb = d.bounds;
      const fp: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [bb[0], bb[1]]]] };
      const nd = d.nodata;
      const inputs: Record<string, InputSource> = kind === 'rgb'
        ? { 'rgb:r': { url: key, sample: 0, scale: 1, offset: 0, nodata: nd }, 'rgb:g': { url: key, sample: 1, scale: 1, offset: 0, nodata: nd }, 'rgb:b': { url: key, sample: 2, scale: 1, offset: 0, nodata: nd } }
        : { 'chm:v': { url: key, sample: 0, scale: 1, offset: 0, nodata: nd } };
      const c: Chosen = { asset, inputs, footprint: fp };
      if (kind === 'rgb') rgb = c; else chm = c;
      paintFootprints(); render();
      say(`${file.name}: EPSG:${d.epsg}, ${d.resM} m pixels, ${d.width} × ${d.height}${nd !== null ? `, no-data ${nd}` : ', no no-data value stated'}.`);
    } catch (e) { say(`Could not use ${file.name}: ${(e as Error).message}`, 'error'); }
  }

  function chooseNsodb(svc: XyzService) {
    const at = new Date().toISOString().slice(0, 10);
    rgb = {
      asset: {
        id: `xyz:${svc.id}`, role: 'boundary-imagery', label: svc.label, uriReference: svc.template, access: 'analytical',
        accessNote: `Enabled for analysis on ${at} by the user's statement that the provider's terms permit it. ${svc.accessNote} Tile zoom is chosen to match the cell size and is not a native resolution; native resolution unknown.`,
        attribution: svc.attribution,
      },
      inputs: { 'rgb:r': { kind: 'xyz', url: svc.template, maxZoom: svc.maxZoom, sample: 0, scale: 1, offset: 0, nodata: null }, 'rgb:g': { kind: 'xyz', url: svc.template, maxZoom: svc.maxZoom, sample: 1, scale: 1, offset: 0, nodata: null }, 'rgb:b': { kind: 'xyz', url: svc.template, maxZoom: svc.maxZoom, sample: 2, scale: 1, offset: 0, nodata: null } },
      footprint: null,
    };
    render();
  }

  // ── Objects ───────────────────────────────────────────────────────────────

  function currentRecipe(aoi: Aoi, epsg: number): Recipe {
    const sv: Record<string, string> = {};
    for (const c of [rgb, chm]) if (c?.asset.contentVersion) sv[c.asset.id] = c.asset.contentVersion;
    if (s2) sv[`earth-search/${s2.collectionId}/${s2.itemId}`] = String(s2.properties.updated ?? s2.datetime ?? '');
    return {
      algorithm: OBIA_ALGORITHM_VERSION, aoi: { id: aoi.id, name: aoi.name, geometry: aoi.geometry }, objective: S.presetId, epsg, cellM: S.cellM, bufferM: S.bufferM,
      segment: S.segment, referenceScales: REFERENCE_SCALES,
      sources: { rgb: rgb?.asset.id ?? null, chm: chm?.asset.id ?? null, dtm: chm?.inputs['lidar:dtm'] ? chm.asset.id : null, sentinel: s2 ? `earth-search/${s2.collectionId}/${s2.itemId}` : null },
      sourceVersions: sv, sentinel: { itemId: s2?.itemId ?? null, ...DEFAULT_SENTINEL }, heightBandsM: S.heightBandsM,
    };
  }

  function planFor(aoi: Aoi) {
    const [w0, s0, e0, n0] = aoiBox(aoi.geometry);
    const epsg = utmEpsgFor((w0 + e0) / 2, (s0 + n0) / 2, S.datum);
    const p = projector(epsg);
    const areaP = projectPolygon(aoi.geometry, p);
    const grid = analysisGrid(areaP, epsg, S.cellM, S.bufferM);
    return { epsg, p, areaP, grid };
  }

  function estimate(grid: AnalysisGrid, withS2: boolean) {
    const px = grid.width * grid.height;
    const s2px = withS2 ? ((grid.width * S.cellM) / 10) * ((grid.height * S.cellM) / 10) * 1.3 : 0;
    const bytes = estimateBytes({ px, rgb: !!rgb, chm: !!chm, dtm: !!chm?.inputs['lidar:dtm'], sentinelNativePx: s2px, sentinelPlanes: 8, targetAreaM2: S.segment.targetAreaM2, cellM: S.cellM });
    const budget = deviceBudget((navigator as Navigator & { deviceMemory?: number }).deviceMemory);
    return { px, bytes, budget, ok: bytes <= budget, maxHa: maxAreaM2(budget, S.cellM, { rgb: !!rgb, chm: !!chm, dtm: !!chm?.inputs['lidar:dtm'] }) / 1e4 };
  }

  /** Read the fine planes over a grid (main thread: COG and tile decoding). */
  async function readFine(grid: AnalysisGrid, p: Projector, stage: (s: string) => void) {
    const out = { w: grid.width, h: grid.height, lonLat: lonLatOf(grid, p) };
    const planes: { r?: Float32Array; g?: Float32Array; b?: Float32Array; chm?: Float32Array; dtm?: Float32Array } = {};
    if (rgb) {
      stage(`Reading the imagery (${rgb.asset.label})…`);
      const got = await sampleGrid(rgb.inputs, out);
      planes.r = got['rgb:r']; planes.g = got['rgb:g']; planes.b = got['rgb:b'];
    }
    if (chm) {
      stage(`Reading the LiDAR rasters (${chm.asset.label})…`);
      const got = await sampleGrid(chm.inputs, out);
      if (got['chm:v']) planes.chm = got['chm:v'];
      else {
        const dsm = got['lidar:dsm'], dtm = got['lidar:dtm'], c = new Float32Array(dsm.length).fill(NaN);
        // CHM = DSM − DTM per fine pixel (nearest native cell of each); small negatives are noise, clamped to 0.
        for (let i = 0; i < c.length; i++) { const d = dsm[i] - dtm[i]; if (d === d) c[i] = Math.max(0, d); }
        planes.chm = c; planes.dtm = dtm;
      }
    }
    return planes;
  }

  async function readSentinel(aoi: Aoi, stage: (s: string) => void): Promise<SentinelInput | null> {
    if (!s2) return null;
    const box = aoiBox(aoi.geometry), pad = S.bufferM / 111000 + 0.0005;
    const b: [number, number, number, number] = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
    const keys = [...DEFAULT_SENTINEL.bands, 'nir08', 'scl'].filter((k, i, a) => a.indexOf(k) === i && s2!.assets[k]);
    const baseline = (s2.properties['s2:processing_baseline'] as string | undefined) ?? null;
    const groups = new Map<string, NativeRaster>();
    // Three reads at a time: each band is its own COG, and an uncapped burst stalls a weak link.
    const wins = new Map<string, Awaited<ReturnType<typeof readNative>>>();
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(3, keys.length) }, async () => {
      while (next < keys.length) {
        const k = keys[next++], a = s2!.assets[k];
        const sc = k === 'scl' ? { scale: 1, offset: 0, nodata: 0 } : s2AssetScaling(k, a.bands[0] ? { scale: a.bands[0].scale, offset: a.bands[0].offset, nodata: a.bands[0].noData } : undefined, baseline);
        wins.set(k, await readNative([[k, { url: a.href, sample: 0, scale: sc.scale, offset: sc.offset, nodata: sc.nodata }]], b));
        stage(`Reading Sentinel-2 at native resolution: ${++done} of ${keys.length} bands…`);
      }
    }));
    for (const k of keys) {
      const win = wins.get(k)!;
      const gk = `${win.res}:${win.originX}:${win.originY}:${win.w}:${win.h}`;
      const r = groups.get(gk) ?? { key: `s2:${s2.itemId}:${win.res}m`, epsg: win.epsg, originX: win.originX, originY: win.originY, res: win.res, w: win.w, h: win.h, values: {} };
      r.values[k] = win.values[k];
      groups.set(gk, r);
    }
    for (const r of groups.values()) if (Math.abs(r.res - (S2_BAND_RES[Object.keys(r.values)[0]] ?? r.res)) > 1e-6) throw new Error(`Sentinel-2 ${Object.keys(r.values)[0]} came back at ${r.res} m, not its native resolution`);
    return { sourceId: `earth-search/${s2.collectionId}/${s2.itemId}`, rasters: [...groups.values()], bands: [...DEFAULT_SENTINEL.bands, 'nir08'], indices: DEFAULT_SENTINEL.indices, sclInvalid: DEFAULT_SENTINEL.sclInvalid, maskBufferPx: DEFAULT_SENTINEL.maskBufferPx };
  }

  async function runObjects(kind: 'preview' | 'full') {
    const where = area.current();
    if (!where.aoi) { say(where.reason, 'error'); return; }
    if (!rgb && !chm) { say('Choose RGB imagery or a LiDAR source in Sources first.', 'error'); return; }
    if (rgb && rgb.asset.access !== 'analytical' || chm && chm.asset.access !== 'analytical') { say('A chosen source is not readable analytically; see Sources.', 'error'); return; }
    if (job) return;
    const aoi = where.aoi;
    const plan = planFor(aoi);
    let grid = plan.grid;
    if (kind === 'preview') {
      // A representative window at the REAL cell size: around the map centre when it is in the area, else the area's centre.
      const N = Math.min(256, grid.width, grid.height);
      const c = map.getCenter();
      const [cx, cy] = pointInAoi(aoi.geometry, c.lng, c.lat) ? plan.p.forward([c.lng, c.lat]) : gridXY(grid, grid.width / 2, grid.height / 2);
      const col = Math.max(0, Math.min(grid.width - N, Math.round((cx - grid.transform[0]) / S.cellM - N / 2)));
      const row = Math.max(0, Math.min(grid.height - N, Math.round((grid.transform[3] - cy) / S.cellM - N / 2)));
      const x0 = grid.transform[0] + col * S.cellM, y1 = grid.transform[3] - row * S.cellM;
      grid = { ...grid, width: N, height: N, transform: [x0, S.cellM, 0, y1, 0, -S.cellM], bounds: [x0, y1 - N * S.cellM, x0 + N * S.cellM, y1] };
    }
    const est = estimate(grid, kind === 'full' && !!s2);
    if (!est.ok) {
      say(`Refused before reading: this run needs about ${fmtMiB(est.bytes)} against this device's budget of ${fmtMiB(est.budget)}. Use a smaller study area (up to ~${est.maxHa.toFixed(0)} ha at ${S.cellM} m), choose a coarser cell size explicitly, or drop an input.`, 'error');
      return;
    }
    const recipe = currentRecipe(aoi, plan.epsg);
    const segVersion = segmentationKey(recipe).slice(0, 12);
    const mg = { w: grid.width, h: grid.height, box: grid.bounds, lonLat: (px: number, py: number) => gridXY(grid, px, py) };
    const mask = polygonMask(mg, plan.areaP);
    const t0 = performance.now();
    let cancelled = false;
    const stage = (s: string) => { if (job) job.stage = s; if (jobLine) jobLine.textContent = s; };
    job = { label: kind === 'preview' ? 'Preview' : 'Objects', stage: 'Reading inputs…', run: { promise: Promise.resolve(), cancel: () => { cancelled = true; } }, t0 };
    render();
    try {
      const planes = await readFine(grid, plan.p, stage);
      if (cancelled) throw new Error('cancelled');
      const tRead = performance.now() - t0;
      // Coverage inside the area, and the quality mask.
      let inside = 0, rgbOkN = 0, chmOkN = 0;
      const rgbOk = planes.r ? new Uint8Array(mask.length) : null, chmOk = planes.chm ? new Uint8Array(mask.length) : null;
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        inside++;
        if (rgbOk && planes.r![i] === planes.r![i]) { rgbOk[i] = 1; rgbOkN++; }
        if (chmOk && planes.chm![i] === planes.chm![i]) { chmOk[i] = 1; chmOkN++; }
      }
      if (rgbOk && !rgbOkN) throw new Error(`no imagery was read inside the study area (outside the source's coverage, unreadable, or over a read limit: ${rgb!.asset.label})`);
      if (chmOk && !chmOkN) throw new Error(`no LiDAR values were read inside the study area (${chm!.asset.label})`);
      if (!planes.r && planes.chm) { layerOn['obia-chm'] = true; layerOn['obia-rgb'] = false; }
      const disp = {
        rgb: planes.r ? showImage(map, 'obia-rgb', rgbImage(planes.r, planes.g!, planes.b!, grid.width, grid.height), grid, plan.p, 1, layerOn['obia-rgb']) : undefined,
        chm: planes.chm ? showImage(map, 'obia-chm', chmImage(planes.chm, grid.width, grid.height), grid, plan.p, 0.9, layerOn['obia-chm']) : undefined,
        quality: showImage(map, 'obia-quality', qualityImage(rgbOk, chmOk, mask, grid.width, grid.height), grid, plan.p, 0.7, layerOn['obia-quality']),
      };
      const sentinel = kind === 'full' ? await readSentinel(aoi, stage) : null;
      if (cancelled) throw new Error('cancelled');
      const tS2 = performance.now() - t0 - tRead;
      stage('Segmenting in the worker…');
      const run = runObjectsJob({
        grid: { w: grid.width, h: grid.height, x0: grid.transform[0], y0: grid.transform[3], cellM: S.cellM, epsg: plan.epsg },
        planes, mask, params: S.segment, windowEdge: kind === 'preview', heightBandsM: S.heightBandsM, segmentationVersion: segVersion,
        sources: { rgb: rgb?.asset.id ?? null, chm: chm?.asset.id ?? null, dtm: recipe.sources.dtm }, sentinel,
      }, s => stage(`Worker: ${s}…`));
      job.run = run as Running<unknown>;
      const r = await run.promise;
      proj = plan.p;
      if (kind === 'preview') {
        preview = { grid, labels: r.labels, count: r.count, edgeObjects: r.objects.filter(o => o.flags.includes('touches-window-edge')).length };
        display = { ...display };
        say(`Preview: ${r.count} objects in a ${grid.width} × ${grid.height} window at ${S.cellM} m (${((performance.now() - t0) / 1000).toFixed(1)} s). ${preview.edgeObjects} touch the window's artificial edge.`);
      } else {
        const sources: SourceAsset[] = [];
        if (rgb) sources.push(rgb.asset);
        if (chm) sources.push(chm.asset);
        if (s2 && sentinel) {
          const r10 = sentinel.rasters.find(x => x.res === 10) ?? sentinel.rasters[0];
          sources.push({
            id: sentinel.sourceId, role: 'spectral-context', label: `Sentinel-2 ${s2.itemId}`, collectionId: s2.collectionId, itemId: s2.itemId,
            assetKey: [...DEFAULT_SENTINEL.bands, 'nir08', 'scl'].join(','), uriReference: s2.assets.red.href, acquiredStart: s2.datetime ?? undefined, acquiredEnd: s2.datetime ?? undefined,
            nativeResolutionM: [10, 10], access: 'analytical', accessNote: s2Probe,
            grid: { crs: `EPSG:${r10.epsg}`, transform: [r10.originX, r10.res, 0, r10.originY, 0, -r10.res], width: r10.w, height: r10.h, pixelConvention: 'area' },
            bands: [...DEFAULT_SENTINEL.bands, 'nir08'].map(k => ({ name: k, unit: 'reflectance', scale: s2!.assets[k].bands[0]?.scale, offset: s2!.assets[k].bands[0]?.offset, noData: s2!.assets[k].bands[0]?.noData })),
            contentVersion: String(s2.properties.updated ?? ''), attribution: 'Copernicus Sentinel-2 data, via Element 84 Earth Search',
          });
        }
        const prev = project;
        const keepClasses = prev?.classes ?? DEFAULT_CLASSES.map(c => ({ ...c }));
        const at = new Date().toISOString();
        const next: ObiaProject = {
          schema: PROJECT_SCHEMA, created: prev?.created ?? at, updated: at, recipe, recipeHash: recipeHash(recipe), segmentationVersion: segVersion,
          sources, grid, crsDefinition: plan.p.def, labels: r.labels, count: r.count, objects: r.objects, featureDefs: r.featureDefs, coarsePixels: r.coarsePixels,
          classes: keepClasses, labelEntries: [], references: prev?.references ?? [], model: null, classification: null,
          measured: {
            areaHa: aoiAreaM2(aoi.geometry) / 1e4, gridPx: grid.width * grid.height, objects: r.count, estimatedMiB: Math.round(est.bytes / 1024 ** 2), budgetMiB: Math.round(est.budget / 1024 ** 2),
            readFineMs: Math.round(tRead), readSentinelMs: Math.round(tS2), ...Object.fromEntries(Object.entries(r.stageMs).map(([k, v]) => [`${k}Ms`, Math.round(v)])),
            totalMs: Math.round(performance.now() - t0), sentinelIntersection: r.sentinelExact === null ? 'no Sentinel' : r.sentinelExact ? 'exact' : 'approximate (fine grid)',
            userAgent: navigator.userAgent,
          },
        };
        // Labels from the previous segmentation are CARRIED by location and held for confirmation; references are re-applied.
        const carried: LabelEntry[] = [];
        if (prev && prev.segmentationVersion !== segVersion) {
          for (const e of prev.labelEntries) {
            if (e.source === 'reference-polygon' || e.source === 'reference-point' || e.x === undefined || e.y === undefined) continue;
            const i = Math.floor((e.x - grid.transform[0]) / S.cellM) + Math.floor((grid.transform[3] - e.y) / S.cellM) * grid.width;
            const k = i >= 0 && i < r.labels.length ? r.labels[i] : -1;
            if (k >= 0) carried.push({ ...e, objectId: r.objects[k].id, pending: `carried from segmentation ${prev.segmentationVersion} by location: confirm` });
          }
        } else if (prev) carried.push(...prev.labelEntries);
        project = next; preview = null;
        labels = new LabelStore(carried);
        project.labelEntries = labels.all();
        display = disp;
        reapplyReferences(false);
        await checkpoint();
        say(`${r.count.toLocaleString()} objects over ${fmtArea(aoiAreaM2(aoi.geometry))} at ${S.cellM} m in ${(project.measured.totalMs as number / 1000).toFixed(1)} s.${carried.some(c => c.pending) ? ` ${carried.filter(c => c.pending).length} earlier labels carried over by location, held for confirmation in Training.` : ''}`);
      }
      paintObjects();
    } catch (e) {
      const m = (e as Error).message;
      say(m === 'cancelled' ? 'Cancelled. Nothing from the cancelled run was kept.' : `Could not segment: ${m}`, m === 'cancelled' ? 'info' : 'error');
    }
    job = null; render();
  }

  function reapplyReferences(announce = true) {
    if (!project || !proj) return;
    const polys = project.references.filter(r => r.kind === 'polygon').map(r => ({ id: r.id, classId: r.classId, role: r.role, geometry: projectPolygon(r.geometry as GeoJSON.Polygon, proj!) }));
    const at = new Date().toISOString();
    const out: LabelEntry[] = []; review = [];
    for (const rl of ['training', 'validation'] as const) {
      const ps = polys.filter(p => p.role === rl);
      if (!ps.length) continue;
      const a = assignFromPolygons(project.grid, project.labels, project.objects.map(o => o.id), ps, S.refThreshold, rl, at);
      out.push(...a.labels); review.push(...a.review);
    }
    for (const r of project.references.filter(x => x.kind === 'point')) {
      const [lon, lat] = (r.geometry as GeoJSON.Point).coordinates;
      const i = pixelOfLonLat(project.grid, proj, lon, lat), k = i >= 0 ? project.labels[i] : -1;
      if (k < 0) continue;
      const id = project.objects[k].id;
      if (S.pointsRepresent) out.push({ objectId: id, classId: r.classId, role: r.role, source: 'reference-point', at, referenceId: r.id });
      else review.push({ objectId: id, reason: 'a reference point: confirm it represents the whole object', shares: { [r.classId]: 1 } });
    }
    // Reference labels replace earlier reference labels; manual labels win over a reference on the same object.
    const manual = new Set(labels.all().filter(e => e.source === 'manual' || e.source === 'review-correction').map(e => e.objectId));
    const refIds = labels.all().filter(e => e.source === 'reference-polygon' || e.source === 'reference-point').map(e => e.objectId);
    labels.apply(refIds, () => null);
    const add = out.filter(e => !manual.has(e.objectId));
    labels.apply(add.map(e => e.objectId), id => add.find(e => e.objectId === id)!);
    if (announce) say(`References: ${add.length} objects labelled (one class ≥ ${Math.round(S.refThreshold * 100)} % of the object), ${review.length} need review.`);
    labelsChanged();
  }

  // ── Classification ────────────────────────────────────────────────────────

  async function classify() {
    if (!project || job) return;
    const t0 = performance.now();
    const run = runClassifyJob({
      objects: project.objects, featureDefs: project.featureDefs, labels: labels.all(), groups: S.groups, blockM: S.blockM, folds: S.folds,
      forest: { trees: S.trees, maxDepth: 16, minLeaf: 1, seed: 20261012 }, coarsePixels: project.coarsePixels,
    }, s => { if (jobLine) jobLine.textContent = `Worker: ${s}…`; });
    job = { label: 'Training', stage: 'Training and cross-validating…', run: run as Running<unknown>, t0 };
    render();
    try {
      const r = await run.promise;
      const byId = new Map(r.predictions.map(p => [p.objectId, p]));
      for (const o of project.objects) { const p = byId.get(o.id); o.predictedClass = p?.cls; o.classScores = p?.scores; }
      project.model = r.model;
      project.classification = { settings: { groups: S.groups, blockM: S.blockM, folds: S.folds, forest: r.model.options }, features: r.features, cv: r.cv, ablation: r.ablation, validation: r.validation, trainedOn: r.trainedOn, labelsHash: labelsHash(), segmentationVersion: project.segmentationVersion, at: new Date().toISOString() };
      project.measured = { ...project.measured, classifyMs: Math.round(performance.now() - t0), trainedOn: r.trainedOn };
      colourBy = 'predicted';
      await checkpoint();
      say(`Model trained on ${r.trainedOn} labelled objects with ${r.features.length} predictors; every object predicted (${((performance.now() - t0) / 1000).toFixed(1)} s).`);
      paintObjects();
    } catch (e) {
      const m = (e as Error).message;
      say(m === 'cancelled' ? 'Cancelled.' : `Could not classify: ${m}`, m === 'cancelled' ? 'info' : 'error');
    }
    job = null; render();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function stepState(s: Step): 'done' | 'stale' | '' {
    if (!project) return s === 'area' && area.current().aoi ? 'done' : s === 'sources' && (rgb || chm) ? 'done' : '';
    if (s === 'objects') { const a = area.current().aoi; return a && (rgb || chm) && segmentationKey(currentRecipe(a, project.grid.epsg)).slice(0, 12) !== project.segmentationVersion ? 'stale' : 'done'; }
    if (s === 'training') return labels.byRole('training').length ? 'done' : '';
    if (s === 'classify' || s === 'review') return project.classification ? (project.classification.labelsHash !== labelsHash() ? 'stale' : 'done') : '';
    return 'done';
  }

  function render() {
    clear(el);
    if (fixtureLoaded) el.append(h('p', { class: 'note small' }, h('strong', {}, FIXTURE_LABEL), '. Everything below is computed from a synthetic scene for testing; nothing is a real result.'));
    if (note) el.append(h('p', { class: 'muted small' }, note, ' ', h('button', { class: 'chip', onclick: () => { note = ''; render(); } }, 'OK')));
    el.append(h('nav', { class: 'stepper', 'aria-label': 'Workflow' }, ...STEPS.map(([s, label], i) => {
      const st = stepState(s);
      return h('button', { class: `stepper-btn${s === step ? ' on' : ''}${st ? ` ${st}` : ''}`, 'aria-current': s === step ? 'step' : undefined, title: st === 'stale' ? 'Out of date: inputs or labels changed since this ran' : '', onclick: () => setStep(s) },
        h('span', { class: 'step-n' }, st === 'done' ? '✓' : st === 'stale' ? '!' : String(i + 1)), h('span', {}, label));
    })));
    if (job) {
      jobLine = h('span', { class: 'grow' }, job.stage);
      el.append(h('div', { class: 'note small row job' }, h('strong', {}, `${job.label}: `), jobLine, h('button', { class: 'chip', onclick: () => job?.run.cancel() }, 'Cancel')));
    }
    const body = h('section', { class: 'step' });
    el.append(body);
    const n = STEPS.findIndex(x => x[0] === step) + 1;
    if (step === 'area') renderArea(body, n);
    else if (step === 'sources') renderSources(body, n);
    else if (step === 'objects') renderObjects(body, n);
    else if (step === 'training') renderTraining(body, n);
    else if (step === 'classify') renderClassify(body, n);
    else renderReview(body, n);
  }

  function renderArea(body: HTMLElement, n: number) {
    body.append(stepHead(n, 'Study area', area.summary()), area.el());
    const aoi = area.current().aoi;
    const preset = PRESETS.find(p => p.id === S.presetId) ?? PRESETS[0];
    body.append(h('label', { class: 'field' }, 'Mapping objective (preset)', h('select', { onchange: (e: Event) => {
      const p = PRESETS.find(x => x.id === (e.target as HTMLSelectElement).value)!;
      S = { ...S, presetId: p.id, cellM: p.cellM, segment: { ...p.segment } }; persist(); render();
    } }, ...PRESETS.map(p => h('option', { value: p.id, selected: p.id === S.presetId }, `${p.label} — ${p.boundary}`)))));
    body.append(h('p', { class: 'muted small' }, `Suggested boundary grid ${preset.cells.join('–')} m, target object area ${preset.segment.targetAreaM2} m². ${preset.context}. Starting points, conditional on the sources: they are not accuracy claims.`));
    body.append(h('div', { class: 'row' },
      h('label', { class: 'row' }, 'Boundary cell ', h('select', { 'aria-label': 'Boundary sampling resolution', onchange: (e: Event) => { S.cellM = +(e.target as HTMLSelectElement).value; persist(); render(); } },
        ...[0.5, 1, 2].map(c => h('option', { value: String(c), selected: c === S.cellM }, `${c} m`)))),
      h('label', { class: 'row' }, 'Buffer ', h('input', { type: 'number', min: '0', max: '200', step: '5', value: String(S.bufferM), style: 'width:64px', 'aria-label': 'Processing buffer (m)', onchange: (e: Event) => { S.bufferM = Math.max(0, +(e.target as HTMLInputElement).value); persist(); render(); } }), ' m')));
    body.append(h('label', { class: 'field' }, 'Analysis CRS', h('select', { onchange: (e: Event) => { S.datum = (e.target as HTMLSelectElement).value as Datum; persist(); render(); } },
      h('option', { value: 'wgs84', selected: S.datum === 'wgs84' }, 'WGS 84 / UTM (the Sentinel-2 grid: exact native intersections)'),
      h('option', { value: 'csrs', selected: S.datum === 'csrs' }, 'NAD83(CSRS) / UTM (null datum shift here; Sentinel intersections then approximate)'))));
    if (aoi) {
      const plan = planFor(aoi);
      const est = estimate(plan.grid, !!s2);
      body.append(h('p', { class: 'small' }, `EPSG:${plan.epsg} · ${plan.grid.width} × ${plan.grid.height} cells at ${S.cellM} m (area ${fmtArea(aoiAreaM2(aoi.geometry))} plus a ${S.bufferM} m processing buffer). The study area, the processing buffer and any hydrological contributing area are distinct: objects are kept only inside the study area.`));
      body.append(h('p', { class: est.ok ? 'muted small' : 'note small' }, `Estimated memory for the objects stage: ${fmtMiB(est.bytes)} of this device's ${fmtMiB(est.budget)} budget${est.ok ? '.' : ` — over budget: up to ~${est.maxHa.toFixed(0)} ha fits at ${S.cellM} m with these inputs.`}`));
    }
    body.append(h('div', { class: 'row' }, h('button', { class: 'btn', disabled: !aoi, onclick: () => setStep('sources') }, 'Next: Sources')));
    body.append(h('details', { class: 'panel' }, h('summary', {}, 'Test fixture'),
      h('p', { class: 'muted small' }, 'Load a small synthetic scene (fine RGB, CHM, coarse spectra with a cloudy pixel, NoData, reference polygons) to exercise the whole workflow without network access. Clearly marked as synthetic everywhere it appears.'),
      h('button', { class: 'chip', onclick: () => void loadFixture() }, 'Load the test fixture')));
  }

  function sourceCard(title: string, c: Chosen | null, extra: (Node | string | null)[] = []) {
    const a = c?.asset;
    return h('div', { class: 'res-card' },
      h('div', { class: 'row res-head' }, h('strong', { class: 'grow' }, title), a ? h('span', { class: `badge${a.access === 'analytical' ? ' ok' : ''}` }, a.access) : h('span', { class: 'muted small' }, 'none')),
      a ? h('p', { class: 'small' }, a.label) : null,
      a ? h('p', { class: 'muted small' }, [
        a.nativeResolutionM ? `native ${a.nativeResolutionM[0]} m` : 'native resolution unknown',
        a.grid?.crs ?? (a.uriReference.startsWith('local:') ? '' : ''),
        a.verticalDatum ?? '',
        a.acquiredStart ? `acquired ${fmtDate(a.acquiredStart)}` : 'acquisition date not stated',
        a.accessNote ?? '',
      ].filter(Boolean).join(' · ')) : null,
      ...extra);
  }

  function renderSources(body: HTMLElement, n: number) {
    const aoi = area.current().aoi;
    body.append(stepHead(n, 'Sources', aoi ? aoi.name : 'no study area'));
    if (!aoi) { body.append(h('p', { class: 'note small' }, 'Choose a study area first.')); return; }
    // RGB
    const rgbIn = h('input', { type: 'file', accept: '.tif,.tiff', hidden: true, onchange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void importRaster('rgb', f); } });
    const urlIn = h('input', { type: 'url', class: 'grow', placeholder: 'https://…/orthophoto.tif (a COG)', 'aria-label': 'RGB COG URL' });
    const nsodb = ORTHO_SERVICES.filter(o => o.access === 'unconfirmed');
    const esri = ORTHO_SERVICES.find(o => o.access === 'reference-only');
    body.append(sourceCard('1 · Boundary imagery (RGB)', rgb, [
      h('div', { class: 'row' }, h('button', { class: 'chip', onclick: () => rgbIn.click() }, 'Import a GeoTIFF…'), rgbIn, rgb ? h('button', { class: 'chip', onclick: () => { rgb = null; paintFootprints(); render(); } }, 'Remove') : null),
      h('div', { class: 'row' }, urlIn, h('button', { class: 'chip', onclick: async () => {
        const u = urlIn.value.trim();
        if (!u) return;
        const pr = await probeRange(u);
        if (!pr.ok) { say(`That URL cannot be read here: ${pr.reason}`, 'error'); return; }
        try {
          const d = await describeFile(u);
          if (d.bands < 3 || d.bitsPerSample !== 8) throw new Error(`expected 8-bit RGB; ${d.bands} band(s) of ${d.bitsPerSample} bits`);
          const bb = d.bounds;
          rgb = { asset: { id: `url:${u.split('?')[0]}`, role: 'boundary-imagery', label: u.split('/').pop()!.split('?')[0], uriReference: u.split('?')[0], nativeResolutionM: [d.resM, d.resM], access: 'analytical', accessNote: 'byte-range reads confirmed', contentVersion: pr.size ? `size:${pr.size}` : undefined, grid: { crs: `EPSG:${d.epsg}`, transform: [0, d.resM, 0, 0, 0, -d.resM], width: d.width, height: d.height, pixelConvention: 'area' } },
            inputs: { 'rgb:r': { url: u, sample: 0, scale: 1, offset: 0, nodata: d.nodata }, 'rgb:g': { url: u, sample: 1, scale: 1, offset: 0, nodata: d.nodata }, 'rgb:b': { url: u, sample: 2, scale: 1, offset: 0, nodata: d.nodata } },
            footprint: { type: 'Polygon', coordinates: [[[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [bb[0], bb[1]]]] } };
          paintFootprints(); render();
        } catch (e) { say(`Could not use that COG: ${(e as Error).message}`, 'error'); }
      } }, 'Use URL')),
      h('details', {}, h('summary', { class: 'small' }, 'Provincial orthophoto tiles (terms unconfirmed)'),
        h('p', { class: 'muted small' }, nsodb[0]?.accessNote ?? ''),
        h('select', { 'aria-label': 'Orthophoto service', onchange: (e: Event) => { nsodbId = (e.target as HTMLSelectElement).value; } }, ...nsodb.map(o => h('option', { value: o.id, selected: o.id === nsodbId }, o.label))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: nsodbAck, onchange: (e: Event) => { nsodbAck = (e.target as HTMLInputElement).checked; render(); } }), 'I have confirmed the provider\'s terms permit derived analysis (recorded in the project).'),
        h('button', { class: 'chip', disabled: !nsodbAck, onclick: () => chooseNsodb(ORTHO_SERVICES.find(o => o.id === nsodbId)!) }, 'Use for analysis'),
        h('p', { class: 'muted small' }, 'Tile services read at most ~96 tiles per run, so they suit small areas only.')),
      esri ? h('p', { class: 'muted small' }, `${esri.label}: reference only — ${esri.accessNote}`) : null,
      h('p', { class: 'muted small' }, 'Without RGB, objects are drawn on the canopy height model alone: structure boundaries, no colour boundaries.'),
    ]));
    // LiDAR
    const chmIn = h('input', { type: 'file', accept: '.tif,.tiff', hidden: true, onchange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void importRaster('chm', f); } });
    const lidarCov = chm ? coverageOf(aoi.geometry, chm.footprint) : null;
    body.append(sourceCard('2 · LiDAR structure (CHM)', chm, [
      lidarCov !== null ? h('p', { class: lidarCov < 0.999 ? 'note small' : 'muted small' }, `Covers ${pct(lidarCov)} of the study area${lidarCov < 0.999 ? ': objects outside it have no structure' : ''}.`) : null,
      h('div', { class: 'row' }, h('button', { class: 'chip', disabled: !!searching, onclick: () => void searchLidar(aoi) }, searching === 'LiDAR' ? 'Searching…' : 'Search NRCan HRDEM'),
        h('button', { class: 'chip', onclick: () => chmIn.click() }, 'Import a CHM GeoTIFF…'), chmIn, chm ? h('button', { class: 'chip', onclick: () => { chm = null; paintFootprints(); render(); } }, 'Remove') : null),
      ...lidarItems.slice(0, 8).map(it => {
        const cov = coverageOf(aoi.geometry, it.geometry);
        return h('button', { class: `card${chm?.asset.itemId === it.itemId ? ' on' : ''}`, onclick: () => void chooseLidar(it) },
          h('span', { class: 'card-body' }, h('strong', {}, it.itemId), h('span', { class: 'muted' }, `${it.collectionId} · ${it.datetime ? fmtDate(it.datetime) : 'undated'} · ${it.assets.dsm ? 'DTM + DSM' : 'DTM only (no CHM)'} · ${trueCover.has(it.itemId) ? 'true coverage' : 'envelope'} ${pct(cov)}`)));
      }),
    ]));
    // Sentinel
    const dd = s2 && chm?.asset.acquiredStart ? days(s2.datetime, chm.asset.acquiredStart) : null;
    body.append(sourceCard('3 · Spectral context (Sentinel-2, optional)', s2 ? { asset: { id: s2.itemId, role: 'spectral-context', label: s2.itemId, uriReference: '', nativeResolutionM: [10, 10], acquiredStart: s2.datetime ?? undefined, access: s2Probe.startsWith('Not') ? 'unavailable' : 'analytical', accessNote: s2Probe }, inputs: {}, footprint: s2.geometry } : null, [
      h('div', { class: 'row' },
        h('label', { class: 'row small' }, 'From ', h('input', { type: 'date', value: S.s2.from, onchange: (e: Event) => { S.s2.from = (e.target as HTMLInputElement).value; persist(); } })),
        h('label', { class: 'row small' }, 'To ', h('input', { type: 'date', value: S.s2.to, onchange: (e: Event) => { S.s2.to = (e.target as HTMLInputElement).value; persist(); } })),
        h('label', { class: 'row small' }, 'Cloud ≤ ', h('input', { type: 'number', min: '0', max: '100', value: String(S.s2.maxCloud), style: 'width:56px', onchange: (e: Event) => { S.s2.maxCloud = +(e.target as HTMLInputElement).value; persist(); } }), ' %')),
      h('div', { class: 'row' }, h('button', { class: 'chip', disabled: !!searching, onclick: () => void searchSentinel(aoi) }, searching === 'Sentinel-2' ? 'Searching…' : 'Search Earth Search'), s2 ? h('button', { class: 'chip', onclick: () => void chooseSentinel(null) }, 'No Sentinel') : null),
      dd !== null ? h('p', { class: dd > 365 ? 'note small' : 'muted small' }, `Sentinel and LiDAR are ${(dd / 365.25).toFixed(1)} years apart${dd > 365 ? ': anything built, cleared or grown between them reads wrongly' : ''}.`) : null,
      ...s2Items.slice(0, 10).map(it => h('button', { class: `card${s2?.itemId === it.itemId ? ' on' : ''}`, onclick: () => void chooseSentinel(it) },
        h('span', { class: 'card-body' }, h('strong', {}, `${it.datetime ? fmtDate(it.datetime) : '?'} · ${fmt(it.properties['eo:cloud_cover'] as number, 1)} % cloud`), h('span', { class: 'muted' }, `${it.itemId} · covers ${pct(coverageOf(aoi.geometry, it.geometry))} · baseline ${it.properties['s2:processing_baseline'] ?? 'not stated'}`)))),
      s2Truncated ? h('p', { class: 'muted small' }, 'More scenes exist than were listed: narrow the dates.') : null,
      h('p', { class: 'muted small' }, 'Read at native support (B02–B04, B08 at 10 m; B8A, B11, SCL at 20 m) and never resampled onto the fine grid. Cloud, shadow, cirrus and snow are masked from the SCL with a one-pixel buffer. RGB + LiDAR alone is a complete workflow.'),
    ]));
    body.append(h('div', { class: 'row' }, h('button', { class: 'btn', disabled: !rgb && !chm, onclick: () => setStep('objects') }, 'Next: Objects')));
  }

  function renderObjects(body: HTMLElement, n: number) {
    const aoi = area.current().aoi;
    body.append(stepHead(n, 'Objects', project ? `${project.count.toLocaleString()} objects` : ''));
    const sp = S.segment;
    if (sp.keepDistinctAbove === undefined) S.segment = { ...sp, keepDistinctAbove: 3 };
    const slider = (label: string, key: keyof SegmentParams, min: number, max: number, step: number, show: (v: number) => string, help: string) => {
      const out = h('output', {}, show(sp[key]));
      return h('label', { class: 'slider3', title: help }, h('span', {}, label), h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(sp[key] ?? min), 'aria-label': label,
        oninput: (e: Event) => { S.segment = { ...S.segment, [key]: +(e.target as HTMLInputElement).value }; out.textContent = show(S.segment[key]); },
        onchange: () => { persist(); render(); } }), out);
    };
    body.append(
      slider('Target object area', 'targetAreaM2', 10, 5000, 10, v => `${v} m²`, 'Approximate: sets the seed spacing. Not the minimum mapping unit.'),
      slider('Compactness', 'compactness', 0.1, 3, 0.1, v => v.toFixed(1), 'Higher: rounder objects; lower: objects follow edges more closely.'),
      slider('Imagery influence', 'imageryWeight', 0, 2, 0.1, v => (v ? v.toFixed(1) : 'off'), 'Weight of the RGB colour channels.'),
      slider('Vegetation-structure influence', 'structureWeight', 0, 2, 0.1, v => (v ? v.toFixed(1) : 'off'), 'Weight of the canopy height model.'),
      slider('Terrain influence', 'terrainWeight', 0, 2, 0.1, v => (v ? v.toFixed(1) : 'off'), 'Weight of slope from the DTM (HRDEM only).'),
      slider('Merge similarity', 'mergeSimilarity', 0, 3, 0.1, v => (v ? v.toFixed(1) : 'off'), 'Neighbours this similar (in reference differences) merge.'),
      slider('Minimum patch area', 'minPatchAreaM2', 0, 2500, 5, v => `${v} m²`, 'A target, not the minimum mapping unit of a final map: small objects are merged into their most similar neighbour unless they differ from all of them (next control).'),
      slider('Keep small objects differing by', 'keepDistinctAbove', 0.5, 8, 0.5, v => `${v.toFixed(1)}×`, 'In reference differences (1× = L* 8, CHM 2 m). A small object unlike every neighbour by more than this — a pond, a rock, a channel — is kept and flagged rather than forced into unrelated cover.'),
    );
    body.append(h('p', { class: 'muted small' }, `Channels: ${[rgb && sp.imageryWeight ? 'L*a*b* colour' : '', chm && sp.structureWeight ? 'CHM' : '', chm?.inputs['lidar:dtm'] && sp.terrainWeight ? 'slope' : ''].filter(Boolean).join(' + ') || 'none'}, each in fixed reference differences (L* 8, a*/b* 6, CHM 2 m, slope 5°), groups weighted by influence / √channels. Sentinel-2 is never a segmentation input.${chm?.inputs['chm:v'] && sp.terrainWeight ? ' A supplied CHM has no DTM, so terrain is off.' : ''}`));
    if (aoi && (rgb || chm)) {
      const est = estimate(planFor(aoi).grid, !!s2);
      body.append(h('p', { class: est.ok ? 'muted small' : 'note small' }, `Full run: ~${fmtMiB(est.bytes)} of ${fmtMiB(est.budget)}${est.ok ? '' : ' — over budget, refused before reading'}.`));
    }
    body.append(h('div', { class: 'row' },
      h('button', { class: 'btn ghost', disabled: !!job || !aoi || (!rgb && !chm), onclick: () => void runObjects('preview') }, 'Preview a window'),
      h('button', { class: 'btn', disabled: !!job || !aoi || (!rgb && !chm), onclick: () => void runObjects('full') }, project ? 'Run on the whole area again' : 'Run on the whole area')));
    if (preview) body.append(h('p', { class: 'note small' }, `Preview: ${preview.count} objects in a ${preview.grid.width} × ${preview.grid.height} window at the real cell size, same algorithm and parameters. ${preview.edgeObjects} objects touch the window's artificial edge and are cut by it. `, h('button', { class: 'chip', onclick: () => { preview = null; paintObjects(); render(); } }, 'Clear preview')));
    body.append(layerToggles());
    if (project && !preview) {
      const m = project.measured;
      body.append(h('p', { class: 'small' }, `${project.count.toLocaleString()} objects · segmentation ${project.segmentationVersion} · ${project.grid.width} × ${project.grid.height} cells · read ${fmt((m.readFineMs as number) / 1000, 1)} s + Sentinel ${fmt((m.readSentinelMs as number) / 1000, 1)} s · segment ${fmt((m.segmentationMs as number) / 1000, 1)} s · features ${fmt((m.featuresMs as number) / 1000, 1)} s · Sentinel stats ${fmt(((m.sentinelMs as number) ?? 0) / 1000, 1)} s (${m.sentinelIntersection}).`));
      const small = project.objects.filter(o => o.flags.includes('below-min-patch')).length;
      if (small) body.append(h('p', { class: 'muted small' }, `${small} objects are below the minimum patch area and kept because they differ from every neighbour (flagged).`));
    }
    body.append(h('div', { class: 'row' }, h('button', { class: 'btn', disabled: !project, onclick: () => setStep('training') }, 'Next: Training')));
  }

  function layerToggles(): HTMLElement {
    const t = (id: RasterLayer, label: string) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: layerOn[id], onchange: (e: Event) => { layerOn[id] = (e.target as HTMLInputElement).checked; if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', layerOn[id] ? 'visible' : 'none'); } }), label);
    const s2on = !!map.getLayer('obia-s2grid') && map.getLayoutProperty('obia-s2grid', 'visibility') === 'visible';
    return h('div', { class: 'layer-toggles' }, t('obia-rgb', 'RGB'), t('obia-chm', 'CHM'), t('obia-objects', 'Objects'), t('obia-quality', 'Quality mask (red: no imagery, blue: no CHM)'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s2on, disabled: !project?.sources.some(s => s.role === 'spectral-context'), onchange: (e: Event) => paintS2Grid((e.target as HTMLInputElement).checked) }), 'Sentinel-2 native 10 m grid'));
  }

  function classPicker(): HTMLElement {
    const classes = project?.classes ?? [];
    return h('div', { class: 'class-list' }, ...classes.map(c => {
      const nT = labels.all().filter(e => e.classId === c.id && e.role === 'training' && !e.pending).length, nV = labels.all().filter(e => e.classId === c.id && e.role === 'validation' && !e.pending).length;
      return h('button', { class: `class-btn${c.id === activeClass ? ' on' : ''}`, title: c.description ?? '', onclick: () => { activeClass = c.id; render(); } },
        h('span', { class: 'swatch', style: `--c:${c.colour}` }), h('span', { class: 'grow' }, c.label), h('span', { class: 'muted share' }, `${nT}${nV ? ` + ${nV}v` : ''}`));
    }));
  }

  function renderTraining(body: HTMLElement, n: number) {
    body.append(stepHead(n, 'Training', `${labels.byRole('training').length} training · ${labels.byRole('validation').length} validation`));
    if (!project) { body.append(h('p', { class: 'note small' }, 'Run Objects first.')); return; }
    if (colourBy !== 'labels') { colourBy = 'labels'; paintObjects(); }
    body.append(segBar('Label role', [{ value: 'training', label: 'Training' }, { value: 'validation', label: 'Held-out validation' }], role, v => { role = v as LabelRole; render(); }));
    body.append(h('p', { class: 'muted small' }, role === 'validation' ? 'Validation labels are never trained on and never offered as "uncertain objects"; they are reported against the final model only.' : 'Tap an object on the map to label it with the chosen class; Shift-tap to select several, then apply.'));
    body.append(classPicker());
    body.append(h('div', { class: 'row' },
      h('button', { class: 'chip', disabled: !selected.size, onclick: () => { applyLabel([...selected]); selected.clear(); paintObjects(); } }, `Label ${selected.size} selected`),
      h('button', { class: 'chip', disabled: !selected.size, onclick: () => { applyLabel([...selected], true); selected.clear(); paintObjects(); } }, 'Clear their labels'),
      h('button', { class: 'chip', disabled: !labels.canUndo, onclick: () => { labels.undo(); labelsChanged(); } }, 'Undo'),
      h('button', { class: 'chip', disabled: !labels.canRedo, onclick: () => { labels.redo(); labelsChanged(); } }, 'Redo')));
    const pend = labels.all().filter(e => e.pending);
    if (pend.length) body.append(h('div', { class: 'note small' }, `${pend.length} labels were carried over from an earlier segmentation by location. They are excluded from training until confirmed. `,
      h('button', { class: 'chip', onclick: () => { labels.apply(pend.map(e => e.objectId), id => { const e = pend.find(x => x.objectId === id)!; const { pending: _, ...rest } = e; void _; return rest; }); labelsChanged(); } }, 'Confirm all'),
      h('button', { class: 'chip', onclick: () => { labels.apply(pend.map(e => e.objectId), () => null); labelsChanged(); } }, 'Drop all')));
    // Class schema.
    const sch = h('details', { class: 'panel' }, h('summary', {}, `Class schema (${project.classes.length})`));
    project.classes.forEach(c => sch.append(h('div', { class: 'row rule-head' },
      h('input', { type: 'color', value: c.colour, 'aria-label': 'Colour', onchange: (e: Event) => { c.colour = (e.target as HTMLInputElement).value; labelsChanged(); } }),
      h('input', { type: 'text', class: 'grow', value: c.label, 'aria-label': 'Class label', onchange: (e: Event) => { c.label = (e.target as HTMLInputElement).value; labelsChanged(); } }),
      h('select', { 'aria-label': 'Parent class', onchange: (e: Event) => { c.parent = (e.target as HTMLSelectElement).value || undefined; labelsChanged(); } }, h('option', { value: '' }, '(top level)'), ...project!.classes.filter(x => x !== c).map(x => h('option', { value: x.id, selected: c.parent === x.id }, `in ${x.label}`))),
      h('button', { class: 'icon', title: 'Delete class', 'aria-label': 'Delete class', disabled: labels.all().some(e => e.classId === c.id), onclick: () => { project!.classes = project!.classes.filter(x => x !== c); labelsChanged(); } }, '✕'),
    ), h('input', { type: 'text', class: 'small', value: c.description ?? '', placeholder: 'Description', 'aria-label': 'Description', onchange: (e: Event) => { c.description = (e.target as HTMLInputElement).value; labelsChanged(); } })));
    const schemaIn = h('input', { type: 'file', accept: '.json', hidden: true, onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
      try {
        const j = JSON.parse(await f.text()) as ClassDef[];
        if (!Array.isArray(j) || !j.every(c => typeof c.id === 'string' && typeof c.label === 'string' && /^#[0-9a-f]{6}$/i.test(c.colour))) throw new Error('expected [{ id, label, colour: "#rrggbb", description?, parent? }]');
        project!.classes = j; labelsChanged();
      } catch (err) { say(`Could not import the schema: ${(err as Error).message}`, 'error'); }
    } });
    sch.append(h('div', { class: 'row' },
      h('button', { class: 'chip', onclick: () => { const id = `class${project!.classes.length + 1}`; project!.classes.push({ id, label: 'New class', colour: PALETTE[project!.classes.length % PALETTE.length] }); labelsChanged(); } }, '+ Class'),
      h('button', { class: 'chip', onclick: () => download('class_schema.json', JSON.stringify(project!.classes, null, 2), 'application/json') }, 'Export'),
      h('button', { class: 'chip', onclick: () => schemaIn.click() }, 'Import'), schemaIn));
    body.append(sch);
    // References.
    const refs = h('details', { class: 'panel', open: !!refFile || review.length > 0 }, h('summary', {}, `Reference polygons and points (${project.references.length})`));
    const refIn = h('input', { type: 'file', accept: '.geojson,.json', hidden: true, onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
      try {
        const fc = JSON.parse(await f.text()) as GeoJSON.FeatureCollection;
        if (fc.type !== 'FeatureCollection') throw new Error('expected a GeoJSON FeatureCollection in lon/lat (RFC 7946)');
        const fields = [...new Set(fc.features.flatMap(ft => Object.keys(ft.properties ?? {})))];
        refFile = { name: f.name, fc, field: fields.find(k => /class|type|label|cover/i.test(k)) ?? fields[0] ?? '' };
        render();
      } catch (err) { say(`Could not read ${f.name}: ${(err as Error).message}`, 'error'); }
    } });
    refs.append(h('p', { class: 'muted small' }, `Originals are kept as imported. A polygon labels an object only when one class covers at least the threshold of it and no two classes overlap in it; the rest are listed for review. Points need the stated assumption below.`),
      h('label', { class: 'row' }, 'Coverage threshold ', h('input', { type: 'number', min: '0.5', max: '1', step: '0.05', value: String(S.refThreshold), style: 'width:64px', onchange: (e: Event) => { S.refThreshold = Math.min(1, Math.max(0.5, +(e.target as HTMLInputElement).value)); persist(); } })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.pointsRepresent, onchange: (e: Event) => { S.pointsRepresent = (e.target as HTMLInputElement).checked; persist(); } }), 'Each reference point represents the whole object it falls in'),
      h('div', { class: 'row' }, h('button', { class: 'chip', onclick: () => refIn.click() }, 'Import GeoJSON…'), refIn, project.references.length ? h('button', { class: 'chip', onclick: () => reapplyReferences() }, 'Re-apply') : null));
    if (refFile) {
      const fields = [...new Set(refFile.fc.features.flatMap(ft => Object.keys(ft.properties ?? {})))];
      const values = [...new Set(refFile.fc.features.map(ft => String(ft.properties?.[refFile!.field] ?? '')))].filter(Boolean);
      refs.append(h('p', { class: 'small' }, `${refFile.name}: ${refFile.fc.features.length} features.`),
        h('label', { class: 'row' }, 'Class field ', h('select', { onchange: (e: Event) => { refFile!.field = (e.target as HTMLSelectElement).value; render(); } }, ...fields.map(k => h('option', { value: k, selected: k === refFile!.field }, k)))),
        h('p', { class: 'muted small' }, `Values: ${values.slice(0, 12).join(', ')}${values.length > 12 ? '…' : ''}. Each becomes the class of the same name (created if missing). Role: ${role}.`),
        h('button', { class: 'chip', onclick: () => {
          const at = refFile!.name;
          for (const v of values) if (!project!.classes.some(c => c.id === v || c.label.toLowerCase() === v.toLowerCase())) project!.classes.push({ id: v, label: v, colour: PALETTE[project!.classes.length % PALETTE.length] });
          const idOf = (v: string) => project!.classes.find(c => c.id === v || c.label.toLowerCase() === v.toLowerCase())!.id;
          let skipped = 0;
          refFile!.fc.features.forEach((ft, i) => {
            const v = String(ft.properties?.[refFile!.field] ?? '');
            const g = ft.geometry;
            const geoms = !v || !g ? [] : g.type === 'Polygon' ? [g] : g.type === 'MultiPolygon' ? g.coordinates.map(c => ({ type: 'Polygon', coordinates: c } as GeoJSON.Polygon)) : g.type === 'Point' ? [g] : [];
            if (!geoms.length) skipped++;
            geoms.forEach((gg, j) => project!.references.push({ id: `${at}#${i}${geoms.length > 1 ? `.${j}` : ''}`, kind: gg.type === 'Point' ? 'point' : 'polygon', classId: idOf(v), role: role === 'validation' ? 'validation' : 'training', geometry: gg as ReferenceFeature['geometry'], file: at, properties: ft.properties ?? {} }));
          });
          refFile = null;
          if (skipped) say(`${skipped} features had no class value or an unsupported geometry and were not imported.`, 'error');
          paintRefs(); reapplyReferences();
        } }, 'Import and assign'));
    }
    if (review.length) {
      refs.append(h('p', { class: 'small' }, `${review.length} objects need review:`));
      for (const r of review.slice(0, 30)) {
        const o = project.objects.find(x => x.id === r.objectId);
        refs.append(h('div', { class: 'row small' }, h('span', { class: 'grow' }, `${r.reason} — ${Object.entries(r.shares).map(([c, s]) => `${c} ${pct(s)}`).join(', ')}`),
          h('button', { class: 'chip', onclick: () => { if (o) { selected.clear(); selected.add(o.index); paintObjects(); zoomToObject(o.index); } } }, 'Show'),
          h('button', { class: 'chip', onclick: () => { const top = Object.entries(r.shares).sort((a, b) => b[1] - a[1])[0][0]; labels.apply([r.objectId], () => ({ objectId: r.objectId, classId: top, role, source: 'manual', at: new Date().toISOString(), x: o?.cx, y: o?.cy })); review = review.filter(x => x !== r); labelsChanged(); } }, 'Accept top class')));
      }
    }
    body.append(refs);
    body.append(h('div', { class: 'row' }, h('button', { class: 'btn', disabled: !labels.byRole('training').length, onclick: () => setStep('classify') }, 'Next: Classification')));
  }

  function reportTable(r: import('../obia/validation.ts').Report, title: string): HTMLElement {
    const wrap = h('div', {}, h('p', { class: 'small' }, h('strong', {}, title), ` — ${r.nObjects} objects in ${r.groups} spatial group${r.groups === 1 ? '' : 's'}${r.folds ? `, ${r.folds} folds` : ''}. Macro-F1 ${fmt(r.macroF1)} (${r.macroF1Classes.length} classes) · accuracy ${pct(r.accuracy)} by object, ${pct(r.areaAccuracy)} by area.`));
    for (const s of r.suppressed) wrap.append(h('p', { class: 'note small' }, s));
    wrap.append(h('div', { class: 'cmp-wrap' }, h('table', { class: 'cmp' },
      h('thead', {}, h('tr', {}, ...['Class', 'n', 'Precision', 'Recall', 'F1', 'Area recall'].map(t => h('th', {}, t)))),
      h('tbody', {}, ...r.perClass.map(m => h('tr', {}, h('td', {}, project?.classes.find(c => c.id === m.cls)?.label ?? m.cls), h('td', {}, String(m.n)),
        ...(m.suppressed ? [h('td', { colspan: '4', class: 'muted' }, `not reported: ${m.suppressed}`)] : [h('td', {}, fmt(m.precision, 2)), h('td', {}, fmt(m.recall, 2)), h('td', {}, fmt(m.f1, 2)), h('td', {}, fmt(m.areaRecall, 2))])))))));
    const cls = r.classes;
    wrap.append(h('details', {}, h('summary', { class: 'small' }, 'Confusion matrix (rows: reference, columns: predicted)'), h('div', { class: 'cmp-wrap' }, h('table', { class: 'cmp' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), ...cls.map(c => h('th', {}, c)))),
      h('tbody', {}, ...r.confusion.map((row, i) => h('tr', {}, h('th', {}, cls[i]), ...row.map(v => h('td', {}, String(v))))))))));
    return wrap;
  }

  function renderClassify(body: HTMLElement, n: number) {
    body.append(stepHead(n, 'Classification', project?.classification ? (stepState('classify') === 'stale' ? 'labels changed since training' : 'trained') : ''));
    if (!project) { body.append(h('p', { class: 'note small' }, 'Run Objects first.')); return; }
    const avail = new Set(project.featureDefs.map(d => d.group));
    body.append(h('div', { class: 'allowed' }, ...GROUPS.map(([g, label]) => h('label', {}, h('input', { type: 'checkbox', checked: S.groups.includes(g), disabled: !avail.has(g), onchange: (e: Event) => { S.groups = (e.target as HTMLInputElement).checked ? [...S.groups, g] : S.groups.filter(x => x !== g); persist(); } }), `${label}${avail.has(g) ? '' : ' (no source)'}`))));
    body.append(h('div', { class: 'row' },
      h('label', { class: 'row' }, 'Spatial block ', h('input', { type: 'number', min: '20', step: '10', value: String(S.blockM), style: 'width:70px', onchange: (e: Event) => { S.blockM = Math.max(20, +(e.target as HTMLInputElement).value); persist(); } }), ' m'),
      h('label', { class: 'row' }, 'Folds ', h('input', { type: 'number', min: '2', max: '10', value: String(S.folds), style: 'width:56px', onchange: (e: Event) => { S.folds = Math.max(2, Math.min(10, +(e.target as HTMLInputElement).value)); persist(); } })),
      h('label', { class: 'row' }, 'Trees ', h('input', { type: 'number', min: '10', max: '500', step: '10', value: String(S.trees), style: 'width:64px', onchange: (e: Event) => { S.trees = Math.max(10, Math.min(500, +(e.target as HTMLInputElement).value)); persist(); } }))));
    body.append(h('p', { class: 'muted small' }, 'Folds are spatial blocks. In each fold, training objects that share a native Sentinel pixel with a test object are left out (a buffer), so no coarse pixel informs both. Missing values: training-fold medians. Identifiers and coordinates are never predictors.'));
    body.append(h('button', { class: 'btn', disabled: !!job || labels.byRole('training').filter(e => !e.pending).length < 2, onclick: () => void classify() }, project.classification ? 'Train and evaluate again' : 'Train and evaluate'));
    const c = project.classification;
    if (!c) return;
    if (c.cv?.reason) body.append(h('p', { class: 'note small' }, `No cross-validation: ${c.cv.reason}.`));
    if (c.cv) body.append(reportTable(c.cv.report, `Spatial cross-validation (${c.features.length} predictors)`));
    if (c.cv?.buffered?.some(x => x > 0)) body.append(h('p', { class: 'muted small' }, `Coarse-support buffer: training objects sharing a Sentinel pixel with the test fold were left out of that fold's training (${c.cv.buffered.join(', ')} per fold).`));
    if (c.ablation) {
      const a = c.ablation, d = (x: number | null, y: number | null) => (x === null || y === null ? '—' : `${y - x >= 0 ? '+' : ''}${(y - x).toFixed(3)}`);
      body.append(h('p', { class: 'small' }, h('strong', {}, 'Ablation, identical folds: '), `RGB + LiDAR macro-F1 ${fmt(a.base.macroF1)} → with Sentinel ${fmt(a.withSentinel.macroF1)} (${d(a.base.macroF1, a.withSentinel.macroF1)}); area accuracy ${pct(a.base.areaAccuracy)} → ${pct(a.withSentinel.areaAccuracy)}. Sentinel is kept only if it earns its place; check the predictions against the Sentinel grid for grid-shaped artefacts.`));
    }
    if (c.validation) body.append(reportTable(c.validation, 'Held-out validation labels'));
    const imp = project.model ? project.model.features.map((f, i) => [f, project!.model!.importance[i]] as const).sort((a, b) => b[1] - a[1]).slice(0, 8) : [];
    if (imp.length) body.append(h('p', { class: 'muted small' }, `Most used predictors (mean decrease in impurity): ${imp.map(([f, v]) => `${f} ${(v * 100).toFixed(0)} %`).join(', ')}.`));
    // Uncertain objects (never validation-labelled ones).
    const labelled = new Set(labels.all().map(e => e.objectId));
    const unc = project.objects.filter(o => o.classScores && !labelled.has(o.id)).map(o => { const v = Object.values(o.classScores!).sort((a, b) => b - a); return { o, m: v[0] - (v[1] ?? 0) }; }).sort((a, b) => a.m - b.m).slice(0, 8);
    if (unc.length) {
      body.append(h('p', { class: 'small' }, h('strong', {}, 'Most uncertain unlabelled objects'), ' (smallest vote margin) — label these next:'));
      for (const { o, m } of unc) body.append(h('div', { class: 'row small' }, h('span', { class: 'grow' }, `${o.id.split(':').pop()} · ${o.predictedClass} · margin ${m.toFixed(2)} · ${fmtArea(o.areaM2)}`),
        h('button', { class: 'chip', onclick: () => { selected.clear(); selected.add(o.index); paintObjects(); zoomToObject(o.index); step = 'training'; render(); } }, 'Label it')));
    }
    body.append(h('p', { class: 'muted small' }, 'Scores are the share of trees voting for a class: model scores, not calibrated probabilities. Classes are candidate mapped units, not regulatory boundaries or confirmed communities.'));
    body.append(h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => setStep('review') }, 'Next: Review & export')));
  }

  function zoomToObject(k: number) {
    if (!project || !proj) return;
    const o = project.objects[k];
    const r = Math.max(30, Math.sqrt(o.areaM2) * 2);
    const a = proj.inverse([o.cx - r, o.cy - r]), b = proj.inverse([o.cx + r, o.cy + r]);
    map.fitBounds([a, b], { duration: 400 });
  }

  function renderReview(body: HTMLElement, n: number) {
    body.append(stepHead(n, 'Review & export', project ? `${project.count.toLocaleString()} objects` : ''));
    if (!project) {
      body.append(h('p', { class: 'note small' }, 'No project yet.'), bundleIn());
      return;
    }
    body.append(h('label', { class: 'row' }, 'Colour objects by ', h('select', { onchange: (e: Event) => { colourBy = (e.target as HTMLSelectElement).value as typeof colourBy; paintObjects(); render(); } },
      ...([['predicted', 'Predicted class (reviewed wins)'], ['condition', 'Condition'], ['labels', 'Labels'], ['none', 'Outlines only']] as const).map(([v, t]) => h('option', { value: v, selected: colourBy === v }, t)))));
    if (colourBy === 'condition') body.append(h('ul', { class: 'legend' }, ...CONDITIONS.map(([id, c, t]) => h('li', {}, h('span', { class: 'swatch', style: `--c:${c}` }), h('span', { class: 'grow' }, t), h('span', { class: 'muted share' }, String(project!.objects.filter(o => conditionsOf(o.index).includes(id)).length))))));
    const s2a = project.sources.find(s => s.role === 'spectral-context'), lid = project.sources.find(s => s.role === 'lidar-feature');
    const gap = days(s2a?.acquiredStart, lid?.acquiredStart);
    if (gap !== null && gap > 365) body.append(h('p', { class: 'note small' }, `Date mismatch (applies to every object): Sentinel-2 ${fmtDate(s2a!.acquiredStart!)} vs LiDAR ${fmtDate(lid!.acquiredStart!)} — ${(gap / 365.25).toFixed(1)} years. Recent spectra do not update older geometry.`));
    if (stepState('review') === 'stale') body.append(h('p', { class: 'note small' }, 'Labels changed since the model was trained: the predictions shown are from the earlier model.'));
    body.append(layerToggles());
    if (inspected !== null && project.objects[inspected]) body.append(inspector(project.objects[inspected]));
    else body.append(h('p', { class: 'muted small' }, 'Tap an object on the map to inspect it.'));
    // Exports.
    const p = project, pr = proj!;
    const ex = h('div', { class: 'panel exports' }, h('strong', {}, 'Export'),
      h('div', { class: 'row' },
        h('button', { class: 'chip', onclick: () => download(`obia_${p.segmentationVersion}.obia.json`, toBundle(p), 'application/json') }, 'Project bundle (reloadable)'),
        h('button', { class: 'chip', onclick: () => download(`objects_${p.segmentationVersion}.geojson`, JSON.stringify({ ...objectsGeoJSON(p, pr), properties: manifest(p) }), 'application/geo+json') }, 'Objects GeoJSON'),
        h('button', { class: 'chip', disabled: !p.objects.some(o => o.predictedClass || o.reviewedClass), onclick: () => download(`classes_dissolved_${p.segmentationVersion}.geojson`, JSON.stringify(dissolvedGeoJSON(p, pr)), 'application/geo+json') }, 'Dissolved by class (GeoJSON)'),
        h('button', { class: 'chip', onclick: () => download(`object_features_${p.segmentationVersion}.csv`, featuresCsv(p), 'text/csv') }, 'Feature CSV'),
        h('button', { class: 'chip', disabled: !p.model, onclick: () => download(`model_${p.segmentationVersion}.json`, modelBundle(p), 'application/json') }, 'Model + preprocessing'),
        h('button', { class: 'chip', onclick: () => download(`segments_${p.segmentationVersion}.tif`, writeGeoTiff(p.grid, p.labels, { nodata: -1, description: `segment ids; ${p.recipeHash}` }), 'image/tiff') }, 'Segment-ID GeoTIFF'),
        h('button', { class: 'chip', disabled: !p.objects.some(o => o.predictedClass || o.reviewedClass), onclick: () => { const c = classRaster(p); download(`classes_${p.segmentationVersion}.tif`, writeGeoTiff(p.grid, c.data, { nodata: 0, description: `class index: ${c.legend.map((id, i) => `${i + 1}=${id}`).join(' ')}` }), 'image/tiff'); } }, 'Class GeoTIFF')),
      h('p', { class: 'muted small' }, 'GeoJSON is EPSG:4326 (RFC 7946); the CSV, the rasters and the bundle are in the analysis CRS, stated in full in the bundle manifest. The GeoTIFFs are plain GeoTIFFs, not Cloud-Optimized. GeoPackage export is not implemented.'));
    body.append(ex);
    const st = h('p', { class: 'muted small' }, '');
    void storageReport().then(t => { st.textContent = t; });
    body.append(h('div', { class: 'panel' }, h('strong', {}, 'Saved on this device'), st,
      h('div', { class: 'row' },
        h('button', { class: 'chip', onclick: async () => { const ok = await requestPersistence(); say(ok ? 'Storage marked persistent.' : 'The browser declined persistent storage.'); render(); } }, 'Ask for persistent storage'),
        bundleIn(),
        h('button', { class: 'chip danger', onclick: async () => { if (!confirm('Delete the saved project from this browser? Export the bundle first to keep it.')) return; await clearProject(); project = null; labels = new LabelStore(); display = {}; for (const id of ['obia-rgb', 'obia-chm', 'obia-quality', 'obia-objects'] as const) removeImage(map, id); render(); } }, 'Delete saved project'))));
  }

  function bundleIn(): HTMLElement {
    const inp = h('input', { type: 'file', accept: '.json', hidden: true, onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
      try { const p = fromBundle(await f.text()); adopt(p); await checkpoint(); say(`Loaded ${f.name}: ${p.count} objects.`); render(); }
      catch (err) { say(`Could not load ${f.name}: ${(err as Error).message}`, 'error'); }
    } });
    return h('span', {}, h('button', { class: 'chip', onclick: () => inp.click() }, 'Open a bundle…'), inp);
  }

  function inspector(o: ObiaProject['objects'][number]): HTMLElement {
    const p = project!;
    const lab = labels.labels.get(o.id);
    const conds = conditionsOf(o.index);
    const wrap = h('div', { class: 'res-card' },
      h('div', { class: 'row res-head' }, h('strong', { class: 'grow' }, `Object ${o.index}`), h('span', { class: 'muted small' }, fmtArea(o.areaM2))),
      h('p', { class: 'small' }, `Predicted: ${o.predictedClass ? p.classes.find(c => c.id === o.predictedClass)?.label ?? o.predictedClass : '—'}${o.reviewedClass ? ` · reviewed: ${p.classes.find(c => c.id === o.reviewedClass)?.label ?? o.reviewedClass}` : ''} · training status: ${lab ? `${lab.role} label "${lab.classId}" (${lab.source}${lab.pending ? ', pending' : ''})` : 'unlabelled'}`));
    if (o.classScores) wrap.append(h('p', { class: 'muted small' }, `Model scores (vote shares, uncalibrated): ${Object.entries(o.classScores).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${v.toFixed(2)}`).join(' · ')}`));
    wrap.append(h('p', { class: 'small' }, 'Conditions: ', conds.length ? conds.map(c => CONDITIONS.find(x => x[0] === c)![2]).join('; ') : 'none flagged'));
    wrap.append(h('table', { class: 'cmp' }, h('thead', {}, h('tr', {}, h('th', {}, 'Support'), h('th', {}, 'Valid'), h('th', {}, 'Native px'), h('th', {}, 'n_eff'), h('th', {}, 'Flags'))),
      h('tbody', {}, ...Object.entries(o.support).map(([k, s]) => h('tr', {}, h('td', {}, k), h('td', {}, pct(s.validFraction)), h('td', {}, s.nativePixelCount === undefined ? '' : String(s.nativePixelCount)), h('td', {}, s.effectivePixelCount === undefined ? '' : s.effectivePixelCount.toFixed(1)), h('td', {}, s.qualityFlags.join(', ')))))));
    wrap.append(h('details', {}, h('summary', { class: 'small' }, `Feature values (${p.featureDefs.length})`), h('table', { class: 'cmp' }, h('tbody', {}, ...p.featureDefs.map(d => h('tr', {}, h('td', { title: `${d.operation}; ${d.sampling}${d.effectiveSupportM ? `; support ${d.effectiveSupportM} m` : ''}` }, d.label), h('td', {}, fmt(o.featureValues[d.id])), h('td', { class: 'muted' }, d.unit)))))));
    wrap.append(h('div', { class: 'row' }, 'Correct to ', h('select', { 'aria-label': 'Reviewed class', onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      o.reviewedClass = v || undefined;
      // A correction is recorded as a REVIEW entry — not a training observation until included.
      if (v && (!lab || lab.role === 'review')) labels.apply([o.id], () => ({ objectId: o.id, classId: v, role: 'review', source: 'review-correction', at: new Date().toISOString(), x: o.cx, y: o.cy }));
      if (!v && lab?.role === 'review') labels.apply([o.id], () => null);
      labelsChanged();
    } }, h('option', { value: '' }, '(no correction)'), ...p.classes.map(c => h('option', { value: c.id, selected: o.reviewedClass === c.id }, c.label))),
      lab?.role === 'review' ? h('button', { class: 'chip', title: 'Make this correction a training observation', onclick: () => { labels.apply([o.id], () => ({ ...lab!, role: 'training', source: 'review-correction' })); labelsChanged(); } }, 'Include in training') : null));
    return wrap;
  }

  // ── Fixture ───────────────────────────────────────────────────────────────

  async function loadFixture() {
    if (job) return;
    const f = fixtureScene();
    const p = projector(f.epsg);
    const ring: [number, number][] = [[f.x0, f.y0], [f.x0 + f.w, f.y0], [f.x0 + f.w, f.y0 - f.h], [f.x0, f.y0 - f.h], [f.x0, f.y0]];
    const aoi: Aoi = { id: 'fixture', name: 'Synthetic fixture', geometry: { type: 'Polygon', coordinates: [ring.map(q => p.inverse(q))] }, source: 'rect', createdAt: new Date().toISOString() };
    const grid: AnalysisGrid = { crs: `EPSG:${f.epsg}`, epsg: f.epsg, cellM: 1, transform: [f.x0, 1, 0, f.y0, 0, -1], width: f.w, height: f.h, pixelConvention: 'area', bounds: [f.x0, f.y0 - f.h, f.x0 + f.w, f.y0] };
    const dispRgb = showImage(map, 'obia-rgb', rgbImage(f.planes.r, f.planes.g, f.planes.b, f.w, f.h), grid, p, 1, true);
    const dispChm = showImage(map, 'obia-chm', chmImage(f.planes.chm, f.w, f.h), grid, p, 0.9, layerOn['obia-chm']);
    const t0 = performance.now();
    const run = runObjectsJob({ grid: { w: f.w, h: f.h, x0: f.x0, y0: f.y0, cellM: 1, epsg: f.epsg }, planes: f.planes, mask: f.mask, params: { ...f.params, mergeSimilarity: 0 }, windowEdge: false, heightBandsM: S.heightBandsM, segmentationVersion: 'fixture-v1', sources: { rgb: 'fixture:rgb', chm: 'fixture:chm', dtm: null }, sentinel: f.sentinel }, () => {});
    job = { label: 'Fixture', stage: 'Segmenting the synthetic scene…', run: run as Running<unknown>, t0 };
    render();
    try {
      const r = await run.promise;
      const recipe: Recipe = { algorithm: OBIA_ALGORITHM_VERSION, aoi: { id: aoi.id, name: aoi.name, geometry: aoi.geometry }, objective: 'fine-patches', epsg: f.epsg, cellM: 1, bufferM: 0, segment: f.params, referenceScales: REFERENCE_SCALES, sources: { rgb: 'fixture:rgb', chm: 'fixture:chm', dtm: null, sentinel: 'fixture:sentinel-2' }, sourceVersions: {}, sentinel: { itemId: 'fixture', ...DEFAULT_SENTINEL }, heightBandsM: S.heightBandsM };
      const at = new Date().toISOString();
      const fx = (id: string, role: SourceAsset['role'], label: string, res: number): SourceAsset => ({ id, role, label: `${label} — ${FIXTURE_LABEL}`, uriReference: 'fixture', nativeResolutionM: [res, res], access: 'analytical', accessNote: FIXTURE_LABEL });
      const s2grid = f.sentinel.rasters[0];
      project = {
        schema: PROJECT_SCHEMA, created: at, updated: at, recipe, recipeHash: recipeHash(recipe), segmentationVersion: 'fixture-v1',
        sources: [fx('fixture:rgb', 'boundary-imagery', 'RGB', 1), fx('fixture:chm', 'lidar-feature', 'CHM', 1), { ...fx('fixture:sentinel-2', 'spectral-context', 'Sentinel-2', 10), grid: { crs: `EPSG:${f.epsg}`, transform: [s2grid.originX, 10, 0, s2grid.originY, 0, -10], width: s2grid.w, height: s2grid.h, pixelConvention: 'area' } }],
        grid, crsDefinition: p.def, labels: r.labels, count: r.count, objects: r.objects, featureDefs: r.featureDefs, coarsePixels: r.coarsePixels,
        classes: [{ id: 'Forest', label: 'Forest', colour: '#1b7837' }, { id: 'Meadow', label: 'Meadow', colour: '#e6c84f' }, { id: 'Water', label: 'Water', colour: '#2166ac' }],
        labelEntries: [], references: fixtureReferences().features.map((ft, i) => ({ id: `fixture#${i}`, kind: 'polygon', classId: String(ft.properties!.class), role: 'training', geometry: ft.geometry as GeoJSON.Polygon, file: 'fixture', properties: ft.properties ?? {} })),
        model: null, classification: null, measured: { totalMs: Math.round(performance.now() - t0), objects: r.count, ...Object.fromEntries(Object.entries(r.stageMs).map(([k, v]) => [`${k}Ms`, Math.round(v)])), sentinelIntersection: r.sentinelExact ? 'exact' : 'approximate' },
      };
      proj = p; labels = new LabelStore(); display = { rgb: dispRgb, chm: dispChm }; fixtureLoaded = true; preview = null;
      activeClass = 'Forest';
      // The fixture is 240 × 160 m: 60 m blocks (one per stand row) give enough spatial groups. Session only, not saved.
      S = { ...S, blockM: 60, folds: 4 };
      paintRefs(); reapplyReferences();
      map.fitBounds(aoiBox(aoi.geometry) as [number, number, number, number], { padding: 60, duration: 500 });
      await checkpoint();
      step = 'training';
      say(`Test fixture loaded: ${r.count} objects; reference polygons applied. ${FIXTURE_LABEL}.`);
    } catch (e) { say(`Fixture failed: ${(e as Error).message}`, 'error'); }
    job = null; render(); paintObjects();
  }

  // Leaving with a job running loses it; say so.
  window.addEventListener('beforeunload', (e) => { if (job) { e.preventDefault(); e.returnValue = ''; } });
  render();
}
