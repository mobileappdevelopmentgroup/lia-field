const CACHE = 'lia-field-v26';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './js/device-cache.js',
  './js/storage.js',
  './js/sound.js',
  './js/catalog.js',
  './js/jobs.js',
  './js/entry.js',
  './js/list.js',
  './js/nfc.js',
  './js/sync.js',
  './js/fp.js',
  './js/export.js',
  './js/scan.js',
  './js/sheets.js',
  './js/app.js',
  './js/boot.js',
  'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = e.request.url;
  const isHTML = e.request.destination === 'document' ||
                 url.endsWith('/') ||
                 url.endsWith('index.html');

  if (isHTML) {
    // Network-first for HTML: always fetch fresh when online, fall back to cache offline
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
  } else {
    // Cache-first for all other assets (JS, images, etc.)
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        });
      })
    );
  }
});
