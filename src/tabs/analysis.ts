// Step 4 of the Fusion tab and its RESULTS page — how an analysis of a study
// area is chosen, run and inspected, on FieldMapper's HabLab pattern:
//
//   • ONE tool at a time, picked from a segmented bar (Class areas · Objects ·
//     Feature table), its parameters under it, and ONE Run button that names
//     the area it will run on. A tool that cannot run says why on the bar.
//   • A run's progress and outcome go to a RUN LOG (folded by default), not
//     only to the status line that the next message overwrites.
//   • A run that produced something switches to the RESULTS page. Results
//     ACCUMULATE: every run is its own card and its own map layer, so two
//     areas, or one area under two rule sets, can be compared side by side.
//     They used to share one slot each, and every run replaced the last.
//   • A result is a SNAPSHOT. It records the area by value, the class product,
//     the inputs' dates and the parameters; it says when the classes or the
//     inputs have changed since, and offers to run again on the same ground.
//   • Results live in this tab's memory. Each must be ANSWERED — downloaded or
//     discarded — and leaving the page with one that is neither asks first.
//
// Tapping the map inspects the topmost visible result under the tap.

import maplibregl, { type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl';
import { h } from '../dom.ts';
import { defaultStyle, variableById, variableProduct, type Planes, type Product, type ProductStyle } from '../products.ts';
import type { InputSource } from '../engine.ts';
import { rampTable } from '../paint.ts';
import { aoiAreaM2, fmtArea, pointInAoi, type Aoi } from '../aoi.ts';
import { runClassAreas, type ClassAreaResult } from '../analysis/classAreas.ts';
import { classAreasCsv, tallyClasses, type ClassTally } from '../analysis/tally.ts';
import { clusterInputs, clusterVariables, runClusters, type ClusterParams, type ClusterResult } from '../analysis/clusterRun.ts';
import { clusterProfileCsv } from '../analysis/cluster.ts';
import { DEFAULT_SEGMENT, objectAttributes, pixelAt, segmentGeoJSON, segmentImage, segmentView, type SegmentGrid, type SegmentParams, type SegmentResult } from '../segment/segmentView.ts';
import { buildFeatureTable, type FeatureTable } from '../segment/featureTable.ts';
import { tableCsv, tableGeoParquet } from '../segment/featureTableExport.ts';
import { segBar } from '../ui/steps.ts';
import type { StudyAreaStep } from './studyArea.ts';
import { ANCHOR, mapClaim, type Ctx } from './ctx.ts';
import { toc } from '../layers/toc.ts';
import { aoiBox } from '../aoi.ts';

export type ToolId = 'areas' | 'objects' | 'table' | 'cluster';

export interface AnalysisHost {
  ctx: Ctx;
  area: StudyAreaStep;
  /** The class product (strata or rules) the tools classify with, or null. */
  classProduct(): Product | null;
  /** Sources for these inputs plus every input the inputs in hand can supply. */
  sources(inputs: string[]): Record<string, InputSource>;
  /** What a result depends on besides its area and parameters: the classes and the inputs. */
  signature(): string;
  /** The inputs' dates, for the record. */
  provenance(): string;
  /** Re-render the whole tab. */
  render(): void;
  /** Switch the tab to its Results page. */
  showResults(): void;
}

interface ToolDef { id: ToolId; name: string; blurb: string }
export const ANALYSIS_TOOLS: ToolDef[] = [
  { id: 'areas', name: 'Class areas', blurb: 'The classes of step 3 evaluated at every pixel of the study area (2 m wherever the area allows), with the hectares and share of each. The on-screen legend only ever counts the view, off overview pixels; this is the figure for the area.' },
  { id: 'objects', name: 'Objects', blurb: 'Splits the study area into objects on canopy height and the orthophoto (superpixels, then neighbours merged — or individual tree crowns), averages every input over each object, adds object measures (area, compactness, canopy-height P90 and spread, photo texture) and classifies each object with the classes of step 3. Objects cut by the area\'s outline keep only their inside part. A screening tool: Sentinel-2 values here are fine-grid samples of 10–20 m pixels; for native-support statistics, training and validation use the Objects tab.' },
  { id: 'table', name: 'Feature table', blurb: "One row per cell of Sentinel-2's own pixel grid (the imagery is never resampled), one column per variable: every finer input averaged into the cell, canopy-height P90 and spread, photo texture, the share of the cell in each class of step 3, and H3 ids. Cells less than half inside the area are left out. GeoParquet or CSV." },
  { id: 'cluster', name: 'Unsupervised classes (k-means)', blurb: 'Groups every pixel of the study area by the variables you choose, with no rules and no labels: k-means on standardised variables. Each cluster is reported with its centre in the variables\' own units, so you can name it; a cluster is a statistical group, not a cover type.' },
];

interface Common {
  id: number;
  area: Aoi;
  at: Date;
  ms: number;
  /** The class product's label, or null when there was none. */
  productLabel: string | null;
  sig: string;
  provenance: string;
  visible: boolean;
  opacity: number;
  downloaded: boolean;
  /** Class areas over the study area (Class areas and Objects). */
  tally: ClassTally | null;
  classes: Product['classes'];
}
type Result = Common & (
  | { tool: 'areas'; data: ClassAreaResult }
  | { tool: 'cluster'; data: ClusterResult; params: ClusterParams }
  | { tool: 'objects'; data: SegmentResult; params: SegmentParams; fill: boolean }
  | { tool: 'table'; data: FeatureTable; cellM: 10 | 20; column: string; range: string });

interface LogLine { t: Date; msg: string; level: 'info' | 'ok' | 'error' }

const LS_TOOL = 'sv.tool', LS_SEGMENT = 'sv.segment', LS_CELL = 'sv.table.cell';
const AREAS_SRC = 'result-areas';
const VIRIDIS = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];
const load = <T>(k: string, fallback: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } };
const store = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const fmt = (x: number) => (!Number.isFinite(x) ? '—' : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3));
const hex = (c: string) => [1, 3, 5].map(k => parseInt(c.slice(k, k + 2), 16));
const NO_STYLE = () => defaultStyle({ channels: [] } as unknown as Product);

/** How a run is asked for from outside the step (the Toolbox). */
export interface RunOptions {
  /** The ground to run on (else the step's own study area). */
  area?: Aoi;
  segment?: SegmentParams;
  cellM?: 10 | 20;
  cluster?: ClusterParams;
  /** Instead of switching the Fusion tab to its Results page. */
  onDone?: () => void;
}

export function analysisStep(host: AnalysisHost) {
  const { map, say } = host.ctx;
  /** 'change' whenever a result is added, changed or discarded, or a run starts or ends. */
  const events = new EventTarget();
  const rerender = () => { host.render(); events.dispatchEvent(new Event('change')); };
  let tool: ToolId = load<ToolId>(LS_TOOL, 'areas');
  if (!ANALYSIS_TOOLS.some(t => t.id === tool)) tool = 'areas';
  let segParams: SegmentParams = { ...DEFAULT_SEGMENT, ...load<Partial<SegmentParams>>(LS_SEGMENT, {}) };
  let cellM: 10 | 20 = load<number>(LS_CELL, 10) === 20 ? 20 : 10;
  let results: Result[] = [];
  let nextId = 1;
  let busy: { tool: ToolId; area: string } | null = null;
  let busyLine: HTMLElement | null = null;
  const log: LogLine[] = [];
  let logOpen = false;
  let logEl: HTMLElement | null = null;

  // ── Run log ───────────────────────────────────────────────────────────────

  function note(msg: string, level: LogLine['level'] = 'info') {
    log.push({ t: new Date(), msg, level });
    if (log.length > 200) log.splice(0, log.length - 200);
    say(msg, level === 'error' ? 'error' : 'info');
    if (logEl) fillLog(logEl);
  }
  function fillLog(el: HTMLElement) {
    el.replaceChildren(...log.slice().reverse().map(l => h('li', { class: `log-${l.level}` }, h('span', { class: 'muted' }, l.t.toTimeString().slice(0, 8)), ' ', l.msg)));
  }

  // ── Map ───────────────────────────────────────────────────────────────────

  map.on('load', () => {
    map.addSource(AREAS_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: AREAS_SRC, type: 'line', source: AREAS_SRC, paint: { 'line-color': '#333', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
  });

  const layerId = (r: Result) => `res-${r.id}`;

  function imageOf(r: Result): ImageData {
    if (r.tool === 'objects') return segmentImage(r.data, r.fill);
    if (r.tool === 'areas' || r.tool === 'cluster') {
      const { grid, classOf } = r.data;
      const img = new ImageData(grid.w, grid.h), d = img.data;
      const colour = new Map((r.classes ?? []).map(c => [c.value, hex(c.colour)]));
      for (let i = 0; i < classOf.length; i++) {
        const c = colour.get(classOf[i]);
        if (c) { d[4 * i] = c[0]; d[4 * i + 1] = c[1]; d[4 * i + 2] = c[2]; d[4 * i + 3] = 255; }
      }
      return img;
    }
    const t = r.data;
    const all = [...t.columns, ...t.shares];
    const col = all.find(c => c.name === r.column) ?? all[0];
    const img = new ImageData(t.grid.w, t.grid.h);
    if (!col) return img;
    r.column = col.name;
    const v = [...col.values].filter(Number.isFinite).sort((a, b) => a - b);
    const lo = v[Math.floor(0.02 * (v.length - 1))] ?? 0, hi = v[Math.ceil(0.98 * (v.length - 1))] ?? 1;
    const lut = rampTable(VIRIDIS);
    for (let i = 0; i < t.grid.w * t.grid.h; i++) {
      const row = t.rowOf[i];
      if (row < 0) continue;
      const x = col.values[row];
      if (x !== x) continue;
      const k = Math.max(0, Math.min(255, Math.round(((x - lo) / (hi - lo || 1)) * 255)));
      img.data[4 * i] = lut[3 * k]; img.data[4 * i + 1] = lut[3 * k + 1]; img.data[4 * i + 2] = lut[3 * k + 2]; img.data[4 * i + 3] = 255;
    }
    r.range = `${col.label}: ${fmt(lo)} → ${fmt(hi)} (2nd–98th percentile)`;
    return img;
  }

  const gridOf = (r: Result): SegmentGrid => r.data.grid;

  function draw(r: Result) {
    const img = imageOf(r);
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
    const url = c.toDataURL('image/png');
    const [W, S, E, N] = gridOf(r).box;
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [[W, N], [E, N], [E, S], [W, S]];
    const id = layerId(r);
    // Replaced rather than updateImage()d: an update while the previous image is still decoding aborts it
    // (a rename or a recolour straight after a run). The table of contents keeps the entry's place and switches.
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    map.addSource(id, { type: 'image', url, coordinates });
    map.addLayer({ id, type: 'raster', source: id, layout: { visibility: r.visible ? 'visible' : 'none' }, paint: { 'raster-opacity': r.opacity, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, ANCHOR.fusion);
    register(r);
  }

  /** The result's row in the table of contents (re-registering keeps its place). */
  function register(r: Result) {
    const def = toolDef(r.tool);
    toc().add({
      id: layerId(r), title: `#${r.id} ${def.name}`, subtitle: `${r.area.name}${r.productLabel ? ` · ${r.productLabel}` : ''}`, family: 'result',
      kind: r.tool === 'objects' ? 'objects' : r.tool === 'table' ? 'table' : 'classes', mapLayers: [layerId(r)], bounds: aoiBox(r.area.geometry),
      visible: r.visible, opacity: r.opacity,
      legend: () => r.tally?.rows.length ? h('ul', { class: 'toc-legend' }, ...r.tally.rows.map(row => h('li', {}, h('span', { class: 'swatch', style: `--c:${row.colour}` }), `${row.label} · ${fmtArea(row.areaM2)}`))) : r.tool === 'table' ? h('p', { class: 'muted small' }, r.range) : null,
      details: () => host.showResults(),
      onVisible: (v) => { r.visible = v; paintAreas(); rerender(); },
      onOpacity: (o) => { r.opacity = o; rerender(); },
      onRemove: () => discard(r),
      removeLabel: 'Discard result',
      removeConfirm: r.downloaded ? undefined : `Discard #${r.id} ${def.name}? It has not been downloaded.`,
    });
  }

  /** Take the result's layer off the map; `keepEntry` when it is about to be redrawn in place (Run again). */
  function undraw(r: Result, keepEntry = false) {
    const id = layerId(r);
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    if (!keepEntry) toc().forget(id);
  }

  function paintAreas() {
    (map.getSource(AREAS_SRC) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: results.filter(r => r.visible).map(r => ({ type: 'Feature', properties: { id: r.id }, geometry: r.area.geometry })),
    });
  }

  function setVisible(r: Result, on: boolean) {
    r.visible = on;
    toc().setVisible(layerId(r), on);
    paintAreas();
  }

  // ── Running ───────────────────────────────────────────────────────────────

  const toolDef = (id: ToolId) => ANALYSIS_TOOLS.find(t => t.id === id)!;

  /** Why a tool cannot run now, or ''. */
  function blocked(id: ToolId): string {
    if (id === 'areas' && !host.classProduct()) return 'Class areas need classes: choose Strata × cover or Rule-based classes in step 3.';
    return '';
  }

  /** A per-pixel class image from an object labelling, for the tally. */
  function objectTally(r: SegmentResult): ClassTally | null {
    if (!r.classes || !r.product?.classes) return null;
    const classOf = new Float32Array(r.labels.length).fill(NaN);
    for (let i = 0; i < r.labels.length; i++) if (r.labels[i] >= 0) classOf[i] = r.classes[r.labels[i]];
    return tallyClasses(classOf, r.mask, r.product.classes, r.grid.cellM * r.grid.cellM);
  }

  async function run(id: ToolId, again?: Result, opts: RunOptions = {}) {
    if (busy) return;
    const why = blocked(id);
    if (why) { note(why, 'error'); return; }
    const pick = again ? { aoi: again.area } : opts.area ? { aoi: opts.area, reason: '' } : host.area.current();
    if (!pick.aoi) { note(pick.reason, 'error'); return; }
    const area = pick.aoi;
    const def = toolDef(id);
    busy = { tool: id, area: area.name };
    rerender();
    const stage = (m: string) => { note(m); if (busyLine) busyLine.textContent = m; };
    note(`${def.name} on "${area.name}" (${fmtArea(aoiAreaM2(area.geometry))}) started.`);
    const t0 = performance.now();
    try {
      // Clusters read only their own variables; the class product plays no part.
      const cParams = id === 'cluster' ? (again?.tool === 'cluster' ? again.params : opts.cluster) : undefined;
      if (id === 'cluster' && !cParams) throw new Error('no variables chosen');
      const product = id === 'cluster' ? null : host.classProduct();
      const style = product ? defaultStyle(product) : null;
      const sources = host.sources(id === 'cluster' ? clusterInputs(clusterVariables(cParams!.vars)) : product?.inputs ?? []);
      const base = { id: again?.id ?? nextId++, area, at: new Date(), productLabel: id === 'cluster' ? `k-means, ${cParams!.k} clusters` : product?.label ?? null, sig: host.signature(), provenance: host.provenance(), visible: true, opacity: again?.opacity ?? 0.8, downloaded: false, classes: product?.classes };
      let r: Result;
      if (id === 'cluster') {
        const data = await runClusters(area.geometry, sources, cParams!, stage);
        r = { ...base, tool: 'cluster', data, params: cParams!, classes: data.classes, tally: data.tally, ms: performance.now() - t0 };
      } else if (id === 'areas') {
        const data = await runClassAreas(area.geometry, sources, product!, style!, stage);
        r = { ...base, tool: 'areas', data, tally: data.tally, ms: performance.now() - t0 };
      } else if (id === 'objects') {
        const params = again?.tool === 'objects' ? again.params : { ...(opts.segment ?? segParams) };
        const data = await segmentView(area.geometry, sources, product, style, params, stage);
        r = { ...base, tool: 'objects', data, params, fill: again?.tool === 'objects' ? again.fill : true, tally: objectTally(data), ms: performance.now() - t0 };
      } else {
        const cell = again?.tool === 'table' ? again.cellM : opts.cellM ?? cellM;
        const data = await buildFeatureTable(area.geometry, sources, cell, product, style, stage);
        r = { ...base, tool: 'table', data, cellM: cell, column: again?.tool === 'table' ? again.column : 'chm', range: '', tally: null, ms: performance.now() - t0 };
      }
      if (again) {
        undraw(again, true);
        results = results.map(x => (x === again ? r : x));
      } else results.push(r);
      draw(r);
      paintAreas();
      note(`#${r.id} ${def.name} on "${area.name}": ${summary(r)} in ${(r.ms / 1000).toFixed(1)} s.`, 'ok');
      busy = null;
      if (opts.onDone) { opts.onDone(); events.dispatchEvent(new Event('change')); } else { host.showResults(); events.dispatchEvent(new Event('change')); }
    } catch (e) {
      note(`${def.name} on "${area.name}" failed: ${(e as Error).message}.`, 'error');
      busy = null;
      rerender();
    }
  }

  function summary(r: Result): string {
    if (r.tool === 'cluster') return `${r.data.model.k} clusters on ${r.data.vars.length} variable${r.data.vars.length === 1 ? '' : 's'} over ${fmtArea(r.data.tally.areaM2)} at ${r.data.grid.cellM.toFixed(1)} m; ${(r.data.model.explained * 100).toFixed(0)} % of the variance between clusters${r.data.missingShare > 0.005 ? `; ${(r.data.missingShare * 100).toFixed(1)} % of the area unclassified (a variable missing)` : ''}`;
    if (r.tool === 'areas') return `${r.tally?.rows.length ?? 0} classes over ${fmtArea(r.data.tally.areaM2)} at ${r.data.grid.cellM.toFixed(1)} m`;
    if (r.tool === 'objects') return `${r.data.count.toLocaleString()} ${r.params.method === 'crowns' ? 'crowns' : 'objects'} at ${r.data.grid.cellM.toFixed(1)} m`;
    return `${r.data.rows.length.toLocaleString()} cells × ${r.data.columns.length + r.data.shares.length} variables (${r.data.lattice})`;
  }

  // ── Inspecting ────────────────────────────────────────────────────────────

  const INSPECT = ['chm', 'obj_chm_p90', 'ndvi', 'ndwi', 'o_exg', 'pc_ivg', 'pc_pen', 'pc_att', 'ci6', 'ci'];

  /** Values of the INSPECT variables at one pixel of a set of planes. */
  function valuesAt(planes: Planes, i: number, style: ProductStyle): [string, number][] {
    const have = new Set(Object.keys(planes));
    const out: [string, number][] = [];
    for (const id of INSPECT) {
      const v = variableById.get(id);
      if (!v || v.sharpenKeys || !v.inputs.every(k => have.has(k))) continue;
      const x = v.channel.fn(planes, i, style);
      if (Number.isFinite(x)) out.push([v.label, x]);
    }
    return out;
  }

  map.on('click', (e: MapMouseEvent) => {
    if (mapClaim.owner || (document.getElementById('pane-fusion')!.hidden && document.getElementById('pane-toolbox')?.hidden !== false)) return;
    const { lng, lat } = e.lngLat;
    for (const r of [...results].reverse()) {
      if (!r.visible || !pointInAoi(r.area.geometry, lng, lat)) continue;
      const i = pixelAt(gridOf(r), lng, lat);
      if (i < 0) continue;
      const head = h('div', { class: 'muted small' }, `#${r.id} ${toolDef(r.tool).name} · ${r.area.name}`);
      let body: HTMLElement | null = null;
      if (r.tool === 'cluster') {
        const c = r.data.classOf[i];
        const cls = r.classes?.find(x => x.value === c);
        const vals = r.data.vars.map(v => [v.label, v.channel.fn(r.data.planes, i, defaultStyle(variableProduct(v)))] as [string, number]);
        body = h('div', {}, h('strong', {}, cls ? cls.label : 'Unclassified (a variable missing)'),
          h('table', {}, ...vals.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, fmt(v))))));
      } else if (r.tool === 'areas') {
        const c = r.data.classOf[i];
        const cls = r.classes?.find(x => x.value === c);
        const style = defaultStyle(r.data.product);
        body = h('div', {}, h('strong', {}, cls ? cls.label : 'Unclassified'),
          h('table', {}, ...valuesAt(r.data.planes, i, style).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, fmt(v))))));
      } else if (r.tool === 'objects') {
        const k = r.data.labels[i];
        if (k < 0) continue;
        const style = r.data.product ? defaultStyle(r.data.product) : NO_STYLE();
        const cls = r.data.classes ? r.classes?.find(c => c.value === r.data.classes![k]) : undefined;
        const want = ['obj_area', 'chm', 'obj_chm_p90', 'obj_chm_sd', 'ndvi', 'o_exg', 'obj_tex', 'pc_ivg', 'pc_pen', 'pc_att', 'obj_compact', 'ci6', 'ci'];
        const attrs = objectAttributes(r.data, style).filter(a => want.includes(a.id)).sort((a, b) => want.indexOf(a.id) - want.indexOf(b.id));
        body = h('div', {}, h('strong', {}, `${cls ? cls.label : 'Unclassified'} · object ${k + 1}`),
          h('table', {}, ...attrs.map(a => h('tr', {}, h('th', {}, a.label), h('td', {}, fmt(a.values[k]))))));
      } else {
        const t = r.data, row = t.rowOf[i];
        if (row < 0) continue;
        const cols = [...t.columns, ...t.shares];
        const show = [r.column, 'chm', 'ndvi', 'pc_ivg', 'pc_pen', 'pc_att', 'o_exg', 'obj_chm_p90', ...t.shares.map(s => s.name)];
        const seen = new Set<string>();
        const rows = show.filter(n => !seen.has(n) && seen.add(n)).map(n => cols.find(c => c.name === n)).filter(Boolean).map(c => h('tr', {}, h('th', {}, c!.label), h('td', {}, fmt(c!.values[row]))));
        const cell = t.rows[row];
        body = h('div', {}, h('strong', {}, `Cell ${t.epsg}:${t.cellM}:${cell.ix}:${cell.iy}`), h('table', {}, ...rows));
      }
      new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(e.lngLat).setDOMContent(h('div', { class: 'popup' }, head, body)).addTo(map);
      return;
    }
  });

  // ── Downloads ─────────────────────────────────────────────────────────────

  const slug = (s: string) => s.replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'area';
  function save(name: string, body: BlobPart, type: string) {
    const a = h('a', { href: URL.createObjectURL(new Blob([body], { type })), download: name });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const runLabel = (r: Result) => `#${r.id} ${toolDef(r.tool).name}`;

  async function download(r: Result, what: 'areas' | 'geojson' | 'parquet' | 'csv' | 'profile') {
    const stem = `${slug(r.area.name)}_${r.tool}_${r.id}`;
    try {
      if (what === 'profile' && r.tool === 'cluster') {
        const areas = r.data.classes.map(c => r.tally?.rows.find(x => x.value === c.value)?.areaM2 ?? 0);
        save(`${stem}_cluster_profiles.csv`, clusterProfileCsv(r.data.model, r.data.classes.map(c => c.label), r.data.vars, areas), 'text/csv');
      } else if (what === 'areas' && r.tally) save(`${stem}_class_areas.csv`, classAreasCsv(r.tally, { run: runLabel(r), area: r.area.name, product: r.productLabel ?? '' }), 'text/csv');
      else if (what === 'geojson' && r.tool === 'objects') {
        note('Tracing object outlines…');
        await new Promise(res => setTimeout(res, 0));
        const fc = segmentGeoJSON(r.data, r.data.product ? defaultStyle(r.data.product) : NO_STYLE());
        save(`${stem}.geojson`, JSON.stringify({ ...fc, properties: { study_area: r.area.name, run: runLabel(r), classes: r.productLabel, made: r.at.toISOString(), inputs: r.provenance } }), 'application/geo+json');
        note(`Exported ${fc.features.length.toLocaleString()} objects with ${Object.keys(fc.features[0]?.properties ?? {}).length} attributes each.`, 'ok');
      } else if ((what === 'parquet' || what === 'csv') && r.tool === 'table') {
        note(`Writing ${what === 'parquet' ? 'GeoParquet' : 'CSV'}…`);
        const body = what === 'parquet' ? await tableGeoParquet(r.data) : await tableCsv(r.data);
        save(`${stem}_${r.data.cellM}m.${what}`, body, what === 'parquet' ? 'application/vnd.apache.parquet' : 'text/csv');
        note(`Downloaded ${r.data.rows.length.toLocaleString()} cells.`, 'ok');
      } else return;
      r.downloaded = true;
      rerender();
    } catch (e) { note(`Could not write: ${(e as Error).message}`, 'error'); }
  }

  function downloadAllAreas() {
    const withTally = results.filter(r => r.tally);
    const csv = withTally.map((r, k) => classAreasCsv(r.tally!, { run: runLabel(r), area: r.area.name, product: r.productLabel ?? '' }, k === 0)).join('\n');
    save('class_areas_all_runs.csv', csv, 'text/csv');
    withTally.forEach(r => { if (r.tool === 'areas') r.downloaded = true; });
    rerender();
  }

  function discard(r: Result) {
    undraw(r);
    results = results.filter(x => x !== r);
    paintAreas();
    rerender();
  }

  const unanswered = () => results.filter(r => !r.downloaded).length;
  window.addEventListener('beforeunload', (e) => { if (unanswered()) { e.preventDefault(); e.returnValue = ''; } });

  // ── Step 4: choose and run ────────────────────────────────────────────────

  function setupEl(): HTMLElement {
    const wrap = h('div', { class: 'step-body' });
    wrap.append(segBar('Analysis', ANALYSIS_TOOLS.map(t => ({ value: t.id, label: t.name, disabled: blocked(t.id) || undefined })), tool, v => { tool = v as ToolId; store(LS_TOOL, tool); rerender(); }));
    const why = blocked(tool);
    wrap.append(h('p', { class: 'muted small' }, toolDef(tool).blurb));
    if (tool === 'objects') wrap.append(...segmentParamsEl());
    if (tool === 'table') wrap.append(h('label', { class: 'row' }, 'Cell ', h('select', { 'aria-label': 'Cell size', onchange: (e: Event) => { cellM = +(e.target as HTMLSelectElement).value as 10 | 20; store(LS_CELL, cellM); } },
      h('option', { value: '10', selected: cellM === 10 }, '10 m (Sentinel-2 10 m pixels)'),
      h('option', { value: '20', selected: cellM === 20 }, '20 m (Sentinel-2 20 m pixels)'))));
    if (why) wrap.append(h('p', { class: 'note small' }, why));
    if (!host.classProduct() && tool !== 'areas') wrap.append(h('p', { class: 'muted small' }, 'Without classes in step 3 the result carries every variable but no class.'));
    const where = host.area.current();
    wrap.append(h('button', { class: 'btn wide', disabled: !!busy || !!why || !where.aoi, onclick: () => void run(tool) },
      busy ? `Running ${toolDef(busy.tool).name} on ${busy.area}…` : where.aoi ? `Run ${toolDef(tool).name} on ${host.area.summary()}` : where.reason));
    busyLine = h('p', { class: 'muted small', 'aria-live': 'polite', hidden: !busy });
    wrap.append(busyLine);
    wrap.append(logPanel());
    return wrap;
  }

  function logPanel(): HTMLElement {
    const d = h('details', { class: 'panel runlog', open: logOpen }, h('summary', {}, `Run log${log.length ? ` (${log.length})` : ''}`));
    d.addEventListener('toggle', () => { logOpen = d.open; });
    logEl = h('ul', { class: 'log' });
    fillLog(logEl);
    d.append(logEl);
    return d;
  }

  function segmentParamsEl(): HTMLElement[] {
    const persist = () => store(LS_SEGMENT, segParams);
    const slider = (label: string, key: 'sizeM' | 'merge' | 'compactness' | 'minTreeM', min: number, max: number, step: number, show: (v: number) => string) => {
      const out = h('output', {}, show(segParams[key]));
      return h('label', { class: 'row' }, `${label} `, h('input', {
        type: 'range', min: String(min), max: String(max), step: String(step), value: String(segParams[key]), class: 'grow', 'aria-label': label,
        oninput: (e: Event) => { segParams = { ...segParams, [key]: +(e.target as HTMLInputElement).value }; out.textContent = show(segParams[key]); },
        onchange: persist,
      }), out);
    };
    const els: HTMLElement[] = [
      segBar('Objects', [{ value: 'patches', label: 'Patches' }, { value: 'crowns', label: 'Tree crowns' }], segParams.method, v => { segParams = { ...segParams, method: v as SegmentParams['method'] }; persist(); rerender(); }),
      h('label', { class: 'row' }, 'Object height ', h('select', { class: 'grow', 'aria-label': 'Object height', onchange: (e: Event) => { segParams = { ...segParams, heightStat: (e.target as HTMLSelectElement).value as SegmentParams['heightStat'] }; persist(); } },
        h('option', { value: 'mean', selected: segParams.heightStat === 'mean' }, 'Mean canopy height'),
        h('option', { value: 'p90', selected: segParams.heightStat === 'p90' }, '90th percentile (the canopy, not its gaps)'))),
    ];
    if (segParams.method === 'crowns') els.push(slider('Minimum tree height', 'minTreeM', 2, 10, 0.5, v => `${v} m`), h('p', { class: 'muted small' }, 'Crowns need ~1 m pixels: a study area under about 2.7 km².'));
    else els.push(
      slider('Superpixel size', 'sizeM', 4, 40, 1, v => `${v} m`),
      slider('Merge', 'merge', 0, 3, 0.1, v => (v ? v.toFixed(1) : 'off')),
      slider('Compactness', 'compactness', 0.2, 2, 0.1, v => v.toFixed(1)));
    return els;
  }

  // ── Results page ──────────────────────────────────────────────────────────

  function classTable(t: ClassTally): HTMLElement {
    const list = h('ul', { class: 'legend' });
    for (const row of t.rows) list.append(h('li', {},
      h('span', { class: 'swatch', style: `--c:${row.colour}` }), h('span', { class: 'grow' }, row.label),
      h('span', { class: 'muted share' }, fmtArea(row.areaM2)), h('span', { class: 'share pct' }, `${(row.share * 100).toFixed(row.share < 0.01 ? 1 : 0)} %`)));
    if (t.unclassifiedM2 > 0) list.append(h('li', { class: 'muted' }, h('span', { class: 'swatch', style: '--c:transparent' }), h('span', { class: 'grow' }, 'Unclassified'), h('span', { class: 'share' }, fmtArea(t.unclassifiedM2)), h('span', { class: 'share pct' }, '')));
    return list;
  }

  /**
   * The clusters as a table to NAME them from: each row a cluster (its colour
   * and name editable), its area and share, and its centre in every variable's
   * own units. Renaming relabels the map, the legend and the downloads.
   */
  function clusterProfile(r: Result & { tool: 'cluster' }): HTMLElement {
    const d = r.data, m = d.model;
    const renamed = () => {
      r.tally = d.tally = tallyClasses(d.classOf, d.mask, d.classes, d.grid.cellM * d.grid.cellM);
      r.classes = d.classes;
      draw(r);
    };
    const head = h('tr', {}, h('th', {}, ''), h('th', {}, 'Name'), h('th', {}, 'Area'), ...d.vars.map(v => h('th', { title: v.label }, v.id)));
    const rows = d.classes.map((c, k) => {
      const row = d.tally.rows.find(x => x.value === c.value);
      return h('tr', {},
        h('td', {}, h('input', { type: 'color', value: c.colour, 'aria-label': `Colour of ${c.label}`, class: 'cl-colour', onchange: (e: Event) => { c.colour = (e.target as HTMLInputElement).value; renamed(); } })),
        h('td', {}, h('input', { type: 'text', value: c.label, 'aria-label': `Name of cluster ${k + 1}`, class: 'cl-name', onchange: (e: Event) => { c.label = (e.target as HTMLInputElement).value.trim() || `Cluster ${k + 1}`; renamed(); events.dispatchEvent(new Event('change')); } })),
        h('td', {}, row ? `${fmtArea(row.areaM2)} · ${(row.share * 100).toFixed(row.share < 0.01 ? 1 : 0)} %` : '—'),
        ...m.centresRaw[k].map(v => h('td', {}, fmt(v))));
    });
    return h('div', { class: 'cmp-wrap' },
      h('p', { class: 'muted small' }, `Cluster centres in each variable's own units${r.params.standardise ? ' (clustered on z-scores, so every variable counts equally)' : ' (clustered on raw values: variables with large numbers dominate)'}. Name each cluster from its profile and what you know of the ground: a cluster is a statistical group, not a cover type.`),
      h('table', { class: 'cmp cl-table' }, h('thead', {}, head), h('tbody', {}, ...rows)),
      d.missingShare > 0.005 ? h('p', { class: d.missingShare > 0.2 ? 'note small' : 'muted small' }, `${(d.missingShare * 100).toFixed(1)} % of the area is unclassified because a variable has no value there: `,
        d.vars.map((v, j) => `${v.label} ${(d.coverage[j] * 100).toFixed(0)} %`).join(', '), ' of the area covered. ',
        d.vars.some((v, j) => v.id.startsWith('pc_') && d.coverage[j] < 0.9) ? 'Point-cloud metrics exist only where enough returns of their kind fall (vegetation intensity only over vegetation > 0.5 m, attenuation only under ≥ 2 m of canopy); leave them out to classify the whole area.' : '') : null,
      h('p', { class: 'muted small' }, `${m.valid.toLocaleString()} pixels with every variable; centres fitted on ${m.sampled.toLocaleString()} (seed ${r.params.seed}), ${m.iterations} iteration${m.iterations === 1 ? '' : 's'}${m.converged ? '' : ' (stopped before converging)'}. ${(m.explained * 100).toFixed(0)} % of the variance lies between clusters.`));
  }

  function card(r: Result): HTMLElement {
    const stale = r.sig !== host.signature();
    const def = toolDef(r.tool);
    const el = h('div', { class: `res-card${r.visible ? '' : ' res-hidden'}` });
    el.append(h('div', { class: 'row res-head' },
      h('button', { class: 'icon', 'aria-pressed': String(r.visible), title: r.visible ? 'Hide on the map' : 'Show on the map', 'aria-label': r.visible ? 'Hide on the map' : 'Show on the map', onclick: () => { setVisible(r, !r.visible); rerender(); } }, r.visible ? '◉' : '○'),
      h('span', { class: 'grow res-title' }, h('strong', {}, `#${r.id} ${def.name}`), ' ', h('span', { class: 'muted' }, `· ${r.area.name}`)),
      h('span', { class: 'muted small' }, r.at.toTimeString().slice(0, 5)),
      r.downloaded ? h('span', { class: 'badge ok', title: 'Downloaded' }, '✓') : h('span', { class: 'badge', title: 'Not downloaded yet' }, 'new')));
    el.append(h('p', { class: 'small' }, `${summary(r)} · ${fmtArea(aoiAreaM2(r.area.geometry))} area · ${(r.ms / 1000).toFixed(1)} s`));
    el.append(h('p', { class: 'muted small' }, `${r.productLabel ? `Classes: ${r.productLabel}. ` : 'No classes. '}${r.provenance}`));
    if (stale) el.append(h('div', { class: 'note small' }, 'The classes or inputs have changed since this run. ',
      h('button', { class: 'chip', disabled: !!busy, onclick: () => void run(r.tool, r) }, 'Run again on this area')));
    if (r.tool === 'cluster') el.append(clusterProfile(r));
    else if (r.tally && r.tally.rows.length) el.append(classTable(r.tally));
    else if (r.tool !== 'table' && !r.tally) el.append(h('p', { class: 'muted small' }, 'Not classified (no classes were chosen in step 3).'));
    if (r.tool === 'objects') el.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: r.fill, onchange: (e: Event) => { r.fill = (e.target as HTMLInputElement).checked; draw(r); } }), 'Fill by class (else outlines only)'));
    if (r.tool === 'table') {
      const t = r.data;
      el.append(h('label', { class: 'field' }, 'Show column on the map', h('select', { onchange: (e: Event) => { r.column = (e.target as HTMLSelectElement).value; draw(r); rerender(); } },
        ...[...t.columns, ...t.shares].map(c => h('option', { value: c.name, selected: c.name === r.column }, c.label)))));
      const stops = VIRIDIS.map((c, i) => `${c} ${(i / (VIRIDIS.length - 1)) * 100}%`).join(',');
      el.append(h('div', { class: 'ramp' }, h('div', { class: 'ramp-bar', style: `background: linear-gradient(to right, ${stops})` })), h('p', { class: 'muted small' }, r.range));
    }
    el.append(h('label', { class: 'row' }, 'Opacity ', h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(r.opacity), class: 'grow', 'aria-label': 'Opacity',
      oninput: (e: Event) => toc().applyLayer(layerId(r), +(e.target as HTMLInputElement).value),
      onchange: (e: Event) => toc().setOpacity(layerId(r), +(e.target as HTMLInputElement).value) })));
    const actions = h('div', { class: 'row' }, h('button', { class: 'chip', onclick: () => host.area.zoomTo(r.area) }, 'Zoom to'));
    if (r.tally) actions.append(h('button', { class: 'chip', onclick: () => void download(r, 'areas') }, 'Class areas CSV'));
    if (r.tool === 'cluster') actions.append(h('button', { class: 'chip', onclick: () => void download(r, 'profile') }, 'Cluster profiles CSV'));
    if (r.tool === 'objects') actions.append(h('button', { class: 'chip', onclick: () => void download(r, 'geojson') }, 'Objects GeoJSON'));
    if (r.tool === 'table') actions.append(h('button', { class: 'chip', onclick: () => void download(r, 'parquet') }, 'GeoParquet'), h('button', { class: 'chip', onclick: () => void download(r, 'csv') }, 'CSV'));
    if (r.area.source === 'view' && !host.area.isSaved(r.area.id)) actions.append(h('button', { class: 'chip', title: 'Keep this ground as a study area to run other tools on', onclick: () => {
      const name = prompt('Name for this study area', 'View area');
      if (name === null) return;
      const saved = host.area.save(r.area, name);
      for (const x of results) if (x.area.id === r.area.id) x.area = saved;
      note(`Saved "${saved.name}" as a study area.`, 'ok');
      rerender();
    } }, 'Save area'));
    if (!stale) actions.append(h('button', { class: 'chip', disabled: !!busy, title: 'Run the same tool and parameters on this area again', onclick: () => void run(r.tool, r) }, 'Run again'));
    actions.append(h('button', { class: 'chip danger', onclick: () => discard(r) }, 'Discard'));
    el.append(actions);
    return el;
  }

  function resultsEl(): HTMLElement {
    const wrap = h('div', { class: 'results' });
    if (!results.length) {
      wrap.append(h('p', { class: 'muted' }, busy ? `Running ${toolDef(busy.tool).name} on ${busy.area}…` : 'No results yet. Choose a study area and an analysis in Set up, then Run.'));
      return wrap;
    }
    const open = unanswered();
    wrap.append(h('p', { class: 'small' }, `Each run is kept as its own layer, newest on top; tap the map to inspect what is under it. Results live in this tab until you leave: download what you need. ${open ? `${open} not downloaded yet.` : 'All downloaded.'}`));
    const head = h('div', { class: 'row' });
    if (results.filter(r => r.tally).length > 1) head.append(h('button', { class: 'chip', onclick: downloadAllAreas }, 'Class areas of every run (CSV)'));
    head.append(h('button', { class: 'chip', onclick: () => { const on = !results.every(r => r.visible); results.forEach(r => setVisible(r, on)); rerender(); } }, results.every(r => r.visible) ? 'Hide all' : 'Show all'));
    head.append(h('button', { class: 'chip danger', onclick: () => { if (open && !confirm(`Discard every result? ${open} ha${open === 1 ? 's' : 've'} not been downloaded.`)) return; for (const r of results) undraw(r); results = []; paintAreas(); rerender(); } }, 'Discard all'));
    wrap.append(head);
    for (const r of [...results].reverse()) wrap.append(card(r));
    return wrap;
  }

  return {
    setupEl,
    resultsEl,
    events,
    /** Run a tool from outside the step (the Toolbox), on an explicit area and parameters. */
    runTool: (id: ToolId, opts: RunOptions) => run(id, undefined, opts),
    blocked,
    busy: () => busy,
    log: () => log as readonly LogLine[],
    count: () => results.length,
    unanswered,
    isBusy: () => !!busy,
  };
}
