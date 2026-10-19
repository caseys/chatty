import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { compactAssistantContent, isTalkOnly } from '../src/core/history-format.ts';
import { ConversationOrchestrator, EXAMPLE_TURNS } from '../src/core/orchestrator.ts';
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

describe('compactAssistantContent', () => {
  it('summarizes drawing programs instead of replaying them', () => {
    const out = compactAssistantContent(msg(DRAWING, 'Drawing a red circle.'));
    expect(out).toBe('speak("Drawing a red circle.");\n// (Earlier program omitted: built something on screen, 6 lines.)');
  });

  it('keeps short talk-only replies as they were', () => {
    expect(compactAssistantContent(msg('speak("Hi there!");', 'Hi there!'))).toBe('speak("Hi there!");');
  });

  it('recognizes talk-only programs', () => {
    expect(isTalkOnly('speak("Hi!"); speak(`Bye`);')).toBe(true);
    expect(isTalkOnly('speak("He said \\"hi\\"");')).toBe(true);
    expect(isTalkOnly(DRAWING)).toBe(false);
    expect(isTalkOnly('await playNotes("C4", 200);')).toBe(false);
  });

  it('passes prose replies through', () => {
    expect(compactAssistantContent({ ...msg('', 'Hello'), rawCode: undefined })).toBe('Hello');
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

    const conversation = llm.calls[0].messages.slice(EXAMPLE_TURNS.length);
    expect(conversation).toEqual([{ role: 'user', content: 'Make a tip calculator' }]);
  });

  it('describes past programs in the system prompt and shows the one being edited in full', async () => {
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

    // The conversation's own turns, after the example exchanges
    const assistantSeen = (call: LlmGenerationOptions) =>
      call.messages.slice(EXAMPLE_TURNS.length).filter((m) => m.role === 'assistant').map((m) => m.content);
    // Unrelated turn: the drawing leaves the history (so small models can't copy a summary
    // instead of writing code) and is described in the system prompt
    expect(assistantSeen(llm.calls[1])).toEqual([]);
    expect(llm.calls[1].messages.slice(EXAMPLE_TURNS.length).map((m) => m.content)).not.toContain('draw a red circle');
    expect(llm.calls[1].systemPrompt).toContain('- "draw a red circle": you built something on screen (6 lines)');
    // Edit turn: the program being changed is shown in full
    expect(assistantSeen(llm.calls[2])).toContain(DRAWING);
  });
});
