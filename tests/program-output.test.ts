import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { pastProgramResult } from '../src/core/history-format.ts';
import { ConversationOrchestrator, FORMAT_TURNS } from '../src/core/orchestrator.ts';
import { StateMachineCoordinator } from '../src/core/state-machine.ts';
import type { JavascriptExecutionResult, JavascriptRuntime } from '../src/tools/javascript-runtime.ts';
import type { ConversationMessage, LlmGenerationOptions, LlmGenerationResult, LlmRuntimeProvider } from '../src/types/index.ts';

const DRAWING = [
  'speak("Drawing a red circle.");',
  'const canvas = document.createElement("canvas");',
  'root.appendChild(canvas);',
  'const ctx = canvas.getContext("2d");',
  'ctx.fillStyle = "red";',
  'ctx.beginPath(); ctx.arc(50, 50, 40, 0, Math.PI * 2); ctx.fill();',
].join('\n');
const TALK = 'speak("2 plus 2 is 4.");';

class QueueLlm implements LlmRuntimeProvider {
  readonly id = 'queue';
  modelId = 'queue';
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = false;
  calls: LlmGenerationOptions[] = [];
  constructor(
    readonly replies: string[],
    readonly contextLimit = 8192,
    readonly maxOutputTokens = 512
  ) {}
  async initialize(): Promise<void> {}
  async generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    this.calls.push(structuredClone({ ...options, signal: undefined, onToken: undefined, tools: undefined }));
    const text = this.replies.shift() ?? 'speak("ok");';
    options.onToken?.(text, 0);
    return { turnId: options.turnId, text, aborted: false, timeToFirstTokenMs: 1, totalTimeMs: 1, tokensGenerated: 1, tokensPerSecond: 1 };
  }
  cancel(): void {}
  async reset(): Promise<void> {}
  async dispose(): Promise<void> {}
}

/** A runtime whose runs say what the code's speak() calls say */
const runtime = {
  async execute(code: string, _cb: unknown, opts?: { onSpeak?: (phrase: string) => void }): Promise<JavascriptExecutionResult> {
    const spokenTexts = [...code.matchAll(/speak\("([^"]*)"\)/g)].map((m) => m[1]);
    for (const t of spokenTexts) opts?.onSpeak?.(t);
    return { success: true, logs: [], hasVisualOutput: code.includes('canvas'), executionTimeMs: 1, code, mode: 'eval', spokenTexts };
  },
  async resetVisual() {},
  hasRunningProgram: () => false,
} as unknown as JavascriptRuntime;

function orchestratorFor(llm: LlmRuntimeProvider, events: ConstructorParameters<typeof ConversationOrchestrator>[0]['events'] = {}) {
  return new ConversationOrchestrator({
    events,
    stateCoordinator: new StateMachineCoordinator(),
    llmProvider: llm,
    javascriptRuntime: runtime,
    enableSpeechOutput: false,
    getConversationId: () => 'c1',
    shouldAutoTitle: () => false,
  });
}

async function turn(orchestrator: ConversationOrchestrator, text: string) {
  await orchestrator.submitUserInput(text);
  await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
}

const msg = (rawCode: string, said: string, extra: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'm',
  turnId: 't',
  role: 'assistant',
  canonicalContent: said,
  rawCode,
  timestamp: 0,
  ...extra,
});

describe('what a program said, in the model\'s history', () => {
  it('reads as the program\'s output, not as a speak() call the model wrote', () => {
    const out = pastProgramResult(msg('const total = 57.5;\nroot.append(total);\n', 'Total: $57.50', { fromProgram: true, toolCall: { name: 'javascript_runtime', arguments: {} } }));
    expect(out).toBe('// (Your program showed something on screen, 3 lines; it ran without an error. It said: "Total: $57.50".)');
    expect(out).not.toContain('speak(');
  });

  it('leaves out Chatty\'s own fallback words', () => {
    const out = pastProgramResult(msg(DRAWING, "I've rendered that on your screen.", { fromProgram: false }));
    expect(out).toBe('// (Your program showed something on screen, 6 lines; it ran.)');
  });

  it('keeps a talk-only reply as the speak() call the model wrote', () => {
    expect(pastProgramResult(msg(TALK, '2 plus 2 is 4.'))).toBe(TALK);
  });
});

describe('fromProgram on the reply', () => {
  it('is set when a drawing program speaks, and not for a talk-only reply', async () => {
    const llm = new QueueLlm([DRAWING, TALK]);
    const updates: ConversationMessage[] = [];
    const orchestrator = orchestratorFor(llm, { onMessageUpdated: (m) => updates.push(m) });

    await turn(orchestrator, 'draw a red circle');
    await turn(orchestrator, "what's 2+2");

    const replies = orchestrator.memoryStore.getMessages().filter((m) => m.role === 'assistant');
    expect(replies.map((m) => m.canonicalContent)).toEqual(['Drawing a red circle.', '2 plus 2 is 4.']);
    expect(replies[0].fromProgram).toBe(true);
    expect(replies[1].fromProgram).toBeFalsy();
    // The chat is told with the same flag
    expect(updates.some((m) => m.canonicalContent === 'Drawing a red circle.' && m.fromProgram === true)).toBe(true);
    expect(updates.some((m) => m.canonicalContent === '2 plus 2 is 4.' && m.fromProgram)).toBe(false);
  });

  it('shows in the next prompt as the program\'s output, with the talk-only reply still a speak() call', async () => {
    const llm = new QueueLlm([DRAWING, TALK, 'speak("ok");']);
    const orchestrator = orchestratorFor(llm);
    await turn(orchestrator, 'draw a red circle');
    await turn(orchestrator, "what's 2+2");
    await turn(orchestrator, 'thanks');

    const seen = llm.calls[2].messages.slice(FORMAT_TURNS.length).filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('It said: "Drawing a red circle."');
    expect(seen[0]).not.toContain('speak(');
    expect(seen[1]).toBe(TALK);
  });
});
