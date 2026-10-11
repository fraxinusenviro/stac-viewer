// Putting engine layers on the MapLibre map, restyling them, taking them off.

import type { Map as MlMap, RasterTileSource } from 'maplibre-gl';
import { removeLayer, setLayer, setStyle, tileUrl, type LayerDef } from './engine.ts';
import type { ProductStyle } from './products.ts';

const versions = new Map<string, number>();

/**
 * Register `def` under `id` and draw it below `beforeId`. Replaces a layer
 * already there with the same id. Returns the layer's lon/lat bounds.
 */
export async function showLayer(map: MlMap, id: string, def: LayerDef, beforeId: string, opacity = 1, maxzoom = 18) {
  hideLayer(map, id);
  const bounds = await setLayer(id, def);
  const v = (versions.get(id) ?? 0) + 1;
  versions.set(id, v);
  map.addSource(id, { type: 'raster', tiles: [tileUrl(id, v)], tileSize: 256, bounds, maxzoom });
  map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 } }, beforeId);
  return bounds;
}

/** Repaint a layer after its style changed (cached planes make this cheap). */
export function restyle(map: MlMap, id: string, style: Partial<ProductStyle>) {
  setStyle(id, style);
  const v = (versions.get(id) ?? 0) + 1;
  versions.set(id, v);
  (map.getSource(id) as RasterTileSource | undefined)?.setTiles([tileUrl(id, v)]);
}

export function hideLayer(map: MlMap, id: string) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
  removeLayer(id);
}

/**
 * Swap a layer's definition in place: the MapLibre source stays, only its
 * tile URL version moves. When the inputs are unchanged (a rule edit, a new
 * threshold) the engine's plane cache answers every tile — no flash, no
 * re-download. Draws it fresh when it is not on the map yet.
 */
export async function updateLayer(map: MlMap, id: string, def: LayerDef, beforeId: string, opacity = 1) {
  if (!map.getSource(id)) return showLayer(map, id, def, beforeId, opacity);
  const bounds = await setLayer(id, def);
  const v = (versions.get(id) ?? 0) + 1;
  versions.set(id, v);
  (map.getSource(id) as RasterTileSource).setTiles([tileUrl(id, v)]);
  return bounds;
}
