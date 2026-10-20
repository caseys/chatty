import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { LiteRtLlmProvider } from '../src/runtimes/llm-provider.ts';

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

/** An engine whose conversations hand back queued replies; counts how many it had to create */
function fakeEngine(replies: string[]) {
  const created: Array<{ preface: Msg[]; sent: string[] }> = [];
  const engine = {
    async createConversation(config: { preface: { messages: Msg[] } }) {
      const record = { preface: config.preface.messages, sent: [] as string[] };
      created.push(record);
      return {
        isBusy: false,
        sendMessageStreaming(message: { content: string }) {
          record.sent.push(message.content);
          const text = replies.shift() ?? '';
          return new ReadableStream({
            start(controller) {
              controller.enqueue({ content: [{ type: 'text', text }] });
              controller.close();
            },
          });
        },
        cancel() {},
        async delete() {},
      };
    },
  };
  return { engine, created };
}

function providerWith(replies: string[]) {
  const provider = new LiteRtLlmProvider('gemma-4-e2b-it-web');
  const { engine, created } = fakeEngine(replies);
  (provider as unknown as { engine: unknown }).engine = engine;
  let n = 0;
  const generate = (systemPrompt: string, messages: Msg[]) =>
    provider.generate({ turnId: `t${++n}`, systemPrompt, messages, temperature: 0.1 });
  return { generate, created };
}

const FORMAT: Msg[] = [
  { role: 'user', content: 'Hi Chatty!' },
  { role: 'assistant', content: 'speak("Hi! What would you like me to make?");' },
];

describe('reusing the desktop model\'s processed prompt between turns', () => {
  it('keeps one conversation while each turn repeats the last call and adds to it', async () => {
    const { generate, created } = providerWith(['speak("One.");', 'speak("Two.");', 'speak("Three.");']);
    await generate('SYSTEM', [...FORMAT, { role: 'user', content: 'first' }]);
    await generate('SYSTEM', [...FORMAT, { role: 'user', content: 'first' }, { role: 'assistant', content: 'speak("One.");' }, { role: 'user', content: 'second' }]);
    await generate('SYSTEM', [
      ...FORMAT,
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'speak("One.");' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'speak("Two.");' },
      { role: 'user', content: 'third' },
    ]);
    expect(created.length).toBe(1);
    expect(created[0].sent).toEqual(['first', 'second', 'third']);
  });

  it('ignores the whitespace around a past reply (the history holds the program trimmed)', async () => {
    const { generate, created } = providerWith(['  speak("One.");\n\n', 'speak("Two.");']);
    await generate('SYSTEM', [...FORMAT, { role: 'user', content: 'first' }]);
    await generate('SYSTEM', [...FORMAT, { role: 'user', content: 'first' }, { role: 'assistant', content: 'speak("One.");' }, { role: 'user', content: 'second' }]);
    expect(created.length).toBe(1);
  });

  it('starts over when the system prompt or an earlier message changed', async () => {
    const { generate, created } = providerWith(['speak("One.");', 'speak("Two.");', 'speak("Three.");']);
    await generate('SYSTEM', [...FORMAT, { role: 'user', content: 'first' }]);
    await generate('SYSTEM plus a programs list', [...FORMAT, { role: 'user', content: 'first' }, { role: 'assistant', content: 'speak("One.");' }, { role: 'user', content: 'second' }]);
    expect(created.length).toBe(2);
    // An earlier user message rewritten (here: a note dropped from it)
    await generate('SYSTEM plus a programs list', [
      ...FORMAT,
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'speak("One.");' },
      { role: 'user', content: 'Notes: x\n\nRequest: second' },
      { role: 'assistant', content: 'speak("Two.");' },
      { role: 'user', content: 'third' },
    ]);
    expect(created.length).toBe(3);
  });
});
