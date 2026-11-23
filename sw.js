'use strict';

// Zorgt dat de app zelf ook zonder bereik opent: de eigen bestanden en de bibliotheken
// (MapLibre, iconen) eerst vers van internet, en zonder bereik uit de opslag.
// Kaarttegels en wandelroutes regelt app.js zelf.
const CACHE = 'veloverde-app-v1';
const SHELL_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin && !SHELL_HOSTS.includes(url.hostname)) return;
  // Grote datalijsten (stations, luchthavens, stadsnamen): meteen uit de opslag, en op de
  // achtergrond vernieuwd voor de volgende keer. Zo wacht het opstarten niet op een megabyte.
  if (url.origin === location.origin && url.pathname.endsWith('.json') && !url.pathname.endsWith('manifest.json')) {
    const fresh = fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    });
    e.respondWith(caches.match(req).then(hit => {
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh;
    }));
    return;
  }
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      // Het startscherm kan met of zonder ?demo=1 geopend zijn
      .catch(() => caches.match(req, { ignoreSearch: req.mode === 'navigate' })
        .then(hit => hit || Response.error()))
  );
});
