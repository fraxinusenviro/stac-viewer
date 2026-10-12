// The TOOLBOX tab: every analysis in one hierarchy — toolboxes › toolsets ›
// tools (toolbox/catalog.ts) — and one dialog per tool drawn from its
// contract, in three numbered steps:
//
//   1 Inputs      a picker per declared input; a required one missing stops
//                 the Run button with the reason. LiDAR, scenes, orthophoto,
//                 point cloud and classes are the Fusion tab's WORKSPACE
//                 (shared.workspace): chosen here or there, they are one set.
//                 The study area is this tab's own.
//   2 Parameters  rendered from the specs, defaults stated, remembered per
//                 tool on this device.
//   3 Output      what it makes and where it goes.
//
// Raster outputs become layers in the map's Layers panel (with their stretch
// in the row's fold); analysis outputs (class areas, objects, feature table)
// land on this tab's Results page with their downloads; the Objects workflow
// tools open the Objects tab at their step.

import { h, clear, fmtDate } from '../dom.ts';
import { viewStats } from '../engine.ts';
import { hideLayer, restyle, showLayer } from '../mapLayers.ts';
import { FUSION_PRODUCTS, FUSION_VARIABLES, RASTER_PRODUCTS, customFusionProduct, defaultStyle, hasStretch, imageryProduct, variableById, variableProduct, type Product, type ProductStyle } from '../products.ts';
import { resolveInputs } from '../sources.ts';
import { stretchPanel, type StretchPanel } from '../ui/stretch.ts';
import { stepHead } from '../ui/steps.ts';
import { aoiBox } from '../aoi.ts';
import { pcStatus } from '../pointcloud/pointCloud.ts';
import { clusterInputs, clusterVariables } from '../analysis/clusterRun.ts';
import { TOOLS, defaultParams, missingInput, searchTools, toolById, toolTree, type InputKind, type InputSpec, type ParamSpec, type ToolSpec } from '../toolbox/catalog.ts';
import type { ToolId } from './analysis.ts';
import { findHrdem } from './rasters.ts';
import { studyAreaStep } from './studyArea.ts';
import { ANCHOR, itemName, shared, type Ctx, type Workspace } from './ctx.ts';
import { toc } from '../layers/toc.ts';
import type { Family } from '../layers/tocModel.ts';
import type { SegmentParams } from '../segment/segmentView.ts';

type Value = string | number | boolean;
interface Output { id: string; tool: ToolSpec; name: string; params: Record<string, Value>; inputs: string; panel: StretchPanel | null; at: Date }

const LS_PARAMS = 'sv.tb.params', LS_OPEN = 'sv.tb.open', LS_TOOL = 'sv.tb.tool';
const load = <T>(k: string, f: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : f; } catch { return f; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

/** Variables a Variable map or a custom RGB can draw: everything but the per-object measures (those exist only after segmentation). */
const DRAWABLE = FUSION_VARIABLES.filter(v => !v.inputs.some(k => k.startsWith('obj:')));

export function initToolbox(ctx: Ctx) {
  const { map, say } = ctx;
  const el = document.getElementById('toolbox-body')!;
  const pane = document.getElementById('pane-toolbox')!;
  let page: 'tools' | 'results' = 'tools';
  let toolId: string | null = load<string | null>(LS_TOOL, null);
  if (toolId && !toolById.has(toolId)) toolId = null;
  let query = '';
  const open = new Set<string>(load<string[]>(LS_OPEN, [TOOLS[0].path[0]]));
  const helpOpen = new Set<string>();
  const params: Record<string, Record<string, Value>> = load(LS_PARAMS, {});
  const outputs: Output[] = [];
  let seq = 0;
  let busy: string | null = null;
  let searching = '';
  const log: { t: Date; msg: string; level: 'info' | 'ok' | 'error' }[] = [];
  const area = studyAreaStep(ctx, () => render(), { prefix: 'tb-aoi', pane: 'pane-toolbox' });

  const ws = (): Workspace => {
    if (!shared.workspace) throw new Error('the Fusion workspace is not ready');
    return shared.workspace;
  };
  const note = (msg: string, level: 'info' | 'ok' | 'error' = 'info') => { log.push({ t: new Date(), msg, level }); if (log.length > 100) log.shift(); say(msg, level === 'error' ? 'error' : 'info'); };
  const paramsOf = (t: ToolSpec) => ({ ...defaultParams(t), ...(params[t.id] ?? {}) });
  const setParam = (t: ToolSpec, id: string, v: Value) => { params[t.id] = { ...(params[t.id] ?? {}), [id]: v }; save(LS_PARAMS, params); };

  // Re-render when the workspace, the analysis results or the search results change — but not while this tab is hidden.
  const soon = (() => { let q = false; return () => { if (q) return; q = true; queueMicrotask(() => { q = false; if (!pane.hidden) render(); }); }; })();
  for (const ev of ['workspace', 'hrdem', 'scenes']) shared.events.addEventListener(ev, soon);
  queueMicrotask(() => shared.workspace?.analysis.events.addEventListener('change', soon));
  shared.events.addEventListener('toolbox-open', (e) => {
    const d = (e as CustomEvent).detail as string;
    if (d === 'results') page = 'results';
    else if (toolById.has(d)) { page = 'tools'; toolId = d; save(LS_TOOL, toolId); }
    render();
  });
  document.querySelector('.tab[data-tab="toolbox"]')?.addEventListener('click', () => render());
  map.on('moveend', () => { for (const o of outputs) void o.panel?.refresh(); });

  // ── Inputs ────────────────────────────────────────────────────────────────

  /** Is an input of this kind present in the workspace (or this tab)? */
  function have(kind: InputKind): boolean {
    const w = shared.workspace;
    if (kind === 'area') return !!area.current().aoi;
    if (!w) return false;
    const it = w.items();
    switch (kind) {
      case 'lidar': return !!it.lidar;
      case 'lidar-dsm': return !!it.lidar?.dsm;
      case 'scene': return !!it.s2;
      case 'scene-off': return !!it.s2b;
      case 'ortho': return !!it.ortho;
      case 'pointcloud': return !!it.pointCloud;
      case 'classes': return !!w.classProduct();
    }
  }

  /** Inputs are searched for the study area when the open tool runs on one, else for the view (raster tools draw the view). */
  const usesArea = () => !!(toolId && toolById.get(toolId)?.inputs.some(i => i.kind === 'area'));
  const searchWhere = () => (usesArea() && area.current().aoi ? 'the study area' : 'this view');
  const searchBox = () => { const a = usesArea() ? area.current().aoi : null; return a ? aoiBox(a.geometry) : ctx.viewBox(); };

  async function searchLidar() {
    searching = 'lidar'; render();
    try {
      const r = await findHrdem(searchBox(), say);
      shared.setHrdem(r.items);
      note(`${r.items.length} HRDEM source${r.items.length === 1 ? '' : 's'} cover ${searchWhere()}.`, 'ok');
    } catch (e) { note(`LiDAR search failed: ${(e as Error).message}`, 'error'); }
    searching = ''; render();
  }

  async function findInputs() {
    searching = 'all'; render();
    try { await ws().findInputs(searchBox()); } catch (e) { note(`Could not find inputs: ${(e as Error).message}`, 'error'); }
    searching = ''; render();
  }

  function inputRow(i: InputSpec): HTMLElement {
    const w = shared.workspace;
    const ok = have(i.kind);
    const badge = h('span', { class: `badge${ok ? ' ok' : ''}` }, ok ? 'ready' : i.required ? 'needed' : 'optional');
    const head = h('div', { class: 'row res-head' }, h('strong', { class: 'grow' }, i.label), badge);
    const box = h('div', { class: `tb-input${ok || !i.required ? '' : ' missing'}` }, head);
    if (i.note) box.append(h('p', { class: 'muted small' }, i.note));
    if (i.kind === 'area') { box.append(area.el()); return box; }
    if (!w) { box.append(h('p', { class: 'note small' }, 'The Fusion workspace has not loaded.')); return box; }
    const ids = w.ids();
    const sel = (label: string, value: string, opts: [string, string, boolean?][], pick: (v: string) => void) =>
      h('label', { class: 'field' }, label, h('select', { onchange: (e: Event) => pick((e.target as HTMLSelectElement).value) },
        ...opts.map(([v, l, dis]) => h('option', { value: v, selected: v === value, disabled: !!dis }, l))));
    if (i.kind === 'lidar' || i.kind === 'lidar-dsm') {
      const list = i.kind === 'lidar-dsm' ? w.lidarChoices() : shared.hrdem;
      box.append(sel('Source', ids.lidar ?? '', list.length ? list.map(it => [it.id, `${itemName(it)}${it.datetime ? ` · ${fmtDate(it.datetime)}` : ''}${it.dsm ? '' : ' · DTM only'}`]) : [['', 'None found yet — search below']], v => w.set({ lidar: v || null })),
        h('div', { class: 'row' }, h('button', { class: 'chip', disabled: !!searching, onclick: () => void searchLidar() }, searching === 'lidar' ? 'Searching…' : `Search ${searchWhere()}`)));
    } else if (i.kind === 'scene' || i.kind === 'scene-off') {
      const scenes = w.scenes();
      const opt = (s: typeof scenes[number]): [string, string] => [s.id, `${fmtDate(s.datetime)} · ${s.cloud?.toFixed(1) ?? '?'}% cloud · ${s.mgrs ?? ''}`];
      if (i.kind === 'scene') box.append(sel('Scene', ids.scene ?? '', scenes.length ? scenes.map(opt) : [['', 'None found yet — find inputs below']], v => w.set({ scene: v || null })));
      else box.append(sel('Scene', ids.off, [['', 'None'], ...scenes.filter(s => s.id !== ids.scene).map(opt)], v => w.set({ off: v })));
      box.append(h('div', { class: 'row' }, h('button', { class: 'chip', disabled: !!searching, onclick: () => void findInputs() }, searching === 'all' ? 'Finding…' : `Find LiDAR, a leaf-on and a leaf-off scene for ${searchWhere()}`),
        h('span', { class: 'muted small' }, 'or search in the Imagery tab.')));
    } else if (i.kind === 'ortho') {
      box.append(sel('Service', ids.ortho, [['', 'None'], ...w.orthoServices().map(o => [o.id, o.label] as [string, string])], v => w.set({ ortho: v })));
    } else if (i.kind === 'pointcloud') {
      box.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ids.pc, onchange: (e: Event) => w.set({ pc: (e.target as HTMLInputElement).checked }) }), 'Read the point cloud'));
      if (pcStatus.chunks || pcStatus.loading) box.append(h('p', { class: 'muted small' }, pcStatus.loading ? `Reading ${pcStatus.loading} chunk${pcStatus.loading === 1 ? '' : 's'}…` : `${pcStatus.points.toLocaleString()} returns read so far.`));
    } else if (i.kind === 'classes') {
      const p = w.classProduct();
      box.append(h('p', { class: 'small' }, p ? `${p.label} — ${p.classes?.length ?? 0} classes.` : 'None: Fusion ▸ Classes shows a composite, not classes.'),
        h('div', { class: 'row' }, h('button', { class: 'chip', onclick: () => w.openClasses() }, p ? 'Edit the classes' : 'Choose classes')));
    }
    return box;
  }

  // ── Parameters ────────────────────────────────────────────────────────────

  function variableOptions(): { value: string; label: string; group: string }[] {
    return DRAWABLE.map(v => ({ value: v.id, label: v.label, group: v.group }));
  }

  function paramRow(t: ToolSpec, p: ParamSpec, v: Value): HTMLElement {
    const help = p.help ? h('span', { class: 'muted small' }, p.help) : null;
    if (p.type === 'check') return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!v, onchange: (e: Event) => setParam(t, p.id, (e.target as HTMLInputElement).checked) }), p.label, help);
    if (p.type === 'variables') {
      // A checklist of every pixel variable, grouped; at least `min`, at most `max`.
      const chosen = new Set(String(v).split(',').filter(Boolean));
      const groups = new Map<string, typeof DRAWABLE>();
      for (const x of DRAWABLE) (groups.get(x.group) ?? groups.set(x.group, []).get(x.group)!).push(x);
      const count = h('span', { class: 'muted small' }, `${chosen.size} chosen`);
      const list = h('div', { class: 'tb-vars' });
      for (const [g, vs] of groups) {
        list.append(h('div', { class: 'tb-vars-group small' }, g));
        for (const x of vs) list.append(h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: chosen.has(x.id), onchange: (e: Event) => {
          if ((e.target as HTMLInputElement).checked) chosen.add(x.id); else chosen.delete(x.id);
          // Keep the catalogue's order, so the first variable (which numbers the clusters) is stable.
          setParam(t, p.id, DRAWABLE.filter(y => chosen.has(y.id)).map(y => y.id).join(','));
          count.textContent = `${chosen.size} chosen${chosen.size < p.min ? ` — choose at least ${p.min}` : chosen.size > p.max ? ` — at most ${p.max}` : ''}`;
        } }), x.label));
      }
      return h('div', { class: 'field' }, h('span', {}, p.label, ' ', count), list, help);
    }
    if (p.type === 'range') {
      const out = h('output', {}, `${v}${p.unit ? ` ${p.unit}` : ''}`);
      return h('label', { class: 'row' }, `${p.label} `, h('input', {
        type: 'range', min: String(p.min), max: String(p.max), step: String(p.step), value: String(v), class: 'grow', 'aria-label': p.label,
        oninput: (e: Event) => { out.textContent = `${(e.target as HTMLInputElement).value}${p.unit ? ` ${p.unit}` : ''}`; },
        onchange: (e: Event) => setParam(t, p.id, +(e.target as HTMLInputElement).value),
      }), out, help);
    }
    // Variable pickers are filled from the variable catalogue, grouped.
    const options = p.options.length ? p.options.map(o => ({ ...o, group: '' })) : variableOptions();
    const groups = new Map<string, typeof options>();
    for (const o of options) (groups.get(o.group) ?? groups.set(o.group, []).get(o.group)!).push(o);
    const opt = (o: { value: string; label: string }) => h('option', { value: o.value, selected: o.value === v }, o.label);
    return h('label', { class: 'field' }, p.label, h('select', { onchange: (e: Event) => { setParam(t, p.id, (e.target as HTMLSelectElement).value); render(); } },
      ...[...groups].map(([g, os]) => (g ? h('optgroup', { label: g }, ...os.map(opt)) : os.map(opt))).flat()), help);
  }

  /** Parameters that matter for the current choice (the Objects tool's patch-only and crown-only sliders). */
  function relevant(t: ToolSpec, p: ParamSpec, values: Record<string, Value>): boolean {
    if (t.id === 'fusion.objects') {
      if (values.method === 'crowns' && ['sizeM', 'merge', 'compactness'].includes(p.id)) return false;
      if (values.method !== 'crowns' && p.id === 'minTreeM') return false;
    }
    return true;
  }

  /** For a tool clustering on chosen variables: which input the choice needs and is not set, or ''. */
  function variableInputsMissing(t: ToolSpec, v: Record<string, Value>): string {
    if (t.id !== 'fusion.cluster' || !shared.workspace) return '';
    const ids = String(v.variables ?? '').split(',').filter(Boolean);
    if (!ids.length) return 'Choose at least one variable to cluster on.';
    if (ids.length > 12) return 'Choose at most 12 variables.';
    try { resolveInputs(clusterInputs(clusterVariables(ids)), shared.workspace.items()); return ''; }
    catch (e) { return `The chosen variables need an input that is not set: ${(e as Error).message.replace(/^this product needs /, '')}.`; }
  }

  // ── Running ───────────────────────────────────────────────────────────────

  /** The product a raster tool draws, from its fixed settings and parameters. */
  function productFor(t: ToolSpec, v: Record<string, Value>): Product {
    switch (t.runner) {
      case 'raster-product': {
        const id = t.fixed!.mode === 'chm' ? 'chm' : `${v.surface}-${t.fixed!.mode}`;
        const p = RASTER_PRODUCTS.find(x => x.id === id);
        if (!p) throw new Error(`no product ${id}`);
        return p;
      }
      case 'pc-metric':
      case 'variable-map': {
        const vv = variableById.get(String(t.runner === 'pc-metric' ? v.metric : v.variable));
        if (!vv) throw new Error('choose a variable');
        return variableProduct(vv);
      }
      case 'product': {
        const p = FUSION_PRODUCTS.find(x => x.id === t.fixed!.product);
        if (!p) throw new Error(`no product ${t.fixed!.product}`);
        return p;
      }
      case 's2-product': {
        const p = imageryProduct(String(t.fixed?.product ?? v.product));
        if (!p) throw new Error(`no imagery product ${v.product}`);
        return p;
      }
      case 'fusion-rgb': return customFusionProduct([String(v.r), String(v.g), String(v.b)]);
      default: throw new Error(`${t.name} does not draw a raster`);
    }
  }

  const familyOf = (t: ToolSpec): Family => (t.path[0].startsWith('LiDAR rasters') ? 'raster' : t.path[0].startsWith('Sentinel') ? 'imagery' : 'result');

  function describe(t: ToolSpec, v: Record<string, Value>): string {
    return t.params.filter(p => relevant(t, p, v)).map(p => {
      const val = v[p.id];
      if (p.type === 'select') return `${p.label}: ${(p.options.length ? p.options : variableOptions()).find(o => o.value === val)?.label ?? val}`;
      if (p.type === 'range') return `${p.label}: ${val}${p.unit ? ` ${p.unit}` : ''}`;
      if (p.type === 'variables') return `${p.label}: ${String(val).split(',').map(id => variableById.get(id)?.label ?? id).join(', ')}`;
      return `${p.label}: ${val ? 'yes' : 'no'}`;
    }).join(' · ');
  }

  async function runRaster(t: ToolSpec, v: Record<string, Value>) {
    const w = ws();
    const p = productFor(t, v);
    const it = w.items();
    // Raster tools read only what the product names; a missing input is named.
    const sources = resolveInputs(p.inputs, it);
    const style: ProductStyle = { ...defaultStyle(p), ...(typeof v.zFactor === 'number' ? { zFactor: v.zFactor } : {}), ...(typeof v.azimuth === 'number' ? { azimuth: v.azimuth } : {}) };
    const id = `tb-${++seq}`;
    const name = `${t.name === 'Return metric' || t.name === 'Variable map' || t.name === 'Band composite' || t.name === 'Spectral index' ? p.label : t.name}`;
    const inputs = [p.inputs.some(k => k.startsWith('lidar:')) && it.lidar ? itemName(it.lidar) : '', p.inputs.some(k => k.startsWith('s2:')) && it.s2 ? `S2 ${fmtDate(it.s2.datetime)}` : '', p.inputs.some(k => k.startsWith('s2b:')) && it.s2b ? `S2 ${fmtDate(it.s2b.datetime)}` : '', p.inputs.some(k => k.startsWith('pc:')) ? 'point cloud' : '', p.inputs.some(k => k.startsWith('ortho:')) && it.ortho ? it.ortho.label : ''].filter(Boolean).join(' · ');
    note(`${t.name}: drawing ${name}…`);
    const bounds = await showLayer(map, id, { product: p, sources, style }, ANCHOR.fusion);
    const o: Output = { id, tool: t, name, params: v, inputs, panel: null, at: new Date() };
    if (hasStretch(p) || p.render === 'relief' || p.render === 'classes') {
      o.panel = stretchPanel({ product: p, style, stats: () => viewStats(id, ctx.viewBox()), apply: () => restyle(map, id, style) });
      if (p.render !== 'classes') { await o.panel.seed(); restyle(map, id, style); } else void o.panel.refresh();
    }
    outputs.push(o);
    toc().add({
      id, title: name, subtitle: `${t.path[0]} › ${t.name}${inputs ? ` · ${inputs}` : ''}`, family: familyOf(t), kind: p.render === 'classes' ? 'classes' : 'raster', mapLayers: [id], bounds,
      legend: () => o.panel ? h('div', {}, h('p', { class: 'muted small' }, p.note), o.panel.el) : h('p', { class: 'muted small' }, p.note),
      details: () => { (document.querySelector('.tab[data-tab="toolbox"]') as HTMLElement | null)?.click(); page = 'results'; render(); },
      onRemove: () => { hideLayer(map, id); outputs.splice(outputs.indexOf(o), 1); render(); },
    });
    note(`${name}: on the map (Layers panel). ${p.note}`, 'ok');
  }

  async function run(t: ToolSpec) {
    if (busy) return;
    const v = paramsOf(t);
    const why = missingInput(t, k => have(k));
    if (why) { note(`${t.name}: ${why}`, 'error'); return; }
    busy = t.id; render();
    try {
      if (t.runner === 'analysis') {
        const a = area.current().aoi!;
        const segment: SegmentParams = { method: v.method as SegmentParams['method'], heightStat: v.heightStat as SegmentParams['heightStat'], sizeM: +v.sizeM, merge: +v.merge, compactness: +v.compactness, minTreeM: +v.minTreeM };
        const tool = t.fixed!.tool as ToolId;
        const blocked = ws().analysis.blocked(tool);
        if (blocked) throw new Error(blocked);
        note(`${t.name} on "${a.name}"…`);
        const vars = String(v.variables ?? '').split(',').filter(Boolean);
        if (t.id === 'fusion.cluster' && (vars.length < 1 || vars.length > 12)) throw new Error('choose between 1 and 12 variables to cluster on');
        const cluster = t.id === 'fusion.cluster' ? { vars, k: +v.k, seed: +v.seed, standardise: !!v.standardise } : undefined;
        await ws().analysis.runTool(tool, { area: a, segment: t.id === 'fusion.objects' ? segment : undefined, cellM: t.id === 'fusion.table' ? (+v.cellM === 20 ? 20 : 10) : undefined, cluster, onDone: () => { page = 'results'; } });
      } else if (t.runner === 'objects-tab') {
        (document.querySelector('.tab[data-tab="obia"]') as HTMLElement | null)?.click();
        shared.events.dispatchEvent(new CustomEvent('obia-step', { detail: t.fixed!.step }));
      } else await runRaster(t, v);
    } catch (e) { note(`${t.name} failed: ${(e as Error).message}`, 'error'); }
    busy = null; render();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function helpEl(t: ToolSpec): HTMLElement {
    const row = (k: string, v?: string) => (v ? h('p', { class: 'small' }, h('strong', {}, `${k}. `), v) : null);
    return h('div', { class: 'tb-help' }, row('Purpose', t.help.purpose), row('Method', t.help.method), row('Reading the result', t.help.reading), row('Cautions', t.help.cautions),
      h('p', { class: 'muted small' }, `Inputs: ${t.inputs.map(i => `${i.label}${i.required ? '' : ' (optional)'}`).join('; ') || 'none'}. Outputs: ${t.outputs.map(o => o.label).join('; ')}.`));
  }

  function toolRow(t: ToolSpec, withPath: boolean): HTMLElement {
    const why = missingInput(t, k => have(k));
    const info = helpOpen.has(t.id);
    const row = h('div', { class: 'tb-tool' },
      h('div', { class: 'row tb-tool-line' },
        h('button', { class: 'tb-tool-name', onclick: () => { toolId = t.id; save(LS_TOOL, toolId); render(); pane.scrollTop = 0; } },
          h('strong', {}, t.name), withPath ? h('span', { class: 'muted small' }, ` ${t.path.join(' › ')}`) : null,
          h('span', { class: 'muted small tb-tool-sum' }, t.summary)),
        h('button', { class: 'icon', 'aria-expanded': String(info), title: 'About this tool', 'aria-label': `About ${t.name}`, onclick: () => { if (info) helpOpen.delete(t.id); else helpOpen.add(t.id); render(); } }, 'i')),
      why ? h('p', { class: 'muted small tb-why' }, why) : null);
    if (info) row.append(helpEl(t));
    return row;
  }

  function treeEl(): HTMLElement {
    const wrap = h('div', { class: 'tb-tree' });
    wrap.append(h('input', { type: 'search', class: 'tb-search', placeholder: 'Search tools', value: query, 'aria-label': 'Search tools', oninput: (e: Event) => {
      query = (e.target as HTMLInputElement).value;
      const list = wrap.querySelector('.tb-list')!;
      list.replaceWith(listEl());
    } }));
    const listEl = () => {
      const list = h('div', { class: 'tb-list' });
      if (query.trim()) {
        const found = searchTools(query);
        if (!found.length) list.append(h('p', { class: 'muted small' }, 'No tool matches.'));
        for (const t of found) list.append(toolRow(t, true));
        return list;
      }
      for (const box of toolTree()) {
        const isOpen = open.has(box.toolbox);
        const n = box.toolsets.reduce((a, s) => a + s.tools.length, 0);
        const d = h('div', { class: `tb-box${isOpen ? ' open' : ''}` },
          h('button', { class: 'tb-box-head', 'aria-expanded': String(isOpen), onclick: () => { if (isOpen) open.delete(box.toolbox); else open.add(box.toolbox); save(LS_OPEN, [...open]); render(); } },
            h('span', { 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'), ' ', h('span', { class: 'grow' }, box.toolbox), h('span', { class: 'muted small' }, `${n} tool${n === 1 ? '' : 's'}`)));
        if (isOpen) for (const set of box.toolsets) {
          d.append(h('div', { class: 'tb-set' }, h('div', { class: 'tb-set-head muted small' }, set.name), ...set.tools.map(t => toolRow(t, false))));
        }
        list.append(d);
      }
      return list;
    };
    wrap.append(listEl());
    return wrap;
  }

  function toolEl(t: ToolSpec): HTMLElement {
    const v = paramsOf(t);
    const wrap = h('div', { class: 'tb-dialog' });
    wrap.append(h('div', { class: 'row' }, h('button', { class: 'chip', onclick: () => { toolId = null; save(LS_TOOL, null); render(); } }, '‹ All tools'), h('span', { class: 'muted small grow' }, t.path.join(' › '))));
    wrap.append(h('h3', { class: 'tb-title' }, t.name), h('p', { class: 'small' }, t.summary));
    const about = h('details', { class: 'panel' }, h('summary', {}, 'About this tool'), helpEl(t));
    wrap.append(about);
    // 1 Inputs
    const s1 = h('section', { class: 'step' }, stepHead(1, 'Inputs', `${t.inputs.filter(i => have(i.kind)).length} of ${t.inputs.length} ready`));
    if (!t.inputs.length) s1.append(h('p', { class: 'muted small' }, 'None.'));
    for (const i of t.inputs) s1.append(inputRow(i));
    if (t.runner === 'objects-tab') s1.append(h('p', { class: 'muted small' }, 'The Objects tab chooses its own sources (it reads Sentinel-2 and the point cloud at their native support); they are listed here so the tool states what it reads.'));
    wrap.append(s1);
    // 2 Parameters
    const s2 = h('section', { class: 'step' }, stepHead(2, 'Parameters', t.params.length ? null : 'none'));
    const shown = t.params.filter(p => relevant(t, p, v));
    if (!shown.length) s2.append(h('p', { class: 'muted small' }, t.runner === 'objects-tab' ? 'Set in the Objects tab.' : 'This tool has no parameters.'));
    for (const p of shown) s2.append(paramRow(t, p, v[p.id]));
    if (t.params.length) s2.append(h('button', { class: 'chip', onclick: () => { delete params[t.id]; save(LS_PARAMS, params); render(); } }, 'Reset to defaults'));
    wrap.append(s2);
    // 3 Output
    const s3 = h('section', { class: 'step' }, stepHead(3, 'Output'));
    s3.append(h('ul', { class: 'tb-outs' }, ...t.outputs.map(o => h('li', { class: 'small' }, h('span', { class: 'badge' }, o.kind), ' ', o.label, o.formats ? h('span', { class: 'muted' }, ` — ${o.formats.join(', ')}`) : null))));
    const why = missingInput(t, k => have(k)) || (t.runner === 'analysis' && shared.workspace ? shared.workspace.analysis.blocked(t.fixed!.tool as ToolId) : '') || variableInputsMissing(t, v);
    const aBusy = shared.workspace?.analysis.busy();
    const label = busy === t.id || aBusy ? 'Running…' : t.runner === 'objects-tab' ? 'Open in the Objects tab' : t.runner === 'analysis' ? `Run on ${area.summary()}` : 'Run (add to the map)';
    s3.append(h('button', { class: 'btn wide', disabled: !!busy || !!aBusy || (!!why && t.runner !== 'objects-tab'), onclick: () => void run(t) }, label));
    if (why && t.runner !== 'objects-tab') s3.append(h('p', { class: 'note small' }, why));
    if (t.runner !== 'analysis' && t.runner !== 'objects-tab') s3.append(h('p', { class: 'muted small' }, 'Raster tools draw for the map view as you pan; the study area is not used.'));
    wrap.append(s3);
    // Run log
    const d = h('details', { class: 'panel runlog' }, h('summary', {}, `Run log${log.length ? ` (${log.length})` : ''}`),
      h('ul', { class: 'log' }, ...log.slice().reverse().map(l => h('li', { class: `log-${l.level}` }, h('span', { class: 'muted' }, l.t.toTimeString().slice(0, 8)), ' ', l.msg))));
    wrap.append(d);
    return wrap;
  }

  function resultsEl(): HTMLElement {
    const wrap = h('div', {});
    wrap.append(h('h3', { class: 'tb-title' }, 'Map layers made by tools'));
    if (!outputs.length) wrap.append(h('p', { class: 'muted small' }, 'None yet. Raster tools add a layer to the map\'s Layers panel.'));
    for (const o of [...outputs].reverse()) {
      wrap.append(h('div', { class: 'res-card' },
        h('div', { class: 'row res-head' }, h('strong', { class: 'grow' }, o.name), h('span', { class: 'muted small' }, o.at.toTimeString().slice(0, 5))),
        h('p', { class: 'muted small' }, `${o.tool.path.join(' › ')} › ${o.tool.name}${o.inputs ? ` · ${o.inputs}` : ''}`),
        describe(o.tool, o.params) ? h('p', { class: 'small' }, describe(o.tool, o.params)) : null,
        h('div', { class: 'row' },
          h('button', { class: 'chip', onclick: () => toc().zoomTo(o.id) }, 'Zoom to'),
          h('button', { class: 'chip', onclick: () => { toolId = o.tool.id; page = 'tools'; params[o.tool.id] = { ...o.params }; save(LS_PARAMS, params); render(); } }, 'Open the tool with these settings'),
          h('button', { class: 'chip danger', onclick: () => toc().remove(o.id) }, 'Remove'))));
    }
    wrap.append(h('h3', { class: 'tb-title' }, 'Analysis results'));
    if (shared.workspace) wrap.append(shared.workspace.analysis.resultsEl());
    return wrap;
  }

  function render() {
    clear(el);
    const nRes = (shared.workspace?.analysis.count() ?? 0) + outputs.length, openN = shared.workspace?.analysis.unanswered() ?? 0;
    el.append(h('div', { class: 'subtabs', role: 'tablist' },
      h('button', { class: `subtab${page === 'tools' ? ' on' : ''}`, role: 'tab', 'aria-selected': String(page === 'tools'), onclick: () => { page = 'tools'; render(); } }, 'Tools'),
      h('button', { class: `subtab${page === 'results' ? ' on' : ''}`, role: 'tab', 'aria-selected': String(page === 'results'), onclick: () => { page = 'results'; render(); } },
        'Results', nRes ? h('span', { class: `subtab-n${openN ? ' open' : ''}`, title: openN ? `${openN} not downloaded` : '' }, String(nRes)) : null)));
    if (page === 'results') { el.append(resultsEl()); return; }
    const t = toolId ? toolById.get(toolId) : null;
    el.append(t ? toolEl(t) : treeEl());
  }

  render();
}
