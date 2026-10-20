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
function loadWorker(network: (url: string) => Response | Promise<Response>) {
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
    };
  };
  const self = {
    location: new URL(`${ORIGIN}${BASE}sw.js`),
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
  vm.runInNewContext(SW_SOURCE, { self, caches, fetch: fakeFetch, URL, Response, console });

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
