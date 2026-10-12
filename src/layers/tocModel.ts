// The TABLE OF CONTENTS as data: an ordered tree of map outputs, and the one
// statement of how that order becomes the MapLibre draw order. Pure;
// test/tocModel.test.ts.
//
// The list is held TOP FIRST, as it is read: the first row draws on top. A
// node is a LAYER (one output, which may paint several MapLibre layers — a
// fill and its outline) or a GROUP of layers (the Objects tab's RGB, CHM,
// quality mask and objects, which belong to one run). A group moves as a
// unit; its children reorder among themselves only, so a group's layers are
// always contiguous in the draw order — which is what lets a group be read
// as one thing.
//
// Where a new output lands is decided by its FAMILY, bottom to top:
//   imagery · raster (LiDAR rasters) · fusion (the pixel classes) ·
//   result (an analysis run, a toolbox output) · objects
// A new node goes on top of its own family's band (newest first) and below
// every node of a higher family, so a scene added after a classification
// does not cover it. After that the user's order is the order: a node moved
// out of its band stays where it was put.

export type Family = 'imagery' | 'raster' | 'fusion' | 'result' | 'objects';
export const FAMILY_RANK: Record<Family, number> = { imagery: 0, raster: 1, fusion: 2, result: 3, objects: 4 };
export const FAMILY_LABEL: Record<Family, string> = { imagery: 'Imagery', raster: 'LiDAR rasters', fusion: 'Fusion classes', result: 'Analysis results', objects: 'Objects' };

export type Kind = 'raster' | 'classes' | 'objects' | 'vector' | 'table';

export interface TocLayerNode {
  type: 'layer';
  id: string;
  title: string;
  subtitle?: string;
  family: Family;
  kind: Kind;
  /** MapLibre layer ids this output paints, bottom to top. */
  mapLayers: string[];
  visible: boolean;
  opacity: number;
  /** The group it belongs to, or undefined at the top level. */
  parent?: string;
}

export interface TocGroupNode {
  type: 'group';
  id: string;
  title: string;
  subtitle?: string;
  family: Family;
  visible: boolean;
  collapsed: boolean;
  /** Child layer ids, top first. */
  children: string[];
}

export type TocNode = TocLayerNode | TocGroupNode;

export interface TocState {
  /** Top-level node ids, top first. */
  order: string[];
  nodes: Map<string, TocNode>;
}

export const emptyToc = (): TocState => ({ order: [], nodes: new Map() });

/**
 * Where a new top-level node of `family` goes: directly above the topmost
 * node of its own family; with none, above the first node of a LOWER family
 * (so below every higher one); else at the bottom.
 */
export function insertIndex(s: TocState, family: Family): number {
  const r = FAMILY_RANK[family];
  const same = s.order.findIndex(id => s.nodes.get(id)!.family === family);
  if (same >= 0) return same;
  const lower = s.order.findIndex(id => FAMILY_RANK[s.nodes.get(id)!.family] < r);
  return lower < 0 ? s.order.length : lower;
}

/** The list a node lives in (top level, or its group's children). */
export function siblingsOf(s: TocState, id: string): string[] {
  const n = s.nodes.get(id);
  if (!n) return [];
  if (n.type === 'layer' && n.parent) return (s.nodes.get(n.parent) as TocGroupNode).children;
  return s.order;
}

/**
 * Move `id` to position `to` among its siblings (0 = top). Clamped. Returns
 * true when the order changed. A node never leaves its list: a layer cannot
 * be dragged out of its group, nor a top-level node into one.
 */
export function moveTo(s: TocState, id: string, to: number): boolean {
  const list = siblingsOf(s, id);
  const from = list.indexOf(id);
  if (from < 0) return false;
  const k = Math.max(0, Math.min(list.length - 1, to));
  if (k === from) return false;
  list.splice(from, 1);
  list.splice(k, 0, id);
  return true;
}

export const moveBy = (s: TocState, id: string, delta: number) => moveTo(s, id, siblingsOf(s, id).indexOf(id) + delta);
export const moveToEdge = (s: TocState, id: string, edge: 'top' | 'bottom') => moveTo(s, id, edge === 'top' ? 0 : siblingsOf(s, id).length - 1);

/** Add or replace a top-level layer or group. A replaced node keeps its place, visibility and opacity. */
export function upsert(s: TocState, node: TocNode): TocNode {
  const old = s.nodes.get(node.id);
  if (old && old.type === node.type) {
    const kept = node.type === 'layer'
      ? { ...node, visible: (old as TocLayerNode).visible, opacity: (old as TocLayerNode).opacity, parent: (old as TocLayerNode).parent ?? node.parent }
      : { ...node, visible: old.visible, collapsed: (old as TocGroupNode).collapsed, children: (old as TocGroupNode).children };
    s.nodes.set(node.id, kept);
    return kept;
  }
  if (old) remove(s, node.id);
  s.nodes.set(node.id, node);
  if (node.type === 'layer' && node.parent) {
    const g = s.nodes.get(node.parent);
    if (!g || g.type !== 'group') throw new Error(`no group ${node.parent}`);
    g.children.unshift(node.id);
  } else s.order.splice(insertIndex(s, node.family), 0, node.id);
  return node;
}

/** Remove a node (a group with its children). Returns the ids of the LAYERS removed. */
export function remove(s: TocState, id: string): string[] {
  const n = s.nodes.get(id);
  if (!n) return [];
  const gone: string[] = [];
  if (n.type === 'group') for (const c of [...n.children]) gone.push(...remove(s, c));
  else gone.push(id);
  const list = siblingsOf(s, id);
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  s.nodes.delete(id);
  return gone;
}

/** A layer is drawn when it and its group are both switched on. */
export function effectiveVisible(s: TocState, id: string): boolean {
  const n = s.nodes.get(id);
  if (!n) return false;
  if (n.type === 'group') return n.visible;
  return n.visible && (!n.parent || (s.nodes.get(n.parent) as TocGroupNode).visible);
}

/** Every MapLibre layer id, BOTTOM TO TOP, as the list states it. */
export function drawOrder(s: TocState): string[] {
  const out: string[] = [];
  const layer = (id: string) => { const n = s.nodes.get(id); if (n?.type === 'layer') out.push(...n.mapLayers); };
  for (const id of [...s.order].reverse()) {
    const n = s.nodes.get(id)!;
    if (n.type === 'group') for (const c of [...n.children].reverse()) layer(c);
    else layer(id);
  }
  return out;
}

/** Top-level rows and the children shown under each, for rendering. */
export function rows(s: TocState): { node: TocNode; depth: 0 | 1 }[] {
  const out: { node: TocNode; depth: 0 | 1 }[] = [];
  for (const id of s.order) {
    const n = s.nodes.get(id)!;
    out.push({ node: n, depth: 0 });
    if (n.type === 'group' && !n.collapsed) for (const c of n.children) out.push({ node: s.nodes.get(c)!, depth: 1 });
  }
  return out;
}
