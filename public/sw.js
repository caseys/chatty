// ============================================================================
// Chatty PWA Service Worker
// Offline Caching for App Shell (HTML, CSS, JS, Icons, Manifest)
// Model weights and OPFS binaries bypass the SW to prevent memory bloat/stalls.
//
// Caching strategy (every path is relative to the worker's own URL, so it works under /chatty/):
//   - Page navigations: network-first, raced against NAV_TIMEOUT_MS. If the network is slow or
//     down, the cached page is served and the network response still refreshes the cache in the
//     background. With no cached page, the network is awaited. A new deploy's index.html is
//     picked up on the next load and can't be shadowed by an old cached build.
//   - <base>/assets/* (content-hashed by Vite): cache-first; a new build uses new file names.
//     The build injects its asset list into this file (see vite.config.ts), so install precaches
//     the current build's JS/CSS chunks (a deploy's rsync --delete removes the old build's lazy
//     chunks) and activate prunes assets/ entries that are no longer in the build.
//     .wasm files (28 MB each) are never precached, only cached when first used.
//   - Other same-origin shell files (icons, manifests): stale-while-revalidate.
//   - Version-pinned jsdelivr runtime code: cache-first. Everything else cross-origin: untouched.
//   - Big responses (assets, pinned CDN) are put in the cache and read back instead of cloned,
//     so a 28 MB wasm file isn't held in memory twice.
//   - Only chatty-app-* / chatty-cdn-* caches are ever deleted; model caches (WebLLM, piper) are
//     the app's own and stay (mirrors isModelCache in src/core/model-cache.ts).
// ============================================================================

const CACHE_NAME_APP = 'chatty-app-v3';
// Version-pinned runtime code (LiteRT-LM, onnxruntime-web, piper-phonemize WASM/JS) from jsdelivr.
// Pinned URLs never change, so cache-first keeps them available offline. Model weights are NOT here.
const CACHE_NAME_CDN = 'chatty-cdn-v1';
// piper_phonemize.data/.wasm are cached by the app itself (chatty-piper-phonemize-v1 in
// tts-provider.ts), so they pass through the worker untouched.
const PIPER_PHONEMIZE_PATH = '/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';
const isPinnedCdnRuntime = (url) =>
  url.hostname === 'cdn.jsdelivr.net' &&
  /^\/npm\/(@[^/]+\/)?[^/@]+@\d[^/]*\//.test(url.pathname) &&
  url.pathname !== PIPER_PHONEMIZE_PATH + '.data' &&
  url.pathname !== PIPER_PHONEMIZE_PATH + '.wasm';

// Only caches with these prefixes belong to the SW; everything else is the app's model data
const SW_CACHE_PREFIXES = ['chatty-app-', 'chatty-cdn-'];

// How long a navigation waits for the network before falling back to the cached page
const NAV_TIMEOUT_MS = 4000;

// File names in <base>/assets/ of the current build. Vite's build replaces the
// empty list below in dist/sw.js (vite.config.ts); in dev it stays empty and nothing is precached
// or pruned.
const BUILD_ASSETS = /*__BUILD_ASSETS__*/ [];

// Base path the app is served from (e.g. '/chatty/'), derived from this worker's own URL.
const BASE = new URL('./', self.location).pathname;

const APP_SHELL_URLS = [
  '',
  'index.html',
  'debug.html',
  'manifest.webmanifest',
  'mascot.png',
  'apple-touch-icon.png',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-192-maskable.png',
  'icons/icon-512-maskable.png',
].map((path) => BASE + path);

const PRECACHE_ASSET_URLS = BUILD_ASSETS.filter((name) => /\.(js|css)$/.test(name)).map(
  (name) => BASE + 'assets/' + name
);

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME_APP).then((cache) =>
      // One URL at a time (addAll caches nothing if any one fails), straight from the network so
      // a new install never stores an old index.html out of the browser's HTTP cache.
      // The build's JS/CSS chunks come along so lazy chunks survive the next deploy; .wasm doesn't.
      // A chunk already cached is kept: its hashed name means its content can't have changed, so
      // a deploy downloads only the chunks that did.
      Promise.all(
        [...APP_SHELL_URLS, ...PRECACHE_ASSET_URLS].map(async (url) => {
          if (PRECACHE_ASSET_URLS.includes(url) && (await cache.match(url))) return;
          return fetch(url, { cache: 'reload' })
            .then((response) => (response.ok ? cache.put(url, response) : undefined))
            .catch((err) => {
              console.warn('[Chatty SW] Pre-caching failed for', url, err);
            });
        })
      )
    )
  );
});

// Drops assets/ entries (including .wasm) that the current build no longer has
async function pruneAssets() {
  if (BUILD_ASSETS.length === 0) return;
  const current = new Set(BUILD_ASSETS.map((name) => BASE + 'assets/' + name));
  const cache = await caches.open(CACHE_NAME_APP);
  for (const request of await cache.keys()) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(BASE + 'assets/') && !current.has(pathname)) {
      await cache.delete(request);
    }
  }
}

// Stores a response, then serves it from the cache instead of cloning it: a clone would hold a
// big (28 MB wasm) body twice. Falls back to a plain fetch if the cache refuses it (quota).
async function putAndServe(cache, request, response) {
  try {
    await cache.put(request, response);
  } catch {
    return fetch(request);
  }
  return (await cache.match(request)) || fetch(request);
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => {
        return Promise.all(
          keys
            .filter(
              (k) =>
                SW_CACHE_PREFIXES.some((prefix) => k.startsWith(prefix)) &&
                k !== CACHE_NAME_APP &&
                k !== CACHE_NAME_CDN
            )
            .map((k) => caches.delete(k))
        );
      }),
      pruneAssets(),
    ])
  );
});

// Network-first navigation. After NAV_TIMEOUT_MS the cached page wins, but the network response
// still updates the cache in the background. No cached page: keep waiting on the network.
async function handleNavigation(event, request, url) {
  const cache = await caches.open(CACHE_NAME_APP);
  const network = fetch(request).then((response) => {
    if (response && response.status === 200) {
      const clone = response.clone();
      cache.put(request, clone).catch(() => {});
    }
    return response;
  });
  const settled = network.then(() => {}, () => {});
  event.waitUntil(settled);

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
  const first = await Promise.race([network.catch(() => null), timeout]);
  if (first) return first;

  let cached = await cache.match(request);
  if (!cached && url.pathname.includes('debug')) cached = await cache.match(BASE + 'debug.html');
  if (!cached) cached = (await cache.match(BASE + 'index.html')) || (await cache.match(BASE));
  if (cached) return cached;
  return network.catch(() => Response.error());
}

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
        return response.ok ? putAndServe(cache, request, response) : response;
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

  // 3. Navigation Requests (HTML Pages): Network-First (raced against a timeout) with App Shell Fallback
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event, request, url));
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
            return await putAndServe(cache, request, response);
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
