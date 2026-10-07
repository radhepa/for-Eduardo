// Crow app service worker: network first, cached copy when offline (so the app opens at 7am
// even if the Wi-Fi is down; the clock talks Bluetooth, not internet).
const CACHE = 'crow-app-v1';
const SHELL = [
  './app.html', './manifest.webmanifest', './css/app.css',
  './js/real.js', './js/app.js', './js/ble-link.js', './js/proto.js', './js/rules.js',
  './js/puzzles.js', './js/crow-art.js', './js/audio.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
