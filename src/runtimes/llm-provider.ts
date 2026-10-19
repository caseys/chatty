// ============================================================================
// LLM Runtime Provider: LiteRT-LM WebGPU Provider (Gemma 4 E2B / E4B)
// (Spec Section 3.2 & Addendum Section 8)
// ============================================================================

import type {
  LlmGenerationOptions,
  LlmGenerationResult,
  LlmRuntimeProvider,
} from '../types/index.ts';
import { MODEL_REGISTRY } from '../core/model-manager.ts';

const WASM_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@litert-lm/core@0.19.0-nightly.20261016/wasm';
const WASM_RELAXED_SIMD_CHECK = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1,
  0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11,
]);

/**
 * Loads the `@litert-lm/core` WASM module inside an ES module Web Worker (`type: "module"`).
 * `@litertjs/wasm-utils` uses `importScripts(...)` when `typeof importScripts === 'function'`,
 * which throws inside module workers. This helper dynamically imports the matching UMD/ESM
 * loader script with an explicit `locateFile` callback and registers the resulting `LiteRtLm`
 * instance globally.
 */
async function ensureLiteRtLmWasmLoaded(fallbackCdnUrl = WASM_CDN_BASE): Promise<void> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    throw new Error('WebGPU is not supported in this environment');
  }

  const {
    LiteRtLm,
    hasGlobalLiteRtLm,
    getGlobalLiteRtLmPromise,
    setGlobalLiteRtLm,
    setGlobalLiteRtLmPromise,
  } = await import('@litert-lm/core');

  if (hasGlobalLiteRtLm()) return;
  const existingPromise = getGlobalLiteRtLmPromise();
  if (existingPromise) {
    await existingPromise;
    return;
  }

  const loadPromise = (async () => {
    let relaxedSimd = false;
    try {
      await WebAssembly.instantiate(WASM_RELAXED_SIMD_CHECK);
      relaxedSimd = true;
    } catch {
      relaxedSimd = false;
    }
    const jspi = typeof WebAssembly !== 'undefined' && 'Suspending' in WebAssembly;

    const jsFileName = relaxedSimd
      ? jspi
        ? 'litertlm_wasm_internal.js'
        : 'litertlm_wasm_asyncify_internal.js'
      : jspi
        ? 'litertlm_wasm_compat_internal.js'
        : 'litertlm_wasm_compat_asyncify_internal.js';

    // Prefer same-origin local WASM directory when served by the Vite dev server to avoid 23MB
    // CDN downloads. Dev only: production builds don't ship node_modules, and an SPA fallback
    // answers that probe with index.html (200), which then fails to import as a module.
    let resolvedBaseUrl = fallbackCdnUrl;
    if (import.meta.env.DEV && typeof self !== 'undefined' && self.location?.origin) {
      const localCandidate = `${self.location.origin}${import.meta.env.BASE_URL}node_modules/@litert-lm/core/wasm`;
      try {
        const check = await fetch(`${localCandidate}/${jsFileName}`, { method: 'HEAD' });
        if (check.ok) {
          resolvedBaseUrl = localCandidate;
        }
      } catch {
        // Fallback to CDN
      }
    }

    const g = globalThis as any;
    if (typeof g.custom_dbg !== 'function') {
      g.custom_dbg = (...args: unknown[]) => console.debug('[LiteRT-LM]', ...args);
    }
    if (typeof g.dbg !== 'function') {
      g.dbg = g.custom_dbg;
    }

    const prevExports = g.exports;
    const prevModule = g.module;
    const tempExports: Record<string, any> = {};
    const tempModule: { exports: any } = { exports: tempExports };
    g.exports = tempExports;
    g.module = tempModule;

    let moduleFactory: any;
    try {
      const imported = await import(/* @vite-ignore */ `${resolvedBaseUrl}/${jsFileName}`);
      moduleFactory =
        tempModule.exports?.default ??
        (typeof tempModule.exports === 'function' ? tempModule.exports : null) ??
        imported?.default ??
        g.ModuleFactory;
    } finally {
      if (prevExports === undefined) delete g.exports;
      else g.exports = prevExports;
      if (prevModule === undefined) delete g.module;
      else g.module = prevModule;
    }

    if (typeof moduleFactory !== 'function') {
      throw new Error(`Failed to resolve LiteRT-LM WASM ModuleFactory from ${jsFileName}`);
    }

    const wasmModule = await moduleFactory({
      locateFile: (path: string) => `${resolvedBaseUrl}/${path}`,
      printErr: (text: string) => {
        if (/^(INFO|WARNING):/.test(text) || /^I\d{4}\s/.test(text) || /^W\d{4}\s/.test(text)) {
          console.debug('[LiteRT-LM]', text);
        } else {
          console.warn('[LiteRT-LM]', text);
        }
      },
    });
    const liteRtLm = new LiteRtLm(wasmModule);
    setGlobalLiteRtLm(liteRtLm);
    return liteRtLm;
  })();

  setGlobalLiteRtLmPromise(
    loadPromise.catch((err) => {
      setGlobalLiteRtLmPromise(undefined as any);
      throw err;
    })
  );

  await loadPromise;
}

const DESIRED_WEBGPU_FEATURES = ['shader-f16', 'subgroups'];

/**
 * Ensures `wasmModule.preinitializedWebGPUDevice` is populated with a resilient
 * fallback sequence (`high-performance` -> default `{}` -> `low-power`) and retries
 * across brief reload contention so `@litert-lm/core` does not fail when
 * `requestAdapter({ powerPreference: 'high-performance' })` returns null.
 */
async function ensurePreinitializedWebGpuDevice(wasmModule: any): Promise<void> {
  if (!wasmModule || wasmModule.preinitializedWebGPUDevice) {
    return;
  }
  const gpu = typeof navigator !== 'undefined' ? (navigator as any).gpu : undefined;
  if (!gpu || typeof gpu.requestAdapter !== 'function') {
    throw new Error('WebGPU is not available in this execution context.');
  }

  const descriptorCandidates: Array< Record<string, unknown> | undefined> = [
    { powerPreference: 'high-performance' },
    undefined,
    { powerPreference: 'low-power' },
  ];

  let adapter: any = null;
  for (let attempt = 0; attempt < 4 && !adapter; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
    for (const desc of descriptorCandidates) {
      try {
        adapter = desc ? await gpu.requestAdapter(desc) : await gpu.requestAdapter();
        if (adapter) break;
      } catch {
        // Try next descriptor
      }
    }
  }

  if (!adapter) {
    throw new Error('No GPU adapter found.');
  }

  const requiredFeatures: string[] = [];
  for (const feature of DESIRED_WEBGPU_FEATURES) {
    if (adapter.features?.has?.(feature)) {
      requiredFeatures.push(feature);
    }
  }

  const requiredLimits: Record<string, number> = {};
  if (adapter.limits) {
    if (adapter.limits.maxBufferSize) requiredLimits.maxBufferSize = adapter.limits.maxBufferSize;
    if (adapter.limits.maxStorageBufferBindingSize) {
      requiredLimits.maxStorageBufferBindingSize = adapter.limits.maxStorageBufferBindingSize;
    }
    if (adapter.limits.maxStorageBuffersPerShaderStage) {
      requiredLimits.maxStorageBuffersPerShaderStage =
        adapter.limits.maxStorageBuffersPerShaderStage;
    }
    if (adapter.limits.maxTextureDimension2D) {
      requiredLimits.maxTextureDimension2D = adapter.limits.maxTextureDimension2D;
    }
  }

  let device: any;
  try {
    device = await adapter.requestDevice({
      requiredFeatures,
      requiredLimits,
    });
  } catch {
    device = await adapter.requestDevice({
      requiredFeatures,
    });
  }

  device.lost?.then?.((info: any) => {
    console.warn('[LiteRT-LM WebGPU] Device lost:', info?.reason, info?.message);
    if (wasmModule.preinitializedWebGPUDevice === device) {
      wasmModule.preinitializedWebGPUDevice = null;
    }
  });

  wasmModule.preinitializedWebGPUDevice = device;
}

/**
 * LiteRT-LM WebGPU Provider using `@litert-lm/core`
 */
export class LiteRtLlmProvider implements LlmRuntimeProvider {
  readonly id = 'litert-lm';
  readonly modelId: string;
  readonly contextLimit: number;
  readonly maxOutputTokens: number;
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = true;

  private engine: any = null;
  private initPromise: Promise<void> | null = null;
  private activeConversation: any = null;
  private persistentConversation: any = null;
  private cachedSystemPrompt: string | null = null;
  private cachedMessagesJson: string | null = null;
  private cachedTemperature: number | undefined = undefined;
  private cachedMaxOutputTokens: number | undefined = undefined;
  private activeTurnId: string | null = null;
  private generationChain: Promise<unknown> = Promise.resolve();

  constructor(
    modelId = 'gemma-4-e2b-it-web',
    overrides?: { contextLimit?: number; maxOutputTokens?: number }
  ) {
    this.modelId = modelId;
    const manifest = MODEL_REGISTRY.find((m) => m.id === modelId);
    this.contextLimit = overrides?.contextLimit ?? manifest?.contextWindowTokens ?? 8192;
    this.maxOutputTokens = overrides?.maxOutputTokens ?? manifest?.maxOutputTokens ?? 1024;
  }

  async initialize(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.engine) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.doInitialize(onProgress);
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInitialize(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      throw new Error('WebGPU is not supported in this environment');
    }

    const manifest = MODEL_REGISTRY.find((m) => m.id === this.modelId);
    const modelUrl =
      manifest?.url ??
      'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm';
    const expectedTotal = manifest?.expectedSizeBytes ?? 2_008_432_640;

    onProgress?.(0, expectedTotal);
    const { Engine, getGlobalLiteRtLm } = await import('@litert-lm/core');

    // Load matching WASM runtime safely inside ES module worker and preinitialize WebGPU device
    await ensureLiteRtLmWasmLoaded(WASM_CDN_BASE);
    await ensurePreinitializedWebGpuDevice(getGlobalLiteRtLm()?.liteRtLmWasm);

    // Check OPFS cache first so offline & warm startups don't redownload 2GB
    let modelSource: Blob | ReadableStream<Uint8Array> | null = null;
    let usedCachedFile = false;
    let wroteToOpfs = false;
    const modelId = this.modelId;
    const removeCachedModel = async () => {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(`${modelId}.litertlm`).catch(() => {});
        await root.removeEntry(`${modelId}.litertlm.complete`).catch(() => {});
      } catch {
        // Ignore
      }
    };
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.getDirectory === 'function'
    ) {
      try {
        const root = await navigator.storage.getDirectory();
        const fileHandle = await root.getFileHandle(`${this.modelId}.litertlm`);
        const cachedFile = await fileHandle.getFile();
        // Accept only a file with a completion marker recording its exact size, or an exact
        // match against the manifest's expected size. A merely "large enough" file may be truncated.
        let complete = cachedFile.size === expectedTotal;
        if (!complete) {
          try {
            const markerHandle = await root.getFileHandle(`${this.modelId}.litertlm.complete`);
            const markerText = await (await markerHandle.getFile()).text();
            complete = Number(markerText.trim()) === cachedFile.size;
          } catch {
            // No marker
          }
        }
        if (complete) {
          onProgress?.(cachedFile.size, cachedFile.size);
          modelSource = cachedFile;
          usedCachedFile = true;
        } else {
          // Incomplete partial file from an interrupted download; remove it
          await root.removeEntry(`${this.modelId}.litertlm`).catch(() => {});
          await root.removeEntry(`${this.modelId}.litertlm.complete`).catch(() => {});
        }
      } catch {
        // Not in OPFS yet; will fetch and cache below
      }
    }

    if (!modelSource) {
      // Use cors mode (LiteRT's internal fetch uses 'same-origin' which fails on Hugging Face CDN redirects)
      const response = await fetch(modelUrl, { mode: 'cors', credentials: 'omit' });
      if (!response.ok || !response.body) {
        throw new Error(`Failed to fetch Gemma model (${response.status}) from ${modelUrl}`);
      }

      const headerLength = Number(response.headers.get('Content-Length'));
      const hasContentLength = headerLength > 0;
      const contentLength = headerLength || expectedTotal;
      let loadedBytes = 0;

      // Stream into OPFS while simultaneously streaming to Engine.create
      let opfsWritable: any = null;
      if (
        typeof navigator !== 'undefined' &&
        navigator.storage &&
        typeof navigator.storage.getDirectory === 'function'
      ) {
        try {
          const root = await navigator.storage.getDirectory();
          const fileHandle = await root.getFileHandle(`${this.modelId}.litertlm`, { create: true });
          if (typeof (fileHandle as any).createWritable === 'function') {
            opfsWritable = await (fileHandle as any).createWritable();
          } else if (typeof (fileHandle as any).createSyncAccessHandle === 'function') {
            const accessHandle = await (fileHandle as any).createSyncAccessHandle();
            let handleClosed = false;
            const closeHandle = () => {
              if (handleClosed) return;
              handleClosed = true;
              accessHandle.close();
            };
            try {
              accessHandle.truncate(0);
            } catch (truncErr) {
              closeHandle();
              throw truncErr;
            }
            let offset = 0;
            opfsWritable = {
              async write(chunk: Uint8Array) {
                accessHandle.write(chunk, { at: offset });
                offset += chunk.byteLength;
              },
              async close() {
                if (handleClosed) return;
                try {
                  accessHandle.flush();
                } finally {
                  closeHandle();
                }
              },
              async abort() {
                closeHandle();
              },
            };
          }
        } catch {
          opfsWritable = null;
        }
      }

      const reader = response.body.getReader();
      wroteToOpfs = !!opfsWritable;
      let opfsOk = true;
      const abortWritable = async () => {
        const w = opfsWritable;
        opfsWritable = null;
        if (w) await Promise.resolve(w.abort?.()).catch(() => {});
      };
      // Closes the OPFS file and writes the completion marker. Must run as soon as the last byte
      // is written: Engine.create stops pulling once it has the full model and never reads the
      // stream's end, so waiting for `done` left the download in an uncommitted swap file and
      // every reload re-downloaded the model.
      let opfsFinalized = false;
      const finalizeOpfs = async () => {
        if (!opfsWritable) return;
        opfsFinalized = true;
        const w = opfsWritable;
        opfsWritable = null;
        let closed = true;
        await w.close().catch(() => {
          closed = false;
        });
        if (closed && opfsOk && loadedBytes > 0) {
          // Completion marker: records exact size of a fully written file
          try {
            const root = await navigator.storage.getDirectory();
            const mh = await root.getFileHandle(`${modelId}.litertlm.complete`, { create: true });
            const mw = await (mh as any).createWritable?.();
            if (mw) {
              await mw.write(String(loadedBytes));
              await mw.close();
            }
          } catch {
            // Without a marker the exact-size check still applies on next load
          }
        } else if (!opfsOk || !closed) {
          await removeCachedModel();
        }
      };
      modelSource = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              await finalizeOpfs();
              controller.close();
              return;
            }
            if (value) {
              loadedBytes += value.byteLength;
              onProgress?.(loadedBytes, contentLength);
              if (opfsWritable) {
                try {
                  await opfsWritable.write(value);
                } catch {
                  opfsOk = false;
                  await abortWritable();
                }
                if (hasContentLength && loadedBytes >= contentLength) await finalizeOpfs();
              }
              controller.enqueue(value);
            }
          } catch (err) {
            await abortWritable();
            await removeCachedModel();
            try {
              await reader.cancel();
            } catch {
              // Ignore
            }
            throw err;
          }
        },
        async cancel() {
          await abortWritable();
          if (!opfsFinalized) await removeCachedModel();
          await reader.cancel();
        },
      });
    }

    try {
      this.engine = await Engine.create({
        model: modelSource,
        mainExecutorSettings: {
          maxNumTokens: this.contextLimit,
        },
      });
    } catch (err) {
      // A cached/partially cached file may be corrupt; drop it so the next attempt re-downloads.
      if (usedCachedFile || wroteToOpfs) await removeCachedModel();
      throw err;
    }
    onProgress?.(expectedTotal, expectedTotal);
  }

  private async clearPersistentConversation(): Promise<void> {
    const conv = this.persistentConversation;
    this.persistentConversation = null;
    this.cachedSystemPrompt = null;
    this.cachedMessagesJson = null;
    this.cachedTemperature = undefined;
    this.cachedMaxOutputTokens = undefined;
    if (conv) {
      try {
        await conv.delete();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    if (!this.engine) {
      await this.initialize();
    }

    const runTurn = async (): Promise<LlmGenerationResult> => {
      if (options.signal?.aborted) {
        return {
          turnId: options.turnId,
          text: '',
          aborted: true,
          timeToFirstTokenMs: 1,
          totalTimeMs: 1,
          tokensGenerated: 0,
          tokensPerSecond: 0,
        };
      }

      this.activeTurnId = options.turnId;
      const startTime = performance.now();
      let ttftMs = 0;
      let tokensGenerated = 0;
      let fullText = '';
      let aborted = false;
      let hadError = false;

      const priorMessages = options.messages.slice(0, -1).map((m) => ({
        role: m.role === 'assistant' ? 'model' : m.role,
        content: m.content,
      }));
      const latestUserMessage =
        options.messages[options.messages.length - 1]?.content ?? '';
      const priorMessagesJson = JSON.stringify(priorMessages);

      const targetTemperature = options.temperature;
      const targetMaxOutputTokens = options.maxOutputTokens ?? this.maxOutputTokens;

      // Reuse the existing WebGPU Conversation & KV cache if the system prompt, prior turns,
      // and session config (temperature, maxOutputTokens) match; otherwise recreate with updated preface.
      let conversation = this.persistentConversation;
      const canReuse =
        Boolean(conversation) &&
        !conversation.isBusy &&
        this.cachedSystemPrompt === options.systemPrompt &&
        this.cachedMessagesJson === priorMessagesJson &&
        this.cachedTemperature === targetTemperature &&
        this.cachedMaxOutputTokens === targetMaxOutputTokens;

      if (!canReuse) {
        await this.clearPersistentConversation();
        conversation = await this.engine.createConversation({
          sessionConfig: {
            samplerParams: targetTemperature !== undefined ? { temperature: targetTemperature } : undefined,
            maxOutputTokens: targetMaxOutputTokens,
          },
          preface: {
            messages: [
              { role: 'system', content: options.systemPrompt },
              ...priorMessages,
            ],
          },
        });
        this.persistentConversation = conversation;
        this.cachedTemperature = targetTemperature;
        this.cachedMaxOutputTokens = targetMaxOutputTokens;
      }
      this.activeConversation = conversation;

      let reader: ReadableStreamDefaultReader<any> | null = null;
      const onAbort = () => {
        aborted = true;
        try {
          conversation.cancel();
        } catch {
          // Ignore
        }
        try {
          void reader?.cancel();
        } catch {
          // Ignore
        }
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const stream = conversation.sendMessageStreaming({
          role: 'user',
          content: latestUserMessage,
        });

        const streamReader = stream.getReader();
        reader = streamReader;
        while (true) {
          if (options.signal?.aborted || aborted) {
            aborted = true;
            await streamReader.cancel().catch(() => {});
            break;
          }
          const { done, value: chunk } = await streamReader.read();
          if (done) break;

          if (chunk?.content && Array.isArray(chunk.content)) {
            for (const part of chunk.content) {
              if (part.type === 'text' && part.text) {
                if (ttftMs === 0) {
                  ttftMs = Math.max(1, Math.round(performance.now() - startTime));
                }
                tokensGenerated++;
                fullText += part.text;
                options.onToken?.(part.text, tokensGenerated);
              }
            }
          }
        }
      } catch (err) {
        if (options.signal?.aborted || aborted) {
          aborted = true;
        } else {
          hadError = true;
          const msg = String(err);
          if (/device (was )?lost|gpu ?device|webgpu|gpuvalidation|out of memory/i.test(msg)) {
            console.warn('[LiteRT-LM] GPU device loss during generation, resetting engine reference:', msg);
            this.engine = null;
          }
          throw err;
        }
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
        try {
          reader?.releaseLock();
        } catch {
          // Ignore
        }
        if (this.activeConversation === conversation) {
          this.activeConversation = null;
        }
        if (aborted || hadError || !fullText) {
          await this.clearPersistentConversation();
        } else {
          this.cachedSystemPrompt = options.systemPrompt;
          this.cachedMessagesJson = JSON.stringify([
            ...priorMessages,
            { role: 'user', content: latestUserMessage },
            { role: 'model', content: fullText },
          ]);
        }
      }

      const totalTimeMs = Math.max(1, Math.round(performance.now() - startTime));
      const tokensPerSecond =
        tokensGenerated > 0 ? Number(((tokensGenerated * 1000) / totalTimeMs).toFixed(1)) : 0;

      return {
        turnId: options.turnId,
        text: fullText,
        aborted,
        timeToFirstTokenMs: ttftMs || Math.min(20, totalTimeMs),
        totalTimeMs,
        tokensGenerated,
        tokensPerSecond,
      };
    };

    const next = this.generationChain.then(runTurn, runTurn);
    this.generationChain = next.catch(() => {});
    return next;
  }

  cancel(turnId?: string): void {
    if (!turnId || this.activeTurnId === turnId) {
      try {
        this.activeConversation?.cancel();
      } catch {
        // Ignore
      }
    }
  }

  async reset(): Promise<void> {
    this.cancel();
    await this.clearPersistentConversation();
  }

  async dispose(): Promise<void> {
    this.cancel();
    await this.clearPersistentConversation();
    if (this.engine) {
      try {
        await this.engine.delete();
      } catch {
        // Ignore
      }
      this.engine = null;
    }
  }
}
