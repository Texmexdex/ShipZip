/* ShipZip service worker: offline app shell + Android share target. */
const VERSION = 'shipzip-v1';
const SHELL = ['./', './index.html', './app.js', './core.js', './vendor/jszip.min.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== VERSION && k !== 'shipzip-share').map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // A zip shared from another app arrives here as a POST.
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const app = new URL('./', self.registration.scope);
      try {
        const form = await e.request.formData();
        const file = form.getAll('zip').find(f => f && typeof f === 'object' && 'size' in f);
        if (!file) return Response.redirect(app.href + '?shared=none', 303);
        const cache = await caches.open('shipzip-share');
        await cache.put('shared-file', new Response(file, {
          headers: { 'Content-Type': file.type || 'application/zip', 'X-File-Name': encodeURIComponent(file.name || 'shared.zip') }
        }));
        return Response.redirect(app.href + '?shared=1', 303);
      } catch (err) {
        return Response.redirect(app.href + '?shared=none', 303);
      }
    })());
    return;
  }

  // App shell: network first (so updates land), cache as offline fallback. Only same-origin GETs.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
