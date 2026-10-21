import { describe, expect, it, vi } from 'vitest';
import { choiceProbabilities, WebLlmProvider } from '../src/runtimes/webllm-provider.ts';
import type { LlmGenerationOptions } from '../src/types/index.ts';

const top = (token: string, p: number) => ({ token, bytes: [], logprob: Math.log(p) });

describe('choiceProbabilities', () => {
  it('adds the tokens that write the same label, with or without a space', () => {
    const got = choiceProbabilities(['A', 'B', 'C'], [top('A', 0.5), top(' A', 0.1), top('B', 0.2), top('The', 0.1)])!;
    expect(got[0]).toBeCloseTo(0.6);
    expect(got[1]).toBeCloseTo(0.2);
    expect(got[2]).toBe(0);
  });

  it('counts the sampled token once when it is also among the top ones', () => {
    const got = choiceProbabilities(['A', 'B'], [top('B', 0.7), top('A', 0.3), top('B', 0.7)])!;
    expect(got[1]).toBeCloseTo(0.7);
  });

  it('is null when no label is among the tokens', () => {
    expect(choiceProbabilities(['A', 'B'], [top('The', 0.9), top('Answer', 0.1)])).toBeNull();
    expect(choiceProbabilities(['A', 'B'], [])).toBeNull();
  });
});

describe('WebLlmProvider.scoreChoices', () => {
  const options: LlmGenerationOptions = {
    turnId: 't',
    systemPrompt: 'Reply with a letter.',
    messages: [{ role: 'user', content: 'A. sum\nB. cart\nC. total' }],
  };

  /** A provider whose engine answers with the given logprobs for its one token */
  function providerWith(spec: { mlcId: string; noThinking?: boolean }, content: unknown, fail = false) {
    const provider = new WebLlmProvider('m', { ...spec, sizeBytes: 1, contextLimit: 4096, maxOutputTokens: 512 });
    const create = vi.fn(async (_request: Record<string, unknown>) => {
      if (fail) throw new Error('Grammar matcher rejected the newly sampled token');
      return { choices: [{ logprobs: content === null ? null : { content } }] };
    });
    (provider as unknown as { engine: unknown }).engine = { chat: { completions: { create } }, interruptGenerate: vi.fn() };
    return { provider, create };
  }

  const reply = [{ token: 'B', logprob: Math.log(0.55), bytes: [], top_logprobs: [top('B', 0.55), top('A', 0.3), top(' C', 0.1), top('The', 0.03), top('Answer', 0.02)] }];

  it('asks for one token with its likeliest five, held to the labels, and matches them to the tokens', async () => {
    const { provider, create } = providerWith({ mlcId: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC' }, reply);
    const got = await provider.scoreChoices(options, ['A', 'B', 'C']);
    expect(got![0]).toBeCloseTo(0.3);
    expect(got![1]).toBeCloseTo(0.55);
    expect(got![2]).toBeCloseTo(0.1);
    const request = create.mock.calls[0][0] as Record<string, unknown>;
    expect(request).toMatchObject({
      stream: false,
      max_tokens: 1,
      logprobs: true,
      top_logprobs: 5,
      temperature: 1,
      response_format: { type: 'grammar', grammar: 'root ::= "A" | "B" | "C"' },
    });
    expect(request.extra_body).toBeUndefined();
    expect((request.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('asks a Qwen3 model without thinking, so the token scored is the answer', async () => {
    const { provider, create } = providerWith({ mlcId: 'Qwen3-4B-q4f16_1-MLC', noThinking: true }, reply);
    await provider.scoreChoices(options, ['A', 'B', 'C']);
    expect((create.mock.calls[0][0] as Record<string, unknown>).extra_body).toEqual({ enable_thinking: false });
  });

  it('is null when the reply carries no logprobs, no label matches, or the engine throws', async () => {
    const spec = { mlcId: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC' };
    expect(await providerWith(spec, null).provider.scoreChoices(options, ['A', 'B'])).toBeNull();
    expect(await providerWith(spec, [{ token: 'The', logprob: -0.1, bytes: [], top_logprobs: [top('The', 0.9)] }]).provider.scoreChoices(options, ['A', 'B'])).toBeNull();
    const failing = providerWith(spec, reply, true);
    expect(await failing.provider.scoreChoices(options, ['A', 'B'])).toBeNull();
    // (one try: a failed grammar is not retried without it)
    expect(failing.create).toHaveBeenCalledTimes(1);
  });

  it('asks nothing when already aborted', async () => {
    const { provider, create } = providerWith({ mlcId: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC' }, reply);
    const controller = new AbortController();
    controller.abort();
    expect(await provider.scoreChoices({ ...options, signal: controller.signal }, ['A', 'B'])).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
