// ============================================================================
// OnnxLlmProvider: small ONNX causal LMs (Transformers.js, WebGPU) in a dedicated worker.
// Used on memory-constrained phones for the FunctionGemma router, the Gemma 3 1B chat
// model and the Qwen2.5-Coder JavaScript writer. Models are meant to be resident one at a
// time: dispose() terminates the worker, which releases all of the model's memory.
// ============================================================================

import { retryTemperature } from './retry-temperature.ts';
import type { LlmGenerationOptions, LlmGenerationResult, LlmRuntimeProvider } from '../types/index.ts';

export interface OnnxModelSpec {
  /** Hugging Face repo with an onnx/ folder (e.g. onnx-community/functiongemma-270m-it-ONNX) */
  repo: string;
  /** Weight variant to load (q4f16 keeps phones within memory) */
  dtype: string;
  contextLimit: number;
  maxOutputTokens: number;
  /** Extra chat-template variables (e.g. Qwen3's enable_thinking) */
  templateOptions?: Record<string, unknown>;
}

export interface OnnxRawGenerateOptions {
  messages: Array<{ role: string; content: string }>;
  /** JSON-schema tool declarations passed to the chat template */
  tools?: unknown[];
  maxNewTokens?: number;
  temperature?: number;
  topP?: number;
  /** Keep special tokens in the output (FunctionGemma marks calls with special tokens) */
  keepSpecialTokens?: boolean;
  signal?: AbortSignal;
  onToken?: (chunk: string, sequence: number) => void;
}

interface RawResult {
  text: string;
  tokens: number;
  timeToFirstTokenMs: number;
  totalTimeMs: number;
  aborted: boolean;
}

type Pending = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  onProgress?: (loaded: number, total: number) => void;
  onToken?: (chunk: string, sequence: number) => void;
};

export class OnnxLlmProvider implements LlmRuntimeProvider {
  readonly id: string;
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = true;
  contextLimit: number;
  maxOutputTokens: number;

  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private reqCounter = 0;
  private pending = new Map<string, Pending>();
  // Serializes generations: the worker runs one at a time
  private generationChain: Promise<unknown> = Promise.resolve();

  constructor(readonly modelId: string, readonly spec: OnnxModelSpec) {
    this.id = `onnx:${modelId}`;
    this.contextLimit = spec.contextLimit;
    this.maxOutputTokens = spec.maxOutputTokens;
  }

  get isLoaded(): boolean {
    return this.initialized;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../workers/onnx-llm.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<any>) => {
      const data = ev.data;
      const p = data?.id ? this.pending.get(data.id) : undefined;
      if (!p) return;
      switch (data.type) {
        case 'progress':
          p.onProgress?.(data.loaded, data.total);
          break;
        case 'token':
          p.onToken?.(data.text, data.sequence);
          break;
        case 'initialized':
        case 'disposed':
          this.pending.delete(data.id);
          p.resolve(undefined);
          break;
        case 'result':
          this.pending.delete(data.id);
          p.resolve(data);
          break;
        case 'error':
          this.pending.delete(data.id);
          p.reject(new Error(data.error ?? 'ONNX worker error'));
          break;
      }
    };
    const crash = (message: string) => {
      const err = new Error(message);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
      this.initialized = false;
      this.initPromise = null;
    };
    worker.onerror = () => crash(`${this.modelId} worker crashed`);
    worker.onmessageerror = () => crash(`${this.modelId} worker message error`);
    this.worker = worker;
    return worker;
  }

  private request<T>(type: string, payload: unknown, hooks: Omit<Pending, 'resolve' | 'reject'> = {}): { id: string; promise: Promise<T> } {
    const worker = this.ensureWorker();
    const id = `${type}_${++this.reqCounter}`;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...hooks });
    });
    worker.postMessage({ id, type, payload });
    return { id, promise };
  }

  initialize(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.request<void>('init', { repo: this.spec.repo, dtype: this.spec.dtype }, { onProgress })
      .promise.then(() => {
        this.initialized = true;
      })
      .catch((err) => {
        this.initPromise = null;
        throw err;
      });
    return this.initPromise;
  }

  /** Raw chat-template generation (used by the FunctionGemma router and the coder). */
  generateRaw(options: OnnxRawGenerateOptions): Promise<RawResult> {
    const run = async (): Promise<RawResult> => {
      await this.initialize();
      if (options.signal?.aborted) {
        return { text: '', tokens: 0, timeToFirstTokenMs: 0, totalTimeMs: 0, aborted: true };
      }
      const { id, promise } = this.request<Omit<RawResult, 'aborted'>>(
        'generate',
        {
          messages: options.messages,
          tools: options.tools,
          maxNewTokens: options.maxNewTokens ?? this.maxOutputTokens,
          temperature: options.temperature,
          topP: options.topP,
          keepSpecialTokens: options.keepSpecialTokens,
          templateOptions: this.spec.templateOptions,
        },
        { onToken: options.onToken }
      );
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        this.worker?.postMessage({ id, type: 'interrupt' });
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await promise;
        return { ...res, aborted };
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
      }
    };
    const next = this.generationChain.then(run, run);
    this.generationChain = next.catch(() => {});
    return next;
  }

  async generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    const messages: Array<{ role: string; content: string }> = [];
    if (options.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt });
    messages.push(...options.messages);
    const res = await this.generateRaw({
      messages,
      maxNewTokens: options.maxOutputTokens ?? this.maxOutputTokens,
      // Exact turn: greedy decoding (temperature 0 means do_sample false in the worker)
      // A retry samples cooler (retryTemperature)
      temperature: options.sampling ? options.sampling.temperature : options.exact ? 0 : options.temperature === undefined ? undefined : retryTemperature(options.temperature, options.retry),
      topP: options.sampling?.topP ?? options.topP,
      signal: options.signal,
      onToken: options.onToken,
    });
    return {
      turnId: options.turnId,
      text: res.text,
      aborted: res.aborted,
      timeToFirstTokenMs: res.timeToFirstTokenMs,
      totalTimeMs: res.totalTimeMs,
      tokensGenerated: res.tokens,
      tokensPerSecond: res.totalTimeMs > 0 ? (res.tokens * 1000) / res.totalTimeMs : 0,
    };
  }

  cancel(): void {
    for (const id of this.pending.keys()) {
      if (id.startsWith('generate_')) this.worker?.postMessage({ id, type: 'interrupt' });
    }
  }

  async reset(): Promise<void> {
    // Stateless between generations (full prompt each call)
  }

  /** Unloads the model by terminating its worker; the next call reloads from the browser cache. */
  async dispose(): Promise<void> {
    const err = new Error(`${this.modelId} unloaded`);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.initialized = false;
    this.initPromise = null;
  }
}
