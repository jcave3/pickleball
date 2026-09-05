const STATIC_CACHE = 'pickleball-static-v5-picker-skeletons-1';
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

  // `cache: 'no-cache'` forces a conditional request (If-None-Match /
  // If-Modified-Since) instead of letting the browser's own HTTP cache answer
  // from its copy. Without it, network-first isn't actually network-first:
  // fetch() here goes through the same HTTP cache as any other request, and
  // GitHub Pages serves these assets with `max-age=600`, so a phone can sit on
  // stale bytes for ten minutes. That's how you get the failure mode this
  // guards against — index.html and a js/ file change in the same deploy, one
  // revalidates and the other doesn't, and the new script runs against the old
  // markup (missing element -> TypeError -> the page renders nothing at all).
  // The cost is a round trip per asset, but a 304 is empty, and the .catch()
  // below still falls back to the cache when the network is genuinely gone.
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
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
