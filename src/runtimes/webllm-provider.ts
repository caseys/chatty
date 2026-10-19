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

export class WebLlmProvider implements LlmRuntimeProvider {
  readonly id: string;
  readonly contextLimit: number;
  readonly maxOutputTokens: number;
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = false;

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
      const { CreateWebWorkerMLCEngine } = await import('@mlc-ai/web-llm');
      const worker = new Worker(new URL('../workers/webllm.worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      const total = this.spec.sizeBytes;
      onProgress?.(0, total);
      try {
        const engine = await CreateWebWorkerMLCEngine(
          worker,
          this.spec.mlcId,
          // WebLLM reports a 0..1 fraction (download, then loading onto the GPU)
          { initProgressCallback: (report) => onProgress?.(Math.round(report.progress * total), total) },
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
    })().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
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
