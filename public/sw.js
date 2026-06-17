const SHELL_CACHE = 'shuazi-shell-v2';
const DATA_CACHE  = 'shuazi-data-v1';

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/js/auth.js',
  '/js/cards.js',
  '/js/config.js',
  '/js/progress.js',
  '/js/state.js',
  '/js/ui.js',
  '/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // External CDN (supabase, GA): network-only, no local caching
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  // JSON data files: stale-while-revalidate (instant load + background refresh)
  if (url.pathname.startsWith('/data/')) {
    event.respondWith(staleWhileRevalidate(event.request, DATA_CACHE));
    return;
  }

  // App shell (HTML, CSS, JS, icons): cache-first for near-instant repeat loads
  event.respondWith(cacheFirst(event.request, SHELL_CACHE));
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  const cache = await caches.open(cacheName);
  cache.put(request, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const revalidate = fetch(request).then(fresh => {
    cache.put(request, fresh.clone());
    return fresh;
  });
  return cached || revalidate;
}
