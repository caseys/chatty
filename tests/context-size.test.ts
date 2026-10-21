// A WebLLM model's context comes from what its working memory costs (its own config) and the
// device's budget, never above Chatty's limit for it and never below one turn's need
import { describe, expect, it } from 'vitest';
import { contextWindowFor, kvBytesPerToken, MIN_CONTEXT, modelMaxContext, workingMemoryBudget } from '../src/runtimes/context-size.ts';

// The sizes from the models' own mlc-chat-config.json files
const qwen3_06b = { quantization: 'q4f16_1', context_window_size: 40960, model_config: { num_hidden_layers: 28, num_attention_heads: 16, num_key_value_heads: 8, head_dim: 128, hidden_size: 1024 } };
const qwen25_05b = { quantization: 'q4f16_1', model_config: { num_hidden_layers: 24, num_attention_heads: 14, num_key_value_heads: 2, head_dim: 64, hidden_size: 896 } };
const qwen35_2b = { quantization: 'q4f16_1', model_config: { num_hidden_layers: 24, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 256, full_attention_interval: 4 } };
const gemma3_1b = { quantization: 'q4f16_1', model_config: { text_config: { num_hidden_layers: 26, num_attention_heads: 4, num_key_value_heads: 1, head_dim: 256 } } };
const KB = 1024;
const MB = 1024 * 1024;

describe('the cost of a token', () => {
  it('is a key and a value per attention layer and KV head, in the model\'s float type', () => {
    expect(kvBytesPerToken(qwen3_06b)).toBe(28 * 2 * 8 * 128 * 2);
    expect(kvBytesPerToken(qwen25_05b)).toBe(12 * KB);
    // Every layer counts as f32 in an f32 build
    expect(kvBytesPerToken({ ...qwen25_05b, quantization: 'q4f32_1' })).toBe(24 * KB);
  });

  it('counts only the attention layers of a hybrid model, and reads nested sizes', () => {
    // Qwen3.5: every 4th layer attends; the others keep a fixed-size state
    expect(kvBytesPerToken(qwen35_2b)).toBe(6 * 2 * 2 * 256 * 2);
    expect(kvBytesPerToken({ model_config: { num_hidden_layers: 4, num_key_value_heads: 1, head_dim: 64, layer_types: ['linear_attention', 'linear_attention', 'linear_attention', 'full_attention'] } })).toBe(1 * 2 * 1 * 64 * 2);
    expect(kvBytesPerToken(gemma3_1b)).toBe(26 * 2 * 1 * 256 * 2);
  });

  it('is unknown without the sizes', () => {
    expect(kvBytesPerToken(null)).toBeNull();
    expect(kvBytesPerToken({ model_config: { num_hidden_layers: 4 } })).toBeNull();
  });
});

describe('the context a model gets', () => {
  const iphone = workingMemoryBudget({ appleMobile: true, phone: false });
  const desktop = workingMemoryBudget({ appleMobile: false, phone: false });

  it('shrinks where a token costs a lot, and stays at the limit where it is cheap', () => {
    const qwen3 = contextWindowFor(kvBytesPerToken(qwen3_06b), iphone, 4096, modelMaxContext(qwen3_06b));
    expect(qwen3).toBeLessThan(4096);
    expect(qwen3 % 256).toBe(0);
    expect(qwen3 * kvBytesPerToken(qwen3_06b)!).toBeLessThanOrEqual(iphone);
    expect(contextWindowFor(kvBytesPerToken(qwen25_05b), iphone, 4096)).toBe(4096);
    expect(contextWindowFor(kvBytesPerToken(qwen3_06b), desktop, 4096)).toBe(4096);
  });

  it('never goes below one turn\'s need, above Chatty\'s limit, or past the model\'s own longest', () => {
    expect(contextWindowFor(200 * KB, 64 * MB, 8192)).toBe(MIN_CONTEXT);
    expect(contextWindowFor(1 * KB, 4096 * MB, 8192)).toBe(8192);
    expect(contextWindowFor(1 * KB, 4096 * MB, 8192, 2048)).toBe(2048);
    // Unknown cost: the limit, as before
    expect(contextWindowFor(null, iphone, 4096)).toBe(4096);
  });

  it('budgets by the device: iPhone fixed, others by their memory where the browser says', () => {
    expect(workingMemoryBudget({ appleMobile: false, phone: false, memoryGb: 4 })).toBeLessThan(desktop);
    expect(workingMemoryBudget({ appleMobile: false, phone: true, memoryGb: 8 })).toBeGreaterThan(workingMemoryBudget({ appleMobile: false, phone: true, memoryGb: 4 }));
    expect(iphone).toBeLessThan(workingMemoryBudget({ appleMobile: false, phone: true }));
  });
});
