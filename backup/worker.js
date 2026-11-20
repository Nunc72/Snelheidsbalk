// Back-up van Verlocidad: per gebruiker één versleuteld pakketje (de server kan het niet lezen).
// GET  /b/<id>  → het pakketje
// PUT  /b/<id>  → bewaren; header X-Write moet kloppen met de eerste keer (alleen wie de link heeft kan schrijven)
const ORIGINS = ['https://nunc72.github.io', 'http://localhost:8770'];
const MAX = 256 * 1024;

const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

export default {
  async fetch(req, env) {
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
    const m = new URL(req.url).pathname.match(/^\/b\/([0-9a-f]{32})$/);
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
