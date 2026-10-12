import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilities, search, type StacProvider } from '../src/obia/stacAdapter.ts';
import { probeRange } from '../src/obia/probe.ts';

const P: StacProvider = { id: 'p', label: 'Fixture STAC', url: 'https://stac.example/api/', collections: ['c1'], attribution: '', verified: 'test' };
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });

test('capabilities: conformance read from the landing page, or from /conformance', async () => {
  const f = async (url: string) => (url === P.url
    ? json({ links: [{ rel: 'conformance', href: 'conformance' }, { rel: 'search', href: 'search', method: 'POST' }] })
    : json({ conformsTo: ['https://api.stacspec.org/v1.0.0/item-search', 'https://api.stacspec.org/v1.0.0/item-search#sort'] }));
  const c = await capabilities(P, f as typeof fetch);
  assert.equal(c.itemSearch, true);
  assert.equal(c.sort, true);
  assert.equal(c.query, false);
  assert.deepEqual(c.searchMethods, ['POST']);
});

test('search: follows next links (POST with merge), resolves relative hrefs, keeps identifiers, reports truncation', async () => {
  const calls: { url: string; body?: unknown }[] = [];
  const page = (n: number, next: boolean) => json({
    features: [{ id: `item-${n}`, collection: 'c1', properties: { datetime: '2024-07-0' + n + 'T00:00:00Z' }, links: [{ rel: 'self', href: `https://stac.example/api/collections/c1/items/item-${n}` }],
      assets: { red: { href: `../../../data/item-${n}/B04.tif`, 'raster:bands': [{ scale: 0.0001, offset: -0.1, nodata: 0 }], roles: ['data'] } } }],
    links: next ? [{ rel: 'next', href: 'search', method: 'POST', body: { token: `t${n}` }, merge: true }] : [],
  });
  const f = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    return page(calls.length, calls.length < 3);
  };
  const caps = { conformsTo: [], itemSearch: true, query: true, filter: false, sort: false, searchMethods: ['POST'] };
  const r = await search(P, { bbox: [-64, 44, -63, 45], query: { 'eo:cloud_cover': { lte: 20 } } }, caps, f as typeof fetch);
  assert.equal(r.pages, 3);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.items.map(i => i.itemId), ['item-1', 'item-2', 'item-3']);
  assert.equal(r.items[0].assets.red.href, 'https://stac.example/api/data/item-1/B04.tif');
  assert.equal(r.items[0].assets.red.bands[0].offset, -0.1);
  assert.equal((calls[1].body as { token: string }).token, 't1');
  assert.deepEqual((calls[1].body as { bbox: number[] }).bbox, [-64, 44, -63, 45], 'merge keeps the original body');
  const capped = await search(P, { bbox: [-64, 44, -63, 45], query: {} }, caps, (async () => page(1, true)) as typeof fetch, 2);
  assert.equal(capped.truncated, true);
});

test('search: refused when Item Search is not advertised', async () => {
  await assert.rejects(search(P, { bbox: [0, 0, 1, 1] }, { conformsTo: [], itemSearch: false, query: false, filter: false, sort: false, searchMethods: [] }), /Item Search/);
});

test('probe: 206 is readable; a server ignoring Range, an auth refusal and a network failure are each explained', async () => {
  const ok = await probeRange('https://x/a.tif', (async () => new Response(new Uint8Array(1024), { status: 206, headers: { 'content-range': 'bytes 0-1023/52428800' } })) as typeof fetch);
  assert.deepEqual(ok, { ok: true, size: 52428800, contentType: null });
  const full = await probeRange('https://x/a.tif', (async () => new Response('x'.repeat(10), { status: 200 })) as typeof fetch);
  assert.ok(!full.ok && /ignored the byte-range/.test(full.reason));
  const auth = await probeRange('https://x/a.tif', (async () => new Response('', { status: 403 })) as typeof fetch);
  assert.ok(!auth.ok && /authentication/.test(auth.reason));
  const net = await probeRange('https://x/a.tif', (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch);
  assert.ok(!net.ok && /CORS/.test(net.reason));
});

test('search: GET when no body-only extension is needed; a POST the browser cannot send falls back to GET and says what was dropped', async () => {
  const caps = { conformsTo: [], itemSearch: true, query: true, filter: false, sort: true, searchMethods: ['GET', 'POST'], searchUrl: 'https://stac.example/pg/search' };
  const seen: string[] = [];
  const ok = async (url: string, init?: RequestInit) => { seen.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`); return json({ features: [], links: [] }); };
  const g = await search(P, { bbox: [0, 0, 1, 1] }, caps, ok as typeof fetch);
  assert.equal(g.method, 'GET');
  assert.equal(seen[0], 'GET https://stac.example/pg/search');
  const blocked = async (url: string, init?: RequestInit) => { if (init?.method === 'POST') throw new TypeError('Failed to fetch'); return ok(url, init); };
  const r = await search(P, { bbox: [0, 0, 1, 1], query: { a: 1 }, sortby: [{ field: 'x', direction: 'asc' }] }, caps, blocked as typeof fetch);
  assert.equal(r.method, 'GET');
  assert.deepEqual(r.dropped, ['query', 'sortby']);
});
