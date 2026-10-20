// ============================================================================
// Dedicated LLM Inference Web Worker
// Runs LiteRT-LM WebGPU (Gemma 4 E2B / E4B) off the main thread
// ============================================================================

import type { WorkerRequestMessage, WorkerResponseMessage } from '../types/index.ts';
import { LiteRtLlmProvider } from '../runtimes/llm-provider.ts';
import type { LlmRuntimeProvider } from '../types/index.ts';

let activeProvider: LlmRuntimeProvider = new LiteRtLlmProvider('gemma-4-e2b-it-web');
const activeControllers = new Map<string, AbortController>();

self.onmessage = async (event: MessageEvent<WorkerRequestMessage<any>>) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  const { requestId, turnId, sequence, type, payload } = msg;

  const reply = (resType: string, resPayload: unknown, error?: string) => {
    const response: WorkerResponseMessage = {
      requestId,
      turnId,
      sequence,
      type: resType,
      payload: resPayload,
      error,
      timestamp: performance.now(),
    };
    self.postMessage(response);
  };

  try {
    switch (type) {
      case 'init': {
        const modelId: string = payload?.modelId ?? 'gemma-4-e2b-it-web';
        const wantedContext: number | undefined = payload?.contextLimit;
        const wantedOutput: number | undefined = payload?.maxOutputTokens;
        if (
          activeProvider.modelId !== modelId ||
          (wantedContext && activeProvider.contextLimit !== wantedContext)
        ) {
          await activeProvider.dispose();
          activeProvider = new LiteRtLlmProvider(modelId, {
            contextLimit: wantedContext,
            maxOutputTokens: wantedOutput,
          });
        }

        await activeProvider.initialize((loaded, total) => {
          reply('progress', { loaded, total, modelId });
        });

        reply('initialized', {
          modelId: activeProvider.modelId,
          contextLimit: activeProvider.contextLimit,
          maxOutputTokens: activeProvider.maxOutputTokens,
        });
        break;
      }

      case 'generate': {
        const controller = new AbortController();
        activeControllers.set(turnId, controller);

        try {
          const result = await activeProvider.generate({
            turnId,
            systemPrompt: payload.systemPrompt,
            messages: payload.messages,
            maxOutputTokens: payload.maxOutputTokens,
            temperature: payload.temperature,
            topP: payload.topP,
            exact: payload.exact,
            retry: payload.retry,
            sampling: payload.sampling,
            fixShape: payload.fixShape,
            choiceCount: payload.choiceCount,
            signal: controller.signal,
            onToken: (token, tokenSeq) => {
              reply('token', { token, tokenSeq });
            },
          });
          reply('completed', result);
        } finally {
          activeControllers.delete(turnId);
        }
        break;
      }

      case 'cancel': {
        const targetTurnId = payload?.turnId ?? turnId;
        const ctrl = activeControllers.get(targetTurnId);
        if (ctrl) {
          ctrl.abort();
          activeControllers.delete(targetTurnId);
        }
        activeProvider.cancel(targetTurnId);
        reply('canceled', { turnId: targetTurnId });
        break;
      }

      case 'reset': {
        await activeProvider.reset();
        reply('reset_ok', {});
        break;
      }

      case 'dispose': {
        await activeProvider.dispose();
        reply('disposed', {});
        break;
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    reply('error', null, errorMsg);
  }
};
