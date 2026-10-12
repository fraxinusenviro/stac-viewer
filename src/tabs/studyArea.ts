// Step 1 of the Fusion tab: the STUDY AREA every analysis runs over —
// FieldMapper's HabLab picker, in this viewer's terms.
//
//   This view   the map view at the moment Run is pressed (ad hoc; a result
//               made on it can be saved as an area afterwards)
//   Saved area  a named polygon kept in this browser
//   Draw        a polygon or a rectangle tapped on the map, then named
//
// The choice is remembered, so a reload comes back to the same ground. The
// chosen saved area is outlined on the map while the Fusion tab is open.
// Saved areas are device-local (localStorage): there is no account here to
// sync them to, and an export of one is a GeoJSON file.

import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import { h } from '../dom.ts';
import { aoiAreaM2, aoiBox, boxPolygon, closeRing, fmtArea, parseAois, uniqueAoiName, type Aoi, type AoiSource } from '../aoi.ts';
import { segBar } from '../ui/steps.ts';
import { mapClaim, type Ctx } from './ctx.ts';

const LS_AOIS = 'sv.aois';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

type Kind = 'view' | 'saved' | 'draw';

const load = <T>(k: string, fallback: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } };
const store = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export interface StudyAreaStep {
  /** The area a run would use now, or null with the reason. */
  current(): { aoi: Aoi } | { aoi: null; reason: string };
  /** The step's body (re-rendered with the tab). */
  el(): HTMLElement;
  /** A one-line description for the step heading. */
  summary(): string;
  /** Keep an area (from a result made on "This view"); returns the saved copy. */
  save(aoi: Aoi, name?: string): Aoi;
  isSaved(id: string): boolean;
  zoomTo(aoi: Aoi): void;
}

/** Saved areas are shared by every tab's picker: a save in one is announced to the others. */
const aoiEvents = new EventTarget();

export function studyAreaStep(ctx: Ctx, changed: () => void, opts: { prefix?: string; pane?: string } = {}): StudyAreaStep {
  const { map, say } = ctx;
  const P = opts.prefix ?? 'aoi', PANE = opts.pane ?? 'pane-fusion';
  const LS_CHOICE = P === 'aoi' ? 'sv.aoi.choice' : `sv.${P}.choice`;
  const SRC = P, DRAFT = `${P}-draft`;
  let aois = parseAois(load(LS_AOIS, []));
  aoiEvents.addEventListener('change', (e) => {
    if ((e as CustomEvent).detail === P) return;
    aois = parseAois(load(LS_AOIS, []));
    if (selected && !aois.some(a => a.id === selected)) { selected = aois[aois.length - 1]?.id ?? null; if (!selected && kind === 'saved') kind = 'view'; }
    paint(); changed();
  });
  const stored = load<{ kind: Kind; id: string | null }>(LS_CHOICE, { kind: 'view', id: null });
  let kind: Kind = stored.kind === 'saved' && aois.some(a => a.id === stored.id) ? 'saved' : 'view';
  let selected: string | null = kind === 'saved' ? stored.id : aois[aois.length - 1]?.id ?? null;
  // Drawing state.
  let shape: 'polygon' | 'rect' = 'polygon';
  let pts: [number, number][] = [];
  let finished: GeoJSON.Polygon | null = null;
  let draftName = '';
  let renaming = false;

  const saveAll = () => { store(LS_AOIS, aois); aoiEvents.dispatchEvent(new CustomEvent('change', { detail: P })); };
  const saveChoice = () => store(LS_CHOICE, { kind: kind === 'draw' ? 'saved' : kind, id: selected });
  const selectedAoi = () => aois.find(a => a.id === selected) ?? null;
  const drawing = () => kind === 'draw' && !finished;

  // ── Map ───────────────────────────────────────────────────────────────────

  map.on('load', () => {
    map.addSource(SRC, { type: 'geojson', data: EMPTY });
    map.addSource(DRAFT, { type: 'geojson', data: EMPTY });
    map.addLayer({ id: `${P}-fill`, type: 'fill', source: SRC, paint: { 'fill-color': '#d9a441', 'fill-opacity': 0.06 } });
    map.addLayer({ id: `${P}-line`, type: 'line', source: SRC, paint: { 'line-color': '#d9a441', 'line-width': 2.5 } });
    map.addLayer({ id: `${P}-draft-fill`, type: 'fill', source: DRAFT, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#d9a441', 'fill-opacity': 0.12 } });
    map.addLayer({ id: `${P}-draft-line`, type: 'line', source: DRAFT, paint: { 'line-color': '#d9a441', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
    map.addLayer({ id: `${P}-draft-pts`, type: 'circle', source: DRAFT, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#d9a441', 'circle-stroke-width': 2 } });
    paint();
  });

  // The outline belongs to the Fusion tab, like the point-cloud footprints to theirs.
  const fusionOpen = () => !document.getElementById(PANE)!.hidden;
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => setTimeout(paint, 0)));

  function paint() {
    const a = kind === 'saved' ? selectedAoi() : null;
    (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(a && fusionOpen() ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: a.geometry }] } : EMPTY);
    const feats: GeoJSON.Feature[] = [];
    if (kind === 'draw' && fusionOpen()) {
      const ring = finished ? finished.coordinates[0] : pts;
      if (finished) feats.push({ type: 'Feature', properties: {}, geometry: finished });
      else if (pts.length >= 2) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } });
      for (const p of ring) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } });
    }
    (map.getSource(DRAFT) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: feats });
  }

  function claim(on: boolean) {
    if (on) {
      mapClaim.owner = 'aoi';
      map.doubleClickZoom.disable();
      map.getCanvas().style.cursor = 'crosshair';
    } else if (mapClaim.owner === 'aoi') {
      mapClaim.owner = null;
      map.doubleClickZoom.enable();
      map.getCanvas().style.cursor = '';
    }
  }

  map.on('click', (e: MapMouseEvent) => {
    if (!drawing() || mapClaim.owner !== 'aoi' || !fusionOpen()) return;
    const p: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    // A double tap arrives as two clicks on (nearly) one spot: keep one.
    const last = pts[pts.length - 1];
    if (last) { const a = map.project(last), b = map.project(p); if (Math.hypot(a.x - b.x, a.y - b.y) < 6) return; }
    pts.push(p);
    if (shape === 'rect' && pts.length === 2) { finish(); return; }
    paint(); changed();
  });
  map.on('dblclick', (e) => {
    if (!drawing() || mapClaim.owner !== 'aoi') return;
    e.preventDefault();
    if (shape === 'polygon' && pts.length >= 3) finish();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !drawing() || !fusionOpen()) return;
    if (pts.length) { pts = []; paint(); changed(); } else pickKind(aois.length ? 'saved' : 'view');
  });

  function finish() {
    if (shape === 'rect') {
      const [[x0, y0], [x1, y1]] = pts;
      finished = boxPolygon([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]);
    } else finished = { type: 'Polygon', coordinates: [closeRing(pts)] };
    if (!(aoiAreaM2(finished) > 0)) { finished = null; say('That shape has no area: draw it again.', 'error'); return; }
    draftName = uniqueAoiName(aois.map(a => a.name), 'Study area');
    claim(false); paint(); changed();
  }

  function startDraw(s: 'polygon' | 'rect') {
    shape = s; pts = []; finished = null;
    claim(true); paint(); changed();
  }

  function pickKind(k: Kind) {
    kind = k;
    if (k === 'draw') startDraw(shape);
    else { pts = []; finished = null; claim(false); }
    renaming = false;
    saveChoice(); paint(); changed();
  }

  function add(geometry: GeoJSON.Polygon, name: string, source: AoiSource): Aoi {
    const a: Aoi = { id: crypto.randomUUID(), name: uniqueAoiName(aois.map(x => x.name), name), geometry, source, createdAt: new Date().toISOString() };
    aois = [...aois, a];
    saveAll();
    return a;
  }

  function zoomTo(a: Aoi) { map.fitBounds(aoiBox(a.geometry) as [number, number, number, number], { padding: 40, duration: 500 }); }

  // ── Step body ─────────────────────────────────────────────────────────────

  function el(): HTMLElement {
    const wrap = h('div', { class: 'step-body' });
    wrap.append(segBar('Study area', [
      { value: 'view', label: 'This view' },
      { value: 'saved', label: `Saved area${aois.length ? ` (${aois.length})` : ''}`, disabled: aois.length ? undefined : 'No saved areas yet: draw one, or save a view' },
      { value: 'draw', label: 'Draw' },
    ], kind, v => pickKind(v as Kind)));

    if (kind === 'view') {
      wrap.append(h('p', { class: 'muted small' }, 'The map view at the moment you press Run: pan and zoom to frame it. To come back to the same ground later, save it as an area.'),
        h('button', { class: 'chip', onclick: () => { const a = add(boxPolygon(ctx.viewBox()), 'View area', 'view'); selected = a.id; kind = 'saved'; saveChoice(); paint(); changed(); say(`Saved the view as "${a.name}".`); } }, 'Save this view as an area'));
    } else if (kind === 'saved') {
      const a = selectedAoi();
      wrap.append(h('select', { 'aria-label': 'Saved study area', onchange: (e: Event) => { selected = (e.target as HTMLSelectElement).value; renaming = false; saveChoice(); paint(); changed(); const s = selectedAoi(); if (s) zoomTo(s); } },
        ...[...aois].reverse().map(x => h('option', { value: x.id, selected: x.id === selected }, `${x.name} · ${fmtArea(aoiAreaM2(x.geometry))}`))));
      if (a) {
        if (renaming) {
          const inp = h('input', { type: 'text', class: 'grow', value: a.name, 'aria-label': 'Area name' });
          const done = () => { const v = inp.value.trim(); if (v && v !== a.name) { a.name = uniqueAoiName(aois.filter(x => x !== a).map(x => x.name), v); saveAll(); } renaming = false; changed(); };
          inp.addEventListener('keydown', e => { if (e.key === 'Enter') done(); if (e.key === 'Escape') { renaming = false; changed(); } });
          wrap.append(h('div', { class: 'row' }, inp, h('button', { class: 'btn small-btn', onclick: done }, 'Rename')));
          setTimeout(() => inp.focus(), 0);
        } else {
          wrap.append(h('p', { class: 'muted small' }, `${a.source === 'view' ? 'A kept map view' : a.source === 'rect' ? 'A drawn rectangle' : 'A drawn polygon'}${a.createdAt ? `, made ${a.createdAt.slice(0, 10)}` : ''}. Every run on it is masked to the outline.`));
          wrap.append(h('div', { class: 'row' },
            h('button', { class: 'chip', onclick: () => zoomTo(a) }, 'Zoom to'),
            h('button', { class: 'chip', onclick: () => { renaming = true; changed(); } }, 'Rename'),
            h('button', { class: 'chip', onclick: () => download(a) }, 'GeoJSON'),
            h('button', { class: 'chip', onclick: () => {
              if (!confirm(`Delete the study area "${a.name}"? Results already made on it keep their copy of the outline.`)) return;
              aois = aois.filter(x => x !== a); saveAll();
              selected = aois[aois.length - 1]?.id ?? null;
              if (!selected) kind = 'view';
              saveChoice(); paint(); changed();
            } }, 'Delete')));
        }
      }
      const fileIn = h('input', { type: 'file', accept: '.geojson,.json,application/geo+json,application/json', hidden: true, onchange: (e: Event) => void importFile(e) });
      wrap.append(h('div', { class: 'row' }, h('button', { class: 'chip', onclick: () => fileIn.click() }, 'Import GeoJSON…'), fileIn));
    } else {
      wrap.append(segBar('Shape', [{ value: 'polygon', label: 'Polygon' }, { value: 'rect', label: 'Rectangle' }], shape, v => startDraw(v as 'polygon' | 'rect')));
      if (!finished) {
        wrap.append(h('p', { class: 'note small' }, shape === 'rect'
          ? (pts.length ? 'Now tap the opposite corner.' : 'Tap one corner of the rectangle on the map, then the opposite corner.')
          : `Tap the corners on the map (${pts.length} so far); double-tap the last one, or press Finish. Esc clears.`));
        wrap.append(h('div', { class: 'row' },
          shape === 'polygon' ? h('button', { class: 'btn small-btn', disabled: pts.length < 3, onclick: finish }, 'Finish') : null,
          h('button', { class: 'chip', disabled: !pts.length, onclick: () => { pts.pop(); paint(); changed(); } }, 'Undo point'),
          h('button', { class: 'chip', onclick: () => pickKind(aois.length ? 'saved' : 'view') }, 'Cancel')));
      } else {
        const g = finished;
        const inp = h('input', { type: 'text', class: 'grow', value: draftName, 'aria-label': 'Name of the new area', oninput: (e: Event) => { draftName = (e.target as HTMLInputElement).value; } });
        const keep = () => {
          const a = add(g, draftName || 'Study area', shape === 'rect' ? 'rect' : 'drawn');
          selected = a.id; kind = 'saved'; finished = null; pts = [];
          saveChoice(); paint(); changed();
          say(`Saved the study area "${a.name}" (${fmtArea(aoiAreaM2(a.geometry))}).`);
        };
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') keep(); });
        wrap.append(h('p', { class: 'small' }, `${shape === 'rect' ? 'Rectangle' : 'Polygon'} of ${fmtArea(aoiAreaM2(g))}. Name it to keep it:`),
          h('div', { class: 'row' }, inp, h('button', { class: 'btn small-btn', onclick: keep }, 'Save area')),
          h('div', { class: 'row' }, h('button', { class: 'chip', onclick: () => startDraw(shape) }, 'Draw again')));
      }
    }
    return wrap;
  }

  function download(a: Aoi) {
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: a.name, source: a.source, created: a.createdAt, area_ha: Math.round(aoiAreaM2(a.geometry) / 100) / 100 }, geometry: a.geometry }] };
    const link = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' })), download: `${a.name.replace(/[^\w-]+/g, '_')}.geojson` });
    link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  /** Every Polygon (and each part of a MultiPolygon) of a GeoJSON file becomes an area. */
  async function importFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const feats: GeoJSON.Feature[] = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : [{ type: 'Feature', properties: {}, geometry: j }];
      const base = f.name.replace(/\.(geo)?json$/i, '');
      let n = 0, last: Aoi | null = null;
      for (const ft of feats) {
        const g = ft?.geometry;
        const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
        for (const coords of polys) {
          const geometry: GeoJSON.Polygon = { type: 'Polygon', coordinates: coords.map(r => closeRing(r.map(p => [p[0], p[1]]))) };
          if (!(aoiAreaM2(geometry) > 0)) continue;
          const name = typeof ft.properties?.name === 'string' && ft.properties.name.trim() ? ft.properties.name : base;
          last = add(geometry, name, 'drawn'); n++;
        }
      }
      if (!last) { say('No polygon in that file.', 'error'); return; }
      selected = last.id; kind = 'saved'; saveChoice(); paint(); changed(); zoomTo(last);
      say(`Imported ${n} study area${n === 1 ? '' : 's'}. Coordinates are read as WGS84 lon/lat, as GeoJSON requires.`);
    } catch (err) { say(`Could not import: ${(err as Error).message}`, 'error'); }
  }

  return {
    current() {
      if (kind === 'view') {
        const t = new Date();
        return { aoi: { id: `view-${t.getTime()}`, name: `View at ${t.toTimeString().slice(0, 5)}`, geometry: boxPolygon(ctx.viewBox()), source: 'view', createdAt: t.toISOString() } };
      }
      if (kind === 'saved') { const a = selectedAoi(); return a ? { aoi: a } : { aoi: null, reason: 'Choose a saved area.' }; }
      return { aoi: null, reason: finished ? 'Save the drawn area first.' : 'Finish drawing the area first.' };
    },
    el,
    summary() {
      if (kind === 'view') return 'This view';
      if (kind === 'saved') { const a = selectedAoi(); return a ? `${a.name} · ${fmtArea(aoiAreaM2(a.geometry))}` : ''; }
      return 'Drawing…';
    },
    save(aoi, name) {
      const a = add(aoi.geometry, name ?? aoi.name, aoi.source);
      selected = a.id; kind = 'saved'; saveChoice(); paint();
      return a;
    },
    isSaved: (id) => aois.some(a => a.id === id),
    zoomTo,
  };
}
