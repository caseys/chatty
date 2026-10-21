// A stand-in for the WebLLM worker: the real host (workers/webllm-host.ts) running on a fake
// engine, with messages passed the way a worker passes them (copied, and arriving a moment later).
import { vi } from 'vitest';
import type { WebLlmWorker } from '../../src/runtimes/webllm-client.ts';
import { createWebLlmHost, type WebLlmEngine } from '../../src/workers/webllm-host.ts';
import type { WebLlmEvent, WebLlmRequest } from '../../src/workers/webllm-protocol.ts';

export type FakeChunks = Array<string | Error>;

export interface FakeWebLlm {
  /** Every request the page sent, in order */
  sent: WebLlmRequest[];
  /** Every request that reached engine.chat.completions.create */
  created: Array<Record<string, unknown>>;
  engine: {
    reload: ReturnType<typeof vi.fn>;
    unload: ReturnType<typeof vi.fn>;
    interruptGenerate: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    /** Sends a load report, as WebLLM does while reloading */
    report(text: string, progress: number): void;
  };
  deleteCache: ReturnType<typeof vi.fn>;
  terminated: boolean;
  worker: WebLlmWorker;
}

/**
 * models maps an mlc id to its files URL. replies are what successive streamed requests write
 * (text pieces; an Error in the list is thrown there); a function answers a request itself.
 */
export function fakeWebLlmWorker(
  options: { models?: Record<string, string>; replies?: Array<FakeChunks | ((request: Record<string, unknown>) => unknown)> } = {}
): FakeWebLlm {
  const replies = [...(options.replies ?? [])];
  let progress: ((report: { text: string; progress: number }) => void) | null = null;
  const created: Array<Record<string, unknown>> = [];
  const create = vi.fn(async (request: Record<string, unknown>) => {
    created.push(request);
    const next = replies.shift() ?? [];
    if (typeof next === 'function') return next(request);
    return (async function* () {
      for (const piece of next) {
        if (piece instanceof Error) throw piece;
        yield { choices: [{ delta: { content: piece } }] };
      }
    })();
  });
  const engine = {
    reload: vi.fn(async (_model: string, _options: unknown) => {}),
    unload: vi.fn(async () => {}),
    interruptGenerate: vi.fn(async () => {}),
    create,
    report: (text: string, fraction: number) => progress?.({ text, progress: fraction }),
  };
  const deleteCache = vi.fn(async (_model: string) => {});
  const fake: FakeWebLlm = { sent: [], created, engine, deleteCache, terminated: false, worker: null as unknown as WebLlmWorker };

  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage(message: WebLlmRequest) {
      if (fake.terminated) return;
      const copy = structuredClone(message);
      fake.sent.push(copy);
      if (copy.kind !== 'chatty-pace') queueMicrotask(() => host(copy));
    },
    terminate() {
      fake.terminated = true;
    },
  };
  const host = createWebLlmHost(
    {
      engine: {
        setInitProgressCallback: (callback: (report: { text: string; progress: number }) => void) => {
          progress = callback;
        },
        reload: engine.reload,
        unload: engine.unload,
        interruptGenerate: engine.interruptGenerate,
        chat: { completions: { create: engine.create } },
      } as unknown as WebLlmEngine,
      modelUrl: (model) => options.models?.[model],
      deleteCache,
    },
    (event: WebLlmEvent) =>
      queueMicrotask(() => {
        if (!fake.terminated) worker.onmessage?.({ data: structuredClone(event) } as MessageEvent);
      })
  );
  fake.worker = worker;
  return fake;
}
