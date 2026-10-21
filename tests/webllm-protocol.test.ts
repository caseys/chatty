// WebLLM runs in its worker alone: the page sends it typed messages (workers/webllm-protocol.ts)
// and the provider builds on them. These run the real host and client against a fake engine.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebLlmClient } from '../src/runtimes/webllm-client.ts';
import { dropBrokenPieces, IOS_LOAD_PACE_MS, WebLlmProvider } from '../src/runtimes/webllm-provider.ts';
import { ENGLISH_GRAMMAR } from '../src/runtimes/fix-grammar.ts';
import type { WebLlmChatRequest } from '../src/workers/webllm-protocol.ts';
import { fakeWebLlmWorker } from './helpers/fake-webllm-worker.ts';

const request: WebLlmChatRequest = { messages: [{ role: 'user', content: 'Hi' }], temperature: 0.7, top_p: 0.8, max_tokens: 50 };
const spec = { mlcId: 'Some-Model-MLC', sizeBytes: 1000, contextLimit: 4096, maxOutputTokens: 512 };
const generation = { turnId: 't', systemPrompt: 'Be brief.', messages: [{ role: 'user' as const, content: 'Draw a dog' }] };

describe('WebLLM worker protocol', () => {
  it('loads a model with our context size and no sliding window, passing on its reports', async () => {
    const fake = fakeWebLlmWorker();
    fake.engine.reload.mockImplementation(async () => {
      fake.engine.report('Fetching param cache[1/4]: 10MB fetched', 0.25);
      fake.engine.report('Loading GPU shader modules[2/80]: 3% completed', 0.5);
    });
    const client = new WebLlmClient(fake.worker);
    const reports: Array<[string, number]> = [];
    await client.load('Some-Model-MLC', 2048, (text, progress) => reports.push([text, progress]));
    expect(fake.engine.reload).toHaveBeenCalledWith('Some-Model-MLC', { context_window_size: 2048, sliding_window_size: -1 });
    expect(reports).toEqual([
      ['Fetching param cache[1/4]: 10MB fetched', 0.25],
      ['Loading GPU shader modules[2/80]: 3% completed', 0.5],
    ]);
  });

  it('streams the pieces of a reply as they come, skipping empty ones', async () => {
    const fake = fakeWebLlmWorker({ replies: [['Hel', '', 'lo', ' there']] });
    const client = new WebLlmClient(fake.worker);
    const got: string[] = [];
    for await (const piece of client.stream(request)) got.push(piece);
    expect(got).toEqual(['Hel', 'lo', ' there']);
    expect(fake.created[0]).toMatchObject({ ...request, stream: true });
  });

  it('gives the text that came before a stream failed, then the failure as WebLLM wrote it', async () => {
    const fake = fakeWebLlmWorker({ replies: [['one', 'two', new Error('Grammar matcher rejected the newly sampled token')]] });
    const client = new WebLlmClient(fake.worker);
    const got: string[] = [];
    let failure: unknown;
    try {
      for await (const piece of client.stream(request)) got.push(piece);
    } catch (err) {
      failure = err;
    }
    expect(got).toEqual(['one', 'two']);
    expect((failure as Error).message).toBe('Error: Grammar matcher rejected the newly sampled token');
  });

  it('fails a stream that cannot start (no text at all) the same way', async () => {
    const fake = fakeWebLlmWorker({
      replies: [
        () => {
          throw new Error('Cannot compile the grammar');
        },
      ],
    });
    const client = new WebLlmClient(fake.worker);
    await expect((async () => { for await (const _ of client.stream(request)) void _; })()).rejects.toThrow('Cannot compile the grammar');
  });

  it('answers a request that is not streamed with its text and its first token, logprobs kept', async () => {
    const reply = {
      choices: [
        {
          message: { content: 'B' },
          logprobs: { content: [{ token: 'B', logprob: -0.5, bytes: [66], top_logprobs: [{ token: 'B', logprob: -0.5, bytes: [66] }, { token: 'A', logprob: -1.2, bytes: [65] }] }] },
        },
      ],
    };
    const fake = fakeWebLlmWorker({ replies: [() => reply] });
    const client = new WebLlmClient(fake.worker);
    const done = await client.complete({ ...request, logprobs: true, top_logprobs: 5 });
    expect(done).toEqual({
      text: 'B',
      firstToken: { token: 'B', logprob: -0.5, top_logprobs: [{ token: 'B', logprob: -0.5 }, { token: 'A', logprob: -1.2 }] },
    });
    expect(fake.created[0]).toMatchObject({ stream: false, logprobs: true, top_logprobs: 5 });
    // No logprobs in the reply: no first token
    const plain = fakeWebLlmWorker({ replies: [() => ({ choices: [{ message: { content: 'hi' } }] })] });
    expect(await new WebLlmClient(plain.worker).complete(request)).toEqual({ text: 'hi', firstToken: null });
  });

  it('interrupts, unloads, names a model\'s files and deletes its cache', async () => {
    const fake = fakeWebLlmWorker({ models: { 'Some-Model-MLC': 'https://huggingface.co/mlc-ai/Some-Model-MLC' } });
    const client = new WebLlmClient(fake.worker);
    expect(await client.modelUrl('Some-Model-MLC')).toBe('https://huggingface.co/mlc-ai/Some-Model-MLC');
    expect(await client.modelUrl('Unknown-MLC')).toBeUndefined();
    client.interrupt();
    await client.unload();
    await client.deleteCache('Some-Model-MLC');
    expect(fake.engine.interruptGenerate).toHaveBeenCalledTimes(1);
    expect(fake.engine.unload).toHaveBeenCalledTimes(1);
    expect(fake.deleteCache).toHaveBeenCalledWith('Some-Model-MLC');
  });

  it('rejects a failed request with the error as WebLLM writes it, and keeps other requests apart', async () => {
    const fake = fakeWebLlmWorker();
    fake.engine.unload.mockRejectedValue(new Error('device lost'));
    const client = new WebLlmClient(fake.worker);
    const [failed, url] = await Promise.allSettled([client.unload(), client.modelUrl('x')]);
    expect(failed).toMatchObject({ status: 'rejected', reason: { message: 'Error: device lost' } });
    expect(url).toMatchObject({ status: 'fulfilled', value: undefined });
  });

  it('ends the worker on terminate and ignores whatever it said after', async () => {
    const fake = fakeWebLlmWorker();
    const client = new WebLlmClient(fake.worker);
    const unloaded = vi.fn();
    void client.unload().then(unloaded);
    client.terminate();
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.terminated).toBe(true);
    expect(unloaded).not.toHaveBeenCalled();
  });
});

describe('WebLlmProvider through the protocol', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads, with the pace sent first, the bar moving forward and the stage shown', async () => {
    const fake = fakeWebLlmWorker();
    fake.engine.reload.mockImplementation(async () => {
      fake.engine.report('Fetching param cache[1/4]: 10MB fetched', 0.5);
      fake.engine.report('Loading model from cache[1/4]: 10MB loaded', 0.5);
      fake.engine.report('Loading GPU shader modules[2/80]: 3% completed', 1);
      fake.engine.report('Finish loading on WebGPU', 1);
    });
    const provider = new WebLlmProvider('m', spec, () => fake.worker);
    const bar: number[] = [];
    await provider.initialize((loaded, total) => bar.push(loaded / total));
    expect(provider.isLoaded).toBe(true);
    expect(fake.sent[0]).toEqual({ kind: 'chatty-pace', ms: 0 });
    expect(fake.sent.find((m) => m.kind === 'load')).toMatchObject({ model: 'Some-Model-MLC', contextWindow: provider.contextLimit });
    expect(bar[0]).toBe(0);
    expect(bar.at(-1)).toBe(1);
    expect(bar).toEqual([...bar].sort((a, b) => a - b));
    expect(bar).toContain(0.3);
    expect(provider.loadStage).toBe('Finish loading on WebGPU');
  });

  it('paces the load on iPhone', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
    const fake = fakeWebLlmWorker();
    const provider = new WebLlmProvider('m', spec, () => fake.worker);
    await provider.initialize();
    expect(fake.sent[0]).toEqual({ kind: 'chatty-pace', ms: IOS_LOAD_PACE_MS });
  });

  it('streams a reply under the English grammar, without thinking for a Qwen3 model', async () => {
    const fake = fakeWebLlmWorker({ replies: [['out.send(', '1);']] });
    const provider = new WebLlmProvider('m', { ...spec, mlcId: 'Qwen3-0.6B-q4f16_1-MLC', noThinking: true }, () => fake.worker);
    const tokens: string[] = [];
    const result = await provider.generate({ ...generation, onToken: (text) => tokens.push(text) });
    expect(result).toMatchObject({ text: 'out.send(1);', aborted: false, tokensGenerated: 2 });
    expect(tokens).toEqual(['out.send(', '1);']);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({
      stream: true,
      response_format: { type: 'grammar', grammar: ENGLISH_GRAMMAR },
      extra_body: { enable_thinking: false },
      max_tokens: provider.maxOutputTokens,
    });
    expect((fake.created[0].messages as Array<{ role: string }>).map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('retries a grammar that fails before any text cooler, then without it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = () => {
      throw new Error('Grammar matcher rejected the newly sampled token');
    };
    const fake = fakeWebLlmWorker({ replies: [failing, failing, ['done']] });
    const provider = new WebLlmProvider('m', spec, () => fake.worker);
    const result = await provider.generate({ ...generation, temperature: 0.9 });
    expect(result.text).toBe('done');
    expect(fake.created).toHaveLength(3);
    expect(fake.created[0]).toMatchObject({ temperature: 0.9, response_format: { type: 'grammar' } });
    expect(fake.created[1]).toMatchObject({ temperature: 0.5, response_format: { type: 'grammar' } });
    expect(fake.created[2].response_format).toBeUndefined();
    expect(fake.created[2].temperature).toBe(0.9);
  });

  it('does not retry once text went out', async () => {
    const fake = fakeWebLlmWorker({ replies: [['partial', new Error('boom')]] });
    const provider = new WebLlmProvider('m', spec, () => fake.worker);
    await expect(provider.generate(generation)).rejects.toThrow('boom');
    expect(fake.created).toHaveLength(1);
  });

  it('interrupts the engine when the signal aborts, and answers nothing when already aborted', async () => {
    const fake = fakeWebLlmWorker({ replies: [['a', 'b']] });
    const provider = new WebLlmProvider('m', spec, () => fake.worker);
    const controller = new AbortController();
    const result = await provider.generate({ ...generation, signal: controller.signal, onToken: () => controller.abort() });
    expect(fake.engine.interruptGenerate).toHaveBeenCalled();
    expect(result.aborted).toBe(true);
    fake.created.length = 0;
    expect(await provider.generate({ ...generation, signal: controller.signal })).toMatchObject({ text: '', aborted: true });
    expect(fake.created).toHaveLength(0);
    provider.cancel();
    expect(fake.sent.filter((m) => m.kind === 'interrupt').length).toBeGreaterThanOrEqual(2);
  });

  it('runs one generation after another', async () => {
    const fake = fakeWebLlmWorker({ replies: [['first'], ['second']] });
    const provider = new WebLlmProvider('m', spec, () => fake.worker);
    const [a, b] = await Promise.all([provider.generate(generation), provider.generate(generation)]);
    expect([a.text, b.text]).toEqual(['first', 'second']);
  });

  it('repairs a broken stored copy: a new worker, the model\'s cache deleted, one more try', async () => {
    const workers = [fakeWebLlmWorker(), fakeWebLlmWorker()];
    workers[0].engine.reload.mockRejectedValue(new Error('Tensor-cache record range [0, 393216) exceeds shard size 0'));
    let opened = 0;
    const provider = new WebLlmProvider('m', spec, () => workers[opened++].worker);
    const stages: string[] = [];
    const bar: number[] = [];
    const loading = provider.initialize((loaded) => {
      bar.push(loaded);
      stages.push(provider.loadStage);
    });
    await loading;
    expect(opened).toBe(2);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].terminated).toBe(false);
    expect(workers[1].deleteCache).toHaveBeenCalledWith('Some-Model-MLC');
    expect(stages).toContain('Repairing the download');
    expect(provider.isLoaded).toBe(true);
  });

  it('ends its worker and passes on any other load error', async () => {
    const fake = fakeWebLlmWorker();
    fake.engine.reload.mockRejectedValue(new Error('Failed to get GPU adapter'));
    const provider = new WebLlmProvider('m', spec, () => fake.worker);
    await expect(provider.initialize()).rejects.toThrow('Failed to get GPU adapter');
    expect(fake.terminated).toBe(true);
    expect(fake.deleteCache).not.toHaveBeenCalled();
    expect(provider.isLoaded).toBe(false);
  });

  it('unloads the model and ends the worker on dispose', async () => {
    const fake = fakeWebLlmWorker();
    const provider = new WebLlmProvider('m', spec, () => fake.worker);
    await provider.initialize();
    await provider.dispose();
    expect(fake.engine.unload).toHaveBeenCalledTimes(1);
    expect(fake.terminated).toBe(true);
    expect(provider.isLoaded).toBe(false);
  });
});

describe('the page and WebLLM\'s library', () => {
  it('only the worker imports @mlc-ai/web-llm at run time (a type import costs nothing)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(join(import.meta.dirname, '../src'));
    const runtimeImports = files.filter((file) => {
      const code = readFileSync(file, 'utf8');
      return /^\s*(?:import|export)\b(?!\s+type\b)[^;]*?from\s+['"]@mlc-ai\/web-llm['"]|import\(\s*['"]@mlc-ai\/web-llm['"]\s*\)/m.test(code);
    });
    expect(runtimeImports.map((file) => file.replace(/^.*\/src\//, 'src/'))).toEqual(['src/workers/webllm.worker.ts']);
  });
});

describe('dropBrokenPieces reads the stored size from the header first', () => {
  const base = 'https://huggingface.co/mlc-ai/Some-Model-MLC/resolve/main/';
  const records = { records: [{ dataPath: 'params_shard_0.bin', nbytes: 8 }, { dataPath: 'params_shard_1.bin', nbytes: 4 }] };
  function cacheOf(pieces: Record<string, { length?: string; bytes: number }>) {
    const blobs = vi.fn();
    const store = new Map<string, { headers: Headers; blob: () => Promise<Blob>; json?: () => Promise<unknown> }>();
    store.set(`${base}tensor-cache.json`, { headers: new Headers(), blob: async () => new Blob([]), json: async () => records });
    for (const [name, { length, bytes }] of Object.entries(pieces)) {
      store.set(base + name, {
        headers: new Headers(length === undefined ? {} : { 'content-length': length }),
        blob: async () => {
          blobs(name);
          return new Blob([new Uint8Array(bytes)]);
        },
      });
    }
    const cache = { match: async (url: string) => store.get(url), delete: async (url: string) => store.delete(url) } as unknown as Cache;
    return { cache, blobs, store };
  }

  it('does not read a piece whose header gives its size', async () => {
    const { cache, blobs, store } = cacheOf({ 'params_shard_0.bin': { length: '8', bytes: 8 }, 'params_shard_1.bin': { length: '3', bytes: 3 } });
    expect(await dropBrokenPieces(cache, base)).toBe(1);
    expect(blobs).not.toHaveBeenCalled();
    expect([...store.keys()].map((k) => k.split('/').pop())).toEqual(['tensor-cache.json', 'params_shard_0.bin']);
  });

  it('reads the piece when there is no header, or it says 0', async () => {
    const { cache, blobs, store } = cacheOf({ 'params_shard_0.bin': { bytes: 8 }, 'params_shard_1.bin': { length: '0', bytes: 0 } });
    expect(await dropBrokenPieces(cache, base)).toBe(1);
    expect(blobs.mock.calls.map((c) => c[0])).toEqual(['params_shard_0.bin', 'params_shard_1.bin']);
    expect([...store.keys()].map((k) => k.split('/').pop())).toEqual(['tensor-cache.json', 'params_shard_0.bin']);
  });
});
