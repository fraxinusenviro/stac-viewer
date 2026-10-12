// The TABLE OF CONTENTS registry: every output any tab or tool puts on the
// map registers here, and this is the ONE place its visibility, opacity and
// draw order are stated. The model (order, groups, families) is
// tocModel.ts, pure and tested; this file applies it to MapLibre and keeps
// the owners told.
//
// The owner of an output still creates and destroys its MapLibre layers — it
// knows how to draw them. What it gives up is the three switches: it calls
// `setVisible` / `setOpacity` / `remove` here rather than writing the paint
// property itself, and hears back through `onVisible` / `onOpacity` /
// `onRemove`, so the tab's own controls and the table of contents cannot
// disagree. When an owner re-creates its layers (a restyle that replaces the
// image source), it calls `add` again with the same id: the entry keeps its
// place, visibility and opacity, and they are re-applied to the new layers.
//
// Draw order: every registered layer is moved, bottom to top, to directly
// beneath `topAnchor` — above the basemaps and the hillshade basemap, below
// the footprints and the interaction overlays (study-area outlines,
// reference polygons, the Sentinel grid), which are chrome rather than
// outputs and stay on top.

import type { Map as MlMap } from 'maplibre-gl';
import type { LonLatBox } from '../warp.ts';
import { drawOrder, effectiveVisible, emptyToc, moveBy, moveTo, moveToEdge, remove as removeNode, upsert, type Family, type Kind, type TocGroupNode, type TocLayerNode, type TocNode, type TocState } from './tocModel.ts';

export interface TocExtras {
  /** Where "Zoom to" goes. */
  bounds?: LonLatBox | (() => LonLatBox | null);
  /** A legend for the row's fold. */
  legend?: () => HTMLElement | null;
  /** The owner's own controls for the output (e.g. a result card), offered as "Details". */
  details?: () => void;
  /** The owner tears down its layers and state. Called AFTER the entry has gone. */
  onRemove?: () => void;
  onVisible?: (visible: boolean) => void;
  onOpacity?: (opacity: number) => void;
  /** Wording for the remove action and an optional confirmation. */
  removeLabel?: string;
  removeConfirm?: string;
  /** False: the output cannot be removed from here (it is managed by its tab). */
  removable?: boolean;
}

export interface TocLayerSpec extends TocExtras {
  id: string; title: string; subtitle?: string; family: Family; kind: Kind; mapLayers: string[];
  parent?: string; visible?: boolean; opacity?: number;
}
export interface TocGroupSpec extends TocExtras { id: string; title: string; subtitle?: string; family: Family; visible?: boolean; collapsed?: boolean }

const OPACITY_PROP: Record<string, string> = { raster: 'raster-opacity', fill: 'fill-opacity', line: 'line-opacity', circle: 'circle-opacity', symbol: 'icon-opacity', 'fill-extrusion': 'fill-extrusion-opacity' };

export class TableOfContents {
  readonly state: TocState = emptyToc();
  readonly events = new EventTarget();
  private extras = new Map<string, TocExtras>();
  /** The paint opacity each MapLibre layer was created with; the entry's opacity multiplies it. */
  private base = new Map<string, number>();

  constructor(private map: MlMap, private topAnchor: string) {}

  has(id: string) { return this.state.nodes.has(id); }
  get(id: string): TocNode | undefined { return this.state.nodes.get(id); }
  extra(id: string): TocExtras { return this.extras.get(id) ?? {}; }
  count() { let n = 0; for (const v of this.state.nodes.values()) if (v.type === 'layer') n++; return n; }

  addGroup(spec: TocGroupSpec) {
    const { id, title, subtitle, family, visible = true, collapsed = false, ...extras } = spec;
    upsert(this.state, { type: 'group', id, title, subtitle, family, visible, collapsed, children: [] });
    this.extras.set(id, extras);
    this.changed(true);
  }

  /** Register (or re-register) an output. Its MapLibre layers must exist, or be re-applied later with `refresh`. */
  add(spec: TocLayerSpec) {
    const { id, title, subtitle, family, kind, mapLayers, parent, visible = true, opacity = 1, ...extras } = spec;
    for (const m of mapLayers) this.recordBase(m);
    upsert(this.state, { type: 'layer', id, title, subtitle, family, kind, mapLayers, parent, visible, opacity });
    this.extras.set(id, extras);
    this.applyLayer(id);
    this.changed(true);
  }

  /** Re-apply an entry's switches after its owner re-created its MapLibre layers. */
  refresh(id: string) {
    const n = this.get(id);
    if (n?.type !== 'layer') return;
    for (const m of n.mapLayers) this.recordBase(m);
    this.applyLayer(id);
    this.applyOrder();
  }

  /** Change an entry's title or subtitle. */
  rename(id: string, title: string, subtitle?: string) {
    const n = this.get(id);
    if (!n) return;
    n.title = title;
    if (subtitle !== undefined) n.subtitle = subtitle;
    this.changed(false);
  }

  /** Take an output off the map. The owner's onRemove runs after the entry has gone, so it may call remove() again harmlessly. */
  remove(id: string) {
    const n = this.get(id);
    if (!n) return;
    const callbacks = [id, ...(n.type === 'group' ? n.children : [])].map(k => this.extras.get(k)?.onRemove).filter(Boolean) as (() => void)[];
    const layers = removeNode(this.state, id);
    for (const k of [id, ...layers]) this.extras.delete(k);
    this.changed(true);
    for (const f of callbacks) f();
  }

  /** Forget an entry WITHOUT telling its owner (the owner removed it itself). */
  forget(id: string) {
    if (!this.has(id)) return;
    for (const k of [id, ...removeNode(this.state, id)]) this.extras.delete(k);
    this.changed(true);
  }

  setVisible(id: string, visible: boolean) {
    const n = this.get(id);
    if (!n || n.visible === visible) return;
    n.visible = visible;
    if (n.type === 'group') for (const c of n.children) this.applyLayer(c); else this.applyLayer(id);
    this.extras.get(id)?.onVisible?.(visible);
    this.changed(false);
  }

  setOpacity(id: string, opacity: number) {
    const n = this.get(id);
    if (n?.type !== 'layer') return;
    n.opacity = Math.max(0, Math.min(1, opacity));
    this.applyLayer(id);
    this.extras.get(id)?.onOpacity?.(n.opacity);
    this.changed(false);
  }

  setCollapsed(id: string, collapsed: boolean) {
    const n = this.get(id);
    if (n?.type !== 'group') return;
    n.collapsed = collapsed;
    this.changed(false);
  }

  moveTo(id: string, index: number) { if (moveTo(this.state, id, index)) this.changed(true); }
  moveBy(id: string, delta: number) { if (moveBy(this.state, id, delta)) this.changed(true); }
  moveToEdge(id: string, edge: 'top' | 'bottom') { if (moveToEdge(this.state, id, edge)) this.changed(true); }

  boundsOf(id: string): LonLatBox | null {
    const n = this.get(id);
    if (!n) return null;
    const own = this.extras.get(id)?.bounds;
    const b = typeof own === 'function' ? own() : own ?? null;
    if (b || n.type === 'layer') return b;
    const boxes = n.children.map(c => this.boundsOf(c)).filter((x): x is LonLatBox => !!x);
    return boxes.length ? [Math.min(...boxes.map(x => x[0])), Math.min(...boxes.map(x => x[1])), Math.max(...boxes.map(x => x[2])), Math.max(...boxes.map(x => x[3]))] : null;
  }

  zoomTo(id: string) {
    const b = this.boundsOf(id);
    if (b) this.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, maxZoom: 17 });
  }

  /** Is the output drawn (its own switch and its group's)? */
  shown(id: string) { return effectiveVisible(this.state, id); }

  // ── Applying to MapLibre ──────────────────────────────────────────────────

  private recordBase(mapLayer: string) {
    if (this.base.has(mapLayer)) return;
    const l = this.map.getLayer(mapLayer);
    if (!l) return;
    const prop = l && OPACITY_PROP[l.type];
    // A raster's opacity is only ever the user's dial, so its base is 1 whatever it was created with.
    if (l?.type === 'raster') { this.base.set(mapLayer, 1); return; }
    const v = prop ? this.map.getPaintProperty(mapLayer, prop) : undefined;
    // An opacity driven by an expression is left alone (base NaN): only the visibility switch applies to it.
    this.base.set(mapLayer, typeof v === 'number' ? v : v === undefined ? 1 : NaN);
  }

  /** Paint an entry's switches onto its MapLibre layers; `opacity` overrides the stored one (a slider being dragged). */
  applyLayer(id: string, opacity?: number) {
    const n = this.get(id) as TocLayerNode | undefined;
    if (!n || n.type !== 'layer') return;
    const on = effectiveVisible(this.state, id);
    for (const m of n.mapLayers) {
      const l = this.map.getLayer(m);
      if (!l) continue;
      this.map.setLayoutProperty(m, 'visibility', on ? 'visible' : 'none');
      const prop = OPACITY_PROP[l.type], base = this.base.get(m) ?? 1;
      if (prop && Number.isFinite(base)) this.map.setPaintProperty(m, prop, base * (opacity ?? n.opacity));
    }
  }

  /** Move every registered layer, bottom to top, beneath the anchor. */
  applyOrder() {
    if (!this.map.getLayer(this.topAnchor)) return;
    const want = drawOrder(this.state).filter(m => this.map.getLayer(m));
    // Skip the moves when the style already agrees (a re-render must not churn the style).
    const style = this.map.getStyle().layers.map(l => l.id);
    const at = style.indexOf(this.topAnchor);
    const current = style.slice(0, at).filter(id => want.includes(id));
    const tail = style.slice(at - want.length, at);
    if (current.length === want.length && current.every((id, k) => id === want[k]) && tail.every((id, k) => id === want[k])) return;
    for (const m of want) this.map.moveLayer(m, this.topAnchor);
  }

  private changed(order: boolean) {
    if (order) this.applyOrder();
    this.events.dispatchEvent(new Event('change'));
  }
}

let instance: TableOfContents | null = null;
/** The one table of contents (created by main.ts once the map has loaded its anchors). */
export function initToc(map: MlMap, topAnchor: string) { instance = new TableOfContents(map, topAnchor); return instance; }
export function toc(): TableOfContents {
  if (!instance) throw new Error('the table of contents is not initialised');
  return instance;
}
/** The table of contents when it exists (outputs created before the map loaded register later). */
export const tocOrNull = () => instance;

export type { TocGroupNode, TocLayerNode };
