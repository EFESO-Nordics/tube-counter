// Offline cache for the app shell. Network first, so a new upload is used
// as soon as it is online; the cache is only the fallback when offline.
const VERSION = 'tube-counter-v5';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'src/count.js', 'src/core.js', 'src/auto.js', 'src/measure.js', 'src/xr.js', 'src/xr-native.js', 'src/worker.js', 'src/app.js', 'src/app.css',
  'assets/sample.jpg', 'assets/icon-192.png', 'assets/icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
