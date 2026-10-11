// The point-cloud worker: COPC reading and laz-perf decoding off the main
// thread. One request = one chunk's metric grids, transferred back.

import { createLazPerf, type LazPerf } from 'laz-perf';
import lazPerfWasmUrl from 'laz-perf/lib/web/laz-perf.wasm?url';
import { PcReader } from './pcReader.ts';
import type { CellGrid } from './pcMetrics.ts';

export interface PcRequest { id: number; urls: string[]; grid: CellGrid; margin: number }
export type PcResponse =
  | { id: number; ok: true; metrics: Record<string, Float32Array>; points: number; depths: number[]; totalBytes: number }
  | { id: number; ok: false; error: string };

let lp: Promise<LazPerf> | null = null;
const lazPerf = () => (lp ??= createLazPerf({ locateFile: () => lazPerfWasmUrl } as unknown as Parameters<typeof createLazPerf>[0]));
const reader = new PcReader(lazPerf);

self.onmessage = async (e: MessageEvent<PcRequest>) => {
  const { id, urls, grid, margin } = e.data;
  try {
    const r = await reader.chunk(urls, grid, margin);
    // The worker's running total: requests overlap, so a per-request difference would count shared reads twice.
    const msg: PcResponse = { id, ok: true, metrics: r.metrics, points: r.points, depths: r.depths, totalBytes: reader.stats.bytes };
    (self as unknown as Worker).postMessage(msg, Object.values(r.metrics).map(a => a.buffer));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error).message ?? String(err) } satisfies PcResponse);
  }
};
