// The TABLE OF CONTENTS panel: every output on the map, top row on top, in a
// panel that floats on the map's top-left corner (folded to a button until
// opened). A row is GRIP · EYE · NAME over a SUBTITLE · ⋯. The name opens the
// row's fold (opacity and, where the owner gives one, a legend); ⋯ holds
// zoom, the four moves, the owner's details and remove — in words.
//
// Reordering is by DRAG on the grip, with pointer events rather than HTML5
// drag-and-drop (which never fires on a touch screen), and by the keyboard on
// the focused grip (↑ ↓, Home, End). A row moves among its siblings only: a
// group's layers stay together. The panel re-renders on every registry
// change, so a drag's state lives on the module, not on a row node.

import type { IControl, Map as MlMap } from 'maplibre-gl';
import { h, clear } from '../dom.ts';
import { FAMILY_LABEL, rows, siblingsOf, type TocNode } from '../layers/tocModel.ts';
import type { TableOfContents } from '../layers/toc.ts';

const LS_OPEN = 'sv.toc.open';
const GLYPH: Record<string, string> = { raster: '▦', classes: '▣', objects: '⬡', vector: '◇', table: '☰', group: '▤' };

export class TocPanel implements IControl {
  private el = h('div', { class: 'maplibregl-ctrl toc' });
  private body = h('div', { class: 'toc-body' });
  private open = (() => { try { return localStorage.getItem(LS_OPEN) !== '0'; } catch { return true; } })();
  private folded = new Set<string>();
  private menuFor: string | null = null;
  private drag: { id: string; startY: number; rowH: number; from: number; to: number; list: string[]; rowEl: HTMLElement } | null = null;

  constructor(private toc: TableOfContents) {
    toc.events.addEventListener('change', () => { if (!this.drag) this.render(); });
    document.addEventListener('pointerdown', (e) => { if (this.menuFor && !(e.target as HTMLElement).closest('.toc-menu, .toc-more')) { this.menuFor = null; this.render(); } });
  }

  onAdd(_map: MlMap) { this.render(); return this.el; }
  onRemove() { this.el.remove(); }

  private setOpen(v: boolean) {
    this.open = v;
    try { localStorage.setItem(LS_OPEN, v ? '1' : '0'); } catch { /* private mode */ }
    this.render();
  }

  render() {
    const t = this.toc, n = t.count();
    clear(this.el);
    this.el.classList.toggle('open', this.open);
    const head = h('div', { class: 'toc-head' },
      h('button', { class: 'toc-toggle', 'aria-expanded': String(this.open), title: this.open ? 'Fold the table of contents' : 'Open the table of contents', onclick: () => this.setOpen(!this.open) },
        h('span', { 'aria-hidden': 'true' }, '☰'), ' Layers', n ? h('span', { class: 'toc-n' }, String(n)) : null));
    if (this.open && n) {
      const allOn = t.state.order.every(id => t.get(id)!.visible);
      head.append(h('button', { class: 'toc-mini', title: allOn ? 'Hide every output' : 'Show every output', onclick: () => { for (const id of [...t.state.order]) t.setVisible(id, !allOn); } }, allOn ? 'Hide all' : 'Show all'));
    }
    this.el.append(head);
    if (!this.open) return;
    clear(this.body);
    if (!n) this.body.append(h('p', { class: 'muted small toc-empty' }, 'Nothing on the map yet. Every raster, scene, class map, analysis result and object layer you add is listed here, top row on top: drag the grip to reorder.'));
    for (const { node, depth } of rows(t.state)) this.body.append(this.row(node, depth));
    this.el.append(this.body);
  }

  private row(n: TocNode, depth: 0 | 1): HTMLElement {
    const t = this.toc, x = t.extra(n.id);
    const isGroup = n.type === 'group';
    const shown = t.shown(n.id);
    const sib = siblingsOf(t.state, n.id), idx = sib.indexOf(n.id);
    const wrap = h('div', { class: `toc-row${depth ? ' child' : ''}${isGroup ? ' group' : ''}${shown ? '' : ' off'}`, 'data-id': n.id });
    const grip = h('button', {
      class: 'toc-grip', title: 'Drag to reorder (or ↑ ↓ Home End)', 'aria-label': `Reorder ${n.title}: position ${idx + 1} of ${sib.length}`,
      onkeydown: (ev: Event) => { const e = ev as KeyboardEvent;
        const moves: Record<string, () => void> = { ArrowUp: () => t.moveBy(n.id, -1), ArrowDown: () => t.moveBy(n.id, 1), Home: () => t.moveToEdge(n.id, 'top'), End: () => t.moveToEdge(n.id, 'bottom') };
        if (!moves[e.key]) return;
        e.preventDefault(); moves[e.key]();
        (this.el.querySelector(`.toc-row[data-id="${CSS.escape(n.id)}"] .toc-grip`) as HTMLElement | null)?.focus();
      },
      onpointerdown: (e: Event) => this.startDrag(e as PointerEvent, n.id, wrap),
    }, '⠿');
    const eye = h('button', { class: 'toc-eye', 'aria-pressed': String(n.visible), title: n.visible ? 'Hide' : 'Show', 'aria-label': `${n.visible ? 'Hide' : 'Show'} ${n.title}`, onclick: () => t.setVisible(n.id, !n.visible) }, n.visible ? '◉' : '○');
    const fold = isGroup ? !(n as { collapsed: boolean }).collapsed : this.folded.has(n.id);
    const name = h('button', { class: 'toc-name', 'aria-expanded': String(fold), onclick: () => {
      if (isGroup) t.setCollapsed(n.id, fold);
      else { if (fold) this.folded.delete(n.id); else this.folded.add(n.id); this.render(); }
    } },
      h('span', { class: 'toc-title' }, h('span', { class: 'toc-glyph', 'aria-hidden': 'true' }, isGroup ? (fold ? '▾' : '▸') : GLYPH[n.type === 'layer' ? n.kind : 'group']), ' ', n.title),
      h('span', { class: 'toc-sub' }, n.subtitle ?? (isGroup ? `${(n as { children: string[] }).children.length} layers · ${FAMILY_LABEL[n.family]}` : FAMILY_LABEL[n.family])));
    const more = h('button', { class: 'toc-more', 'aria-haspopup': 'menu', 'aria-expanded': String(this.menuFor === n.id), title: 'More', 'aria-label': `More for ${n.title}`, onclick: () => { this.menuFor = this.menuFor === n.id ? null : n.id; this.render(); } }, '⋯');
    wrap.append(h('div', { class: 'toc-line' }, grip, eye, name, more));
    if (this.menuFor === n.id) {
      const item = (label: string, fn: () => void, disabled = false) => h('button', { role: 'menuitem', disabled, onclick: () => { this.menuFor = null; fn(); this.render(); } }, label);
      const b = t.boundsOf(n.id);
      wrap.append(h('div', { class: 'toc-menu', role: 'menu' },
        item('Zoom to', () => t.zoomTo(n.id), !b),
        item('Move to top', () => t.moveToEdge(n.id, 'top'), idx === 0),
        item('Move up', () => t.moveBy(n.id, -1), idx === 0),
        item('Move down', () => t.moveBy(n.id, 1), idx === sib.length - 1),
        item('Move to bottom', () => t.moveToEdge(n.id, 'bottom'), idx === sib.length - 1),
        x.details ? item('Details…', x.details) : null,
        x.removable === false ? null : item(x.removeLabel ?? (isGroup ? 'Remove group' : 'Remove from map'), () => { if (x.removeConfirm && !confirm(x.removeConfirm)) return; t.remove(n.id); })));
    }
    if (!isGroup && fold && n.type === 'layer') {
      const out = h('output', {}, `${Math.round(n.opacity * 100)} %`);
      const body = h('div', { class: 'toc-fold' },
        h('label', { class: 'row' }, 'Opacity ', h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(n.opacity), class: 'grow', 'aria-label': `Opacity of ${n.title}`,
          // The readout is patched in place; the registry is told on release, so a re-render never replaces the slider mid-drag.
          oninput: (e: Event) => { const v = +(e.target as HTMLInputElement).value; out.textContent = `${Math.round(v * 100)} %`; t.applyLayer(n.id, v); },
          onchange: (e: Event) => t.setOpacity(n.id, +(e.target as HTMLInputElement).value) }), out));
      const lg = x.legend?.();
      if (lg) body.append(lg);
      wrap.append(body);
    }
    return wrap;
  }

  // ── Drag ──────────────────────────────────────────────────────────────────

  private startDrag(e: PointerEvent, id: string, rowEl: HTMLElement) {
    if (e.button !== 0) return;
    const list = siblingsOf(this.toc.state, id);
    const from = list.indexOf(id);
    // Siblings' rows (a top-level node's rows include its children when unfolded: measure from the DOM).
    const rect = rowEl.getBoundingClientRect();
    this.drag = { id, startY: e.clientY, rowH: rect.height, from, to: from, list: [...list], rowEl };
    rowEl.classList.add('dragging');
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = this.drag!;
      const dy = ev.clientY - d.startY;
      d.rowEl.style.transform = `translateY(${dy}px)`;
      d.to = this.targetIndex(ev.clientY);
      this.el.querySelectorAll('.toc-row.drop-above, .toc-row.drop-below').forEach(r => r.classList.remove('drop-above', 'drop-below'));
      if (d.to !== d.from) {
        const target = this.el.querySelector(`.toc-row[data-id="${CSS.escape(d.list[d.to])}"]`);
        target?.classList.add(d.to < d.from ? 'drop-above' : 'drop-below');
      }
    };
    const up = () => {
      const d = this.drag!;
      this.drag = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (d.to !== d.from) this.toc.moveTo(d.id, d.to); else this.render();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** The sibling slot under the pointer, from the siblings' rows on screen. */
  private targetIndex(y: number): number {
    const d = this.drag!;
    let best = d.from;
    d.list.forEach((sid, k) => {
      if (sid === d.id) return;
      const r = this.el.querySelector(`.toc-row[data-id="${CSS.escape(sid)}"]`)?.getBoundingClientRect();
      if (!r) return;
      const mid = r.top + r.height / 2;
      if (k < d.from && y < mid && k < best) best = k;
      if (k > d.from && y > mid && k > best) best = k;
    });
    return best;
  }
}
