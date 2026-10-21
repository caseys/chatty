// ============================================================================
// WebLLM (MLC) chat models on WebGPU, run in a worker. WebLLM loads weights in small shards
// straight onto the GPU, so its peak memory while loading stays near the model's own size,
// which is what lets it load in mobile Safari. Downloads are kept in Cache Storage.
//
// WebLLM's library (6 MB) is loaded by the worker alone and never by the page, which matters in
// mobile Safari's memory: the page talks to the worker in the messages of
// workers/webllm-protocol.ts, through WebLlmClient.
// ============================================================================

import { choiceGrammar, ENGLISH_GRAMMAR, fixGrammar } from './fix-grammar.ts';
import { retryTemperature } from './retry-temperature.ts';
import { isAppleMobile } from '../core/settings.ts';
import { AFTER_LOAD_MS, settleOnIos } from '../core/settle.ts';
import { contextWindowFor, currentDevice, kvBytesPerToken, modelMaxContext, readModelConfig, workingMemoryBudget } from './context-size.ts';
import type { LlmGenerationOptions, LlmGenerationResult, LlmRuntimeProvider } from '../types/index.ts';
import type { WebLlmChatRequest } from '../workers/webllm-protocol.ts';
import { WebLlmClient, type WebLlmWorker } from './webllm-client.ts';

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
/** Temperature for an exact answer (a fix turn's corrected line) */
const WEBLLM_EXACT_TEMPERATURE = 0.2;

/**
 * Every WebLLM reply is held to a grammar (English characters, or a fix's shape). Above this
 * temperature WebLLM samples tokens the grammar rules out ("Grammar matcher rejected the newly
 * sampled token"), and the reply fails; up to it, with any top-p, the grammar held in tests.
 */
export const WEBLLM_MAX_TEMPERATURE = 1;

/**
 * Sampling fields for a WebLLM request. Code repeats lines and tokens on purpose (`out.send(...)`,
 * `ctx.`), so a repetition or presence penalty hurts it: Qwen3 / Qwen3.5 get presence penalty 0
 * (Qwen's recommended 0.5 targets thinking-mode loops, and these models run without thinking), and
 * other models (Qwen2.5-Coder ships 1.05) keep a mild repetition penalty. An exact turn is
 * near-greedy with no penalty at all.
 */
export function webLlmSampling(
  options: Pick<LlmGenerationOptions, 'temperature' | 'topP' | 'exact' | 'retry' | 'sampling'>,
  spec: Pick<WebLlmModelSpec, 'mlcId' | 'noThinking'>
): { temperature: number; top_p: number; repetition_penalty?: number; presence_penalty?: number } {
  if (options.sampling) return { temperature: Math.min(options.sampling.temperature, WEBLLM_MAX_TEMPERATURE), top_p: options.sampling.topP };
  const top_p = options.topP ?? 0.8;
  if (options.exact) return { temperature: WEBLLM_EXACT_TEMPERATURE, top_p };
  // Small models get stuck repeating themselves on near-greedy decoding (Chatty asks for 0.1,
  // which LiteRT honours too), so normal turns keep a floor.
  const temperature = Math.min(
    retryTemperature(Math.max(options.temperature ?? WEBLLM_MIN_TEMPERATURE, WEBLLM_MIN_TEMPERATURE), options.retry),
    WEBLLM_MAX_TEMPERATURE
  );
  const qwen3 = spec.noThinking || /^qwen3/i.test(spec.mlcId);
  return qwen3
    ? { temperature, top_p, presence_penalty: 0 }
    : { temperature, top_p, repetition_penalty: 1.05 };
}

/** The most tokens WebLLM reports probabilities for at one position (its top_logprobs is 0 to 5) */
const WEBLLM_MAX_TOP_LOGPROBS = 5;

/**
 * How likely each label is, from the tokens WebLLM reported at the answer's position (a token and
 * its log probability). Tokenizers write the same letter more than one way ("A", " A"), so every
 * token that is a label once its spaces are trimmed counts for that label, and their probabilities
 * add up. A label not among the reported tokens is less likely than all of them: 0. Null when no
 * label showed up (the model's top tokens were something else, or nothing was reported).
 */
export function choiceProbabilities(labels: string[], reported: Array<{ token: string; logprob: number }>): number[] | null {
  const probabilities = labels.map(() => 0);
  const seen = new Set<string>();
  for (const { token, logprob } of reported) {
    // (the sampled token is reported once on its own and again among the top ones)
    if (seen.has(token)) continue;
    seen.add(token);
    const at = labels.indexOf(token.trim());
    if (at >= 0 && Number.isFinite(logprob)) probabilities[at] += Math.exp(logprob);
  }
  return probabilities.some((p) => p > 0) ? probabilities : null;
}

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
    // The header tells the size without reading the piece (tens of MB) into memory; a piece
    // stored without one, or empty, is read
    const length = Number(stored.headers.get('content-length'));
    const size = length > 0 ? length : (await stored.blob()).size;
    if (size !== nbytes) {
      await cache.delete(url);
      dropped++;
    }
  }
  return dropped;
}

/** How long the worker pauses before each weight piece on iPhone and iPad (see webllm.worker.ts) */
export const IOS_LOAD_PACE_MS = 80;

/**
 * Where a WebLLM load report puts the bar, as a fraction of the whole load, or null for a report
 * that doesn't move it. WebLLM counts each step from 0 again (the download, the weights onto the
 * GPU, the shaders), so each gets its share of one bar: the download up to 60%, the weights up to
 * 85% (from 0 when they were all in the cache already), the shaders up to 98%. The last 2% come
 * only once the model is ready.
 */
export function loadFraction(text: string, progress: number, downloaded: boolean): number | null {
  const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  if (/^Fetching param cache/i.test(text)) return p * 0.6;
  if (/^Loading model from cache/i.test(text)) {
    const from = downloaded ? 0.6 : 0;
    return from + p * (0.85 - from);
  }
  if (/^Loading GPU shader modules/i.test(text)) return 0.85 + p * 0.13;
  if (/^Finish loading/i.test(text)) return 0.98;
  return null;
}

/** A load error from a broken stored copy of the model ("Tensor-cache record range [0, 393216) exceeds shard size 0") */
export function isBrokenCacheError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /exceeds shard size|(?:tensor|ndarray)-cache record/i.test(message);
}

/** A worker running workers/webllm.worker.ts (Vite builds the file this URL names) */
const startWorker = (): WebLlmWorker => new Worker(new URL('../workers/webllm.worker.ts', import.meta.url), { type: 'module' });

export class WebLlmProvider implements LlmRuntimeProvider {
  readonly id: string;
  /** The context it gets: the spec's until it loads, then what this device's budget holds for it (see context-size.ts) */
  contextLimit: number;
  /** At most half the context, so a prompt that fills its share and the reply always fit */
  maxOutputTokens: number;
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = false;
  /** What WebLLM is doing while it loads ("Loading GPU shader modules[12/80]: ..."), for the status line */
  loadStage = '';

  /** The worker in use: set when it starts, so it also serves a load that hasn't finished */
  private worker: WebLlmClient | null = null;
  /** The worker once the model is loaded in it */
  private engine: WebLlmClient | null = null;
  private initPromise: Promise<void> | null = null;
  // WebLLM runs one generation at a time
  private generationChain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly modelId: string,
    readonly spec: WebLlmModelSpec,
    private readonly openWorker: () => WebLlmWorker = startWorker
  ) {
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
      const total = this.spec.sizeBytes;
      onProgress?.(0, total);
      let client = this.open();
      try {
        // (where the model's files are comes from WebLLM's list of models, which only the worker has)
        const modelUrl = await client.modelUrl(this.spec.mlcId);
        await this.sizeContext(modelUrl);
        try {
          await this.load(client, total, onProgress);
        } catch (err) {
          // A broken stored copy (an empty or cut-off piece left by a download that stopped) fails
          // the same way every time. The pieces whose size doesn't match the model's index are
          // deleted, so only those download again; if none can be found, the whole model is.
          if (!isBrokenCacheError(err)) throw err;
          this.loadStage = 'Repairing the download';
          onProgress?.(0, total);
          // (the failed load ended its worker)
          client = this.open();
          const dropped =
            modelUrl && typeof caches !== 'undefined'
              ? await dropBrokenPieces(await caches.open(WEBLLM_CACHE), modelFilesUrl(modelUrl)).catch(() => 0)
              : 0;
          if (dropped === 0) await client.deleteCache(this.spec.mlcId).catch(() => {});
          await this.load(client, total, onProgress);
        }
      } catch (err) {
        this.discard(client);
        throw err;
      }
    })().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  /**
   * The context this device can hold for the model: its KV cache's cost per token (from its
   * config) against the device's budget, never above the spec's (see context-size.ts)
   */
  private async sizeContext(modelUrl: string | undefined): Promise<void> {
    const config = modelUrl ? await readModelConfig(`${modelFilesUrl(modelUrl)}mlc-chat-config.json`) : null;
    const perToken = kvBytesPerToken(config);
    const budget = workingMemoryBudget(currentDevice());
    this.contextLimit = contextWindowFor(perToken, budget, this.spec.contextLimit, modelMaxContext(config));
    this.maxOutputTokens = Math.min(this.spec.maxOutputTokens, Math.floor(this.contextLimit / 2));
    if (perToken) {
      console.info(
        `[WebLLM] ${this.modelId}: ${this.contextLimit}-token context (${((perToken * this.contextLimit) / (1024 * 1024)).toFixed(0)} MB of working memory, ${(perToken / 1024).toFixed(0)} KB a token; budget ${(budget / (1024 * 1024)).toFixed(0)} MB)`
      );
    }
  }

  /** Starts a new worker */
  private open(): WebLlmClient {
    const client = new WebLlmClient(this.openWorker());
    this.worker = client;
    // iPhone Safari gets pauses between the load's heavy steps (the worker reads this first)
    client.pace(isAppleMobile() ? IOS_LOAD_PACE_MS : 0);
    return client;
  }

  /** Ends a worker that failed (unless it is no longer the one in use) */
  private discard(client: WebLlmClient): void {
    if (this.worker !== client) return;
    client.terminate();
    this.worker = null;
  }

  /** One attempt at loading the model in a worker; the worker is ended if it fails */
  private async load(client: WebLlmClient, total: number, onProgress?: (loaded: number, total: number) => void): Promise<void> {
    // The bar only moves forward, through every step (see loadFraction)
    let downloaded = false;
    let shown = 0;
    try {
      await client.load(
        this.spec.mlcId,
        // Our context size, never a sliding window (the worker sets it so)
        this.contextLimit,
        // WebLLM reports what it's doing and a 0..1 fraction of that step
        (text, progress) => {
          this.loadStage = text;
          if (/^Fetching param cache/i.test(text)) downloaded = true;
          const at = loadFraction(text, progress, downloaded);
          if (at === null || at <= shown) return;
          shown = at;
          onProgress?.(Math.round(at * total), total);
        }
      );
      // A breath on iPhone before the app moves on, and the bar full only then: the last thing
      // the load changes
      await settleOnIos(AFTER_LOAD_MS);
      if (this.worker !== client) {
        // Disposed while loading
        await client.unload().catch(() => {});
        throw new Error(`${this.modelId} unloaded`);
      }
      this.engine = client;
      onProgress?.(total, total);
    } catch (err) {
      this.discard(client);
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

    const onAbort = () => engine.interrupt();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let text = '';
    let tokens = 0;
    let firstTokenAt = 0;
    // A <think>...</think> block (Qwen3 can still write one) is held back, never shown or run
    let raw = '';
    let emitted = 0;
    try {
      const messages = toChatMessages(options.systemPrompt, options.messages);
      const request: WebLlmChatRequest = {
        messages,
        ...webLlmSampling(options, this.spec),
        max_tokens: options.maxOutputTokens ?? this.maxOutputTokens,
        ...(this.spec.noThinking ? { extra_body: { enable_thinking: false } } : {}),
      };
      // A fix turn is constrained to "// Cause: ..." plus code. If the grammar fails to compile or
      // generation with it throws before any text, retry once without it.
      const consume = async (stream: AsyncIterable<string>) => {
        for await (const delta of stream) {
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
      };
      // Every reply is held to English characters (ENGLISH_GRAMMAR); a fix turn to its shape too
      const grammarFormat = {
        type: 'grammar' as const,
        grammar: options.fixShape ? fixGrammar(options.fixShape, options.choiceCount) : ENGLISH_GRAMMAR,
      };
      {
        try {
          await consume(engine.stream({ ...request, response_format: grammarFormat }));
        } catch (err) {
          // Text already went out (onToken): a second reply would be appended to it
          if (options.signal?.aborted || tokens > 0) throw err;
          // Discard any partial output so the retry starts clean
          const restart = () => {
            raw = '';
            text = '';
            emitted = 0;
            tokens = 0;
            firstTokenAt = 0;
          };
          restart();
          // Once more with the grammar, cooler (a request without it left WebLLM ignoring
          // grammars afterwards), and only then without
          try {
            console.warn('Grammar-constrained reply failed; retrying cooler', err);
            await consume(engine.stream({ ...request, temperature: Math.min(request.temperature, 0.5), response_format: grammarFormat }));
          } catch (again) {
            if (options.signal?.aborted || tokens > 0) throw again;
            console.warn('Grammar-constrained reply failed again; retrying without it', again);
            restart();
            await consume(engine.stream(request));
          }
        }
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

  /**
   * The model's probability for each label as the answer to a multiple-choice request: one pass
   * of the question, one token. WebLLM reports the likeliest tokens at that position (up to 5), so
   * the likeliest five labels are scored and the rest read 0. The reply is held to the labels by
   * a grammar, as in generate: WebLLM applies the grammar to the logits before it computes the
   * probabilities, so they are shared among the labels alone (a bare "A" against "The answer is"
   * and a space-led " A" no longer split the mass, and none of the five slots goes to a token that
   * is no answer). A grammar that fails here gives null instead of a retry without it: a request
   * without a grammar left WebLLM ignoring them afterwards (see runGeneration). Temperature is 1
   * so the numbers are the model's own, not sharpened; the sampled token doesn't matter.
   */
  scoreChoices(options: LlmGenerationOptions, labels: string[]): Promise<number[] | null> {
    const run = () => this.runScoring(options, labels);
    const next = this.generationChain.then(run, run);
    this.generationChain = next.catch(() => {});
    return next;
  }

  private async runScoring(options: LlmGenerationOptions, labels: string[]): Promise<number[] | null> {
    if (labels.length < 2 || options.signal?.aborted) return null;
    await this.initialize();
    const engine = this.engine;
    if (!engine) return null;
    const onAbort = () => engine.interrupt();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const reply = await engine.complete({
        messages: toChatMessages(options.systemPrompt, options.messages),
        temperature: WEBLLM_MAX_TEMPERATURE,
        top_p: 1,
        max_tokens: 1,
        logprobs: true,
        top_logprobs: WEBLLM_MAX_TOP_LOGPROBS,
        response_format: { type: 'grammar', grammar: choiceGrammar(labels) },
        // The grammar rules out a <think> tag, but the model is asked as generate asks it: with the
        // template that skips thinking, so its answer is the next token
        ...(this.spec.noThinking ? { extra_body: { enable_thinking: false } } : {}),
      });
      if (options.signal?.aborted) return null;
      const first = reply.firstToken;
      if (!first) return null;
      return choiceProbabilities(labels, [...first.top_logprobs, { token: first.token, logprob: first.logprob }]);
    } catch (err) {
      console.warn('Scoring the choices failed', err);
      return null;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  cancel(): void {
    this.engine?.interrupt();
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
