// ============================================================================
// ONNX causal-LM worker (Transformers.js on WebGPU)
// Runs one small model per worker (FunctionGemma router, Gemma 3 1B chat, Qwen coder).
// Terminating the worker frees the model's GPU/WASM memory, which is how models are
// swapped on memory-constrained phones.
// ============================================================================

import {
  AutoModelForCausalLM,
  AutoTokenizer,
  InterruptableStoppingCriteria,
  TextStreamer,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from '@huggingface/transformers';

env.allowLocalModels = false;

type GpuLike = { requestAdapter(options?: { powerPreference?: string }): Promise<unknown | null> };

/**
 * Asks for the GPU here, retrying with each power preference: Safari sometimes returns no
 * adapter for a moment (e.g. right after another model released the GPU). The adapter is
 * handed to ONNX Runtime, which would otherwise ask once and give up.
 */
async function acquireGpuAdapter(): Promise<unknown | null> {
  const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
  if (!gpu) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const powerPreference of [undefined, 'high-performance', 'low-power']) {
      const adapter = await gpu.requestAdapter(powerPreference ? { powerPreference } : undefined).catch(() => null);
      if (adapter) return adapter;
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return null;
}

type ChatMessage = { role: string; content: string };

type InboundMessage =
  | { id: string; type: 'init'; payload: { repo: string; dtype: string } }
  | {
      id: string;
      type: 'generate';
      payload: {
        messages: ChatMessage[];
        tools?: unknown[];
        maxNewTokens: number;
        temperature?: number;
        topP?: number;
        keepSpecialTokens?: boolean;
        templateOptions?: Record<string, unknown>;
      };
    }
  | { id: string; type: 'interrupt' }
  | { id: string; type: 'dispose' };

let tokenizer: PreTrainedTokenizer | null = null;
let model: PreTrainedModel | null = null;
const stopping = new InterruptableStoppingCriteria();

const post = (msg: Record<string, unknown>) => (self as unknown as Worker).postMessage(msg);

self.onmessage = async (ev: MessageEvent<InboundMessage>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init': {
        const { repo, dtype } = msg.payload;
        // Per-file download progress, summed into one figure for the UI
        const files = new Map<string, { loaded: number; total: number }>();
        const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
          if (p.status !== 'progress' || !p.file) return;
          files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
          let loaded = 0;
          let total = 0;
          for (const f of files.values()) {
            loaded += f.loaded;
            total += f.total;
          }
          post({ id: msg.id, type: 'progress', loaded, total });
        };
        const adapter = await acquireGpuAdapter();
        if (!adapter) {
          throw new Error(
            'The browser did not make the GPU available (no WebGPU adapter). Reload the page; if it keeps happening, quit and reopen the browser.'
          );
        }
        const onnxEnv = env.backends.onnx as { webgpu?: { adapter?: unknown } };
        onnxEnv.webgpu ??= {};
        onnxEnv.webgpu.adapter = adapter;
        tokenizer = await AutoTokenizer.from_pretrained(repo, { progress_callback });
        model = await AutoModelForCausalLM.from_pretrained(repo, {
          dtype: dtype as 'q4f16',
          device: 'webgpu',
          progress_callback,
        });
        post({ id: msg.id, type: 'initialized' });
        break;
      }

      case 'generate': {
        if (!tokenizer || !model) throw new Error('Model not initialized');
        const { messages, tools, maxNewTokens, temperature, topP, keepSpecialTokens, templateOptions } = msg.payload;
        const inputs = tokenizer.apply_chat_template(messages as never, {
          ...templateOptions,
          tools: tools as never,
          add_generation_prompt: true,
          return_dict: true,
        }) as { input_ids: { dims: number[] } } & Record<string, unknown>;

        stopping.reset();
        let sequence = 0;
        const start = performance.now();
        let firstTokenAt = 0;
        const streamer = new TextStreamer(tokenizer, {
          skip_prompt: true,
          skip_special_tokens: !keepSpecialTokens,
          callback_function: (text: string) => {
            if (!firstTokenAt) firstTokenAt = performance.now();
            post({ id: msg.id, type: 'token', text, sequence: sequence++ });
          },
        });

        const sample = (temperature ?? 0) > 0;
        const output = (await model.generate({
          ...inputs,
          max_new_tokens: maxNewTokens,
          do_sample: sample,
          ...(sample ? { temperature, top_p: topP ?? 0.95 } : {}),
          streamer,
          stopping_criteria: stopping,
        } as never)) as { slice: (...args: unknown[]) => unknown; dims: number[] };

        const promptLength = inputs.input_ids.dims[1];
        const generated = output.slice(null, [promptLength, null]);
        const [text] = tokenizer.batch_decode(generated as never, {
          skip_special_tokens: !keepSpecialTokens,
        });
        const totalMs = performance.now() - start;
        const tokens = output.dims[1] - promptLength;
        post({
          id: msg.id,
          type: 'result',
          text,
          tokens,
          timeToFirstTokenMs: firstTokenAt ? firstTokenAt - start : totalMs,
          totalTimeMs: totalMs,
        });
        break;
      }

      case 'interrupt':
        stopping.interrupt();
        break;

      case 'dispose':
        await model?.dispose();
        model = null;
        tokenizer = null;
        post({ id: msg.id, type: 'disposed' });
        break;
    }
  } catch (err) {
    post({ id: msg.id, type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
