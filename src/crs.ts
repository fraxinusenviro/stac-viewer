// proj4 definitions for every CRS the viewer will place data in, keyed
// `EPSG:<code>`. A code not listed here is REFUSED by the callers rather than
// guessed at: a raster drawn in the wrong projection looks entirely plausible.
//
// NAD83(CSRS) is given a null datum shift (`towgs84=0`). That is what NRCan's
// own services do for display and it keeps HRDEM and the COPC footprints
// aligned with each other; true ITRF placement differs by ~1.4 m in Nova
// Scotia, which this viewer does not model.

const CSRS = '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

const FIXED: Record<number, string> = {
  4326: '+proj=longlat +datum=WGS84 +no_defs',
  3857: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs',
  // NAD83(CSRS) / Canada Atlas Lambert — the HRDEM COGs.
  3979: `+proj=lcc +lat_0=49 +lon_0=-95 +lat_1=49 +lat_2=77 +x_0=0 +y_0=0 ${CSRS}`,
};

/** EPSG code → UTM zone for NAD83(CSRS) / UTM 7N–22N. */
const CSRS_UTM: Record<number, number> = {
  3154: 7, 3155: 8, 3156: 9, 3157: 10, 2955: 11, 2956: 12, 2957: 13, 3158: 14, 3159: 15,
  3160: 16, 2958: 17, 2959: 18, 2960: 19, 2961: 20, 2962: 21, 3761: 22,
};

/** The proj4 string for `EPSG:<code>` (or a bare number), or null when unknown. */
export function projDef(code: string | number): string | null {
  const n = typeof code === 'number' ? code : Number(String(code).replace(/^EPSG:/i, ''));
  if (!Number.isInteger(n)) return null;
  if (FIXED[n]) return FIXED[n];
  // WGS 84 / UTM north and south (Sentinel-2, Landsat).
  if (n >= 32601 && n <= 32660) return `+proj=utm +zone=${n - 32600} +datum=WGS84 +units=m +no_defs`;
  if (n >= 32701 && n <= 32760) return `+proj=utm +zone=${n - 32700} +south +datum=WGS84 +units=m +no_defs`;
  // NAD83 / UTM 1N–23N.
  if (n >= 26901 && n <= 26923) return `+proj=utm +zone=${n - 26900} +datum=NAD83 +units=m +no_defs`;
  // NAD83(CSRS) / UTM — the CanElevation COPC tiles. The EPSG codes are not
  // contiguous by zone, hence the table.
  const zone = CSRS_UTM[n];
  if (zone) return `+proj=utm +zone=${zone} ${CSRS}`;
  return null;
}
