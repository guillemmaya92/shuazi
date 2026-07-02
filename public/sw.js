// Build id from the registration URL (sw.js?b=<id>). Each deploy registers a
// new URL, so the worker updates past Cloudflare's long edge cache, gets a fresh
// cache name, and precaches the matching ?b= asset URLs the page requests.
const BUILD = new URL(self.location.href).searchParams.get('b') || 'dev';
const SHELL_CACHE = 'shuazi-shell-' + BUILD;

// Version only CSS/JS — must match exactly what fingerprint.mjs rewrites in the
// page, so these precache keys line up with the actual network requests.
const v = u => (/\.(css|js)$/.test(u) ? `${u}?b=${BUILD}` : u);
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
  '/js/translator.js',
  '/js/pwa-install.js',
  '/js/coach.js',
  '/js/stroke-order.js',
  '/manifest.json',
].map(v);

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      // cache: 'reload' bypasses the browser HTTP cache so we never store stale assets
      .then(c => c.addAll(SHELL_ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // External CDN (supabase, GA): network-only, no local caching
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  // HTML / navigation: network-first so new deploys always show up
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(networkFirst(event.request, SHELL_CACHE));
    return;
  }

  // CSS / JS / icons: stale-while-revalidate (instant load + refreshes for next visit)
  event.respondWith(staleWhileRevalidate(event.request, SHELL_CACHE));
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    return cached || Response.error();
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const revalidate = fetch(request).then(fresh => {
    cache.put(request, fresh.clone());
    return fresh;
  }).catch(() => cached);
  return cached || revalidate;
}
