const CACHE = 'brosseftracker-v7';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
  await self.clients.claim();
  const windows = await self.clients.matchAll({ type: 'window' });
  await Promise.all(windows.map((client) => client.navigate(client.url)));
})()));
self.addEventListener('fetch', (event) => {
  const request = event.request; if (request.method !== 'GET') return; const url = new URL(request.url); if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) { event.respondWith(fetch(request).then((response) => { if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone())); return response; }).catch(() => caches.match(request))); return; }
  event.respondWith(fetch(request).then((response) => { if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone())); return response; }).catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html'))));
});
