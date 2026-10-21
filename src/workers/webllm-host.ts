// ============================================================================
// The worker's side of the protocol in webllm-protocol.ts: runs each request on a WebLLM engine
// and reports back. It knows nothing of the library itself (the worker hands it an engine), so it
// can be tested with a fake one.
// ============================================================================

import type { WebLlmChatRequest, WebLlmCompletion, WebLlmEvent, WebLlmRequest } from './webllm-protocol.ts';

/** The parts of WebLLM's MLCEngine this host uses */
export interface WebLlmEngine {
  setInitProgressCallback(callback: (report: { text: string; progress: number }) => void): void;
  reload(model: string, options: { context_window_size: number; sliding_window_size: number }): Promise<void>;
  unload(): Promise<void>;
  interruptGenerate(): Promise<void> | void;
  chat: {
    completions: {
      create(request: WebLlmChatRequest & { stream: true }): Promise<AsyncIterable<{ choices: Array<{ delta?: { content?: string | null } }> }>>;
      create(request: WebLlmChatRequest & { stream: false }): Promise<{
        choices: Array<{
          message?: { content?: string | null };
          logprobs?: { content?: Array<{ token: string; logprob: number; top_logprobs?: Array<{ token: string; logprob: number }> }> } | null;
        }>;
      }>;
    };
  };
}

export interface WebLlmHostParts {
  engine: WebLlmEngine;
  /** Where WebLLM's list of prebuilt models keeps a model's files (undefined for an id not in it) */
  modelUrl(model: string): string | undefined;
  /** Deletes a model's stored files, config and library */
  deleteCache(model: string): Promise<void>;
}

/** Returns the function that handles each request the page sends; replies go through post */
export function createWebLlmHost(parts: WebLlmHostParts, post: (event: WebLlmEvent) => void): (request: WebLlmRequest) => void {
  const { engine } = parts;
  // One model loads at a time, so a report belongs to the load in progress
  let loading = 0;
  engine.setInitProgressCallback((report) => {
    if (loading) post({ kind: 'progress', id: loading, text: report.text ?? '', progress: report.progress });
  });

  /** Runs one request and reports how it ended; an error is sent as WebLLM's own toString, as its worker handler did */
  const settle = async (id: number, task: () => Promise<WebLlmCompletion | string | void | undefined>) => {
    try {
      post({ kind: 'done', id, value: (await task()) ?? undefined });
    } catch (err) {
      post({ kind: 'failed', id, message: String(err) });
    }
  };

  return (request) => {
    switch (request.kind) {
      case 'load':
        loading = request.id;
        void settle(request.id, async () => {
          // Our context size, never a sliding window: WebLLM accepts only one of the two, and some
          // models (Gemma 3) ship both
          await engine.reload(request.model, { context_window_size: request.contextWindow, sliding_window_size: -1 });
        });
        return;
      case 'chat':
        void settle(request.id, async () => {
          const stream = await engine.chat.completions.create({ ...request.request, stream: true });
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) post({ kind: 'delta', id: request.id, content });
          }
        });
        return;
      case 'complete':
        void settle(request.id, async (): Promise<WebLlmCompletion> => {
          const reply = await engine.chat.completions.create({ ...request.request, stream: false });
          const choice = reply.choices[0];
          const first = choice?.logprobs?.content?.[0];
          return {
            text: choice?.message?.content ?? '',
            firstToken: first
              ? {
                  token: first.token,
                  logprob: first.logprob,
                  top_logprobs: (first.top_logprobs ?? []).map(({ token, logprob }) => ({ token, logprob })),
                }
              : null,
          };
        });
        return;
      case 'interrupt':
        void Promise.resolve(engine.interruptGenerate()).catch(() => {});
        return;
      case 'unload':
        void settle(request.id, () => engine.unload());
        return;
      case 'model-url':
        void settle(request.id, async () => parts.modelUrl(request.model));
        return;
      case 'delete-cache':
        void settle(request.id, () => parts.deleteCache(request.model));
        return;
    }
  };
}
