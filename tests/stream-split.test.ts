import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ConversationOrchestrator } from '../src/core/orchestrator.ts';
import { StateMachineCoordinator } from '../src/core/state-machine.ts';
import type { LlmGenerationOptions, LlmGenerationResult, LlmRuntimeProvider } from '../src/types/index.ts';

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
