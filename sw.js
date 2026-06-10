
const CACHE_NAME = 'shuazi-v1';
const DATA_CACHE_NAME = 'shuazi-data-v1';

const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME && cacheName !== DATA_CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Skip non-http requests
  if (!event.request.url.startsWith('http')) {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        return fetch(event.request);
      })
  );
});

// Handle messages from main thread for data persistence
self.addEventListener('message', event => {
  if (event.data.type === 'SAVE_DATA') {
    const data = event.data.payload;
    event.waitUntil(
      caches.open(DATA_CACHE_NAME)
        .then(cache => {
          const request = new Request('data.json');
          cache.put(request, new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json' }
          }));
        })
    );
  }

  if (event.data.type === 'GET_DATA') {
    event.waitUntil(
      caches.open(DATA_CACHE_NAME)
        .then(cache => cache.match('data.json'))
        .then(response => {
          if (response) {
            return response.json().then(data => {
              event.source.postMessage({
                type: 'DATA_LOADED',
                payload: data
              });
            });
          } else {
            event.source.postMessage({
              type: 'DATA_LOADED',
              payload: null
            });
          }
        })
    );
  }
});
