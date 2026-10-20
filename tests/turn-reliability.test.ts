import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ConversationMemoryStore } from '../src/core/memory-store.ts';
import {
  COMPACTION_SYSTEM_PROMPT,
  ConversationOrchestrator,
  FORMAT_TURNS,
  type RunStatus,
} from '../src/core/orchestrator.ts';
import { StateMachineCoordinator } from '../src/core/state-machine.ts';
import type { JavascriptExecutionResult, JavascriptRuntime } from '../src/tools/javascript-runtime.ts';
import type {
  ConversationMessage,
  LlmGenerationOptions,
  LlmGenerationResult,
  LlmRuntimeProvider,
  TtsRuntimeProvider,
} from '../src/types/index.ts';

const DRAWING = [
  'speak("Drawing a red circle.");',
  'const canvas = document.createElement("canvas");',
  'root.appendChild(canvas);',
  'const ctx = canvas.getContext("2d");',
  'ctx.fillStyle = "red";',
  'ctx.beginPath(); ctx.arc(50, 50, 40, 0, Math.PI * 2); ctx.fill();',
].join('\n');

/** Replies from a list, one per request; summaries for compaction. Records every call. */
class QueueLlm implements LlmRuntimeProvider {
  readonly id = 'queue';
  readonly modelId = 'queue';
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = false;
  calls: LlmGenerationOptions[] = [];
  /** Requests made to write a reply (not compaction) */
  turns: LlmGenerationOptions[] = [];
  constructor(
    readonly replies: string[],
    readonly contextLimit = 8192,
    readonly maxOutputTokens = 512
  ) {}
  async initialize(): Promise<void> {}
  async generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    const recorded = structuredClone({ ...options, signal: undefined, onToken: undefined, tools: undefined });
    this.calls.push(recorded);
    const compacting = options.systemPrompt === COMPACTION_SYSTEM_PROMPT;
    if (!compacting) this.turns.push(recorded);
    const text = compacting ? 'The user chatted at length.' : (this.replies.shift() ?? 'speak("ok");');
    options.onToken?.(text, 0);
    return { turnId: options.turnId, text, aborted: false, timeToFirstTokenMs: 1, totalTimeMs: 1, tokensGenerated: 1, tokensPerSecond: 1 };
  }
  cancel(): void {}
  async reset(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function countingTts(spoken: string[]): TtsRuntimeProvider {
  return {
    id: 'counting-tts',
    voiceId: 'v',
    async initialize() {},
    async synthesize(text) {
      spoken.push(text);
      return { samples: new Float32Array(10), sampleRate: 22050, synthesisTimeMs: 1, audioDurationMs: 1 };
    },
    cancel() {},
    async dispose() {},
  };
}

function orchestratorFor(llm: LlmRuntimeProvider, extra: Partial<ConstructorParameters<typeof ConversationOrchestrator>[0]> = {}) {
  return new ConversationOrchestrator({
    stateCoordinator: new StateMachineCoordinator(),
    llmProvider: llm,
    enableSpeechOutput: false,
    getConversationId: () => 'c1',
    shouldAutoTitle: () => false,
    ...extra,
  });
}

/** A program runtime that fails the first run the way a countdown with a typo does */
function fakeRuntime(results: Array<Partial<JavascriptExecutionResult>>) {
  const executed: string[] = [];
  /** Whether the previous program still has something going; a reset ends it */
  const state = { running: false, resets: 0 };
  const runtime = {
    async execute(code: string): Promise<JavascriptExecutionResult> {
      executed.push(code);
      const r = results.shift() ?? {};
      return { success: !r.error, logs: [], hasVisualOutput: false, executionTimeMs: 1, code, mode: 'eval', ...r };
    },
    async resetVisual() {
      state.resets++;
      state.running = false;
    },
    hasRunningProgram: () => state.running,
  } as unknown as JavascriptRuntime;
  return { executed, runtime, state };
}

describe('a new program replaces the one still running', () => {
  const SONG = 'setInterval(() => playNotes("C4 E4 G4"), 2000);';
  const SLOWER = 'setInterval(() => playNotes("C4 E4 G4"), 4000);';

  async function turn(orchestrator: ConversationOrchestrator, text: string) {
    await orchestrator.submitUserInput(text);
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
  }

  it('resets before a program that is not talk-only, even one that draws nothing', async () => {
    const llm = new QueueLlm([SONG, SLOWER]);
    const { executed, runtime, state } = fakeRuntime([]);
    const orchestrator = orchestratorFor(llm, { javascriptRuntime: runtime });

    await turn(orchestrator, 'play a song on a loop');
    expect(state.resets).toBe(0);
    state.running = true;
    await turn(orchestrator, 'play something slower');
    expect(state.resets).toBe(1);
    expect(executed).toEqual([SONG, SLOWER]);
  });

  it('leaves a running program alone for a talk-only reply', async () => {
    const llm = new QueueLlm([SONG, 'speak("2 plus 2 is 4.");']);
    const { executed, runtime, state } = fakeRuntime([]);
    const orchestrator = orchestratorFor(llm, { javascriptRuntime: runtime });

    await turn(orchestrator, 'play a song on a loop');
    state.running = true;
    await turn(orchestrator, "what's 2+2");
    expect(state.resets).toBe(0);
    expect(state.running).toBe(true);
    // It still ran, on top of the song
    expect(executed).toEqual([SONG, 'speak("2 plus 2 is 4.");']);
  });
});

describe('a fix that loses the program', () => {
  const lostFixes = [
    ['chat plus a bare speak() in a block', 'Here\'s the corrected program:\n```javascript\nspeak("Sorry about that.");\n```'],
    ['a program that no longer draws', 'const n = 1 + 1;\nspeak(n);'],
    ['prose only', 'Sure, let me fix that for you right away.'],
  ] as const;

  it.each(lostFixes)('is not run, said or shown (%s), and the original stays current', async (_name, fixReply) => {
    const llm = new QueueLlm([DRAWING, fixReply]);
    const { executed, runtime } = fakeRuntime([{ error: 'boom is not defined', errorLine: 3 }]);
    const statuses: RunStatus[] = [];
    const bubbles: string[] = [];
    const spoken: string[] = [];
    const orchestrator = orchestratorFor(llm, {
      autoFixErrors: true,
      enableSpeechOutput: true,
      ttsProvider: countingTts(spoken),
      javascriptRuntime: runtime,
      events: {
        onRunStatus: (_id, status) => statuses.push(status),
        onTokenStream: (_id, _chunk, soFar) => bubbles.push(soFar),
      },
    });

    await orchestrator.submitUserInput('draw a red circle');
    await vi.waitFor(() => expect(statuses.some((s) => s.text.includes('lost the program'))).toBe(true), { timeout: 3000 });
    // Let the fix turn finish
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());

    // The fix asked for the program again, led by the original request
    const fixAsk = llm.turns[1].messages.at(-1)!.content;
    expect(fixAsk.startsWith('draw a red circle. Your last program failed at line 3: boom is not defined.')).toBe(true);
    expect(llm.turns[1].messages.some((m) => m.role === 'assistant' && m.content === DRAWING)).toBe(true);

    // Only the original program ran; the fix's text was neither spoken nor shown
    expect(executed).toEqual([DRAWING]);
    const last = statuses.at(-1)!;
    expect(last.kind).toBe('error');
    expect(last.text).toContain('lost the program');
    expect(last.text).toContain('boom is not defined');
    expect(spoken.join(' ')).not.toMatch(/Sorry about that|corrected program|let me fix/i);
    expect(bubbles.join(' ')).not.toMatch(/Sorry about that|corrected program|let me fix/i);
    const fixReplyMsg = orchestrator.memoryStore.getMessages().filter((m) => m.role === 'assistant').at(-1)!;
    expect(fixReplyMsg.canonicalContent).toBe('');

    // The original program is still the one follow-ups edit and errors are tracked against
    const internals = orchestrator as unknown as { lastRun: { code: string; error: string }; lastAction: { code: string } };
    expect(internals.lastRun.code).toBe(DRAWING);
    expect(internals.lastRun.error).toBe('boom is not defined');
    expect(internals.lastAction.code).toBe(DRAWING);

    // Later prompts leave the fix request and its reply out
    await orchestrator.submitUserInput('how are you?');
    const later = llm.turns.at(-1)!;
    const seen = later.messages.map((m) => m.content).join('\n');
    expect(seen).not.toMatch(/Your last program failed|Sorry about that|corrected program|let me fix/i);
    expect(later.messages.slice(FORMAT_TURNS.length)).toEqual([{ role: 'user', content: 'how are you?' }]);
  });

  it('lets a fix that still draws run, and makes it the current program', async () => {
    const fixed = DRAWING.replace('ctx.fill();', 'ctx.fill(); // fixed');
    const llm = new QueueLlm([DRAWING, fixed]);
    const { executed, runtime } = fakeRuntime([{ error: 'boom is not defined', errorLine: 3 }, {}]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });

    await orchestrator.submitUserInput('draw a red circle');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 3000 });
    expect(executed[1]).toBe(fixed);
    await vi.waitFor(() => expect((orchestrator as unknown as { lastAction: { code: string } }).lastAction.code).toBe(fixed));
  });

  it('keeps fix requests and their replies out of the history of later prompts', async () => {
    const llm = new QueueLlm([]);
    const orchestrator = orchestratorFor(llm);
    const msg = (id: string, turnId: string, role: 'user' | 'assistant', text: string, extra: Partial<ConversationMessage> = {}): ConversationMessage => ({
      id,
      turnId,
      role,
      canonicalContent: text,
      timestamp: 0,
      ...extra,
    });
    const built = (orchestrator as unknown as {
      buildModelPrompt(u: string, c: unknown, m: string): { promptMessages: Array<{ role: string; content: string }> };
    }).buildModelPrompt(
      'and now?',
      {
        workingMessages: [
          msg('u1', 't1', 'user', 'hello'),
          msg('a1', 't1', 'assistant', 'Hi!', { rawCode: 'speak("Hi!");' }),
          msg('u2', 't2', 'user', 'Make a countdown. Your last program failed at line 2: x', { autoFix: true }),
          msg('a2', 't2', 'assistant', 'Here is the corrected program', { rawCode: 'speak("Here is the corrected program");' }),
          msg('u3', 't3', 'user', 'thanks'),
          msg('a3', 't3', 'assistant', 'Welcome!', { rawCode: 'speak("Welcome!");' }),
        ],
        relevantMemories: [],
        conversationSummary: null,
        resolvedReferencesNote: null,
      },
      'direct'
    );
    expect(built.promptMessages.slice(FORMAT_TURNS.length)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'speak("Hi!");' },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'speak("Welcome!");' },
      { role: 'user', content: 'and now?' },
    ]);
  });
});

describe('what a follow-up turn sends the desktop model', () => {
  // LiteRtLlmProvider reuses its processed prompt only when a follow-up repeats the last call's
  // system prompt and messages exactly (plus the reply it got) before the new message

  const reply = (text: string) => ({ role: 'assistant', content: text });

  it('sends the same system prompt and an identical message prefix on consecutive turns', async () => {
    const llm = new QueueLlm(['speak("Hello there.");', 'speak("I am well.");', 'speak("Three.");']);
    const orchestrator = orchestratorFor(llm);
    await orchestrator.submitUserInput('Hello');
    await orchestrator.submitUserInput('How are you?');
    await orchestrator.submitUserInput('What is one plus two?');

    const [a, b, c] = llm.turns;
    expect(b.systemPrompt).toBe(a.systemPrompt);
    expect(c.systemPrompt).toBe(a.systemPrompt);
    expect(b.messages).toEqual([...a.messages, reply('speak("Hello there.");'), { role: 'user', content: 'How are you?' }]);
    expect(c.messages).toEqual([...b.messages, reply('speak("I am well.");'), { role: 'user', content: 'What is one plus two?' }]);
  });

  it('keeps per-request notes (memories, references, answer style) out of the system prompt and repeats them with their request', async () => {
    const llm = new QueueLlm(['speak("Hello there.");', 'speak("Blue.");', 'speak("Green.");', 'speak("Okay.");']);
    const orchestrator = orchestratorFor(llm);
    orchestrator.memoryStore.upsertApprovedMemory('favorite_color', 'blue');
    await orchestrator.submitUserInput('Hello');
    await orchestrator.submitUserInput('What is my favorite color?');
    await orchestrator.submitUserInput('and the second one?');
    await orchestrator.submitUserInput('Thanks');

    const [a, b, c, d] = llm.turns;
    for (const turn of [b, c, d]) expect(turn.systemPrompt).toBe(a.systemPrompt);
    expect(a.systemPrompt).not.toContain('favorite_color');

    // The memory travels with the request that it was picked for
    const asked = b.messages.at(-1)!.content;
    expect(asked).toContain('User approved memory: favorite_color: blue.');
    expect(asked).toMatch(/Request: What is my favorite color\?$/);
    // ... and later prompts repeat that message as it was sent
    expect(c.messages.slice(0, b.messages.length + 1)).toEqual([...b.messages, reply('speak("Blue.");')]);
    expect(c.messages.at(-1)!.content).toContain('Request: and the second one?');
    expect(d.messages.slice(0, c.messages.length + 1)).toEqual([...c.messages, reply('speak("Green.");')]);
  });

  it('keeps the system prompt fixed on the turns after a program too', async () => {
    const llm = new QueueLlm([DRAWING, 'speak("I am well.");', 'speak("Three.");', 'speak("Fine.");']);
    const orchestrator = orchestratorFor(llm);
    await orchestrator.submitUserInput('draw a red circle');
    await orchestrator.submitUserInput('how are you?');
    await orchestrator.submitUserInput('what is one plus two?');
    await orchestrator.submitUserInput('and two plus two?');

    // The turn after a program moves it into the system prompt (once); from then on, turns append
    const [, b, c, d] = llm.turns;
    expect(b.systemPrompt).toContain('you built something on screen');
    expect(c.systemPrompt).toBe(b.systemPrompt);
    expect(d.systemPrompt).toBe(b.systemPrompt);
    expect(c.messages).toEqual([...b.messages, reply('speak("I am well.");'), { role: 'user', content: 'what is one plus two?' }]);
    expect(d.messages).toEqual([...c.messages, reply('speak("Three.");'), { role: 'user', content: 'and two plus two?' }]);
  });
});

describe('the prompt budget counts what the prompt really holds', () => {
  const estimate = (s: string) => Math.ceil(s.length / 4);
  const promptTokens = (call: LlmGenerationOptions) =>
    estimate(call.systemPrompt) + call.messages.reduce((n, m) => n + estimate(m.content) + 4, 0);

  it('compacts before a 4,096-token window with 1,536 tokens set aside for the reply overflows', async () => {
    const llm = new QueueLlm([], 4096, 1536);
    const orchestrator = orchestratorFor(llm);
    const filler = ' word'.repeat(200); // about 250 tokens a message
    for (let i = 1; i <= 8; i++) {
      llm.replies.push(`speak("Answer ${i}.${filler}");`);
      await orchestrator.submitUserInput(`Question number ${i}${filler}`);
    }
    // History was summarized away at least once, and no prompt ever left too little room to reply
    expect(llm.calls.some((c) => c.systemPrompt === COMPACTION_SYSTEM_PROMPT)).toBe(true);
    for (const turn of llm.turns) {
      expect(promptTokens(turn) + 1536, turn.messages.at(-1)!.content.slice(0, 20)).toBeLessThanOrEqual(4096);
    }
  });

  it('counts the real system prompt, not a 120-token stand-in', () => {
    const store = new ConversationMemoryStore();
    const orchestrator = orchestratorFor(new QueueLlm([], 4096, 1536), { memoryStore: store });
    store.addMessage({ id: 'u1', turnId: 't1', role: 'user', canonicalContent: 'Hi', timestamp: 0 });
    // System prompt (rules, examples) and format turns come to well over a thousand tokens
    expect(store.getCurrentContextTokens()).toBeGreaterThan(1000);
    expect(orchestrator).toBeDefined();
  });

  it('keeps desktop behaviour sensible: a normal desktop conversation is not compacted early', async () => {
    const llm = new QueueLlm([], 8192, 1024);
    const orchestrator = orchestratorFor(llm);
    for (let i = 1; i <= 6; i++) {
      llm.replies.push(`speak("Answer ${i}.");`);
      await orchestrator.submitUserInput(`Question number ${i}`);
    }
    expect(llm.calls.some((c) => c.systemPrompt === COMPACTION_SYSTEM_PROMPT)).toBe(false);
  });
});

describe('the memory store budget', () => {
  const add = (store: ConversationMemoryStore, text: string, n: number, role: 'user' | 'assistant' = 'user') =>
    store.addMessage({ id: `m${n}`, turnId: `t${Math.ceil(n / 2)}`, role, canonicalContent: text, timestamp: 0 });

  it('reserves the reply and the fixed prompt inside the window', () => {
    const store = new ConversationMemoryStore();
    add(store, 'x'.repeat(2000), 1); // ~500 tokens
    // The old stand-in (150 tokens) fits a 4,096 window with room to spare
    expect(store.isContextCompactionNeeded(4096, '', 0.85)).toBe(false);
    store.setPromptReserve({ fixedTokens: 1600, outputTokens: 1536 });
    // 1600 + 500 = 2100 of the 2560 tokens left after the reply, over 85% of them (2176)? not yet
    expect(store.isContextCompactionNeeded(4096, '', 0.85)).toBe(false);
    add(store, 'y'.repeat(400), 2, 'assistant'); // ~100 more
    expect(store.isContextCompactionNeeded(4096, '', 0.85)).toBe(true);
  });

  it('does not ask for compaction that could not make room', () => {
    const store = new ConversationMemoryStore();
    add(store, 'hello', 1);
    store.setPromptReserve({ fixedTokens: 3000, outputTokens: 1536 });
    expect(store.isContextCompactionNeeded(4096, '', 0.85)).toBe(false);
  });

  it('leaves messages of fix turns out of the size', () => {
    const store = new ConversationMemoryStore();
    add(store, 'hello', 1);
    const before = store.getCurrentContextTokens();
    store.addMessage({ id: 'fu', turnId: 'tf', role: 'user', canonicalContent: 'x'.repeat(2000), autoFix: true, timestamp: 0 });
    store.addMessage({ id: 'fa', turnId: 'tf', role: 'assistant', canonicalContent: 'y'.repeat(2000), timestamp: 0 });
    expect(store.getCurrentContextTokens()).toBe(before);
  });

  it('lets a few extra messages pile up before trimming, so the start of the prompt holds still', () => {
    const slack = new ConversationMemoryStore({ maxVerbatimTurns: 8, compactionSlack: 4 });
    const exact = new ConversationMemoryStore({ maxVerbatimTurns: 8 });
    for (let n = 1; n <= 12; n++) {
      add(slack, `message ${n}`, n);
      add(exact, `message ${n}`, n);
    }
    expect(slack.getMessages().length).toBe(12);
    expect(exact.getMessages().length).toBe(8);
    add(slack, 'message 13', 13);
    expect(slack.getMessages().length).toBe(8);
    expect(slack.getMessages()[0].canonicalContent).toBe('message 6');
  });
});

describe('rules picked for small models', () => {
  it('keeps the core rules and adds the optional ones only when the request needs them', async () => {
    const { promptRules } = await import('../src/core/orchestrator.ts');
    const tip = promptRules('Code a tip calculator app with a UI for the bill and tip %', true);
    expect(tip).toContain('- What you add to document.body appears in a card');
    expect(tip).toContain('Use HTML and CSS for interfaces');
    expect(tip).not.toContain('Web MIDI');
    expect(tip).not.toContain('<canvas>');
    expect(tip).not.toMatch(/^\d+\. /m);
    const music = promptRules('Play a music loop with a G major chord on piano', true);
    expect(music).toContain('Web MIDI');
    // An edit is matched against the program it changes too
    expect(promptRules('make it faster\nconst out = (await navigator.requestMIDIAccess())', true)).toContain('Web MIDI');
    expect(promptRules('Draw a rainbow over green hills', true)).toContain('<canvas>');
    expect(promptRules('Who was Ada Lovelace?', true)).toContain('Wikipedia');
    // Unfiltered: every rule
    const all = promptRules();
    for (const part of ['Web MIDI', '<canvas>', '<svg>', 'WebGL', 'Wikipedia']) expect(all).toContain(part);
  });
});
