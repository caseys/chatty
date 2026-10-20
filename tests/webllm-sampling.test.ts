import { describe, expect, it } from 'vitest';
import { webLlmSampling } from '../src/runtimes/webllm-provider.ts';
import { LOCAL_CHAT_MODELS } from '../src/core/settings.ts';

const qwen3 = { mlcId: 'Qwen3-4B-q4f16_1-MLC', noThinking: true };
const coder = { mlcId: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC' };

describe('webLlmSampling', () => {
  it('exact: low temperature, no penalties', () => {
    for (const spec of [qwen3, coder]) {
      const s = webLlmSampling({ temperature: 0.1, exact: true }, spec);
      expect(s.temperature).toBe(0.2);
      expect(s.repetition_penalty).toBeUndefined();
      expect(s.presence_penalty).toBeUndefined();
    }
  });
  it('Qwen3 normal: presence penalty, no repetition penalty, temperature floor', () => {
    const s = webLlmSampling({ temperature: 0.1 }, qwen3);
    expect(s).toMatchObject({ temperature: 0.6, presence_penalty: 0.5 });
    expect(s.repetition_penalty).toBeUndefined();
  });
  it('Qwen2.5-Coder normal: repetition penalty 1.05', () => {
    const s = webLlmSampling({ temperature: 0.9 }, coder);
    expect(s).toMatchObject({ temperature: 0.9, repetition_penalty: 1.05 });
    expect(s.presence_penalty).toBeUndefined();
  });
});

describe('LFM2.5 230M', () => {
  it('is treated as a small model but stays off phones', () => {
    const m = LOCAL_CHAT_MODELS.find((x) => x.id === 'lfm2.5-230m')!;
    expect(m.contextLimit).toBe(4096);
    expect(m.maxOutputTokens).toBe(2048);
    expect(m.phone).toBe(false);
  });
});
