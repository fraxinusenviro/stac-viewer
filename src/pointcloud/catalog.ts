// The point-cloud catalogue every part of the app shares: the static parquet
// tile index (lidarIndex.ts) and the project list, opened once.

import { LidarIndex, type LidarTile, type LonLatBox } from '../lidarIndex.ts';

export interface Project {
  id: string; label: string; jurisdiction: string; year: number; crs: string; verticalDatum: string;
  provider: string; licence: string; urlTemplate: string; tiles: number; points: number; bytes: number;
  bbox: LonLatBox;
}

const DATA = new URL('data/', document.baseURI).href;
export const index = new LidarIndex(DATA + 'lidar-tiles.parquet');
export const projectById = new Map<string, Project>();
let loaded: Promise<Project[]> | null = null;

export function loadProjects(): Promise<Project[]> {
  loaded ??= fetch(DATA + 'lidar-projects.json').then(r => r.json()).then((pj: { projects: Project[] }) => {
    pj.projects.forEach(p => projectById.set(p.id, p));
    return pj.projects;
  });
  loaded.catch(() => { loaded = null; });
  return loaded;
}

export const copcUrl = (t: LidarTile) => projectById.get(t.project)?.urlTemplate.replace('{name}', t.key) ?? '';
export const coverageUrl = DATA + 'lidar-coverage.geojson';
