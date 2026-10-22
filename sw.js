// Offline cache for the app shell. Bump VERSION when files change.
const VERSION = 'tube-counter-v4';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'src/count.js', 'src/core.js', 'src/auto.js', 'src/measure.js', 'src/xr.js', 'src/xr-native.js', 'src/worker.js', 'src/app.js', 'src/app.css',
  'assets/sample.jpg', 'assets/icon-192.png', 'assets/icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && new URL(e.request.url).origin === location.origin) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
    }
    return res;
  })));
});
