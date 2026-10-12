// The Fusion tab: LiDAR structure and Sentinel-2 spectra in one product, per
// pixel. Three products: a CHM · NDVI · NDWI composite, a custom composite of
// any three variables, and RULE-BASED CLASSES drawn from a rule set the user
// edits (rules.ts). An optional second, leaf-off scene adds seasonal
// variables — the strongest signal there is for broadleaf against conifer.
//
// "Compare samples" is the test bench: tap crowns of two kinds on the map and
// every variable is ranked by how well it separates them (compare.ts), and
// the best cut becomes a pair of rules in one tap.
//
// The tab reads as FieldMapper's HabLab dialogs do: two pages, Set up and
// Results, and Set up in four numbered steps — 1 the study area (studyArea.ts),
// 2 the inputs, 3 the classes (and the pixel preview), 4 the analysis to run
// over the area (analysis.ts). A run lands on the Results page as a card of
// its own.
//
// The inputs are rarely the same date and never the same resolution (1 m
// LiDAR against 10–20 m imagery); both dates are stated beside the product,
// and the classes are called what they are — a screening, not a validated map.

import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import { h, clear, fmtDate } from '../dom.ts';
import { samplePoint, sampleView, viewStats } from '../engine.ts';
import { hideLayer, restyle, updateLayer } from '../mapLayers.ts';
import {
  FUSION_PRODUCTS, FUSION_VARIABLES, customFusionProduct, defaultStyle, needsLeafOff, sharpeningFor, tintProduct, variableById,
  type Product, type ProductStyle, type Variable,
} from '../products.ts';
import {
  OPS, PRESETS, clonePreset, compileRuleSet, parseRuleSet, ruleVariables, usesLeafOff,
  type Condition, type Op, type Rule, type RuleSet,
} from '../rules.ts';
import { compareLabels, niceThreshold, type Sample } from '../compare.ts';
import { CI_VARIANTS, calibrate, calibrations, ciInputs, type Calibration } from '../coniferIndex.ts';
import { DEFAULT_UNMIX } from '../unmix.ts';
import { compileScheme, defaultScheme, parseScheme, type StrataScheme } from '../strata.ts';
import { strataEditor } from './strataEditor.ts';
import { resolveInputs } from '../sources.ts';
import { searchS2, type HrdemItem, type S2Item } from '../stac.ts';
import { stretchPanel, type StretchPanel } from '../ui/stretch.ts';
import { findHrdem } from './rasters.ts';
import { ANCHOR, itemName, mapClaim, shared, type Ctx } from './ctx.ts';
import { variableOptions } from '../ui/variables.ts';
import { ORTHO_SERVICES, orthoPhotoYear, orthoService } from '../xyz.ts';
import { pcStatus } from '../pointcloud/pointCloud.ts';
import { studyAreaStep } from './studyArea.ts';
import { analysisStep } from './analysis.ts';
import { stepHead } from '../ui/steps.ts';
import { aoiBox, polygonMask } from '../aoi.ts';
import { fmtBytes, fmtCount } from '../dom.ts';
import { toc } from '../layers/toc.ts';

const LAYER = 'fusion';
const LS_RULES = 'sv.rules', LS_SAMPLES = 'sv.samples', LS_STRATA = 'sv.strata', LS_SOURCES = 'sv.sources';
const SAMPLE_COLOURS = ['#e66101', '#5e3c99'];

const load = <T>(k: string, fallback: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export function initFusion(ctx: Ctx) {
  const { map, say } = ctx;
  // Which panels are open survives a re-render: the whole tab is rebuilt on
  // every change, and a panel that folds itself shut under the hand that is
  // using it reads as the control having failed.
  const openPanels = new Map<string, boolean>();
  const panelEl = (key: string, title: string, defaultOpen: boolean) => {
    const d = h('details', { class: 'panel', open: openPanels.get(key) ?? defaultOpen }, h('summary', {}, title));
    d.addEventListener('toggle', () => openPanels.set(key, d.open));
    return d;
  };
  const el = document.getElementById('fusion-body')!;
  const pane = document.getElementById('pane-fusion')!;

  let lidarId: string | null = null;
  let sceneId: string | null = null;
  let offId = '';
  let leafOffScenes: S2Item[] = [];
  let mode: 'fusion-sgw' | 'fusion-sharp-fcir' | 'fusion-pcir' | 'fusion-pc-evidence' | 'custom' | 'rules' | 'strata' = 'strata';
  // The point cloud and the orthophoto: device-local choices.
  const src = load<{ ortho: string; pc: boolean; display: 'classes' | 'tint'; alpha: number }>(LS_SOURCES, { ortho: 'nsodb10k', pc: true, display: 'classes', alpha: 0.45 });
  // A stored choice of a reference-only service (Esri basemap tiles) is not honoured.
  let orthoId = orthoService(src.ortho)?.access === 'reference-only' ? '' : src.ortho, usePc = src.pc, display = src.display, tintAlpha = src.alpha;
  const saveSources = () => save(LS_SOURCES, { ortho: orthoId, pc: usePc, display, alpha: tintAlpha });
  let photoYear = '';
  const pcLine = h('p', { class: 'muted small', 'aria-live': 'polite' });
  pcStatus.events.addEventListener('change', () => {
    pcLine.textContent = pcStatus.loading
      ? `Reading the point cloud: ${pcStatus.loading} chunk${pcStatus.loading === 1 ? '' : 's'} in progress…`
      : pcStatus.chunks ? `Point cloud: ${fmtCount(pcStatus.points)} returns read in ${pcStatus.chunks} chunks, ${fmtBytes(pcStatus.bytes)}.${pcStatus.lastError ? ` Last error: ${pcStatus.lastError}` : ''}` : '';
  });
  let scheme: StrataScheme = (() => { try { return parseScheme(load(LS_STRATA, null)); } catch { return defaultScheme(); } })();
  let ciVariant = 'ci';
  let ciReport: Calibration | null = null;
  let custom: [string, string, string] = ['chm', 'ndvi', 'swir16'];
  let rules: RuleSet = (() => { try { return parseRuleSet(load(LS_RULES, null)); } catch { return clonePreset(0); } })();
  let opacity = 1;
  let style: ProductStyle | null = null;
  let product: Product | null = null;
  let panel: StretchPanel | null = null;
  let shown = false;

  const stored = load<{ labels: [string, string]; samples: Sample[] }>(LS_SAMPLES, { labels: ['Broadleaf', 'Conifer'], samples: [] });
  let labels = stored.labels;
  let samples = stored.samples;
  let sampling: string | null = null;
  let showAllRows = false;
  let page: 'setup' | 'results' = 'setup';
  const setSampling = (v: string | null) => {
    sampling = v;
    if (v) mapClaim.owner = 'sample'; else if (mapClaim.owner === 'sample') mapClaim.owner = null;
    map.getCanvas().style.cursor = v ? 'crosshair' : '';
  };
  const area = studyAreaStep(ctx, () => render());
  /** The study area's box, or the view's when no area is ready (drawing). */
  const areaBox = () => { const a = area.current().aoi; return a ? aoiBox(a.geometry) : ctx.viewBox(); };

  const lidar = (): HrdemItem | null => shared.hrdem.find(s => s.id === lidarId) ?? null;
  const allScenes = () => { const m = new Map<string, S2Item>(); for (const s of [...shared.scenes, ...leafOffScenes]) m.set(s.id, s); return [...m.values()]; };
  const scene = () => allScenes().find(s => s.id === sceneId) ?? null;
  const offScene = () => (offId ? allScenes().find(s => s.id === offId) ?? null : null);
  const lidarChoices = () => shared.hrdem.filter(i => i.dsm);
  const items = () => ({ s2: scene(), s2b: offScene(), lidar: lidar(), ortho: orthoService(orthoId), pointCloud: usePc });

  shared.events.addEventListener('scenes', () => { if (!scene()) sceneId = shared.scenes[0]?.id ?? null; render(); });
  shared.events.addEventListener('hrdem', () => { if (!lidar()) lidarId = lidarChoices()[0]?.id ?? null; render(); });

  // ── Inputs ────────────────────────────────────────────────────────────────

  /** The newest LiDAR source with a DSM, the clearest leaf-on scene and the clearest snow-free leaf-off one, for the study area. */
  async function findInputs() {
    say(`Finding LiDAR, a leaf-on scene and a leaf-off scene for ${area.summary()}…`);
    try {
      const vb = areaBox();
      const y = new Date().getFullYear(), years = [y, y - 1, y - 2];
      const search = (windows: [string, string][]) => Promise.all(windows.map(([from, to]) => searchS2({ bbox: vb, from, to, maxCloud: 10, limit: 50 }).catch(() => []))).then(r => r.flat());
      const clearest = (xs: S2Item[]) => [...xs].sort((a, b) => ((a.nodata ?? 0) > 5 ? 1 : 0) - ((b.nodata ?? 0) > 5 ? 1 : 0) || (a.cloud ?? 100) - (b.cloud ?? 100))[0];
      const [lid, on, off] = await Promise.all([
        findHrdem(vb),
        // Leaf-on: June to September.
        search(years.map(yy => [`${yy}-06-01`, `${yy}-09-30`])),
        // Leaf-off and (usually) snow-free in Nova Scotia: late April to mid May, and November.
        search(years.flatMap(yy => [[`${yy}-04-20`, `${yy}-05-20`], [`${yy}-11-01`, `${yy}-11-30`]] as [string, string][])),
      ]);
      leafOffScenes = off.sort((a, b) => b.datetime.localeCompare(a.datetime));
      shared.setHrdem(lid.items);
      shared.setScenes(on.sort((a, b) => b.datetime.localeCompare(a.datetime)));
      sceneId = clearest(on)?.id ?? null;
      offId = clearest(off)?.id ?? '';
      lidarId = lidarChoices()[0]?.id ?? null;
      render();
      const missing = [!lidarId && 'a LiDAR source with a DSM', !sceneId && 'a clear leaf-on scene', !offId && 'a clear leaf-off scene'].filter(Boolean);
      say(missing.length ? `Found no ${missing.join(', no ')} here.` : 'Inputs chosen: newest LiDAR, clearest leaf-on and leaf-off scenes. Change any below.', missing.length ? 'error' : 'info');
    } catch (e) { say(`Could not find inputs: ${(e as Error).message}`, 'error'); }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  const productFor = (): Product => {
    if (mode === 'strata' || mode === 'rules') {
      const base = mode === 'strata' ? compileScheme(scheme) : compileRuleSet(rules);
      return display === 'tint' ? tintProduct(base, tintAlpha) : base;
    }
    return mode === 'custom' ? customFusionProduct(custom) : FUSION_PRODUCTS.find(p => p.id === mode)!;
  };

  async function draw(reseed: boolean) {
    let p: Product;
    try { p = productFor(); } catch (e) { say(`Cannot draw: ${(e as Error).message}.`, 'error'); return; }
    if (mode === 'rules' && !rules.rules.some(r => !r.off && r.when.length)) { say('Add a rule with at least one condition first.', 'error'); return; }
    const keep = !reseed && style && product && product.render === p.render && product.channels.length === p.channels.length && (mode === 'rules' || mode === 'strata' || product.id === p.id);
    product = p;
    style = keep ? style! : defaultStyle(p);
    try {
      const sources = resolveInputs(p.inputs, items());
      const bounds = await updateLayer(map, LAYER, { product: p, sources, style }, ANCHOR.fusion, opacity);
      shown = true;
      const l0 = lidar(), s0 = scene();
      toc().add({
        id: LAYER, title: p.label, subtitle: `Fusion · LiDAR ${l0?.datetime ? fmtDate(l0.datetime) : '—'} · imagery ${s0 ? fmtDate(s0.datetime) : '—'}`, family: 'fusion',
        kind: p.render === 'classes' ? 'classes' : 'raster', mapLayers: [LAYER], bounds, opacity,
        legend: () => p.classes?.length ? h('ul', { class: 'toc-legend' }, ...p.classes.slice(0, 40).map(c => h('li', {}, h('span', { class: 'swatch', style: `--c:${c.colour}` }), c.label))) : null,
        onRemove: () => { hideLayer(map, LAYER); shown = false; panel = null; render(); },
        onOpacity: (o) => { opacity = o; render(); },
        details: () => { (document.querySelector('.tab[data-tab="fusion"]') as HTMLElement | null)?.click(); page = 'setup'; render(); },
      });
      const st = style;
      panel = stretchPanel({ product: p, style: st, stats: () => viewStats(LAYER, ctx.viewBox()), apply: () => restyle(map, LAYER, st) });
      render();
      if (!keep && p.render !== 'classes') { await panel.seed(); restyle(map, LAYER, st); } else void panel.refresh();
      const s = scene(), o = offScene(), l = lidar();
      if (p.inputs.some(k => k.startsWith('ortho:'))) {
        const [lon, lat] = [(ctx.viewBox()[0] + ctx.viewBox()[2]) / 2, (ctx.viewBox()[1] + ctx.viewBox()[3]) / 2];
        photoYear = await orthoPhotoYear(orthoId, lon, lat);
        render();
      }
      say(`${p.label}: LiDAR ${l?.datetime ? fmtDate(l.datetime) : '(undated)'}, imagery ${s ? fmtDate(s.datetime) : '—'}${o && p.inputs.some(k => k.startsWith('s2b:')) ? ` and ${fmtDate(o.datetime)}` : ''}${photoYear && p.inputs.some(k => k.startsWith('ortho:')) ? `, orthophoto ${photoYear}` : ''}.`);
    } catch (e) { say(`Could not draw: ${(e as Error).message}`, 'error'); }
  }

  let ruleTimer = 0;
  /** A rule changed: save it, and repaint (debounced; unchanged inputs repaint from cache). */
  function rulesChanged(redraw = true) {
    save(LS_RULES, rules);
    if (!redraw || mode !== 'rules' || !shown) return;
    clearTimeout(ruleTimer);
    ruleTimer = window.setTimeout(() => void draw(false), 350);
  }

  let schemeTimer = 0;
  /** The strata scheme changed: save it; re-render the editor if its shape changed; repaint (debounced). */
  function schemeChanged(structural: boolean) {
    save(LS_STRATA, scheme);
    if (structural) render();
    if (mode !== 'strata' || !shown) return;
    clearTimeout(schemeTimer);
    schemeTimer = window.setTimeout(() => void draw(false), 350);
  }

  // ── Samples ───────────────────────────────────────────────────────────────

  /** Every variable these inputs can supply. */
  const availableVariables = () => {
    const it = items();
    return FUSION_VARIABLES.filter(v => v.inputs.every(k => (k.startsWith('obj:') ? false : k.startsWith('lidar:') ? !!it.lidar : k.startsWith('s2b:') ? !!it.s2b : k.startsWith('pc:') ? it.pointCloud : k.startsWith('ortho:') ? !!it.ortho : !!it.s2)));
  };

  async function valuesAt(lon: number, lat: number) {
    const vars = availableVariables();
    const sources = resolveInputs([...new Set(vars.flatMap(v => v.inputs))], items());
    return samplePoint(sources, lon, lat, Object.fromEntries(vars.map(v => [v.id, v.channel.fn])), defaultStyle(FUSION_PRODUCTS[0]), 2, sharpeningFor(vars, rules.sharpen ?? DEFAULT_UNMIX));
  }

  const saveSamples = () => { save(LS_SAMPLES, { labels, samples }); paintSamples(); };
  function paintSamples() {
    (map.getSource('samples') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: samples.map(s => ({ type: 'Feature', properties: { colour: SAMPLE_COLOURS[labels.indexOf(s.label)] ?? '#888' }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })),
    });
  }

  map.on('load', () => {
    map.addSource('samples', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'samples', type: 'circle', source: 'samples', paint: { 'circle-radius': 6, 'circle-color': ['get', 'colour'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    paintSamples();
  });

  map.on('click', async (e: MapMouseEvent) => {
    if (!sampling || pane.hidden || mapClaim.owner === 'aoi') return;
    const label = sampling;
    if (!lidar() || !scene()) { say('Choose a LiDAR source and a scene before sampling.', 'error'); return; }
    try {
      const values = await valuesAt(e.lngLat.lng, e.lngLat.lat);
      samples.push({ id: crypto.randomUUID(), label, lon: e.lngLat.lng, lat: e.lngLat.lat, values });
      saveSamples();
      say(`${label} sample ${samples.filter(s => s.label === label).length} added (canopy ${Number.isFinite(values.chm) ? values.chm.toFixed(1) + ' m' : 'n/a'}).`);
      render();
    } catch (err) { say(`Could not sample: ${(err as Error).message}`, 'error'); }
  });

  async function resampleAll() {
    say(`Re-reading ${samples.length} samples with the current inputs…`);
    for (const s of samples) s.values = await valuesAt(s.lon, s.lat);
    saveSamples();
    say('Samples re-read.');
    render();
  }

  /** Turn the best cut of one variable into a pair of rules at the top of the rule set. */
  function useSplit(v: string, threshold: number, aAbove: boolean) {
    const t = niceThreshold(threshold);
    // Restrict to the canopy the samples were taken in, when it is clearly canopy.
    const chms = samples.map(s => s.values.chm).filter(Number.isFinite);
    const minChm = chms.length ? Math.floor(Math.min(...chms)) : 0;
    const base: Condition[] = minChm >= 2 && v !== 'chm' ? [{ v: 'chm', op: '>=', a: minChm }] : [];
    const [opA, opB]: [Op, Op] = aAbove ? ['>', '<='] : ['<', '>='];
    const mk = (label: string, op: Op, colour: string): Rule => ({ label, colour, when: [...base, { v, op, a: t }] });
    rules = { ...rules, rules: [mk(labels[0], opA, SAMPLE_COLOURS[0]), mk(labels[1], opB, SAMPLE_COLOURS[1]), ...rules.rules] };
    mode = 'rules';
    rulesChanged(false);
    void draw(false);
    say(`Added "${labels[0]}" and "${labels[1]}" rules on ${variableById.get(v)?.label} at ${t}.`);
  }

  // ── Conifer index ─────────────────────────────────────────────────────────

  /** Calibrate the chosen conifer-index variant on the woody pixels in view (FieldMapper's method). */
  async function calibrateCi() {
    const v = CI_VARIANTS.find(x => x.id === ciVariant)!;
    if (v.options.leafOff && !offScene()) { say('This variant needs a leaf-off scene.', 'error'); return; }
    if (v.options.ortho && !orthoService(orthoId)) { say('This variant needs an orthophoto: choose one above.', 'error'); return; }
    if (v.options.pointCloud && !usePc) { say('This variant needs the LiDAR point cloud: switch it on above.', 'error'); return; }
    if (!lidar() || !scene()) { say('Choose a LiDAR source and a scene first.', 'error'); return; }
    const where = area.current().aoi;
    say(`Calibrating ${v.label} on the woody pixels of ${where ? `"${where.name}"` : 'the view'}…`);
    try {
      const { inputs, sharpenKeys } = ciInputs(v.options);
      const sources = resolveInputs(inputs, items());
      const { planes, n, grid } = await sampleView(sources, areaBox(), sharpenKeys.length ? { keys: sharpenKeys, params: rules.sharpen ?? DEFAULT_UNMIX } : undefined);
      // Only the area's own pixels inform the calibration.
      if (where) {
        const mask = polygonMask(grid, where.geometry);
        for (const a of Object.values(planes)) if (a.length === n) for (let i = 0; i < n; i++) if (!mask[i]) a[i] = NaN;
      }
      const cal = calibrate(planes, n, v.options);
      if (cal && v.options.pointCloud && !cal.terms.some(t => t.id === 'intensity' && Number.isFinite(t.median))) say('No point-cloud returns were read for this view (no indexed COPC tiles here, or zoomed out past level 13): the index falls back to its other terms.', 'error');
      if (!cal) { say('Too few woody pixels (canopy ≥ 3 m, NDVI ≥ 0.4) in the study area to calibrate. Choose a forested area.', 'error'); return; }
      calibrations.set(v.id, cal);
      ciReport = cal;
      render();
      // Repaint only if what is on the map reads this index — and say the
      // calibration AFTER the redraw, or the redraw's own line replaces it.
      const usesIt = (mode === 'rules' && ruleVariables(rules).some(x => x.id === v.id)) || (mode === 'strata' && scheme.covers.some(cv => cv.when.some(w => w.v === v.id))) || (mode === 'custom' && custom.includes(v.id));
      if (shown && usesIt) await draw(false);
      say(`${v.label} calibrated on ${cal.woodyPixels.toLocaleString()} woody pixels: split at ${cal.threshold.toFixed(2)} z, bimodality ${Number.isFinite(cal.bimodality) ? cal.bimodality.toFixed(2) : 'n/a'}.`);
    } catch (e) { say(`Could not calibrate: ${(e as Error).message}`, 'error'); }
  }

  function renderConiferIndex() {
    const wrap = panelEl('ci', 'Conifer index (FieldMapper method)', !!ciReport);
    wrap.append(h('p', { class: 'muted small' }, 'Each line of evidence becomes a robust z-score over the woody pixels of the study area (canopy ≥ 3 m, NDVI ≥ 0.4), signed so positive means needle-leaved, and averaged by weight; Otsu places the split. Calibrate in each new area: the index describes contrasts within the area, not absolute values.'));
    wrap.append(h('div', { class: 'row' },
      h('select', { class: 'grow', 'aria-label': 'Conifer index variant', onchange: (e: Event) => { ciVariant = (e.target as HTMLSelectElement).value; ciReport = calibrations.get(ciVariant) ?? null; render(); } },
        ...CI_VARIANTS.map(v => {
          const why = v.options.leafOff && !offScene() ? 'needs leaf-off' : v.options.ortho && !orthoService(orthoId) ? 'needs an orthophoto' : v.options.pointCloud && !usePc ? 'needs the point cloud' : '';
          return h('option', { value: v.id, selected: v.id === ciVariant, disabled: !!why }, v.label + (why ? ` (${why})` : ''));
        })),
      h('button', { class: 'btn small-btn', onclick: () => void calibrateCi() }, 'Calibrate to the study area')));
    const cal = ciReport && calibrations.get(ciVariant) === ciReport ? ciReport : null;
    if (cal) {
      const tw = cal.terms.reduce((a, t) => a + t.weight, 0);
      wrap.append(h('table', { class: 'cmp' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Term'), h('th', {}, 'Weight'), h('th', {}, 'Woody median'), h('th', {}, 'Scale'))),
        h('tbody', {}, ...cal.terms.map(t => h('tr', {}, h('td', {}, `${t.sign > 0 ? '+' : '−'} ${t.label}`), h('td', {}, (t.weight / tw).toFixed(2)), h('td', {}, t.median.toFixed(3)), h('td', {}, t.scale.toFixed(3)))))));
      const bi = cal.bimodality;
      wrap.append(h('p', { class: 'small' },
        `${cal.woodyPixels.toLocaleString()} woody pixels · Otsu split at ${cal.threshold.toFixed(2)} z · ${Math.round(cal.coniferShare * 100)} % on the coniferous side · bimodality ${Number.isFinite(bi) ? bi.toFixed(2) : 'n/a'}: `,
        h('strong', {}, bi > 0.555 ? 'two groups are plausible here.' : 'no clear second group — the split is weak; treat the classes as a gradient.')));
    }
    wrap.append(h('button', { class: 'chip', onclick: () => {
      if (rules.rules.length && !confirm('Replace your rules with the conifer-index preset?')) return;
      const preset = clonePreset(PRESETS.findIndex(p => p.name.startsWith('Forest type — conifer index')));
      preset.rules.forEach(r => r.when.forEach(c => { if (c.v === 'ci') c.v = ciVariant; }));
      preset.name = `Forest type — ${CI_VARIANTS.find(v => v.id === ciVariant)!.label}`;
      rules = preset; mode = 'rules'; rulesChanged(false); render();
      if (!calibrations.get(ciVariant)) say('Rules loaded. Press "Calibrate to the study area" before drawing.');
      else void draw(false);
    } }, 'Use as rules (conifer ≥ 0.25 · mixed · broadleaf ≤ −0.25)'));
    return wrap;
  }

  // ── Analysis over the study area ──────────────────────────────────────────

  /** Inputs worth carrying onto every object or cell: whatever the chosen sources can supply. */
  const standardInputs = () => {
    const it = items(), out: string[] = [];
    if (it.lidar?.dsm) out.push('lidar:dsm', 'lidar:dtm');
    if (it.s2) out.push('s2:nir', 's2:red', 's2:green', 's2:blue', 's2:swir16', 's2:rededge1', 's2:nir08');
    if (it.s2b) out.push('s2b:nir', 's2b:red', 's2b:green', 's2b:swir16');
    if (it.pointCloud) out.push('pc:ivg', 'pc:igr', 'pc:int', 'pc:pen', 'pc:att', 'pc:den');
    if (it.ortho) out.push('ortho:r', 'ortho:g', 'ortho:b', 'ortho:tex');
    return out;
  };
  const classProduct = () => { try { return mode === 'strata' ? compileScheme(scheme) : mode === 'rules' ? compileRuleSet(rules) : null; } catch { return null; } };
  const an = analysisStep({
    ctx, area, classProduct,
    sources: (inputs: string[]) => resolveInputs([...new Set([...inputs, ...standardInputs()])], items()),
    signature: () => JSON.stringify({
      classes: mode === 'strata' ? scheme : mode === 'rules' ? rules : null,
      inputs: [lidarId, sceneId, offId, orthoId, usePc],
      cal: [...calibrations].map(([k, c]) => [k, c.threshold, c.woodyPixels]),
    }),
    provenance: () => {
      const l = lidar(), s = scene(), o = offScene(), svc = orthoService(orthoId);
      return [
        l ? `LiDAR ${itemName(l)}${l.datetime ? ` ${fmtDate(l.datetime)}` : ''}` : 'no LiDAR',
        s ? `leaf-on ${fmtDate(s.datetime)}` : 'no scene',
        o ? `leaf-off ${fmtDate(o.datetime)}` : '',
        svc ? `orthophoto ${svc.label}${photoYear ? ` ${photoYear}` : ''}` : '',
        usePc ? 'point cloud' : '',
      ].filter(Boolean).join(' · ') + '.';
    },
    render: () => render(),
    showResults: () => { page = 'results'; render(); pane.scrollTop = 0; },
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  function renderInputs() {
    const scenes = allScenes().sort((a, b) => b.datetime.localeCompare(a.datetime)), lids = lidarChoices();
    const sceneOpt = (s: S2Item, sel: string | null) => h('option', { value: s.id, selected: s.id === sel }, `${fmtDate(s.datetime)} · ${s.cloud?.toFixed(1) ?? '?'}% cloud · ${s.mgrs ?? ''}`);
    const redraw = () => { if (shown) void draw(false); else render(); };
    return h('div', { class: 'form1' },
      h('label', { class: 'field' }, 'LiDAR (structure)', h('select', { onchange: (e: Event) => { lidarId = (e.target as HTMLSelectElement).value; redraw(); } },
        ...(lids.length ? lids.map(i => h('option', { value: i.id, selected: i.id === lidarId }, `${itemName(i)}${i.datetime ? ` · ${fmtDate(i.datetime)}` : ''}`)) : [h('option', { value: '' }, 'Search in Rasters, or Find inputs')]))),
      h('label', { class: 'field' }, 'Leaf-on scene', h('select', { onchange: (e: Event) => { sceneId = (e.target as HTMLSelectElement).value; redraw(); } },
        ...(scenes.length ? scenes.map(s => sceneOpt(s, sceneId)) : [h('option', { value: '' }, 'Search in Imagery, or Find inputs')]))),
      h('label', { class: 'field' }, 'Leaf-off scene (optional, for seasonal change)', h('select', { onchange: (e: Event) => { offId = (e.target as HTMLSelectElement).value; redraw(); } },
        h('option', { value: '', selected: !offId }, 'None'), ...scenes.filter(s => s.id !== sceneId).map(s => sceneOpt(s, offId)))),
      h('label', { class: 'field' }, 'Orthophoto (sub-metre RGB)', h('select', { onchange: (e: Event) => { orthoId = (e.target as HTMLSelectElement).value; photoYear = ''; saveSources(); redraw(); } },
        h('option', { value: '', selected: !orthoId }, 'None'), ...ORTHO_SERVICES.map(o => h('option', { value: o.id, selected: o.id === orthoId, disabled: o.access === 'reference-only', title: o.accessNote }, o.label + (o.access === 'reference-only' ? ' (reference only)' : ''))))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: usePc, onchange: (e: Event) => { usePc = (e.target as HTMLInputElement).checked; saveSources(); redraw(); } }),
        'LiDAR point cloud (intensity, penetration, attenuation — read from the COPC tiles, from zoom 13)'),
      pcLine);
  }

  function renderRuleEditor() {
    const wrap = panelEl('rules', 'Rules', true);
    const presetSel = h('select', { 'aria-label': 'Preset' }, ...PRESETS.map((p, i) => h('option', { value: String(i) }, p.name)));
    wrap.append(h('div', { class: 'row' }, presetSel,
      h('button', { class: 'btn ghost small-btn', onclick: () => { if (rules.rules.length && !confirm('Replace your rules with this preset?')) return; rules = clonePreset(+presetSel.value); rulesChanged(); render(); } }, 'Load preset')));
    wrap.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: rules.maskClouds, onchange: (e: Event) => { rules.maskClouds = (e.target as HTMLInputElement).checked; rulesChanged(); } }), 'Mask cloud, shadow and snow (Sentinel-2 SCL)'));
    if (usesLeafOff(rules) && !offScene()) wrap.append(h('p', { class: 'note small' }, 'These rules use leaf-off variables: choose a leaf-off scene above, or they cannot be drawn.'));
    if (ruleVariables(rules).some(v => v.sharpenKeys)) {
      const sp = rules.sharpen ?? { ...DEFAULT_UNMIX };
      const set = (patch: Partial<typeof sp>) => { rules.sharpen = { ...sp, ...patch }; rulesChanged(); };
      wrap.append(h('div', { class: 'note small' },
        h('strong', {}, 'LiDAR sharpening. '),
        'Sharpened variables are unmixed by canopy height class: ',
        h('input', { type: 'number', step: '0.5', value: String(sp.breaks[0]), 'aria-label': 'First height break (m)', style: 'width:56px', onchange: (e: Event) => set({ breaks: [+(e.target as HTMLInputElement).value, sp.breaks[1] ?? 5].sort((a, b) => a - b) }) }),
        ' and ',
        h('input', { type: 'number', step: '0.5', value: String(sp.breaks[1] ?? 5), 'aria-label': 'Second height break (m)', style: 'width:56px', onchange: (e: Event) => set({ breaks: [sp.breaks[0], +(e.target as HTMLInputElement).value].sort((a, b) => a - b) }) }),
        ' m, over ',
        h('select', { 'aria-label': 'Neighbourhood', onchange: (e: Event) => set({ radius: +(e.target as HTMLSelectElement).value }) },
          ...[1, 2, 3, 4].map(r => h('option', { value: String(r), selected: r === sp.radius }, `${(2 * r + 1) * 10} m`))),
        ' neighbourhoods. Applies from zoom 15, where a Sentinel pixel spans several screen pixels; below it the original values are shown.'));
    }

    rules.rules.forEach((r, i) => {
      const card = h('div', { class: `rule${r.off ? ' rule-off' : ''}` });
      const move = (d: number) => { const j = i + d; if (j < 0 || j >= rules.rules.length) return; const list = [...rules.rules]; [list[i], list[j]] = [list[j], list[i]]; rules.rules = list; rulesChanged(); render(); };
      card.append(h('div', { class: 'row rule-head' },
        h('span', { class: 'rule-n muted' }, `${i + 1}`),
        h('input', { type: 'color', value: r.colour, 'aria-label': 'Colour', onchange: (e: Event) => { r.colour = (e.target as HTMLInputElement).value; rulesChanged(); } }),
        h('input', { type: 'text', class: 'grow', value: r.label, 'aria-label': 'Class name', onchange: (e: Event) => { r.label = (e.target as HTMLInputElement).value; rulesChanged(); } }),
        h('button', { class: 'icon', title: 'Move up', 'aria-label': 'Move up', onclick: () => move(-1) }, '↑'),
        h('button', { class: 'icon', title: 'Move down', 'aria-label': 'Move down', onclick: () => move(1) }, '↓'),
        h('button', { class: 'icon', title: r.off ? 'Turn on' : 'Turn off', 'aria-label': r.off ? 'Turn rule on' : 'Turn rule off', onclick: () => { r.off = !r.off || undefined; rulesChanged(); render(); } }, r.off ? '○' : '●'),
        h('button', { class: 'icon', title: 'Delete rule', 'aria-label': 'Delete rule', onclick: () => { rules.rules = rules.rules.filter(x => x !== r); rulesChanged(); render(); } }, '✕')));
      r.when.forEach((c, j) => {
        const second = h('input', { type: 'number', step: 'any', value: String(c.b ?? c.a), 'aria-label': 'Upper value', hidden: c.op !== 'between', onchange: (e: Event) => { c.b = +(e.target as HTMLInputElement).value; rulesChanged(); } });
        card.append(h('div', { class: 'cond' },
          h('span', { class: 'muted small' }, j ? 'and' : 'if'),
          h('select', { class: 'grow', 'aria-label': 'Variable', onchange: (e: Event) => { c.v = (e.target as HTMLSelectElement).value; rulesChanged(); render(); } }, ...variableOptions(c.v, !!offScene())),
          h('select', { 'aria-label': 'Operator', onchange: (e: Event) => { c.op = (e.target as HTMLSelectElement).value as Op; if (c.op === 'between' && c.b === undefined) c.b = c.a; if (c.op !== 'between') delete c.b; rulesChanged(); render(); } },
            ...OPS.map(o => h('option', { value: o, selected: o === c.op }, o === '>=' ? '≥' : o === '<=' ? '≤' : o))),
          h('input', { type: 'number', step: 'any', value: String(c.a), 'aria-label': 'Value', onchange: (e: Event) => { c.a = +(e.target as HTMLInputElement).value; rulesChanged(); } }),
          second,
          h('button', { class: 'icon', title: 'Remove condition', 'aria-label': 'Remove condition', onclick: () => { r.when.splice(j, 1); rulesChanged(); render(); } }, '✕')));
      });
      card.append(h('button', { class: 'chip', onclick: () => { r.when.push({ v: 'chm', op: '>=', a: 5 }); rulesChanged(); render(); } }, '+ condition'));
      wrap.append(card);
    });

    const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      try { rules = parseRuleSet(JSON.parse(await f.text())); rulesChanged(); render(); say(`Imported "${rules.name}".`); } catch (err) { say(`Could not import: ${(err as Error).message}`, 'error'); }
    } });
    wrap.append(h('div', { class: 'row' },
      h('button', { class: 'chip', onclick: () => { rules.rules.push({ label: 'New class', colour: '#ff7f00', when: [{ v: 'chm', op: '>=', a: 5 }] }); rulesChanged(); render(); } }, '+ Add rule'),
      h('button', { class: 'chip', onclick: () => {
        const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json' })), download: `${(rules.name || 'rules').replace(/[^\w-]+/g, '_')}.json` });
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } }, 'Export JSON'),
      h('button', { class: 'chip', onclick: () => fileIn.click() }, 'Import JSON'), fileIn));
    wrap.append(h('p', { class: 'muted small' }, 'A pixel takes the first rule whose conditions all hold; give two rules the same name and colour to make them one class (an OR). A condition on a variable with no value at the pixel is false.'));
    return wrap;
  }

  function renderSamples() {
    const wrap = panelEl('samples', `Compare samples (${samples.length})`, samples.length > 0 || !!sampling);
    wrap.append(h('p', { class: 'muted small' }, 'Tap points of two kinds on the map (crowns, not gaps) to see which variables tell them apart here. Values are averaged over ±2 m.'));
    wrap.append(h('div', { class: 'row' }, ...labels.map((lab, k) => h('input', {
      type: 'text', value: lab, class: 'grow', 'aria-label': `Label ${k + 1}`, style: `border-left: 6px solid ${SAMPLE_COLOURS[k]}`,
      onchange: (e: Event) => { const nv = (e.target as HTMLInputElement).value.trim() || lab; samples.forEach(s => { if (s.label === lab) s.label = nv; }); labels = [...labels] as [string, string]; labels[k] = nv; saveSamples(); render(); },
    }))));
    wrap.append(h('div', { class: 'row' },
      ...labels.map((lab, k) => h('button', { class: `btn small-btn${sampling === lab ? '' : ' ghost'}`, style: sampling === lab ? `background:${SAMPLE_COLOURS[k]}` : '', onclick: () => { setSampling(sampling === lab ? null : lab); render(); } },
        sampling === lab ? `Tapping: ${lab} — stop` : `Tap ${lab} (${samples.filter(s => s.label === lab).length})`))));
    if (samples.length) {
      wrap.append(h('div', { class: 'row' },
        h('button', { class: 'chip', onclick: () => { samples.pop(); saveSamples(); render(); } }, 'Undo last'),
        h('button', { class: 'chip', onclick: () => void resampleAll() }, 'Re-read with current inputs'),
        h('button', { class: 'chip', onclick: () => { if (confirm('Delete all samples?')) { samples = []; saveSamples(); render(); } } }, 'Clear')));
    }
    const vars = availableVariables().map(v => v.id);
    const rows = compareLabels(samples, labels[0], labels[1], vars);
    if (!rows.length) {
      wrap.append(h('p', { class: 'muted small' }, 'At least two samples of each kind are needed to compare.'));
      return wrap;
    }
    const n = samples.length;
    const fmt = (x: number) => (Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3));
    const table = h('table', { class: 'cmp' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Variable'), h('th', {}, labels[0]), h('th', {}, labels[1]), h('th', { title: "Cohen's d" }, 'd'), h('th', { title: 'Balanced accuracy of the best cut, on these samples' }, 'Acc.'), h('th', {}, ''))),
      h('tbody', {}, ...(showAllRows ? rows : rows.slice(0, 8)).map(r => h('tr', {},
        h('td', {}, variableById.get(r.v)?.label ?? r.v),
        h('td', {}, `${fmt(r.a.mean)} ± ${fmt(r.a.sd)}`),
        h('td', {}, `${fmt(r.b.mean)} ± ${fmt(r.b.sd)}`),
        h('td', {}, Number.isFinite(r.d) ? r.d.toFixed(1) : '∞'),
        h('td', {}, `${Math.round(r.accuracy * 100)} %`),
        h('td', {}, h('button', { class: 'chip', title: `${labels[0]} ${r.aAbove ? '>' : '<'} ${niceThreshold(r.threshold)}`, onclick: () => useSplit(r.v, r.threshold, r.aAbove) }, `Use ${r.aAbove ? '>' : '<'} ${niceThreshold(r.threshold)}`))))));
    wrap.append(h('div', { class: 'cmp-wrap' }, table));
    if (rows.length > 8) wrap.append(h('button', { class: 'chip', onclick: () => { showAllRows = !showAllRows; render(); } }, showAllRows ? 'Show top 8' : `Show all ${rows.length}`));
    wrap.append(h('p', { class: 'muted small' }, `Ranked by the accuracy of the best single cut. Training figures on ${n} samples: they describe these samples, not the map, and they flatter.`));
    return wrap;
  }

  function render() {
    clear(el);
    // Drawing a study area takes the map's taps; sampling stops rather than fight over them.
    if (mapClaim.owner === 'aoi' && sampling) sampling = null;
    const nRes = an.count(), open = an.unanswered();
    el.append(h('div', { class: 'subtabs', role: 'tablist' },
      h('button', { class: `subtab${page === 'setup' ? ' on' : ''}`, role: 'tab', 'aria-selected': String(page === 'setup'), onclick: () => { page = 'setup'; render(); } }, 'Set up'),
      h('button', { class: `subtab${page === 'results' ? ' on' : ''}`, role: 'tab', 'aria-selected': String(page === 'results'), onclick: () => { page = 'results'; render(); } },
        'Results', nRes ? h('span', { class: `subtab-n${open ? ' open' : ''}`, title: open ? `${open} not downloaded` : 'All downloaded' }, String(nRes)) : null)));
    if (page === 'results') { el.append(an.resultsEl()); return; }

    const section = (n: number, title: string, right?: Node | string | null) => {
      const sec = h('section', { class: 'step' }, stepHead(n, title, right));
      el.append(sec);
      return sec;
    };

    section(1, 'Study area', area.summary()).append(area.el());

    const s2 = section(2, 'Inputs');
    s2.append(h('button', { class: 'btn ghost wide', onclick: () => void findInputs() }, 'Find inputs for the study area'), renderInputs());

    const s3 = section(3, 'Classes', mode === 'strata' || mode === 'rules' ? null : 'none — a composite');
    s3.append(h('label', { class: 'field' }, 'Classes or composite', h('select', { onchange: (e: Event) => { mode = (e.target as HTMLSelectElement).value as typeof mode; if (shown) void draw(true); else render(); } },
      h('option', { value: 'strata', selected: mode === 'strata' }, 'Strata × cover classes (editable)'),
      h('option', { value: 'rules', selected: mode === 'rules' }, 'Rule-based classes (editable)'),
      h('option', { value: 'fusion-sgw', selected: mode === 'fusion-sgw' }, FUSION_PRODUCTS[0].label),
      h('option', { value: 'fusion-sharp-fcir', selected: mode === 'fusion-sharp-fcir' }, FUSION_PRODUCTS.find(p => p.id === 'fusion-sharp-fcir')!.label),
      h('option', { value: 'fusion-pcir', selected: mode === 'fusion-pcir' }, FUSION_PRODUCTS.find(p => p.id === 'fusion-pcir')!.label),
      h('option', { value: 'fusion-pc-evidence', selected: mode === 'fusion-pc-evidence' }, FUSION_PRODUCTS.find(p => p.id === 'fusion-pc-evidence')!.label),
      h('option', { value: 'custom', selected: mode === 'custom' }, 'Custom fusion RGB…'))));

    if (mode === 'custom') {
      s3.append(h('div', { class: 'rgbpick' }, ...(['Red', 'Green', 'Blue'] as const).map((c, i) => h('label', { class: 'field' }, c,
        h('select', { onchange: (e: Event) => { custom = [...custom] as [string, string, string]; custom[i] = (e.target as HTMLSelectElement).value; if (shown) void draw(true); } }, ...variableOptions(custom[i], !!offScene()))))));
    }
    if (mode === 'strata' || mode === 'rules') {
      const alphaOut = h('output', {}, `${Math.round(tintAlpha * 100)} %`);
      s3.append(h('div', { class: 'row' },
        h('label', { class: 'row' }, 'Show as ', h('select', { onchange: (e: Event) => { display = (e.target as HTMLSelectElement).value as typeof display; saveSources(); if (shown) void draw(false); else render(); } },
          h('option', { value: 'classes', selected: display === 'classes' }, 'Classes'),
          h('option', { value: 'tint', selected: display === 'tint', disabled: !orthoService(orthoId) }, 'Tint over the orthophoto (4th band)'))),
        display === 'tint' ? h('label', { class: 'row grow' }, 'Tint ', h('input', { type: 'range', min: '0.1', max: '0.9', step: '0.05', value: String(tintAlpha), 'aria-label': 'Tint strength',
          oninput: (e: Event) => { tintAlpha = +(e.target as HTMLInputElement).value; alphaOut.textContent = `${Math.round(tintAlpha * 100)} %`; },
          onchange: () => { saveSources(); if (shown) void draw(false); } }), alphaOut) : null));
    }
    if (mode === 'strata') s3.append(strataEditor({
      scheme, leafOff: !!offScene(), panel: panelEl, say,
      changed: schemeChanged,
      replace: (next) => { scheme = next; schemeChanged(true); },
    }));
    else if (mode === 'rules') s3.append(renderRuleEditor());
    else s3.append(h('p', { class: 'muted small' }, productFor().note));

    s3.append(h('button', { class: 'btn wide', onclick: () => void draw(true) }, shown ? 'Redraw' : 'Preview on the map'));

    if (shown && product && panel) {
      const s = scene(), l = lidar(), o = offScene();
      const usesOrtho = product.inputs.some(k => k.startsWith('ortho:')), usesPc = product.inputs.some(k => k.startsWith('pc:'));
      const svc = orthoService(orthoId);
      if (s && l) s3.append(h('p', { class: 'note small' }, `LiDAR ${l.datetime ? fmtDate(l.datetime) : '(undated)'} · leaf-on ${fmtDate(s.datetime)}${o ? ` · leaf-off ${fmtDate(o.datetime)}` : ''}${usesOrtho && svc ? ` · orthophoto ${photoYear || '(date not stated)'}` : ''}. Anything built, cleared or grown between the dates reads wrongly, and the imagery is 10–20 m against the LiDAR's 1 m.`));
      if (usesOrtho && svc) s3.append(h('p', { class: 'muted small' }, `${svc.attribution}. Computed in your browser from the tiles the service serves; proof of concept, not for redistribution.`));
      if (usesPc) s3.append(h('p', { class: 'muted small' }, 'Point-cloud metrics are per 2–16 m cell (by zoom) on the tiles\' own UTM grid; intensity is uncalibrated, so compare it within one acquisition.'));
      const legendPanel = panelEl('legend', product.render === 'classes' ? 'Classes (share of this view)' : 'Stretch', true);
      legendPanel.append(panel.el);
      if (product.render === 'classes') legendPanel.append(h('button', { class: 'chip', onclick: () => void panel?.refresh() }, 'Recount this view'));
      s3.append(legendPanel);
      s3.append(h('label', { class: 'row' }, 'Opacity', h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(opacity),
        oninput: (e: Event) => toc().applyLayer(LAYER, +(e.target as HTMLInputElement).value),
        onchange: (e: Event) => toc().setOpacity(LAYER, +(e.target as HTMLInputElement).value) })),
        h('button', { class: 'btn ghost small-btn', onclick: () => toc().remove(LAYER) }, 'Remove from map'));
    }
    s3.append(renderConiferIndex());
    s3.append(renderSamples());

    section(4, 'Analysis').append(an.setupEl());
  }

  render();
  map.on('moveend', () => { if (shown) void panel?.refresh(); });
}

