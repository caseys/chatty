// ============================================================================
// The page's end of the WebLLM worker (workers/webllm.worker.ts): sends the requests in
// workers/webllm-protocol.ts and turns what comes back into promises and a stream of text. It
// imports nothing from WebLLM, so the library stays in the worker.
// ============================================================================

import type { WebLlmChatRequest, WebLlmCompletion, WebLlmEvent, WebLlmRequest } from '../workers/webllm-protocol.ts';

/** What the client needs of a Worker (a fake one in tests) */
export interface WebLlmWorker {
  postMessage(message: WebLlmRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

/** One request waiting for its worker's answer */
interface Pending {
  onProgress?: (text: string, progress: number) => void;
  onDelta?: (content: string) => void;
  done(value?: WebLlmCompletion | string): void;
  failed(error: Error): void;
}

export class WebLlmClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly worker: WebLlmWorker) {
    worker.onmessage = (event) => this.receive(event.data as WebLlmEvent | null);
  }

  /** Pause before each weight piece and between shader builds (iPhone Safari); send before loading */
  pace(ms: number): void {
    this.worker.postMessage({ kind: 'chatty-pace', ms });
  }

  /** Loads the model into the worker; onProgress gets each report WebLLM makes (what it's doing, and 0..1 of that step) */
  async load(model: string, contextWindow: number, onProgress?: (text: string, progress: number) => void): Promise<void> {
    await this.ask((id) => ({ kind: 'load', id, model, contextWindow }), { onProgress });
  }

  /** A reply as it is written: the pieces of text (the request is sent now, not when reading starts) */
  stream(request: WebLlmChatRequest): AsyncGenerator<string, void> {
    const pieces: string[] = [];
    const state: { end: { error?: Error } | null } = { end: null };
    let wake: (() => void) | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };
    const id = this.nextId++;
    this.pending.set(id, {
      onDelta: (content) => {
        pieces.push(content);
        notify();
      },
      done: () => {
        state.end = {};
        notify();
      },
      failed: (error) => {
        state.end = { error };
        notify();
      },
    });
    this.worker.postMessage({ kind: 'chat', id, request });
    // (a reader that stops early ends the stream: what comes after is dropped)
    const forget = () => void this.pending.delete(id);
    return (async function* () {
      try {
        while (true) {
          // (text that arrived before an error is read first)
          if (pieces.length) yield pieces.shift()!;
          else if (state.end) {
            if (state.end.error) throw state.end.error;
            return;
          } else await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        forget();
      }
    })();
  }

  /** A reply that isn't streamed: its text, and the report on its first token when the request asked for logprobs */
  async complete(request: WebLlmChatRequest): Promise<WebLlmCompletion> {
    return (await this.ask((id) => ({ kind: 'complete', id, request }), {})) as WebLlmCompletion;
  }

  /** The first, tiny run after a load, done in the worker; never fails (the worker logs a failure) */
  async warmUp(request: WebLlmChatRequest): Promise<void> {
    await this.ask((id) => ({ kind: 'warm-up', id, request }), {});
  }

  /** Stops the reply being generated */
  interrupt(): void {
    this.worker.postMessage({ kind: 'interrupt' });
  }

  /** Frees the model's GPU memory */
  async unload(): Promise<void> {
    await this.ask((id) => ({ kind: 'unload', id }), {});
  }

  /** Where the files of an mlc model id are (undefined for an id WebLLM doesn't list) */
  async modelUrl(model: string): Promise<string | undefined> {
    return (await this.ask((id) => ({ kind: 'model-url', id, model }), {})) as string | undefined;
  }

  /** Deletes a model's stored files, config and library */
  async deleteCache(model: string): Promise<void> {
    await this.ask((id) => ({ kind: 'delete-cache', id, model }), {});
  }

  /**
   * Ends the worker. Requests still waiting for it stay unanswered, as they did with WebLLM's own
   * client: whoever ended it has moved on.
   */
  terminate(): void {
    this.worker.onmessage = null;
    this.pending.clear();
    this.worker.terminate();
  }

  private ask(make: (id: number) => WebLlmRequest, handlers: Pick<Pending, 'onProgress'>): Promise<WebLlmCompletion | string | undefined> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { ...handlers, done: resolve, failed: reject });
      this.worker.postMessage(make(id));
    });
  }

  private receive(event: WebLlmEvent | null): void {
    const call = event && this.pending.get(event.id);
    if (!event || !call) return;
    switch (event.kind) {
      case 'progress':
        call.onProgress?.(event.text, event.progress);
        return;
      case 'delta':
        call.onDelta?.(event.content);
        return;
      case 'done':
        this.pending.delete(event.id);
        call.done(event.value);
        return;
      case 'failed':
        this.pending.delete(event.id);
        call.failed(new Error(event.message));
        return;
    }
  }
}
