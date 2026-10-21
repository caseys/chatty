import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { LiteRtLlmProvider } from '../src/runtimes/llm-provider.ts';
import { webLlmSampling } from '../src/runtimes/webllm-provider.ts';

function providerWithSamplers() {
  const provider = new LiteRtLlmProvider('gemma-4-e2b-it-web');
  const samplers: Array<{ temperature: number; p: number; k: number }> = [];
  (provider as unknown as { engine: unknown }).engine = {
    async createConversation(config: { sessionConfig: { samplerParams: (typeof samplers)[number] } }) {
      samplers.push(config.sessionConfig.samplerParams);
      return {
        isBusy: false,
        sendMessageStreaming: () =>
          new ReadableStream({
            start(c) {
              c.enqueue({ content: [{ type: 'text', text: 'speak("Hi.");' }] });
              c.close();
            },
          }),
        cancel() {},
        async delete() {},
      };
    },
  };
  let n = 0;
  // A follow-up repeats the last call and its reply before the new message
  const generate = (extra: Record<string, unknown>, system = 'SYSTEM', followUp = false) =>
    provider.generate({
      turnId: `t${++n}`,
      systemPrompt: system,
      messages: followUp
        ? [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'speak("Hi.");' }, { role: 'user', content: 'again' }]
        : [{ role: 'user', content: 'hi' }],
      ...extra,
    } as never);
  return { generate, samplers };
}

describe('LiteRT sampling', () => {
  it('honours the requested temperature and top-p, keeping top-k 64', async () => {
    const { generate, samplers } = providerWithSamplers();
    await generate({ temperature: 0.1, topP: 0.8 });
    expect(samplers[0]).toMatchObject({ temperature: 0.1, p: 0.8, k: 64 });
  });
  it('falls back to Gemma defaults when none is requested, and a retry cools the requested base', async () => {
    const { generate, samplers } = providerWithSamplers();
    await generate({});
    await generate({ temperature: 0.6, retry: 1 }, 'OTHER');
    expect(samplers[0]).toMatchObject({ temperature: 1.0, p: 0.95 });
    expect(samplers[1].temperature).toBeCloseTo(0.3);
  });
  it('starts a new conversation when the temperature differs, and reuses one when it matches', async () => {
    const { generate, samplers } = providerWithSamplers();
    await generate({ temperature: 0.1 });
    await generate({ temperature: 0.1 }, 'SYSTEM', true);
    expect(samplers.length).toBe(1);
    await generate({ temperature: 0.5 }, 'SYSTEM', true);
    expect(samplers.length).toBe(2);
  });
});

describe('WebLLM Qwen3 penalties', () => {
  it('code turns carry no presence or repetition penalty', () => {
    const s = webLlmSampling({ temperature: 0.1 }, { mlcId: 'Qwen3-4B-q4f16_1-MLC', noThinking: true });
    expect(s.presence_penalty).toBe(0);
    expect(s.repetition_penalty).toBeUndefined();
  });
  it('a fix turn\'s sampling swing is used as given', () => {
    const s = webLlmSampling({ sampling: { temperature: 0.7, topP: 0.9 } }, { mlcId: 'Qwen3-4B-q4f16_1-MLC' });
    expect(s).toEqual({ temperature: 0.7, top_p: 0.9 });
  });
});

describe('WebLLM temperature limit', async () => {
  const { webLlmSampling, WEBLLM_MAX_TEMPERATURE } = await import('../src/runtimes/webllm-provider.ts');
  it('never goes above the temperature its grammars hold at', () => {
    const spec = { mlcId: 'Qwen3-0.6B-q4f16_1-MLC', noThinking: true };
    expect(webLlmSampling({ sampling: { temperature: 1.3, topP: 0.95 } }, spec).temperature).toBe(WEBLLM_MAX_TEMPERATURE);
    expect(webLlmSampling({ temperature: 0.9, retry: 3 }, spec).temperature).toBeLessThanOrEqual(WEBLLM_MAX_TEMPERATURE);
  });
});

describe('one bar for a WebLLM load', async () => {
  const { loadFraction } = await import('../src/runtimes/webllm-provider.ts');
  it('moves forward through the download, the weights and the shaders, and leaves the end for when it is ready', () => {
    // Downloaded first: the weights start where the download ended
    expect(loadFraction('Fetching param cache[5/10]: …', 0.5, true)).toBeCloseTo(0.3);
    expect(loadFraction('Loading model from cache[1/10]: …', 0, true)).toBeCloseTo(0.6);
    expect(loadFraction('Loading model from cache[10/10]: …', 1, true)).toBeCloseTo(0.85);
    // Already in the cache: the weights take the bar from 0
    expect(loadFraction('Loading model from cache[5/10]: …', 0.5, false)).toBeCloseTo(0.425);
    // The shaders count from 0 again in WebLLM, but not on the bar
    expect(loadFraction('Loading GPU shader modules[1/80]: …', 0.0125, false)!).toBeGreaterThan(0.85);
    expect(loadFraction('Loading GPU shader modules[80/80]: …', 1, false)).toBeCloseTo(0.98);
    expect(loadFraction('Finish loading on Apple GPU', 1, false)).toBeLessThan(1);
    expect(loadFraction('Start to fetch params', 0, false)).toBeNull();
  });
});
