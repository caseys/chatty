// ============================================================================
// Chatty PWA Service Worker
// Offline Caching for App Shell (HTML, CSS, JS, Icons, Manifest)
// Model weights and OPFS binaries bypass the SW to prevent memory bloat/stalls.
// ============================================================================

const CACHE_NAME_APP = 'chatty-app-v3';

// Base path the app is served from (e.g. '/chatty/'), derived from this worker's own URL.
const BASE = new URL('./', self.location).pathname;

const APP_SHELL_URLS = [
  '',
  'index.html',
  'debug.html',
  'manifest.webmanifest',
  'manifest.json',
  'mascott.png',
  'apple-touch-icon.png',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-192-maskable.png',
  'icons/icon-512-maskable.png',
  'screenshots/screenshot-wide.png',
  'screenshots/screenshot-narrow.png',
].map((path) => BASE + path);

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME_APP).then((cache) => {
      return cache.addAll(APP_SHELL_URLS).catch((err) => {
        console.warn('[Chatty SW] Pre-caching partial failure (safe to continue):', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => {
        return Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME_APP)
            .map((k) => caches.delete(k))
        );
      }),
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 1. Never intercept cross-origin requests (e.g. HuggingFace, CDNs, external APIs)
  // Large model weights are streamed directly to OPFS / IndexedDB by Web Workers.
  // Buffering or cloning gigabyte-sized responses in a Service Worker causes severe memory bloat and reload stalls.
  if (url.origin !== self.location.origin) {
    return;
  }

  // 2. Never intercept Vite development internals or query-timestamped HMR modules
  if (
    url.pathname.includes('/@vite/') ||
    url.pathname.includes('/@fs/') ||
    url.pathname.includes('/node_modules/') ||
    url.searchParams.has('t')
  ) {
    return;
  }

  // 3. Navigation Requests (HTML Pages): Network-First with Offline App Shell Fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME_APP).then((cache) => cache.put(request, clone)).catch(() => {});
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME_APP);
          const cached = await cache.match(request);
          if (cached) return cached;
          if (url.pathname.includes('debug')) {
            return (await cache.match(BASE + 'debug.html')) || (await cache.match(BASE + 'index.html'));
          }
          return (await cache.match(BASE + 'index.html')) || (await cache.match(BASE)) || Response.error();
        })
    );
    return;
  }

  // 4. Static Hashed Assets in <base>/assets/ (Immutable Vite production chunks): Cache-First
  if (url.pathname.startsWith(BASE + 'assets/')) {
    event.respondWith(
      caches.open(CACHE_NAME_APP).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;

        try {
          const response = await fetch(request);
          if (response && response.status === 200) {
            void cache.put(request, response.clone());
          }
          return response;
        } catch (err) {
          if (cached) return cached;
          throw err;
        }
      })
    );
    return;
  }

  // 5. Other App Shell Resources (Icons, Manifest, Images): Stale-While-Revalidate
  event.respondWith(
    caches.open(CACHE_NAME_APP).then(async (cache) => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            void cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
