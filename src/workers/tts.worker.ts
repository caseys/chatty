// ============================================================================
// Dedicated TTS Synthesis Web Worker
// Runs Piper ONNX Runtime Web off the main thread and transfers PCM ArrayBuffers
// back to the main thread with zero copy.
// ============================================================================

import type { WorkerRequestMessage, WorkerResponseMessage } from '../types/index.ts';
import { PiperTtsProvider } from '../runtimes/tts-provider.ts';

let ttsProvider = new PiperTtsProvider('en_US-hfc_female-medium');
const activeControllers = new Map<string, AbortController>();

self.onmessage = async (event: MessageEvent<WorkerRequestMessage<any>>) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  const { requestId, turnId, sequence, type, payload } = msg;

  const reply = (resType: string, resPayload: unknown, transfer?: Transferable[], error?: string) => {
    const response: WorkerResponseMessage = {
      requestId,
      turnId,
      sequence,
      type: resType,
      payload: resPayload,
      error,
      timestamp: performance.now(),
    };
    if (transfer && transfer.length > 0) {
      (self as unknown as Worker).postMessage(response, transfer);
    } else {
      self.postMessage(response);
    }
  };

  try {
    switch (type) {
      case 'init': {
        const voiceId = payload?.voiceId ?? 'en_US-hfc_female-medium';
        if (ttsProvider.voiceId !== voiceId) {
          await ttsProvider.dispose();
          ttsProvider = new PiperTtsProvider(voiceId);
        }
        await ttsProvider.initialize((loaded, total) => {
          reply('progress', { loaded, total, voiceId });
        });
        reply('initialized', { voiceId });
        break;
      }

      case 'synthesize': {
        const controller = new AbortController();
        activeControllers.set(turnId, controller);
        try {
          const result = await ttsProvider.synthesize(
            payload.text,
            turnId,
            sequence,
            controller.signal
          );
          // Transfer the underlying ArrayBuffer to avoid copying PCM audio
          reply('audio_chunk', result, [result.samples.buffer]);
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
        ttsProvider.cancel(targetTurnId);
        reply('canceled', { turnId: targetTurnId });
        break;
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    reply('error', null, undefined, errorMsg);
  }
};
