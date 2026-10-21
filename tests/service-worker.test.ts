// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

const SW_SOURCE = readFileSync(resolve(import.meta.dirname, '../public/sw.js'), 'utf8');
const ORIGIN = 'https://www.mudberry.com';
const BASE = '/chatty/';

type Handler = (event: Record<string, unknown>) => void;

/** Runs public/sw.js against fake `self`, `caches` and `fetch`, served from /chatty/sw.js. */
function loadWorker(network: (url: string) => Response | Promise<Response>, source = SW_SOURCE, script = 'sw.js') {
  const handlers: Record<string, Handler> = {};
  const stores = new Map<string, Map<string, Response>>();
  const fetched: string[] = [];
  const keyOf = (r: string | { url: string }) => (typeof r === 'string' ? r : r.url);
  const openCache = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      match: async (r: string | { url: string }) => store.get(new URL(keyOf(r), ORIGIN).href)?.clone(),
      put: async (r: string | { url: string }, res: Response) => {
        store.set(new URL(keyOf(r), ORIGIN).href, res);
      },
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (r: string | { url: string }) => store.delete(new URL(keyOf(r), ORIGIN).href),
    };
  };
  const self = {
    location: new URL(`${ORIGIN}${BASE}${script}`),
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  const caches = {
    open: async (name: string) => openCache(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const fakeFetch = async (input: string | { url: string }) => {
    const url = new URL(keyOf(input), ORIGIN).href;
    fetched.push(url);
    return network(url);
  };
  vm.runInNewContext(source, { self, caches, fetch: fakeFetch, URL, Response, console, setTimeout });

  const run = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> | undefined;
    handlers[type]({
      ...event,
      waitUntil: (p: Promise<unknown>) => {
        pending = p;
      },
      respondWith: (p: Promise<unknown>) => {
        pending = p;
      },
    });
    return pending ? await pending : undefined;
  };
  return { stores, fetched, run, cache: (name: string) => openCache(name) };
}

const navigation = (path: string) => ({
  request: { url: ORIGIN + path, method: 'GET', mode: 'navigate' },
});
const subresource = (path: string) => ({
  request: { url: ORIGIN + path, method: 'GET', mode: 'cors' },
});
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
const js = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/javascript' } });

describe('service worker under /chatty/', () => {
  let online = true;
  let indexBody = 'build-1';
  const network = (url: string): Response => {
    if (!online) throw new TypeError('offline');
    if (url.endsWith('/assets/app-abc.js')) return js('app');
    return html(url.endsWith('.png') || url.endsWith('.svg') ? 'img' : indexBody);
  };

  beforeEach(() => {
    online = true;
    indexBody = 'build-1';
  });

  it("precaches the build's JS/CSS chunks (not wasm) and prunes old builds' assets, keeping model caches", async () => {
    const built = SW_SOURCE.replace('/*__BUILD_ASSETS__*/ []', JSON.stringify(['app-new.js', 'style-new.css', 'big.wasm']));
    const sw = loadWorker(network, built);
    const app = await sw.cache('chatty-app-v3');
    await app.put(`${BASE}assets/app-old.js`, js('old'));
    await (await sw.cache('webllm/model')).put('https://huggingface.co/m/resolve/main/w.bin', js('weights'));
    await sw.run('install', {});
    expect(sw.fetched).toContain(`${ORIGIN}${BASE}assets/app-new.js`);
    expect(sw.fetched).toContain(`${ORIGIN}${BASE}assets/style-new.css`);
    expect(sw.fetched.some((u) => u.endsWith('.wasm'))).toBe(false);
    await sw.run('activate', {});
    expect(await app.match(`${BASE}assets/app-old.js`)).toBeUndefined();
    expect(await app.match(`${BASE}assets/app-new.js`)).toBeDefined();
    expect(sw.stores.has('webllm/model')).toBe(true);
  });

  it('precaches one file at a time, and only the app shell when registered as lite (iPhone)', async () => {
    const built = SW_SOURCE.replace('/*__BUILD_ASSETS__*/ []', JSON.stringify(['a.js', 'b.js', 'c.css']));
    let inFlight = 0;
    let most = 0;
    const slow = async (url: string) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return network(url);
    };
    const full = loadWorker(slow, built);
    await full.run('install', {});
    expect(most).toBe(1);
    expect(full.fetched).toContain(`${ORIGIN}${BASE}assets/b.js`);
    const lite = loadWorker(network, built, 'sw.js?lite=1');
    await lite.run('install', {});
    expect(lite.fetched).toContain(`${ORIGIN}${BASE}index.html`);
    expect(lite.fetched.some((u) => u.includes('/assets/'))).toBe(false);
  });

  it('precaches only paths inside the /chatty/ scope', async () => {
    const sw = loadWorker(network);
    await sw.run('install', {});
    expect(sw.fetched.length).toBeGreaterThan(5);
    for (const url of sw.fetched) expect(new URL(url).pathname.startsWith(BASE)).toBe(true);
    expect(sw.fetched).toContain(`${ORIGIN}${BASE}index.html`);
  });

  it('still precaches the rest when one file is missing', async () => {
    const sw = loadWorker((url) => (url.endsWith('debug.html') ? new Response('', { status: 404 }) : network(url)));
    await sw.run('install', {});
    const cache = await sw.cache('chatty-app-v3');
    expect(await cache.match(`${BASE}index.html`)).toBeDefined();
    expect(await cache.match(`${BASE}debug.html`)).toBeUndefined();
  });

  it('serves a new deploy on the next navigation, and the cached page only offline', async () => {
    const sw = loadWorker(network);
    await sw.run('install', {});
    indexBody = 'build-2'; // new deploy

    const online2 = (await sw.run('fetch', navigation(BASE))) as Response;
    expect(await online2.text()).toBe('build-2');

    online = false;
    const offline = (await sw.run('fetch', navigation(BASE))) as Response;
    expect(await offline.text()).toBe('build-2'); // the page cached by the last online visit
  });

  it('serves hashed assets from the cache after the first fetch', async () => {
    const sw = loadWorker(network);
    const path = `${BASE}assets/app-abc.js`;
    expect(await ((await sw.run('fetch', subresource(path))) as Response).text()).toBe('app');
    online = false;
    expect(await ((await sw.run('fetch', subresource(path))) as Response).text()).toBe('app');
  });

  it('does not cache an HTML fallback under a missing asset name', async () => {
    const sw = loadWorker(network);
    const path = `${BASE}assets/gone-123.js`;
    await sw.run('fetch', subresource(path)); // server answers with index.html
    const cache = await sw.cache('chatty-app-v3');
    expect(await cache.match(path)).toBeUndefined();
  });

  it('leaves other origins alone', async () => {
    const sw = loadWorker(network);
    // An un-intercepted request never reaches respondWith
    const handled = await sw.run('fetch', {
      request: { url: 'https://huggingface.co/model.bin', method: 'GET', mode: 'cors' },
    });
    expect(handled).toBeUndefined();
    expect(sw.fetched).toEqual([]);
  });

  it('deletes caches from other versions on activate', async () => {
    const sw = loadWorker(network);
    await sw.cache('chatty-app-v1');
    await sw.cache('chatty-app-v3');
    await sw.run('activate', {});
    expect([...sw.stores.keys()]).toEqual(['chatty-app-v3']);
  });
});
