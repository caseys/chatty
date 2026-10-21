// The WebLLM worker's pacing for iPhone Safari: weight pieces wait before they're read, and the
// shaders are built one at a time; with no pace set (every other browser) nothing waits
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@mlc-ai/web-llm', () => ({
  WebWorkerMLCEngineHandler: class {
    onmessage = vi.fn();
  },
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

  it('hands every other message to WebLLM', async () => {
    const { WebWorkerMLCEngineHandler } = await import('@mlc-ai/web-llm');
    expect(WebWorkerMLCEngineHandler).toBeDefined();
    expect(() => onmessage({ data: { kind: 'reload' } } as MessageEvent)).not.toThrow();
  });
});
