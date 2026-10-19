// ============================================================================
// Downloaded model files: Origin Private File System (Gemma, Whistle, Piper voices) and
// Cache Storage (Transformers.js ONNX models, Needle, Piper's phonemizer). The service
// worker's app-shell caches are not models and are left alone.
// ============================================================================

const APP_CACHE_PREFIXES = ['chatty-app-', 'chatty-cdn-'];
const isModelCache = (name: string) => !APP_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix));

type DirHandle = {
  entries(): AsyncIterable<[string, { kind: 'file' | 'directory'; getFile?: () => Promise<File> }]>;
  getDirectoryHandle(name: string): Promise<DirHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
};

async function opfsRoot(): Promise<DirHandle | null> {
  try {
    return (await navigator.storage.getDirectory()) as unknown as DirHandle;
  } catch {
    return null;
  }
}

async function directorySize(dir: DirHandle): Promise<number> {
  let total = 0;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') total += (await handle.getFile!()).size;
    else total += await directorySize(await dir.getDirectoryHandle(name));
  }
  return total;
}

/** Bytes of downloaded models stored in this browser. */
export async function getModelCacheBytes(): Promise<number> {
  let total = 0;
  const root = await opfsRoot();
  if (root) total += await directorySize(root).catch(() => 0);
  if (typeof caches !== 'undefined') {
    for (const name of await caches.keys().catch(() => [] as string[])) {
      if (!isModelCache(name)) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        const length = Number(response?.headers.get('content-length'));
        total += length > 0 ? length : ((await response?.blob())?.size ?? 0);
      }
    }
  }
  return total;
}

/** Deletes every downloaded model; they download again the next time they're needed. */
export async function clearModelCache(): Promise<void> {
  const root = await opfsRoot();
  if (root) {
    const names: string[] = [];
    for await (const [name] of root.entries()) names.push(name);
    await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true }).catch(() => {})));
  }
  if (typeof caches !== 'undefined') {
    for (const name of await caches.keys().catch(() => [] as string[])) {
      if (isModelCache(name)) await caches.delete(name);
    }
  }
}
