// The LiDAR tile search: which COPC tiles cover a lon/lat box, answered from a
// static parquet file by HTTP range reads — no server, no database.
//
// The request chain is the one the file's layout allows (scripts/
// build-lidar-index.mjs): ONE speculative read of the file's tail fetches the
// footer and states the file size; every later search reads only the column
// chunks of the row groups whose bbox statistics can meet the box. Two lessons
// taken from taylor-geospatial/s2-stac-geoparquet (search.js), both measured
// there:
//
//  - every range read is `cache: "no-store"`. Chrome serialises concurrent
//    requests for one URL behind its HTTP cache lock, so the parallel chunk
//    reads of one search arrive as a staircase; out of the cache they arrive
//    together.
//  - a 200 to a ranged request is REFUSED. It means the server ignored the
//    Range header, and a search must never pull the whole file.
//  - the tail read's Content-Range is CHECKED, not trusted. Vite's preview
//    server answers `bytes=-65536` with the FIRST 65 537 bytes; GitHub Pages
//    and S3 answer it correctly. When the bytes are not the tail, the tail is
//    asked for again by explicit offsets.
//
// A row group with no statistics is admitted, never skipped: correctness over
// bytes.

import { parquetMetadata, parquetReadObjects, type AsyncBuffer, type FileMetaData } from 'hyparquet';

export type LonLatBox = [number, number, number, number];

export interface LidarTile {
  project: string;
  key: string;
  year: number;
  points: number;
  bytes: number;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export interface SearchStats {
  groupsRead: number;
  groupsTotal: number;
  bytesRead: number;
  requests: number;
  ms: number;
}

const COLUMNS = ['project', 'key', 'year', 'points', 'bytes', 'xmin', 'ymin', 'xmax', 'ymax'] as const;
const BBOX_COLS = ['xmin', 'ymin', 'xmax', 'ymax'] as const;
/** The tail read: holds the 8-byte trailer and, normally, the whole footer. */
const TAIL_BYTES = 64 * 1024;

/** Row groups whose bbox statistics cannot exclude `box`. Pure. */
export function admitGroups(meta: FileMetaData, box: LonLatBox): number[] {
  const out: number[] = [];
  meta.row_groups.forEach((rg, i) => {
    const stat = (name: string) => rg.columns.find(c => c.meta_data?.path_in_schema.join('.') === name)?.meta_data?.statistics;
    const [sx0, sy0, sx1, sy1] = BBOX_COLS.map(stat);
    // Need: min(xmin) <= box.xmax, max(xmax) >= box.xmin, and the same in y.
    const lo = (s: typeof sx0, which: 'min_value' | 'max_value') => (s && typeof s[which] === 'number' ? (s[which] as number) : null);
    const minX = lo(sx0, 'min_value'), maxX = lo(sx1, 'max_value');
    const minY = lo(sy0, 'min_value'), maxY = lo(sy1, 'max_value');
    if (minX !== null && minX > box[2]) return;
    if (maxX !== null && maxX < box[0]) return;
    if (minY !== null && minY > box[3]) return;
    if (maxY !== null && maxY < box[1]) return;
    out.push(i);
  });
  return out;
}

/** The first row of each row group, so a group can be read by row range. */
export function groupRowStarts(meta: FileMetaData): number[] {
  const starts: number[] = [];
  let row = 0;
  for (const rg of meta.row_groups) { starts.push(row); row += Number(rg.num_rows); }
  starts.push(row);
  return starts;
}

export const intersects = (t: LidarTile, b: LonLatBox) => t.xmin <= b[2] && t.xmax >= b[0] && t.ymin <= b[3] && t.ymax >= b[1];

type RangeGet = (start: number, end: number) => Promise<ArrayBuffer>;

/** A ranged fetch that refuses a 200 and reports the file size from Content-Range. */
async function rangeFetch(url: string, range: string): Promise<{ buf: ArrayBuffer; start: number; size: number }> {
  const res = await fetch(url, { cache: 'no-store', headers: { Range: range } });
  if (res.status !== 206) throw new Error(`range read of ${url} got HTTP ${res.status} — the server must honour Range`);
  const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers.get('content-range') ?? '');
  if (!m) throw new Error(`range read of ${url} carried no usable Content-Range`);
  return { buf: await res.arrayBuffer(), start: Number(m[1]), size: Number(m[3]) };
}

export class LidarIndex {
  private url: string;
  private opened: Promise<{ meta: FileMetaData; file: AsyncBuffer; size: number }> | null = null;
  private counter = { bytes: 0, requests: 0 };

  constructor(url: string) { this.url = url; }

  private open() {
    this.opened ??= (async () => {
      let tail = await rangeFetch(this.url, `bytes=-${TAIL_BYTES}`);
      this.counter.bytes += tail.buf.byteLength; this.counter.requests++;
      const size = tail.size;
      if (tail.start + tail.buf.byteLength !== size) {
        tail = await rangeFetch(this.url, `bytes=${Math.max(0, size - TAIL_BYTES)}-${size - 1}`);
        this.counter.bytes += tail.buf.byteLength; this.counter.requests++;
      }
      const tailStart = tail.start;
      const get: RangeGet = async (start, end) => {
        if (start >= tailStart) return tail.buf.slice(start - tailStart, end - tailStart);
        const r = await rangeFetch(this.url, `bytes=${start}-${end - 1}`);
        this.counter.bytes += r.buf.byteLength; this.counter.requests++;
        return r.buf;
      };
      const file: AsyncBuffer = { byteLength: size, slice: (s, e) => get(s, e ?? size) };
      // The footer length is the 4 bytes before the trailing "PAR1".
      const footerLen = new DataView(tail.buf).getUint32(tail.buf.byteLength - 8, true);
      const footer = footerLen + 8 <= tail.buf.byteLength ? tail.buf : await get(size - footerLen - 8, size);
      const meta = parquetMetadata(footer);
      return { meta, file, size };
    })();
    this.opened.catch(() => { this.opened = null; });
    return this.opened;
  }

  /** Every tile whose footprint box meets `box`, plus what the search cost. */
  async search(box: LonLatBox): Promise<{ tiles: LidarTile[]; stats: SearchStats }> {
    const t0 = performance.now();
    const before = { ...this.counter };
    const { meta, file } = await this.open();
    const groups = admitGroups(meta, box);
    const starts = groupRowStarts(meta);
    const parts = await Promise.all(groups.map(g => parquetReadObjects({
      file, metadata: meta, columns: [...COLUMNS], rowStart: starts[g], rowEnd: starts[g + 1],
    }) as Promise<LidarTile[]>));
    const tiles = parts.flat().filter(t => intersects(t, box));
    return {
      tiles,
      stats: {
        groupsRead: groups.length, groupsTotal: meta.row_groups.length,
        bytesRead: this.counter.bytes - before.bytes, requests: this.counter.requests - before.requests,
        ms: performance.now() - t0,
      },
    };
  }
}
