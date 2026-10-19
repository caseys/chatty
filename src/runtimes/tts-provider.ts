// ============================================================================
// TTS Runtime Provider: Piper ONNX Runtime Web (@realtimex/piper-tts-web)
// Downloads & caches the Piper VITS ONNX voice model in OPFS and runs
// espeak-ng WASM phonemization + ONNX Runtime Web neural speech synthesis.
// (Spec Section 3.3 & Addendum Section 7)
// ============================================================================

import type { TtsRuntimeProvider } from '../types/index.ts';

const ONNX_WASM_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const PIPER_PHONEMIZE_BASE =
  'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';
const PIPER_CACHE_NAME = 'chatty-piper-phonemize-v1';

let cachedPiperDataBuffer: ArrayBuffer | null = null;
let cachedPiperWasmModule: WebAssembly.Module | null = null;
let piperHooksInstalled = false;
// Voice the shared TtsSession singleton was last created for (survives provider instances).
let activeSingletonVoiceId: string | null = null;

async function fetchWithCacheStorage(url: string): Promise<ArrayBuffer> {
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(PIPER_CACHE_NAME);
      const cached = await cache.match(url);
      if (cached && cached.ok) {
        const buf = await cached.arrayBuffer();
        if (buf.byteLength > 1024) {
          return buf;
        }
      }
      const response = await fetch(url);
      if (response.ok) {
        try {
          await cache.put(url, response.clone());
        } catch {
          // Ignore cache write errors
        }
        return await response.arrayBuffer();
      }
    } catch {
      // Fall back to direct fetch
    }
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return await response.arrayBuffer();
}

function isPiperPhonemizeModule(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  const candidate = obj as Record<string, unknown>;
  if (typeof candidate.locateFile !== 'function' || typeof candidate.print !== 'function') {
    return false;
  }
  try {
    return String((candidate.locateFile as (url: string) => string)('a.wasm')).includes(
      'piper_phonemize'
    );
  } catch {
    return false;
  }
}

function installPiperModuleHooks(): void {
  if (piperHooksInstalled) {
    return;
  }
  piperHooksInstalled = true;

  // @realtimex/piper-tts-web calls createPiperPhonemize({ print, printErr, locateFile })
  // on every session.predict(text) call without passing getPreloadedPackage or instantiateWasm,
  // which otherwise triggers a fresh 6.5 MB XHR for piper_phonemize.data and a 1.1 MB fetch+compile
  // for piper_phonemize.wasm on EVERY single phrase. Using targeted getters on Object.prototype
  // returns undefined for all other objects (such as onnxruntime-web) while providing the preloaded
  // ArrayBuffer and compiled WebAssembly.Module to piper_phonemize in <3ms with zero network I/O.
  Object.defineProperty(Object.prototype, 'getPreloadedPackage', {
    configurable: true,
    enumerable: false,
    get() {
      if (cachedPiperDataBuffer && isPiperPhonemizeModule(this)) {
        return () => cachedPiperDataBuffer;
      }
      return undefined;
    },
    set(val) {
      Object.defineProperty(this, 'getPreloadedPackage', {
        value: val,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  });

  Object.defineProperty(Object.prototype, 'instantiateWasm', {
    configurable: true,
    enumerable: false,
    get() {
      if (cachedPiperWasmModule && isPiperPhonemizeModule(this)) {
        return (
          imports: WebAssembly.Imports,
          receiveInstance: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void
        ) => {
          WebAssembly.instantiate(cachedPiperWasmModule!, imports).then((instance) => {
            receiveInstance(instance, cachedPiperWasmModule!);
          });
          return {};
        };
      }
      return undefined;
    },
    set(val) {
      Object.defineProperty(this, 'instantiateWasm', {
        value: val,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  });
}

async function ensureOpfsWorkerWritableSupport(): Promise<void> {
  // Safari Web Workers expose FileSystemFileHandle.createSyncAccessHandle() rather than
  // createWritable(). Polyfilling createWritable via createSyncAccessHandle allows
  // @realtimex/piper-tts-web to persist the 63 MB ONNX voice model in OPFS across reloads,
  // and cleans up any 0-byte stub files left by failed earlier createWritable() attempts.
  if (
    typeof FileSystemFileHandle !== 'undefined' &&
    typeof (FileSystemFileHandle.prototype as any).createWritable !== 'function' &&
    typeof (FileSystemFileHandle.prototype as any).createSyncAccessHandle === 'function'
  ) {
    (FileSystemFileHandle.prototype as any).createWritable = async function () {
      const accessHandle = await (this as any).createSyncAccessHandle();
      let offset = 0;
      return {
        async write(data: Blob | BufferSource | string) {
          let bytes: Uint8Array;
          if (data instanceof Blob) {
            bytes = new Uint8Array(await data.arrayBuffer());
          } else if (typeof data === 'string') {
            bytes = new TextEncoder().encode(data);
          } else if (ArrayBuffer.isView(data)) {
            bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          } else {
            bytes = new Uint8Array(data as ArrayBuffer);
          }
          accessHandle.truncate(0);
          accessHandle.write(bytes, { at: offset });
          offset += bytes.byteLength;
        },
        async close() {
          accessHandle.flush();
          accessHandle.close();
        },
        async abort() {
          accessHandle.close();
        },
      };
    };
  }

  // Clean up any 0-byte corrupted files in OPFS /piper/ directory
  if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('piper', { create: true });
      for await (const [name, handle] of (dir as any).entries()) {
        if (handle.kind === 'file') {
          const file = await handle.getFile();
          if (file.size === 0) {
            await dir.removeEntry(name).catch(() => {});
          }
        }
      }
    } catch {
      // Ignore OPFS inspection errors
    }
  }
}

async function resolveOnnxWasmBase(): Promise<string> {
  // Dev server only: production builds don't ship node_modules, and an SPA fallback answers
  // the probe with index.html (200), which then fails to import as a module.
  if (import.meta.env.DEV && typeof self !== 'undefined' && self.location?.origin) {
    const localCandidate = `${self.location.origin}${import.meta.env.BASE_URL}node_modules/onnxruntime-web/dist/`;
    try {
      const check = await fetch(`${localCandidate}ort-wasm-simd-threaded.jsep.mjs`, {
        method: 'HEAD',
      });
      if (check.ok) {
        return localCandidate;
      }
    } catch {
      // Fall back to CDN
    }
  }
  return ONNX_WASM_CDN;
}

async function preloadPiperPhonemizeAssets(): Promise<void> {
  await ensureOpfsWorkerWritableSupport();
  if (!cachedPiperDataBuffer || !cachedPiperWasmModule) {
    const [dataBuf, wasmBuf] = await Promise.all([
      cachedPiperDataBuffer
        ? Promise.resolve(cachedPiperDataBuffer)
        : fetchWithCacheStorage(`${PIPER_PHONEMIZE_BASE}.data`),
      cachedPiperWasmModule
        ? Promise.resolve(null)
        : fetchWithCacheStorage(`${PIPER_PHONEMIZE_BASE}.wasm`),
    ]);
    cachedPiperDataBuffer = dataBuf;
    if (wasmBuf) {
      cachedPiperWasmModule = await WebAssembly.compile(wasmBuf);
    }
  }
  installPiperModuleHooks();
}

/**
 * Decodes a 16-bit or 32-bit PCM WAV Blob/ArrayBuffer into mono Float32Array samples and sampleRate.
 */
export function decodeWavToFloat32(buffer: ArrayBuffer): {
  samples: Float32Array;
  sampleRate: number;
} {
  const view = new DataView(buffer);
  if (buffer.byteLength < 44) {
    return { samples: new Float32Array(0), sampleRate: 22050 };
  }

  const sampleRate = view.getUint32(24, true) || 22050;
  const bitsPerSample = view.getUint16(34, true) || 16;

  // Locate 'data' chunk
  let dataOffset = 44;
  let dataLength = buffer.byteLength - 44;
  for (let i = 12; i < Math.min(buffer.byteLength - 8, 128); i++) {
    if (
      view.getUint8(i) === 0x64 && // 'd'
      view.getUint8(i + 1) === 0x61 && // 'a'
      view.getUint8(i + 2) === 0x74 && // 't'
      view.getUint8(i + 3) === 0x61 // 'a'
    ) {
      dataLength = view.getUint32(i + 4, true);
      dataOffset = i + 8;
      break;
    }
  }

  const clampedByteLength = Math.min(dataLength, buffer.byteLength - dataOffset);
  if (bitsPerSample === 32) {
    const floatCount = Math.floor(clampedByteLength / 4);
    const samples = new Float32Array(floatCount);
    for (let i = 0; i < floatCount; i++) {
      samples[i] = view.getFloat32(dataOffset + i * 4, true);
    }
    return { samples, sampleRate };
  }

  // Default 16-bit signed PCM
  const sampleCount = Math.floor(clampedByteLength / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(dataOffset + i * 2, true);
    samples[i] = int16 / 32768;
  }

  return { samples, sampleRate };
}

export class PiperTtsProvider implements TtsRuntimeProvider {
  readonly id = 'piper-onnx';
  voiceId: string;
  private session: any = null;
  private initPromise: Promise<void> | null = null;
  private initializingVoiceId: string | null = null;
  private currentSessionVoiceId: string | null = null;
  private canceledTurns = new Set<string>();
  private synthesisChain: Promise<unknown> = Promise.resolve();

  constructor(voiceId = 'en_US-hfc_female-medium') {
    this.voiceId = voiceId;
  }

  async initialize(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.session && this.currentSessionVoiceId === this.voiceId) {
      return;
    }
    if (
      this.initPromise &&
      (this.initializingVoiceId === this.voiceId || this.currentSessionVoiceId === this.voiceId)
    ) {
      await this.initPromise;
      return;
    }

    const targetVoiceId = this.voiceId;
    this.initializingVoiceId = targetVoiceId;
    this.initPromise = this.doInitialize(targetVoiceId, onProgress);
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
      this.initializingVoiceId = null;
    }
  }

  private async doInitialize(
    targetVoiceId: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void> {
    // Prevent onnxruntime-web multi-threading warning when crossOriginIsolated is not enabled
    if (
      typeof globalThis !== 'undefined' &&
      !globalThis.crossOriginIsolated &&
      typeof navigator !== 'undefined'
    ) {
      try {
        Object.defineProperty(navigator, 'hardwareConcurrency', {
          get: () => 1,
          configurable: true,
        });
      } catch {
        // Ignore if non-configurable
      }
    }

    const [{ TtsSession }, onnxWasmBase] = await Promise.all([
      import('@realtimex/piper-tts-web'),
      resolveOnnxWasmBase(),
      preloadPiperPhonemizeAssets(),
    ]);

    // Reset singleton whenever the existing instance was built for a different voice
    const existing = (TtsSession as any)._instance;
    if (
      existing &&
      (existing.voiceId ?? activeSingletonVoiceId ?? this.currentSessionVoiceId) !== targetVoiceId
    ) {
      (TtsSession as any)._instance = null;
    }

    try {
      this.session = await TtsSession.create({
        voiceId: targetVoiceId,
        allowLocalModels: true,
        fallbackStrategy: 'local', // Use configured wasmPaths matching local/CDN onnxruntime-web@1.30.0
        wasmPaths: {
          onnxWasm: onnxWasmBase,
          piperData: `${PIPER_PHONEMIZE_BASE}.data`,
          piperWasm: `${PIPER_PHONEMIZE_BASE}.wasm`,
        },
        progress: (p) => {
          onProgress?.(p.loaded, p.total || 63_201_294);
        },
      });
    } catch (err) {
      if (onnxWasmBase !== ONNX_WASM_CDN) {
        console.error('[Piper TTS] Local ONNX WASM load failed, retrying with CDN fallback:', err);
        (TtsSession as any)._instance = null;
        this.session = await TtsSession.create({
          voiceId: targetVoiceId,
          allowLocalModels: true,
          fallbackStrategy: 'cdn',
          wasmPaths: {
            onnxWasm: ONNX_WASM_CDN,
            piperData: `${PIPER_PHONEMIZE_BASE}.data`,
            piperWasm: `${PIPER_PHONEMIZE_BASE}.wasm`,
          },
          progress: (p) => {
            onProgress?.(p.loaded, p.total || 63_201_294);
          },
        });
      } else {
        throw err;
      }
    }
    this.currentSessionVoiceId = targetVoiceId;
    activeSingletonVoiceId = targetVoiceId;

    // Warm up the phonemizer + ONNX Runtime Web graph execution during initialization
    // so the user's first spoken phrase has low time-to-first-audio.
    try {
      await this.session.predict('Hi.');
    } catch {
      // Ignore warmup errors
    }
  }

  async synthesize(
    text: string,
    turnId: string,
    _sequence: number,
    signal?: AbortSignal
  ): Promise<{
    samples: Float32Array;
    sampleRate: number;
    synthesisTimeMs: number;
    audioDurationMs: number;
  }> {
    const runSynthesis = async () => {
      if (signal?.aborted || this.canceledTurns.has(turnId)) {
        throw new Error('TTS synthesis aborted');
      }

      const start = performance.now();

      if (!this.session || this.currentSessionVoiceId !== this.voiceId) {
        await this.initialize();
      }

      if (signal?.aborted || this.canceledTurns.has(turnId)) {
        throw new Error('TTS synthesis aborted');
      }

      const wavBlob: Blob = await this.session.predict(text);
      if (signal?.aborted || this.canceledTurns.has(turnId)) {
        throw new Error('TTS synthesis aborted');
      }

      const arrayBuf = await wavBlob.arrayBuffer();
      const { samples, sampleRate } = decodeWavToFloat32(arrayBuf);
      const synthesisTimeMs = Math.max(1, Math.round(performance.now() - start));
      const audioDurationMs = Math.max(1, Math.round((samples.length / sampleRate) * 1000));

      return { samples, sampleRate, synthesisTimeMs, audioDurationMs };
    };

    const next = this.synthesisChain.then(runSynthesis, runSynthesis);
    this.synthesisChain = next.catch(() => {});
    return next;
  }

  cancel(turnId?: string): void {
    if (turnId) {
      this.canceledTurns.add(turnId);
    }
  }

  async dispose(): Promise<void> {
    this.session = null;
    this.currentSessionVoiceId = null;
    this.canceledTurns.clear();
  }
}
