/*
  Optional: tiny Cloudflare Worker that lets ShipZip reach the IONOS DNS API
  if IONOS blocks direct calls from web pages (CORS).

  1. Cloudflare dashboard → Workers & Pages → Create → Worker → paste this file → Deploy.
  2. Set ALLOWED_ORIGIN below to the address ShipZip is hosted on, e.g. https://yourname.github.io
  3. In ShipZip → Your site → "How do I get an IONOS API key?" → IONOS API address,
     enter:  https://<your-worker>.workers.dev/dns/v1

  The worker stores nothing. It only forwards /dns/v1/* requests from ALLOWED_ORIGIN to IONOS.
*/
const ALLOWED_ORIGIN = 'https://YOURNAME.github.io';
const UPSTREAM = 'https://api.hosting.ionos.com';

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'X-API-Key, Content-Type, Accept',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin'
    };
    if (origin !== ALLOWED_ORIGIN) return new Response('Forbidden', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/dns/v1/')) return new Response('Not found', { status: 404, headers: cors });

    const headers = new Headers();
    for (const h of ['X-API-Key', 'Content-Type', 'Accept']) {
      const v = request.headers.get(h); if (v) headers.set(h, v);
    }
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer()
    });
    const out = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  }
};
