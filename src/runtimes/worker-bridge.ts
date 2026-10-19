// ============================================================================
// Worker-Backed Runtime Providers with Crash Recovery
// (Spec Sections 2, 7, 9)
// ============================================================================

import type {
  LlmGenerationOptions,
  LlmGenerationResult,
  LlmRuntimeProvider,
  TtsRuntimeProvider,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from '../types/index.ts';
import { MODEL_REGISTRY } from '../core/model-manager.ts';
import { LiteRtLlmProvider } from './llm-provider.ts';
import { PiperTtsProvider } from './tts-provider.ts';

const MAX_WORKER_RESPAWNS = 3;
const RESPAWN_BACKOFF_BASE_MS = 500;

/** Network / HTTP download failures should surface, not trigger a main-thread retry of the same download. */
function isNetworkOrHttpError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /failed to fetch|fetch|network|http|download|cors|\(\s*[45]\d\d\s*\)|\b[45]\d\d\b|timed? ?out|offline|quota/i.test(msg);
}

export class WorkerLlmProvider implements LlmRuntimeProvider {
  readonly id = 'worker-llm';
  modelId: string;
  contextLimit: number;
  maxOutputTokens: number;
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = true;

  private worker: Worker | null = null;
  private directFallback: LlmRuntimeProvider | null = null;
  private initPromise: Promise<void> | null = null;
  private initializedModelId: string | null = null;
  private progressListeners = new Set<(loaded: number, total: number) => void>();
  private reqCounter = 0;
  private pendingRejects = new Set<(err: Error) => void>();
  private onCrashRecovered?: (recoveryTimeMs: number) => void;
  private epoch = 0;
  private respawnCount = 0;

  constructor(
    modelId = 'gemma-4-e2b-it-web',
    options?: { onCrashRecovered?: (recoveryTimeMs: number) => void }
  ) {
    this.modelId = modelId;
    this.onCrashRecovered = options?.onCrashRecovered;
    const manifest = MODEL_REGISTRY.find((m) => m.id === modelId);
    this.contextLimit = manifest?.contextWindowTokens ?? 8192;
    this.maxOutputTokens = manifest?.maxOutputTokens ?? 1024;
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') return null;

    try {
      this.worker = new Worker(new URL('../workers/llm.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onerror = () => {
        const err = new Error('LLM worker crashed');
        const initInFlight = !!this.initPromise;
        for (const fail of Array.from(this.pendingRejects)) fail(err);
        // A crash during init is handled by initialize() itself (fallback or surfaced error);
        // respawning here too would loop on a broken worker script.
        if (!initInFlight) {
          this.recoverFromCrash().catch((e) => {
            console.error('[WorkerLlmProvider] crash recovery failed:', e);
          });
        }
      };
      this.worker.onmessageerror = () => {
        const err = new Error('LLM worker message error');
        for (const fail of Array.from(this.pendingRejects)) fail(err);
      };
      return this.worker;
    } catch {
      return null;
    }
  }

  async recoverFromCrash(): Promise<void> {
    const start = performance.now();
    if (this.respawnCount >= MAX_WORKER_RESPAWNS) {
      throw new Error(`LLM worker crashed ${this.respawnCount} times; giving up on automatic recovery`);
    }
    const backoff = RESPAWN_BACKOFF_BASE_MS * 2 ** this.respawnCount;
    this.respawnCount++;
    this.initializedModelId = null;
    this.initPromise = null;
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // Ignore
      }
      this.worker = null;
    }
    if (backoff > 0 && this.respawnCount > 1) {
      await new Promise((r) => setTimeout(r, backoff / 2));
    }
    await this.initialize();
    this.respawnCount = 0;
    const elapsed = Math.max(1, Math.round(performance.now() - start));
    this.onCrashRecovered?.(elapsed);
  }

  async initialize(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.initializedModelId === this.modelId && (this.worker || this.directFallback)) {
      return;
    }
    if (onProgress) {
      this.progressListeners.add(onProgress);
    }
    if (this.initPromise) {
      try {
        await this.initPromise;
        return;
      } finally {
        if (onProgress) this.progressListeners.delete(onProgress);
      }
    }

    const notifyProgress = (loaded: number, total: number) => {
      for (const listener of this.progressListeners) {
        try {
          listener(loaded, total);
        } catch {
          // Ignore listener errors
        }
      }
    };

    const targetModelId = this.modelId;
    const epoch = this.epoch;
    this.initPromise = (async () => {
      // Drop any stale main-thread fallback (e.g. loaded for a previous model) so it can't shadow the new init.
      if (this.directFallback) {
        const stale = this.directFallback;
        this.directFallback = null;
        try {
          await stale.dispose();
        } catch {
          // Ignore
        }
      }
      const worker = this.ensureWorker();
      if (!worker) {
        const fallback = new LiteRtLlmProvider(targetModelId, { contextLimit: this.contextLimit, maxOutputTokens: this.maxOutputTokens });
        this.directFallback = fallback;
        try {
          await fallback.initialize(notifyProgress);
        } catch (e) {
          if (this.directFallback === fallback) this.directFallback = null;
          throw e;
        }
        this.initializedModelId = targetModelId;
        return;
      }

      const requestId = `llm_init_${++this.reqCounter}`;
      try {
        await new Promise<void>((resolveRaw, rejectRaw) => {
          const failInit = (err: Error) => {
            worker.removeEventListener('message', handler);
            this.pendingRejects.delete(failInit);
            rejectRaw(err);
          };
          const resolve = () => {
            this.pendingRejects.delete(failInit);
            resolveRaw();
          };
          const reject = failInit;
          this.pendingRejects.add(failInit);
          const handler = (ev: MessageEvent<WorkerResponseMessage<any>>) => {
            const data = ev.data;
            if (!data || data.requestId !== requestId) return;

            if (data.type === 'progress') {
              notifyProgress(data.payload.loaded, data.payload.total);
            } else if (data.type === 'initialized') {
              worker.removeEventListener('message', handler);
              this.contextLimit = data.payload.contextLimit ?? this.contextLimit;
              this.maxOutputTokens = data.payload.maxOutputTokens ?? this.maxOutputTokens;
              this.initializedModelId = targetModelId;
              resolve();
            } else if (data.type === 'error') {
              worker.removeEventListener('message', handler);
              reject(new Error(data.error ?? 'Worker initialization failed'));
            }
          };

          worker.addEventListener('message', handler);
          const req: WorkerRequestMessage = {
            requestId,
            turnId: 'init',
            sequence: 0,
            type: 'init',
            payload: {
              modelId: targetModelId,
              contextLimit: this.contextLimit,
              maxOutputTokens: this.maxOutputTokens,
            },
            timestamp: performance.now(),
          };
          worker.postMessage(req);
        });
      } catch (workerErr) {
        try {
          worker.terminate();
        } catch {
          // Ignore
        }
        if (this.worker === worker) this.worker = null;
        // Disposed mid-init, or a network/HTTP download failure: surface it instead of retrying on main thread.
        if (epoch !== this.epoch || isNetworkOrHttpError(workerErr)) throw workerErr;
        // If WebGPU adapter acquisition failed inside the Worker context (e.g. Safari worker
        // WebGPU restriction or adapter exhaustion), fall back to main-thread LiteRtLlmProvider.
        const fallback = new LiteRtLlmProvider(targetModelId, { contextLimit: this.contextLimit, maxOutputTokens: this.maxOutputTokens });
        this.directFallback = fallback;
        try {
          await fallback.initialize(notifyProgress);
          this.initializedModelId = targetModelId;
        } catch {
          if (this.directFallback === fallback) this.directFallback = null;
          throw workerErr;
        }
      }
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
      if (onProgress) this.progressListeners.delete(onProgress);
    }
  }

  async generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    if (this.initPromise) {
      await this.initPromise;
    }
    if (this.initializedModelId !== this.modelId || (!this.worker && !this.directFallback)) {
      await this.initialize();
    }
    if (this.directFallback) {
      return this.directFallback.generate(options);
    }

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

    const worker = this.ensureWorker()!;
    const requestId = `llm_gen_${++this.reqCounter}`;

    return new Promise<LlmGenerationResult>((resolveRaw, rejectRaw) => {
      const failPending = (err: Error) => {
        worker.removeEventListener('message', handler);
        options.signal?.removeEventListener('abort', onAbort);
        this.pendingRejects.delete(failPending);
        rejectRaw(err);
      };
      this.pendingRejects.add(failPending);
      const resolve = (v: LlmGenerationResult) => {
        this.pendingRejects.delete(failPending);
        resolveRaw(v);
      };
      const reject = (e: Error) => {
        this.pendingRejects.delete(failPending);
        rejectRaw(e);
      };
      const onAbort = () => {
        worker.removeEventListener('message', handler);
        this.cancel(options.turnId);
        resolve({
          turnId: options.turnId,
          text: '',
          aborted: true,
          timeToFirstTokenMs: 1,
          totalTimeMs: 1,
          tokensGenerated: 0,
          tokensPerSecond: 0,
        });
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const handler = (ev: MessageEvent<WorkerResponseMessage<any>>) => {
        const data = ev.data;
        if (!data || data.requestId !== requestId) return;

        if (data.type === 'token') {
          options.onToken?.(data.payload.token, data.payload.tokenSeq);
        } else if (data.type === 'completed') {
          worker.removeEventListener('message', handler);
          options.signal?.removeEventListener('abort', onAbort);
          resolve(data.payload as LlmGenerationResult);
        } else if (data.type === 'error') {
          worker.removeEventListener('message', handler);
          options.signal?.removeEventListener('abort', onAbort);
          const errText = data.error ?? 'LLM generation error';
          if (/device (was )?lost|gpu ?device|webgpu|gpuvalidation|out of memory/i.test(errText)) {
            console.warn('[WorkerLlmProvider] GPU device loss signaled, triggering crash recovery');
            void this.recoverFromCrash();
          }
          reject(new Error(errText));
        }
      };

      worker.addEventListener('message', handler);
      const req: WorkerRequestMessage = {
        requestId,
        turnId: options.turnId,
        sequence: 1,
        type: 'generate',
        payload: {
          systemPrompt: options.systemPrompt,
          messages: options.messages,
          maxOutputTokens: options.maxOutputTokens,
        },
        timestamp: performance.now(),
      };
      worker.postMessage(req);
    });
  }

  cancel(turnId?: string): void {
    if (this.directFallback) {
      this.directFallback.cancel(turnId);
      return;
    }
    if (!this.worker) return;
    const req: WorkerRequestMessage = {
      requestId: `llm_cancel_${++this.reqCounter}`,
      turnId: turnId ?? 'any',
      sequence: 0,
      type: 'cancel',
      payload: { turnId },
      timestamp: performance.now(),
    };
    this.worker.postMessage(req);
  }

  async reset(): Promise<void> {
    if (this.directFallback) {
      await this.directFallback.reset();
      return;
    }
    if (!this.worker) return;
    const req: WorkerRequestMessage = {
      requestId: `llm_reset_${++this.reqCounter}`,
      turnId: 'reset',
      sequence: 0,
      type: 'reset',
      payload: {},
      timestamp: performance.now(),
    };
    this.worker.postMessage(req);
  }

  async dispose(): Promise<void> {
    this.epoch++;
    this.initializedModelId = null;
    this.initPromise = null;
    const disposeErr = new Error('LLM provider disposed');
    for (const fail of Array.from(this.pendingRejects)) fail(disposeErr);
    if (this.directFallback) {
      const fb = this.directFallback;
      this.directFallback = null;
      await fb.dispose();
    }
    if (this.worker) {
      try {
        this.worker.postMessage({
          requestId: `llm_dispose_${++this.reqCounter}`,
          turnId: 'dispose',
          sequence: 0,
          type: 'dispose',
          payload: {},
          timestamp: performance.now(),
        });
      } catch {
        // Ignore
      }
      this.worker.terminate();
      this.worker = null;
    }
  }
}

export class WorkerTtsProvider implements TtsRuntimeProvider {
  readonly id = 'worker-tts';
  voiceId: string;
  private worker: Worker | null = null;
  private directFallback: PiperTtsProvider | null = null;
  private initPromise: Promise<void> | null = null;
  private initializedVoiceId: string | null = null;
  private progressListeners = new Set<(loaded: number, total: number) => void>();
  private reqCounter = 0;
  private pendingRejects = new Set<(err: Error) => void>();

  constructor(voiceId = 'en_US-hfc_female-medium') {
    this.voiceId = voiceId;
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') return null;

    try {
      const worker = new Worker(new URL('../workers/tts.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker = worker;
      worker.onerror = () => this.handleWorkerFailure(worker, new Error('TTS worker crashed'));
      worker.onmessageerror = () =>
        this.handleWorkerFailure(worker, new Error('TTS worker message error'));
      return worker;
    } catch {
      return null;
    }
  }

  private handleWorkerFailure(worker: Worker, err: Error): void {
    for (const fail of Array.from(this.pendingRejects)) fail(err);
    try {
      worker.terminate();
    } catch {
      // Ignore
    }
    // Null out the dead worker so the next call spawns a fresh one.
    if (this.worker === worker) {
      this.worker = null;
      this.initializedVoiceId = null;
    }
  }

  async initialize(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.initializedVoiceId === this.voiceId && (this.worker || this.directFallback)) {
      return;
    }
    if (onProgress) {
      this.progressListeners.add(onProgress);
    }
    if (this.initPromise) {
      try {
        await this.initPromise;
        return;
      } finally {
        if (onProgress) this.progressListeners.delete(onProgress);
      }
    }

    const notifyProgress = (loaded: number, total: number) => {
      for (const listener of this.progressListeners) {
        try {
          listener(loaded, total);
        } catch {
          // Ignore listener errors
        }
      }
    };

    const targetVoiceId = this.voiceId;
    this.initPromise = (async () => {
      const worker = this.ensureWorker();
      if (!worker) {
        this.directFallback = new PiperTtsProvider(targetVoiceId);
        await this.directFallback.initialize(notifyProgress);
        this.initializedVoiceId = targetVoiceId;
        return;
      }

      const requestId = `tts_init_${++this.reqCounter}`;
      await new Promise<void>((resolveRaw, rejectRaw) => {
        const failInit = (err: Error) => {
          worker.removeEventListener('message', handler);
          this.pendingRejects.delete(failInit);
          rejectRaw(err);
        };
        const resolve = () => {
          this.pendingRejects.delete(failInit);
          resolveRaw();
        };
        const reject = failInit;
        this.pendingRejects.add(failInit);
        const handler = (ev: MessageEvent<WorkerResponseMessage<any>>) => {
          const data = ev.data;
          if (!data || data.requestId !== requestId) return;

          if (data.type === 'progress') {
            notifyProgress(data.payload.loaded, data.payload.total);
          } else if (data.type === 'initialized') {
            worker.removeEventListener('message', handler);
            this.initializedVoiceId = targetVoiceId;
            resolve();
          } else if (data.type === 'error') {
            worker.removeEventListener('message', handler);
            reject(new Error(data.error ?? 'TTS Worker initialization failed'));
          }
        };

        worker.addEventListener('message', handler);
        const req: WorkerRequestMessage = {
          requestId,
          turnId: 'init',
          sequence: 0,
          type: 'init',
          payload: { voiceId: targetVoiceId },
          timestamp: performance.now(),
        };
        worker.postMessage(req);
      });
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
      if (onProgress) this.progressListeners.delete(onProgress);
    }
  }

  async synthesize(
    text: string,
    turnId: string,
    sequence: number,
    signal?: AbortSignal
  ): Promise<{
    samples: Float32Array;
    sampleRate: number;
    synthesisTimeMs: number;
    audioDurationMs: number;
  }> {
    if (this.initPromise) {
      await this.initPromise;
    }
    if (this.initializedVoiceId !== this.voiceId || (!this.worker && !this.directFallback)) {
      await this.initialize();
    }
    if (this.directFallback) {
      return this.directFallback.synthesize(text, turnId, sequence, signal);
    }

    if (signal?.aborted) {
      throw new Error('TTS aborted');
    }

    const worker = this.ensureWorker()!;
    const requestId = `tts_syn_${++this.reqCounter}`;

    return new Promise((resolveRaw, rejectRaw) => {
      const fail = (err: Error) => {
        worker.removeEventListener('message', handler);
        signal?.removeEventListener('abort', onAbort);
        this.pendingRejects.delete(fail);
        rejectRaw(err);
      };
      const resolve = (v: any) => {
        this.pendingRejects.delete(fail);
        resolveRaw(v);
      };
      const reject = fail;
      this.pendingRejects.add(fail);
      const onAbort = () => {
        this.cancel(turnId);
        fail(new Error('TTS aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const handler = (ev: MessageEvent<WorkerResponseMessage<any>>) => {
        const data = ev.data;
        if (!data || data.requestId !== requestId) return;

        if (data.type === 'audio_chunk') {
          worker.removeEventListener('message', handler);
          signal?.removeEventListener('abort', onAbort);
          resolve(data.payload);
        } else if (data.type === 'error') {
          worker.removeEventListener('message', handler);
          signal?.removeEventListener('abort', onAbort);
          reject(new Error(data.error ?? 'TTS synthesis failed'));
        }
      };

      worker.addEventListener('message', handler);
      const req: WorkerRequestMessage = {
        requestId,
        turnId,
        sequence,
        type: 'synthesize',
        payload: { text },
        timestamp: performance.now(),
      };
      worker.postMessage(req);
    });
  }

  cancel(turnId?: string): void {
    if (this.directFallback) {
      this.directFallback.cancel(turnId);
      return;
    }
    if (!this.worker) return;
    const req: WorkerRequestMessage = {
      requestId: `tts_cancel_${++this.reqCounter}`,
      turnId: turnId ?? 'any',
      sequence: 0,
      type: 'cancel',
      payload: { turnId },
      timestamp: performance.now(),
    };
    this.worker.postMessage(req);
  }

  async dispose(): Promise<void> {
    this.initializedVoiceId = null;
    this.initPromise = null;
    const disposeErr = new Error('TTS provider disposed');
    for (const fail of Array.from(this.pendingRejects)) fail(disposeErr);
    if (this.directFallback) {
      await this.directFallback.dispose();
      this.directFallback = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
