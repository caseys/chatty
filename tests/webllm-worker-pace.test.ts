// The WebLLM worker's pacing for iPhone Safari: weight pieces wait before they're read, and the
// shaders are built one at a time; with no pace set (every other browser) nothing waits
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The worker builds its engine from WebLLM's library; here it's a stand-in that loads nothing
vi.mock('@mlc-ai/web-llm', () => ({
  MLCEngine: class {
    setInitProgressCallback = vi.fn();
    reload = vi.fn(async () => {});
    unload = vi.fn(async () => {});
    interruptGenerate = vi.fn(async () => {});
    chat = { completions: { create: vi.fn() } };
  },
  prebuiltAppConfig: { model_list: [{ model_id: 'Some-Model-MLC', model: 'https://huggingface.co/mlc-ai/Some-Model-MLC' }] },
  deleteModelAllInfoInCache: vi.fn(async () => {}),
}));

const building: number[] = [];
let active = 0;
class FakeDevice {
  async createComputePipelineAsync(descriptor: unknown) {
    active++;
    building.push(active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return descriptor;
  }
}

let onmessage: (event: MessageEvent) => void;

beforeAll(async () => {
  (globalThis as unknown as { GPUDevice: unknown }).GPUDevice = FakeDevice;
  const scope = globalThis as unknown as { self: { onmessage?: (e: MessageEvent) => void } };
  scope.self = scope.self ?? ({} as { onmessage?: (e: MessageEvent) => void });
  await import('../src/workers/webllm.worker.ts');
  onmessage = scope.self.onmessage!;
});

afterEach(() => {
  onmessage({ data: { kind: 'chatty-pace', ms: 0 } } as MessageEvent);
  building.length = 0;
});

const shard = (url: string) => {
  const r = new Response(new Uint8Array([1, 2, 3]));
  Object.defineProperty(r, 'url', { value: url });
  return r;
};

describe('WebLLM worker pacing', () => {
  it('waits before each weight piece only when paced', async () => {
    let t = performance.now();
    await shard('https://hf.co/m/resolve/main/params_shard_3.bin').arrayBuffer();
    expect(performance.now() - t).toBeLessThan(30);
    onmessage({ data: { kind: 'chatty-pace', ms: 60 } } as MessageEvent);
    t = performance.now();
    await shard('https://hf.co/m/resolve/main/params_shard_4.bin').arrayBuffer();
    expect(performance.now() - t).toBeGreaterThanOrEqual(55);
    // Other files (the tokenizer, the model's code) never wait
    t = performance.now();
    await shard('https://hf.co/m/resolve/main/tokenizer.json').arrayBuffer();
    expect(performance.now() - t).toBeLessThan(30);
  });

  it('builds shaders one at a time when paced, all at once otherwise', async () => {
    const device = new FakeDevice();
    await Promise.all([1, 2, 3, 4].map((n) => device.createComputePipelineAsync(n)));
    expect(Math.max(...building)).toBe(4);
    building.length = 0;
    onmessage({ data: { kind: 'chatty-pace', ms: 8 } } as MessageEvent);
    const built = await Promise.all([1, 2, 3, 4].map((n) => device.createComputePipelineAsync(n)));
    expect(built).toEqual([1, 2, 3, 4]);
    expect(Math.max(...building)).toBe(1);
  });

  it('hands every other message to the engine host, and answers through postMessage', async () => {
    const posted: unknown[] = [];
    const scope = globalThis as unknown as { self: { postMessage: (message: unknown) => void } };
    scope.self.postMessage = (message) => void posted.push(message);
    onmessage({ data: { kind: 'model-url', id: 7, model: 'Some-Model-MLC' } } as MessageEvent);
    onmessage({ data: { kind: 'model-url', id: 8, model: 'Not-A-Model' } } as MessageEvent);
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual([
      { kind: 'done', id: 7, value: 'https://huggingface.co/mlc-ai/Some-Model-MLC' },
      { kind: 'done', id: 8, value: undefined },
    ]);
    // A message of no known kind is ignored
    expect(() => onmessage({ data: { kind: 'nonsense' } } as MessageEvent)).not.toThrow();
  });
});
