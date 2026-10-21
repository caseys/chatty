import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { isTalkOnly, pastProgramResult } from '../src/core/history-format.ts';
import { ConversationOrchestrator, FORMAT_TURNS } from '../src/core/orchestrator.ts';
import { StateMachineCoordinator } from '../src/core/state-machine.ts';
import type { ConversationMessage, LlmGenerationOptions, LlmGenerationResult, LlmRuntimeProvider } from '../src/types/index.ts';

const DRAWING = [
  'speak("Drawing a red circle.");',
  'const canvas = document.createElement("canvas");',
  'root.appendChild(canvas);',
  'const ctx = canvas.getContext("2d");',
  'ctx.fillStyle = "red";',
  'ctx.beginPath(); ctx.arc(50, 50, 40, 0, Math.PI * 2); ctx.fill();',
].join('\n');

const msg = (rawCode: string, said: string): ConversationMessage => ({
  id: 'm',
  turnId: 't',
  role: 'assistant',
  canonicalContent: said,
  rawCode,
  timestamp: 0,
});

describe('pastProgramResult', () => {
  it('gives what happened when a program ran and what it said as its output, not its code', () => {
    const out = pastProgramResult(msg(DRAWING, 'Drawing a red circle.'));
    expect(out).toBe('// (Your program showed something on screen, 6 lines; it ran. It said: "Drawing a red circle.".)');
    const failed = pastProgramResult({ ...msg(DRAWING, 'Drawing.'), toolCall: { name: 'javascript_runtime', arguments: {}, error: 'boom is not defined' } });
    expect(failed).toContain('it failed: boom is not defined');
  });

  it('keeps short talk-only replies as they were', () => {
    expect(pastProgramResult(msg('speak("Hi there!");', 'Hi there!'))).toBe('speak("Hi there!");');
  });

  it('recognizes talk-only programs', () => {
    expect(isTalkOnly('speak("Hi!"); speak(`Bye`);')).toBe(true);
    expect(isTalkOnly('speak("He said \\"hi\\"");')).toBe(true);
    expect(isTalkOnly(DRAWING)).toBe(false);
    expect(isTalkOnly('await playNotes("C4", 200);')).toBe(false);
  });

  it('passes prose replies through', () => {
    expect(pastProgramResult({ ...msg('', 'Hello'), rawCode: undefined })).toBe('Hello');
  });
});

/** Replies with a drawing first, then talk; records what each call saw. */
class ScriptedLlm implements LlmRuntimeProvider {
  readonly id = 'scripted';
  readonly modelId = 'scripted';
  readonly contextLimit = 8192;
  readonly maxOutputTokens = 512;
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = false;
  calls: LlmGenerationOptions[] = [];
  private replies = [DRAWING, 'speak("I am well.");', 'speak("Bigger now.");'];
  async initialize(): Promise<void> {}
  async generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    this.calls.push(options);
    const text = this.replies[this.calls.length - 1] ?? 'speak("ok");';
    options.onToken?.(text, 0);
    return { turnId: options.turnId, text, aborted: false, timeToFirstTokenMs: 1, totalTimeMs: 1, tokensGenerated: 1, tokensPerSecond: 1 };
  }
  cancel(): void {}
  async reset(): Promise<void> {}
  async dispose(): Promise<void> {}
}

describe('desktop history with programs', () => {
  it('keeps the welcome greeting out of the prompt so it never joins the last example reply', async () => {
    const llm = new ScriptedLlm();
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator: new StateMachineCoordinator(),
      llmProvider: llm,
      enableSpeechOutput: false,
      getConversationId: () => 'c1',
      shouldAutoTitle: () => false,
    });
    orchestrator.memoryStore.addMessage({
      id: 'msg_assistant_welcome_1',
      turnId: 'welcome_1',
      role: 'assistant',
      canonicalContent: 'Welcome back, what would you like to do with this browser?',
      timestamp: Date.now(),
    });
    await orchestrator.submitUserInput('Make a tip calculator');

    const conversation = llm.calls[0].messages.slice(FORMAT_TURNS.length);
    expect(conversation).toEqual([{ role: 'user', content: 'Make a tip calculator' }]);
  });

  it('keeps every request and reply, past programs as their results, and shows the one being edited in full', async () => {
    const llm = new ScriptedLlm();
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator: new StateMachineCoordinator(),
      llmProvider: llm,
      enableSpeechOutput: false,
      getConversationId: () => 'c1',
      shouldAutoTitle: () => false,
    });
    await orchestrator.submitUserInput('draw a red circle');
    await orchestrator.submitUserInput('how are you?');
    await orchestrator.submitUserInput('make it bigger');

    // The conversation's own turns, after the format turn
    const assistantSeen = (call: LlmGenerationOptions) =>
      call.messages.slice(FORMAT_TURNS.length).filter((m) => m.role === 'assistant').map((m) => m.content);
    // Unrelated turn: the request stays, the drawing as what happened when it ran (no code)
    expect(llm.calls[1].messages.slice(FORMAT_TURNS.length).map((m) => m.content)).toContain('draw a red circle');
    expect(assistantSeen(llm.calls[1])).toEqual([expect.stringContaining('(Your program showed something on screen, 6 lines')]);
    expect(assistantSeen(llm.calls[1]).join('\n')).not.toContain('getContext');
    // Edit turn: the program being changed is shown in full
    expect(assistantSeen(llm.calls[2])).toContain(DRAWING);
  });
});
