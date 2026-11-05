// Offline support: serve the app from cache, refresh the cache in the background.
const CACHE = 'qrbeam-v1';
const FILES = [
  './', 'index.html', 'send.html', 'receive.html', 'style.css', 'fountain.js',
  'decode-worker.js', 'vendor/jsQR.js', 'vendor/qrcode.js', 'manifest.webmanifest',
  'icon.svg', 'icon-180.png', 'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: instant (and offline) loads, updates picked up on the next visit.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
