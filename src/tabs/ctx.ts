// What every tab is handed by main.ts, plus the search results the tabs
// share (Fusion reads the Imagery tab's scenes and the Rasters tab's sources).

import type { Map as MlMap } from 'maplibre-gl';
import type { LonLatBox } from '../warp.ts';
import type { HrdemItem, S2Item } from '../stac.ts';
import type { InputItems } from '../sources.ts';
import type { InputSource } from '../engine.ts';
import type { Product } from '../products.ts';
import type { XyzService } from '../xyz.ts';
import type { RunOptions, ToolId } from './analysis.ts';

/**
 * The inputs and classes the analyses run on, owned by the Fusion tab and
 * read and written by the Toolbox — one set, so a LiDAR source or a scene
 * chosen in either is the one both use.
 */
export interface Workspace {
  items(): InputItems;
  ids(): { lidar: string | null; scene: string | null; off: string; ortho: string; pc: boolean };
  set(patch: Partial<{ lidar: string | null; scene: string | null; off: string; ortho: string; pc: boolean }>): void;
  lidarChoices(): HrdemItem[];
  /** Every scene found (leaf-on and leaf-off searches), newest first. */
  scenes(): S2Item[];
  orthoServices(): XyzService[];
  /** Search LiDAR, a clear leaf-on and a clear leaf-off scene for a box, and choose them. */
  findInputs(box: LonLatBox): Promise<void>;
  /** The class product of Fusion ▸ Classes, or null. */
  classProduct(): Product | null;
  /** The named inputs every analysis can read from the inputs in hand. */
  sources(inputs: string[]): Record<string, InputSource>;
  provenance(): string;
  /** Open Fusion ▸ Classes. */
  openClasses(): void;
  analysis: {
    runTool(id: ToolId, opts: RunOptions): Promise<void>;
    blocked(id: ToolId): string;
    busy(): { tool: ToolId; area: string } | null;
    resultsEl(): HTMLElement;
    count(): number;
    unanswered(): number;
    events: EventTarget;
  };
}

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
  /** Set by the Fusion tab. 'workspace' fires when its inputs or classes change. */
  workspace: null as Workspace | null,
  workspaceChanged() { this.events.dispatchEvent(new Event('workspace')); },
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
