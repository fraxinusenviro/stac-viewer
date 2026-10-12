// A STAC API adapter for the OBIA sources step (spec §3). STAC is the
// catalogue; it says nothing about whether an asset can actually be read, so
// every asset is PROBED (probe.ts) before it is used.
//
// What it does, from what the API advertises rather than assumes:
//   • reads the landing page's `conformsTo` (or /conformance) and uses
//     Item Search only when it is advertised; GET unless the query needs an
//     extension only a JSON body carries, and POST only when advertised —
//     falling back to GET when the browser cannot send it (a JSON POST needs
//     a CORS preflight, and the NRCan datacube refuses preflights: verified
//     2026-10-12);
//   • follows `next` links — GET, or POST with the link's own body (merged
//     or not, per the link) — up to a stated page cap, and SAYS when the cap
//     cut the results short;
//   • resolves relative hrefs against the item's self link or the page URL;
//   • keeps collection, item and asset identifiers as given.
// `fetch` is injected, so the adapter is tested against fixtures
// (test/obiaSources.test.ts). Endpoints are configured below, each with the
// date it was last checked; nothing else is hard-coded.

export interface StacProvider {
  id: string;
  label: string;
  url: string;
  collections: string[];
  attribution: string;
  /** When the endpoint, its CORS and its assets' range access were last verified. */
  verified: string;
}

export const STAC_PROVIDERS: StacProvider[] = [
  { id: 'earth-search', label: 'Element 84 Earth Search (Sentinel-2 L2A)', url: 'https://earth-search.aws.element84.com/v1', collections: ['sentinel-2-c1-l2a'], attribution: 'Copernicus Sentinel-2 data, via Element 84 Earth Search', verified: '2026-10-12' },
  // The trailing slash matters: without it the server answers a 301 that carries no CORS header.
  { id: 'nrcan-datacube', label: 'NRCan datacube (HRDEM LiDAR DTM/DSM)', url: 'https://datacube.services.geo.ca/stac/api/', collections: ['hrdem-lidar', 'hrdem-mosaic-1m', 'hrdem-mosaic-2m'], attribution: 'Natural Resources Canada, Open Government Licence – Canada', verified: '2026-10-12' },
];

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Capabilities { conformsTo: string[]; itemSearch: boolean; query: boolean; filter: boolean; sort: boolean; searchMethods: string[]; /** The advertised search endpoint (it need not be <root>/search). */ searchUrl?: string }

const has = (cs: string[], frag: string) => cs.some(c => c.includes(frag));

export async function capabilities(p: StacProvider, f: Fetch = fetch): Promise<Capabilities> {
  const r = await f(p.url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${p.label}: landing page answered HTTP ${r.status}`);
  const base = r.url || p.url;
  const land = await r.json() as { conformsTo?: string[]; links?: { rel: string; href: string; method?: string }[] };
  let cs = land.conformsTo ?? [];
  if (!cs.length) {
    const c = land.links?.find(l => l.rel === 'conformance');
    if (c) { const rr = await f(new URL(c.href, base).href); if (rr.ok) cs = ((await rr.json()) as { conformsTo?: string[] }).conformsTo ?? []; }
  }
  const searchLinks = (land.links ?? []).filter(l => l.rel === 'search');
  const methods = [...new Set(searchLinks.map(l => (l.method ?? 'GET').toUpperCase()))];
  // Only ITEM-search extensions count: an API may offer `#query` on collection search alone.
  return {
    conformsTo: cs, itemSearch: has(cs, '/item-search'), query: has(cs, 'item-search#query'),
    filter: has(cs, 'item-search#filter'), sort: has(cs, 'item-search#sort'),
    searchMethods: methods.length ? methods : ['GET'],
    searchUrl: searchLinks[0] ? new URL(searchLinks[0].href, base).href : undefined,
  };
}

export interface NormalizedAsset { key: string; href: string; type?: string; roles: string[]; gsd?: number; epsg?: number; bands: { name: string; scale?: number; offset?: number; noData?: number; unit?: string }[] }
export interface NormalizedItem {
  providerId: string;
  collectionId: string;
  itemId: string;
  datetime: string | null;
  start: string | null;
  end: string | null;
  bbox: [number, number, number, number] | null;
  geometry: GeoJSON.Geometry | null;
  properties: Record<string, unknown>;
  assets: Record<string, NormalizedAsset>;
}

interface RawItem { id: string; collection?: string; bbox?: number[]; geometry?: GeoJSON.Geometry; properties?: Record<string, unknown>; links?: { rel: string; href: string }[]; assets?: Record<string, Record<string, unknown>> }

export function normalizeItem(p: StacProvider, it: RawItem, base: string): NormalizedItem {
  const self = it.links?.find(l => l.rel === 'self')?.href;
  const root = self ? new URL(self, base).href : base;
  const props = it.properties ?? {};
  const assets: Record<string, NormalizedAsset> = {};
  for (const [key, a] of Object.entries(it.assets ?? {})) {
    if (typeof a.href !== 'string') continue;
    const rb = (a['raster:bands'] ?? a.bands ?? a['eo:bands'] ?? []) as Record<string, unknown>[];
    const code = (a['proj:epsg'] ?? props['proj:epsg'] ?? String(a['proj:code'] ?? props['proj:code'] ?? '').replace(/^EPSG:/, '')) as number | string;
    assets[key] = {
      key, href: new URL(a.href, root).href, type: a.type as string | undefined, roles: (a.roles as string[]) ?? [],
      gsd: (a.gsd ?? props.gsd) as number | undefined, epsg: Number(code) || undefined,
      bands: rb.map((b, i) => ({ name: String(b.name ?? b.common_name ?? `band${i + 1}`), scale: b.scale as number | undefined, offset: b.offset as number | undefined, noData: (b.nodata ?? b['nodata']) as number | undefined, unit: b.unit as string | undefined })),
    };
  }
  const b = it.bbox;
  return {
    providerId: p.id, collectionId: it.collection ?? '', itemId: it.id,
    datetime: (props.datetime as string | null) ?? null, start: (props.start_datetime as string | null) ?? null, end: (props.end_datetime as string | null) ?? null,
    bbox: b && b.length >= 4 ? [b[0], b[1], b[2], b[3]] : null, geometry: it.geometry ?? null, properties: props, assets,
  };
}

export interface SearchQuery { bbox: [number, number, number, number]; datetime?: string; collections?: string[]; limit?: number; query?: Record<string, unknown>; sortby?: { field: string; direction: 'asc' | 'desc' }[] }
export interface SearchResult { items: NormalizedItem[]; pages: number; truncated: boolean; method: string; /** Extensions that could not be applied (the caller must filter, or say so). */ dropped: string[] }

export async function search(p: StacProvider, q: SearchQuery, caps: Capabilities, f: Fetch = fetch, maxPages = 5): Promise<SearchResult> {
  if (!caps.itemSearch) throw new Error(`${p.label} does not advertise Item Search`);
  const body: Record<string, unknown> = { collections: q.collections ?? p.collections, bbox: q.bbox, limit: q.limit ?? 50 };
  if (q.datetime) body.datetime = q.datetime;
  if (q.query && caps.query) body.query = q.query;
  if (q.sortby && caps.sort) body.sortby = q.sortby;
  const wantsBody = !!(body.query || body.sortby);
  let post = wantsBody && caps.searchMethods.includes('POST');
  const base = caps.searchUrl ?? `${p.url.replace(/\/$/, '')}/search`;
  const getUrl = () => {
    const u = new URL(base);
    u.searchParams.set('collections', (body.collections as string[]).join(','));
    u.searchParams.set('bbox', q.bbox.join(','));
    u.searchParams.set('limit', String(body.limit));
    if (q.datetime) u.searchParams.set('datetime', q.datetime);
    return u.href;
  };
  let url = post ? base : getUrl();
  let init: RequestInit | undefined = post ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined;
  let dropped: string[] = [];
  const items: NormalizedItem[] = [];
  let pages = 0, truncated = false;
  for (;;) {
    let r: Response;
    try { r = await f(url, init); }
    catch (e) {
      // A POST the browser could not send (CORS preflight refused): once, as GET, without the body-only extensions.
      if (!post || pages) throw e;
      post = false; url = getUrl(); init = undefined;
      dropped = ['query', 'sortby'].filter(k => k in body);
      r = await f(url, init);
    }
    if (!r.ok) throw new Error(`${p.label}: search answered HTTP ${r.status}`);
    const page = await r.json() as { features?: RawItem[]; links?: { rel: string; href: string; method?: string; body?: Record<string, unknown>; merge?: boolean }[] };
    pages++;
    for (const it of page.features ?? []) items.push(normalizeItem(p, it, url));
    const next = page.links?.find(l => l.rel === 'next');
    if (!next) break;
    if (pages >= maxPages) { truncated = true; break; }
    url = new URL(next.href, url).href;
    const m = (next.method ?? 'GET').toUpperCase();
    if (m === 'POST') {
      const prev = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
      init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next.merge ? { ...prev, ...(next.body ?? {}) } : (next.body ?? prev)) };
    } else init = undefined;
  }
  return { items, pages, truncated, method: post ? 'POST' : 'GET', dropped };
}
