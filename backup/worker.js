// Back-up van Verlocidad: per gebruiker één versleuteld pakketje (de server kan het niet lezen).
// GET  /b/<id>  → het pakketje
// PUT  /b/<id>  → bewaren; header X-Write moet kloppen met de eerste keer (alleen wie de link heeft kan schrijven)
// GET  /tt/...  → verkeer van TomTom doorgeven. De sleutel staat geheim bij Cloudflare (TOMTOM_KEY),
//                 niet in de app; alleen verzoeken van de app zelf, en alleen deze drie soorten.
const ORIGINS = ['https://nunc72.github.io', 'http://localhost:8770'];
const MAX = 256 * 1024;

const TT_PATHS = [
  /^\/map\/4\/tile\/flow\/relative\/\d{1,2}\/\d{1,7}\/\d{1,7}\.pbf$/,
  /^\/map\/4\/tile\/incidents\/\d{1,2}\/\d{1,7}\/\d{1,7}\.pbf$/,
  /^\/services\/5\/incidentDetails$/,
];

async function traffic(req, env, ctx, path, cors) {
  const origin = req.headers.get('Origin') || '';
  const referer = req.headers.get('Referer') || '';
  if (!ORIGINS.some(o => origin === o || referer.startsWith(o + '/'))) return new Response('niet toegestaan', { status: 403, headers: cors });
  if (!TT_PATHS.some(r => r.test(path))) return new Response('niet gevonden', { status: 404, headers: cors });
  if (!env.TOMTOM_KEY) return new Response('geen sleutel ingesteld', { status: 503, headers: cors });
  // Een minuut bewaren bij Cloudflare: wie hetzelfde vraagt, kost TomTom geen extra verzoek
  const url = new URL(req.url);
  url.searchParams.delete('key');
  const cacheKey = new Request(url.toString());
  const cache = caches.default;
  let res = await cache.match(cacheKey);
  if (!res) {
    const up = new URL('https://api.tomtom.com/traffic' + path + url.search);
    up.searchParams.set('key', env.TOMTOM_KEY);
    // De sleutel werkt alleen voor onze site (whitelist bij TomTom): zeg dat het van daar komt
    const r = await fetch(up, { headers: { 'Accept-Encoding': 'gzip', Origin: ORIGINS[0], Referer: ORIGINS[0] + '/Snelheidsbalk/' } });
    res = new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/octet-stream',
      'Cache-Control': 'public, max-age=60' } });
    if (r.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  }
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Write',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const out = (body, status = 200) => new Response(body, { status, headers: { ...cors, 'Content-Type': 'text/plain' } });
    if (req.method === 'OPTIONS') return out(null, 204);
    const path = new URL(req.url).pathname;
    if (path.startsWith('/tt/') && req.method === 'GET') return traffic(req, env, ctx, path.slice(3), cors);
    const m = path.match(/^\/b\/([0-9a-f]{32})$/);
    if (!m) return out('niet gevonden', 404);
    const id = m[1];
    if (req.method === 'GET') {
      const row = await env.DB.prepare('SELECT d FROM backups WHERE id = ?').bind(id).first();
      return row ? out(row.d) : out('geen back-up', 404);
    }
    if (req.method === 'PUT') {
      const w = req.headers.get('X-Write') || '';
      if (!/^[0-9a-f]{64}$/.test(w)) return out('geen sleutel', 401);
      const body = await req.text();
      if (body.length > MAX) return out('te groot', 413);
      const wh = await sha(w);
      const row = await env.DB.prepare('SELECT w FROM backups WHERE id = ?').bind(id).first();
      if (row && row.w !== wh) return out('verkeerde sleutel', 403);
      await env.DB.prepare('INSERT INTO backups (id, w, d, t) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET d = excluded.d, t = excluded.t')
        .bind(id, wh, body, Date.now()).run();
      return out('ok');
    }
    return out('niet toegestaan', 405);
  },
};
