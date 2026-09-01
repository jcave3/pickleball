const STATIC_CACHE = 'pickleball-static-v2-ux-1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './log-game.html',
  './history.html',
  './players.html',
  './player.html',
  './settings.html',
  './css/style.css',
  './js/config.js',
  './js/api.js',
  './js/admin.js',
  './js/leaderboard.js',
  './js/log-game.js',
  './js/history.js',
  './js/players.js',
  './js/player.js',
  './js/settings.js',
  './js/csv.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
