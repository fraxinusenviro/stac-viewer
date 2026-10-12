// Probing an asset BEFORE any analysis reads it (spec §3): can this browser
// read a byte range of it? A COG is only usable here by ranged reads; a
// server that ignores Range would send the whole file, and an unbounded
// download is never started silently — the probe aborts the body and the
// asset is reported unavailable with the reason. `fetch` is injected for the
// tests (test/obiaSources.test.ts).

export type ProbeResult =
  | { ok: true; size: number | null; contentType: string | null }
  | { ok: false; reason: string; status?: number };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function probeRange(url: string, f: Fetch = fetch, timeoutMs = 15000): Promise<ProbeResult> {
  if (url.startsWith('local:')) return { ok: true, size: null, contentType: 'image/tiff' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await f(url, { headers: { range: 'bytes=0-1023' }, signal: ctl.signal, cache: 'no-store' });
    if (r.status === 206) {
      const cr = r.headers.get('content-range');
      const size = cr && /\/(\d+)$/.test(cr) ? Number(cr.match(/\/(\d+)$/)![1]) : null;
      await r.arrayBuffer().catch(() => undefined);
      return { ok: true, size, contentType: r.headers.get('content-type') };
    }
    ctl.abort();
    if (r.status === 200) return { ok: false, status: 200, reason: 'the server ignored the byte-range request (it would send the whole file); not read' };
    if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, reason: `access refused (HTTP ${r.status}): the asset needs authentication or a signed URL` };
    if (r.status === 404) return { ok: false, status: 404, reason: 'not found (HTTP 404)' };
    return { ok: false, status: r.status, reason: `HTTP ${r.status}` };
  } catch (e) {
    const name = (e as Error).name;
    return { ok: false, reason: name === 'AbortError' ? `no answer within ${timeoutMs / 1000} s` : 'the request failed before an answer (blocked by CORS, offline, or the host is unreachable)' };
  } finally { clearTimeout(timer); }
}
