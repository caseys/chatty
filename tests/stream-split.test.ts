import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ConversationOrchestrator } from '../src/core/orchestrator.ts';
import { StateMachineCoordinator } from '../src/core/state-machine.ts';
import type { LlmGenerationOptions, LlmGenerationResult, LlmRuntimeProvider, TtsRuntimeProvider } from '../src/types/index.ts';

/** Streams one reply in small chunks, as a real model does */
class StreamingLlm implements LlmRuntimeProvider {
  readonly id = 'streaming';
  readonly modelId = 'streaming';
  readonly contextLimit = 8192;
  readonly maxOutputTokens = 512;
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = false;
  constructor(private reply: string) {}
  async initialize(): Promise<void> {}
  async generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    for (let i = 0; i < this.reply.length; i += 6) options.onToken?.(this.reply.slice(i, i + 6), i);
    return { turnId: options.turnId, text: this.reply, aborted: false, timeToFirstTokenMs: 1, totalTimeMs: 1, tokensGenerated: 1, tokensPerSecond: 1 };
  }
  cancel(): void {}
  async reset(): Promise<void> {}
  async dispose(): Promise<void> {}
}

/** Everything the chat bubble showed while the reply streamed in */
async function chatShown(reply: string): Promise<string[]> {
  const shown: string[] = [];
  const orchestrator = new ConversationOrchestrator({
    stateCoordinator: new StateMachineCoordinator(),
    llmProvider: new StreamingLlm(reply),
    enableSpeechOutput: false,
    getConversationId: () => 'c1',
    shouldAutoTitle: () => false,
    events: { onTokenStream: (_turnId, _token, soFar) => shown.push(soFar) },
  });
  await orchestrator.submitUserInput('Play a loop');
  return shown;
}

describe('splitting a streaming reply between the chat and the code', () => {
  it('never shows a reply in the examples\' tag format in the chat', async () => {
    const shown = await chatShown(
      '<examples>\n<example>\n<request>Play a loop</request>\n<reply>\nconst bpm = 90;\nspeak("Here it is.");\n</reply>\n</example>\n</examples>'
    );
    expect(shown.some((s) => s.includes('<'))).toBe(false);
    expect(shown.some((s) => s.includes('const'))).toBe(false);
  });

  it('stops showing an explanation once unfenced code starts', async () => {
    const shown = await chatShown('To play a loop, use this:\nconst bpm = 90;\nconst beat = 60000 / bpm;\nspeak("Here it is.");');
    expect(shown.some((s) => s.includes('const beat'))).toBe(false);
  });
});

/** Streams a reply a few characters at a time with a pause between chunks, and notes when it is done */
class PacedLlm extends StreamingLlm {
  finished = false;
  async generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    const reply = (this as unknown as { reply: string }).reply;
    for (let i = 0; i < reply.length; i += 6) {
      options.onToken?.(reply.slice(i, i + 6), i);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.finished = true;
    return { turnId: options.turnId, text: reply, aborted: false, timeToFirstTokenMs: 1, totalTimeMs: 1, tokensGenerated: 1, tokensPerSecond: 1 };
  }
}

/** What was sent to the voice, and whether the reply had finished streaming by then */
async function voicedFrom(reply: string): Promise<{ voiced: Array<{ text: string; replyDone: boolean }>; shown: string[] }> {
  const llm = new PacedLlm(reply);
  const voiced: Array<{ text: string; replyDone: boolean }> = [];
  const shown: string[] = [];
  const tts: TtsRuntimeProvider = {
    id: 'recording-tts',
    voiceId: 'v',
    async initialize() {},
    async synthesize(text) {
      voiced.push({ text, replyDone: llm.finished });
      return { samples: new Float32Array(10), sampleRate: 22050, synthesisTimeMs: 1, audioDurationMs: 1 };
    },
    cancel() {},
    async dispose() {},
  };
  const orchestrator = new ConversationOrchestrator({
    stateCoordinator: new StateMachineCoordinator(),
    llmProvider: llm,
    ttsProvider: tts,
    getConversationId: () => 'c1',
    shouldAutoTitle: () => false,
    events: { onTokenStream: (_turnId, _token, soFar) => shown.push(soFar) },
  });
  await orchestrator.submitUserInput('Tell me about Paris');
  return { voiced, shown };
}

describe('voicing a streaming reply', () => {
  it('does not read an explanation aloud when the reply turns out to be code', async () => {
    const { voiced } = await voicedFrom('Here is the code you asked for:\nconst bpm = 90;\nspeak("Here it is.");');
    // Only what the program says, once
    expect(voiced.map((v) => v.text)).toEqual(['Here it is.']);
  });

  it('voices a prose reply once, after it is complete, while the chat shows it as it streams', async () => {
    const prose = 'Paris is the capital of France. It sits on the Seine river. Many people visit every year.';
    const { voiced, shown } = await voicedFrom(prose);
    expect(voiced.map((v) => v.text)).toEqual([
      'Paris is the capital of France.',
      'It sits on the Seine river.',
      'Many people visit every year.',
    ]);
    expect(voiced.every((v) => v.replyDone)).toBe(true);
    // The chat bubble still grew a piece at a time
    expect(shown.length).toBeGreaterThan(3);
    expect(shown.at(-1)).toBe(prose);
  });

  it('voices a short prose reply that never left the undecided state', async () => {
    const { voiced, shown } = await voicedFrom('Hi!');
    expect(voiced.map((v) => v.text)).toEqual(['Hi!']);
    expect(shown.at(-1)).toBe('Hi!');
  });
});
