// What every tab is handed by main.ts, plus the search results the tabs
// share (Fusion reads the Imagery tab's scenes and the Rasters tab's sources).

import type { Map as MlMap } from 'maplibre-gl';
import type { LonLatBox } from '../warp.ts';
import type { HrdemItem, S2Item } from '../stac.ts';

export interface Ctx {
  map: MlMap;
  say: (msg: string, kind?: 'info' | 'error') => void;
  viewBox: () => LonLatBox;
}

/** Draw-order anchors (empty layers the rasters insert below), bottom to top. */
export const ANCHOR = { imagery: 'anchor-elev', rasters: 'anchor-fusion', fusion: 'anchor-lidar' } as const;

export const shared = {
  hrdem: [] as HrdemItem[],
  scenes: [] as S2Item[],
  events: new EventTarget(),
  setHrdem(items: HrdemItem[]) { this.hrdem = items; this.events.dispatchEvent(new Event('hrdem')); },
  setScenes(items: S2Item[]) { this.scenes = items; this.events.dispatchEvent(new Event('scenes')); },
};

export const itemName = (it: HrdemItem) => (it.kind === 'project' ? it.id : `National ${it.kind.replace('mosaic-', '')} mosaic`);

/**
 * Who a map tap belongs to. Drawing a study area and tapping samples both
 * take taps that would otherwise inspect a result; whoever holds the claim
 * gets them, and every other click handler stands aside.
 */
export const mapClaim = { owner: null as null | 'aoi' | 'sample' };
