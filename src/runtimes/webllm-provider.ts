// ============================================================================
// WebLLM (MLC) chat models on WebGPU, run in a worker. WebLLM loads weights in small shards
// straight onto the GPU, so its peak memory while loading stays near the model's own size,
// which is what lets it load in mobile Safari. Downloads are kept in Cache Storage.
// ============================================================================

import type { WebWorkerMLCEngine } from '@mlc-ai/web-llm';
import type { LlmGenerationOptions, LlmGenerationResult, LlmRuntimeProvider } from '../types/index.ts';

export interface WebLlmModelSpec {
  /** WebLLM prebuilt model id (e.g. Qwen2.5-0.5B-Instruct-q4f16_1-MLC) */
  mlcId: string;
  /** Approximate download size, for progress before WebLLM reports its own */
  sizeBytes: number;
  contextLimit: number;
  maxOutputTokens: number;
  /** Qwen3: answer directly instead of writing a <think> block first */
  noThinking?: boolean;
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Lowest temperature used with WebLLM models (see runGeneration) */
const WEBLLM_MIN_TEMPERATURE = 0.6;

/** One system message first, then alternating turns (consecutive same-role messages are merged). */
function toChatMessages(systemPrompt: string, messages: LlmGenerationOptions['messages']): ChatMessage[] {
  const system = [systemPrompt, ...messages.filter((m) => m.role === 'system').map((m) => m.content)]
    .filter(Boolean)
    .join('\n');
  const out: ChatMessage[] = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

/**
 * The reply with any leading <think>...</think> block removed, or null while that block is
 * still being written (nothing should be shown yet).
 */
export function withoutThinking(raw: string): string | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('<think>')) {
    // Could still become "<think>" once more characters arrive
    return '<think>'.startsWith(trimmed) && trimmed.length > 0 ? null : raw;
  }
  const end = trimmed.indexOf('</think>');
  return end === -1 ? null : trimmed.slice(end + '</think>'.length).trimStart();
}

/** Where WebLLM stores downloaded model files (Cache API) */
const WEBLLM_CACHE = 'webllm/model';

/** The base URL of a model's files as WebLLM fetches and stores them */
export const modelFilesUrl = (model: string) => `${model.replace(/\/+$/, '')}/resolve/main/`;

/**
 * Deletes the stored pieces of a model whose size doesn't match its index (tensor-cache.json), so
 * only those are downloaded again. Returns how many were deleted (an unreadable index counts).
 */
export async function dropBrokenPieces(cache: Cache, baseUrl: string): Promise<number> {
  const indexUrl = `${baseUrl}tensor-cache.json`;
  const index = await cache.match(indexUrl);
  if (!index) return 0;
  let records: Array<{ dataPath: string; nbytes: number }>;
  try {
    records = (await index.json()).records ?? [];
  } catch {
    await cache.delete(indexUrl);
    return 1;
  }
  let dropped = 0;
  for (const { dataPath, nbytes } of records) {
    const url = baseUrl + dataPath;
    const stored = await cache.match(url);
    if (!stored) continue; // not downloaded yet
    const size = (await stored.blob()).size;
    if (size !== nbytes) {
      await cache.delete(url);
      dropped++;
    }
  }
  return dropped;
}

/** A load error from a broken stored copy of the model ("Tensor-cache record range [0, 393216) exceeds shard size 0") */
export function isBrokenCacheError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /exceeds shard size|(?:tensor|ndarray)-cache record/i.test(message);
}

export class WebLlmProvider implements LlmRuntimeProvider {
  readonly id: string;
  readonly contextLimit: number;
  readonly maxOutputTokens: number;
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = false;
  /** What WebLLM is doing while it loads ("Loading GPU shader modules[12/80]: ..."), for the status line */
  loadStage = '';

  private worker: Worker | null = null;
  private engine: WebWorkerMLCEngine | null = null;
  private initPromise: Promise<void> | null = null;
  // WebLLM runs one generation at a time
  private generationChain: Promise<unknown> = Promise.resolve();

  constructor(readonly modelId: string, readonly spec: WebLlmModelSpec) {
    this.id = `webllm:${modelId}`;
    this.contextLimit = spec.contextLimit;
    this.maxOutputTokens = spec.maxOutputTokens;
  }

  get isLoaded(): boolean {
    return this.engine !== null;
  }

  initialize(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.engine) return Promise.resolve();
    this.initPromise ??= (async () => {
      const webllm = await import('@mlc-ai/web-llm');
      const total = this.spec.sizeBytes;
      onProgress?.(0, total);
      try {
        await this.load(webllm.CreateWebWorkerMLCEngine, total, onProgress);
      } catch (err) {
        // A broken stored copy (an empty or cut-off piece left by a download that stopped) fails
        // the same way every time. The pieces whose size doesn't match the model's index are
        // deleted, so only those download again; if none can be found, the whole model is.
        if (!isBrokenCacheError(err)) throw err;
        this.loadStage = 'Repairing the download';
        onProgress?.(0, total);
        const record = webllm.prebuiltAppConfig.model_list.find((m) => m.model_id === this.spec.mlcId);
        const dropped =
          record && typeof caches !== 'undefined'
            ? await dropBrokenPieces(await caches.open(WEBLLM_CACHE), modelFilesUrl(record.model)).catch(() => 0)
            : 0;
        if (dropped === 0) await webllm.deleteModelAllInfoInCache(this.spec.mlcId).catch(() => {});
        await this.load(webllm.CreateWebWorkerMLCEngine, total, onProgress);
      }
    })().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  /** One attempt at loading the model in a new worker */
  private async load(
    create: typeof import('@mlc-ai/web-llm').CreateWebWorkerMLCEngine,
    total: number,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void> {
    const worker = new Worker(new URL('../workers/webllm.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    try {
      const engine = await create(
        worker,
        this.spec.mlcId,
        // WebLLM reports a 0..1 fraction (download, then loading onto the GPU) and what it's doing
        {
          initProgressCallback: (report) => {
            this.loadStage = report.text ?? '';
            onProgress?.(Math.round(report.progress * total), total);
          },
        },
        { context_window_size: this.spec.contextLimit }
      );
      if (this.worker !== worker) {
        // Disposed while loading
        await engine.unload().catch(() => {});
        throw new Error(`${this.modelId} unloaded`);
      }
      this.engine = engine;
      onProgress?.(total, total);
    } catch (err) {
      if (this.worker === worker) {
        worker.terminate();
        this.worker = null;
      }
      throw err;
    }
  }

  generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    const run = () => this.runGeneration(options);
    const next = this.generationChain.then(run, run);
    this.generationChain = next.catch(() => {});
    return next;
  }

  private async runGeneration(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    const start = performance.now();
    const empty = (aborted: boolean): LlmGenerationResult => ({
      turnId: options.turnId,
      text: '',
      aborted,
      timeToFirstTokenMs: 0,
      totalTimeMs: 0,
      tokensGenerated: 0,
      tokensPerSecond: 0,
    });
    if (options.signal?.aborted) return empty(true);
    await this.initialize();
    const engine = this.engine;
    if (!engine) return empty(true);

    const onAbort = () => void engine.interruptGenerate();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let text = '';
    let tokens = 0;
    let firstTokenAt = 0;
    // A <think>...</think> block (Qwen3 can still write one) is held back, never shown or run
    let raw = '';
    let emitted = 0;
    try {
      const stream = await engine.chat.completions.create({
        messages: toChatMessages(options.systemPrompt, options.messages),
        stream: true,
        // Small models get stuck repeating themselves on near-greedy decoding (Chatty asks for 0.1,
        // which suits Gemma on LiteRT). Qwen's guidance: about 0.7 / 0.8 with a mild repetition
        // penalty, as Qwen2.5-Coder ships.
        temperature: Math.max(options.temperature ?? WEBLLM_MIN_TEMPERATURE, WEBLLM_MIN_TEMPERATURE),
        top_p: options.topP ?? 0.8,
        repetition_penalty: 1.05,
        max_tokens: options.maxOutputTokens ?? this.maxOutputTokens,
        ...(this.spec.noThinking ? { extra_body: { enable_thinking: false } } : {}),
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (!delta) continue;
        raw += delta;
        const visible = withoutThinking(raw);
        if (visible === null || visible.length <= emitted) continue;
        const fresh = visible.slice(emitted);
        emitted = visible.length;
        if (!firstTokenAt) firstTokenAt = performance.now();
        text += fresh;
        tokens++;
        options.onToken?.(fresh, tokens);
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
    const totalTimeMs = Math.max(1, performance.now() - start);
    return {
      turnId: options.turnId,
      text,
      aborted: !!options.signal?.aborted,
      timeToFirstTokenMs: firstTokenAt ? firstTokenAt - start : 0,
      totalTimeMs,
      tokensGenerated: tokens,
      tokensPerSecond: tokens / (totalTimeMs / 1000),
    };
  }

  cancel(): void {
    void this.engine?.interruptGenerate();
  }

  async reset(): Promise<void> {
    // Stateless between generations (full conversation each call)
  }

  /** Unloads the model and ends the worker, freeing its GPU memory. */
  async dispose(): Promise<void> {
    const engine = this.engine;
    const worker = this.worker;
    this.engine = null;
    this.worker = null;
    this.initPromise = null;
    await engine?.unload().catch(() => {});
    worker?.terminate();
  }
}
