// ============================================================================
// Chatty PWA Service Worker
// Offline Caching for App Shell (HTML, CSS, JS, Icons, Manifest)
// Model weights and OPFS binaries bypass the SW to prevent memory bloat/stalls.
//
// Caching strategy (every path is relative to the worker's own URL, so it works under /chatty/):
//   - Page navigations: network-first, cached copy only when offline. A new deploy's index.html
//     is therefore picked up on the next load and can't be shadowed by an old cached build.
//   - <base>/assets/* (content-hashed by Vite): cache-first; a new build uses new file names.
//   - Other same-origin shell files (icons, manifests): stale-while-revalidate.
//   - Version-pinned jsdelivr runtime code: cache-first. Everything else cross-origin: untouched.
// ============================================================================

const CACHE_NAME_APP = 'chatty-app-v3';
// Version-pinned runtime code (LiteRT-LM, onnxruntime-web, piper-phonemize WASM/JS) from jsdelivr.
// Pinned URLs never change, so cache-first keeps them available offline. Model weights are NOT here.
const CACHE_NAME_CDN = 'chatty-cdn-v1';
const isPinnedCdnRuntime = (url) =>
  url.hostname === 'cdn.jsdelivr.net' && /^\/npm\/(@[^/]+\/)?[^/@]+@\d[^/]*\//.test(url.pathname);

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
    caches.open(CACHE_NAME_APP).then((cache) =>
      // One URL at a time (addAll caches nothing if any one fails), straight from the network so
      // a new install never stores an old index.html out of the browser's HTTP cache
      Promise.all(
        APP_SHELL_URLS.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((response) => (response.ok ? cache.put(url, response) : undefined))
            .catch((err) => {
              console.warn('[Chatty SW] Pre-caching failed for', url, err);
            })
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => {
        return Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME_APP && k !== CACHE_NAME_CDN)
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

  // 0. Version-pinned runtime code from jsdelivr: Cache-First (needed for offline use)
  if (isPinnedCdnRuntime(url)) {
    event.respondWith(
      caches.open(CACHE_NAME_CDN).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone()).catch(() => {});
        return response;
      })
    );
    return;
  }

  // 1. Never intercept other cross-origin requests (e.g. HuggingFace, external APIs)
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
          // Not an HTML page: a server that answers a missing chunk with index.html must not get
          // that page cached forever under the chunk's name
          const isHtml = (response.headers.get('content-type') || '').includes('text/html');
          if (response && response.status === 200 && !isHtml) {
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
