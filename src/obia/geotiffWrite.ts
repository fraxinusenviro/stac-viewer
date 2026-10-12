// A minimal GeoTIFF writer for the OBIA label rasters: one band, Int32
// (segment ids, −1 = no object) or UInt8 (class index, 0 = none),
// uncompressed, strips, little-endian, with the CRS as an EPSG code in the
// GeoKeys and PixelIsArea. It is an ordinary GeoTIFF and is called one — NOT
// a Cloud-Optimized GeoTIFF (no tiling, no overviews). Pure; the test reads
// the bytes back with geotiff.js (test/obiaExport.test.ts).

import type { GridDefinition } from './types.ts';

export function writeGeoTiff(grid: GridDefinition & { epsg: number }, data: Int32Array | Uint8Array, opts: { nodata?: number; description?: string } = {}): ArrayBuffer {
  const { width: w, height: h } = grid;
  if (data.length !== w * h) throw new Error('raster size does not match the grid');
  if (grid.transform[2] !== 0 || grid.transform[4] !== 0) throw new Error('rotated grids are not written');
  const int = data instanceof Int32Array, bps = int ? 32 : 8, bytesPer = bps / 8;
  const projected = !(grid.epsg === 4326 || grid.epsg === 4269);
  const rowsPerStrip = Math.max(1, Math.floor(65536 / (w * bytesPer)));
  const strips = Math.ceil(h / rowsPerStrip);
  const geoKeys = [1, 1, 0, 3, 1024, 0, 1, projected ? 1 : 2, 1025, 0, 1, 1, projected ? 3072 : 2048, 0, 1, grid.epsg];
  const nodata = opts.nodata !== undefined ? `${opts.nodata}\0` : null;
  const desc = opts.description ? `${opts.description}\0` : null;
  type Entry = { tag: number; type: number; count: number; value: number[] | string };
  const entries: Entry[] = [
    { tag: 256, type: 4, count: 1, value: [w] },
    { tag: 257, type: 4, count: 1, value: [h] },
    { tag: 258, type: 3, count: 1, value: [bps] },
    { tag: 259, type: 3, count: 1, value: [1] },
    { tag: 262, type: 3, count: 1, value: [1] },
    ...(desc ? [{ tag: 270, type: 2, count: desc.length, value: desc }] : []),
    { tag: 273, type: 4, count: strips, value: new Array(strips).fill(0) },
    { tag: 277, type: 3, count: 1, value: [1] },
    { tag: 278, type: 4, count: 1, value: [rowsPerStrip] },
    { tag: 279, type: 4, count: strips, value: Array.from({ length: strips }, (_, s) => Math.min(rowsPerStrip, h - s * rowsPerStrip) * w * bytesPer) },
    { tag: 284, type: 3, count: 1, value: [1] },
    { tag: 339, type: 3, count: 1, value: [int ? 2 : 1] },
    { tag: 33550, type: 12, count: 3, value: [grid.transform[1], -grid.transform[5], 0] },
    { tag: 33922, type: 12, count: 6, value: [0, 0, 0, grid.transform[0], grid.transform[3], 0] },
    { tag: 34735, type: 3, count: geoKeys.length, value: geoKeys },
    ...(nodata ? [{ tag: 42113, type: 2, count: nodata.length, value: nodata }] : []),
  ].sort((a, b) => a.tag - b.tag);
  const size = (t: number) => (t === 3 ? 2 : t === 4 ? 4 : t === 12 ? 8 : 1);
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdSize;
  const offsets = new Map<Entry, number>();
  for (const e of entries) { const n = size(e.type) * e.count; if (n > 4) { offsets.set(e, extra); extra += n + (n % 2); } }
  const dataStart = extra;
  const buf = new ArrayBuffer(dataStart + data.byteLength);
  const v = new DataView(buf);
  v.setUint16(0, 0x4949); v.setUint16(2, 42, true); v.setUint32(4, 8, true);
  const stripOffsets = entries.find(e => e.tag === 273)!;
  stripOffsets.value = Array.from({ length: strips }, (_, s) => dataStart + s * rowsPerStrip * w * bytesPer);
  const put = (at: number, type: number, vals: number[] | string) => {
    if (typeof vals === 'string') { for (let i = 0; i < vals.length; i++) v.setUint8(at + i, vals.charCodeAt(i)); return; }
    vals.forEach((x, i) => { if (type === 3) v.setUint16(at + 2 * i, x, true); else if (type === 4) v.setUint32(at + 4 * i, x, true); else if (type === 12) v.setFloat64(at + 8 * i, x, true); });
  };
  let p = 8;
  v.setUint16(p, entries.length, true); p += 2;
  for (const e of entries) {
    v.setUint16(p, e.tag, true); v.setUint16(p + 2, e.type, true); v.setUint32(p + 4, e.count, true);
    const off = offsets.get(e);
    if (off !== undefined) { v.setUint32(p + 8, off, true); put(off, e.type, e.value); } else put(p + 8, e.type, e.value);
    p += 12;
  }
  v.setUint32(p, 0, true);
  new Uint8Array(buf, dataStart).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return buf;
}
