import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ConversationMemoryStore } from '../src/core/memory-store.ts';
import {
  COMPACTION_SYSTEM_PROMPT,
  ConversationOrchestrator,
  FORMAT_TURNS,
  type RunStatus,
} from '../src/core/orchestrator.ts';
import { promptRules } from '../src/core/orchestrator.ts';
import { FIX_SYSTEM_PROMPT } from '../src/core/line-fix.ts';
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

describe('a fix whose edits match nothing', () => {
  it('does not run the same failing program again', async () => {
    const miss = '<<<<<<< SEARCH\nnot in the program\n=======\nconst x = 1;\n>>>>>>> REPLACE';
    const llm = new QueueLlm([DRAWING, miss]);
    const { executed, runtime } = fakeRuntime([{ error: 'boom is not defined', errorLine: 3 }]);
    const statuses: RunStatus[] = [];
    const orchestrator = orchestratorFor(llm, {
      autoFixErrors: true,
      javascriptRuntime: runtime,
      events: { onRunStatus: (_id, status) => statuses.push(status) },
    });
    await orchestrator.submitUserInput('draw a red circle');
    await vi.waitFor(() => expect(statuses.some((s) => s.text.includes("didn't change the program"))).toBe(true), { timeout: 3000 });
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
    expect(executed).toEqual([DRAWING]);
  });
});

describe('a fix that loses the program', () => {
  const lostFixes = [
    ['chat plus a bare speak() in a block', 'Here\'s the corrected program:\n```javascript\nspeak("Sorry about that.");\n```'],
    ['a program that no longer draws', 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst n = a + b + c;\nconst m = n * 2;\nspeak(m);'],
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
    expect(fixAsk.startsWith('This program was written for: draw a red circle\nIt failed at the marked line: boom is not defined\n')).toBe(true);
    expect(fixAsk).toContain('// >>> ERROR: boom is not defined');
    // A fix turn has its own short prompt and only the fix request
    expect(llm.turns[1].systemPrompt).toBe(FIX_SYSTEM_PROMPT);
    // One message, the user's, with the program in it
    expect(llm.turns[1].messages).toEqual([{ role: 'user', content: fixAsk }]);

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
    const fixed = DRAWING.replace('ctx.fill();', 'ctx.fill();\nctx.stroke();');
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
      buildModelPrompt(u: string, c: unknown): { promptMessages: Array<{ role: string; content: string }> };
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
      }
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
    const filler = ' word'.repeat(300); // about 375 tokens a message
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
    // The system prompt's rules and the format turns come to a few hundred tokens
    expect(store.getCurrentContextTokens()).toBeGreaterThan(150);
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
    expect(tip).not.toContain('out is ready to use');
    expect(tip).not.toContain('<canvas>');
    expect(tip).not.toMatch(/^\d+\. /m);
    const music = promptRules('Play a music loop with a G major chord on piano', true);
    expect(music).toContain('out is ready to use');
    // An edit is matched against the program it changes too
    expect(promptRules('make it faster\nconst out = (await navigator.requestMIDIAccess())', true)).toContain('out is ready to use');
    expect(promptRules('Draw a rainbow over green hills', true)).toContain('<canvas>');
    expect(promptRules('Who was Ada Lovelace?', true)).toContain('Wikipedia');
    // Unfiltered: every rule
    const all = promptRules();
    for (const part of ['out is ready to use', '<canvas>', '<svg>', 'WebGL', 'Wikipedia']) expect(all).toContain(part);
  });
});


describe('context shared between the conversation and a fix turn', () => {
  it('shows the fix the request and the failed program, and puts a working fix in place of the broken program', async () => {
    const SONG = 'const out = 1;\nspeak("Here is a song.");';
    const FASTER = [
      'const out = 1;',
      'const bpm = 180;',
      'function play() {',
      '  const t = 1;',
      '}',
      'setTimeout(() => send(t), 100);',
      'play();',
      'speak("Faster now.");',
    ].join('\n');
    const FIX = '<<<<<<< SEARCH\nsetTimeout(() => send(t), 100);\n=======\nsetTimeout(() => send(1), 100);\n>>>>>>> REPLACE';
    const llm = new QueueLlm([SONG, FASTER, FIX]);
    const { executed, runtime } = fakeRuntime([{}, { error: 't is not defined', errorLine: 6 }, {}]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });

    await orchestrator.submitUserInput('Play a song');
    await orchestrator.submitUserInput('make it faster');
    await vi.waitFor(() => expect(executed).toHaveLength(3), { timeout: 3000 });
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());

    const fixAsk = llm.turns[2].messages.at(-1)!.content;
    expect(llm.turns[2].messages.map((m) => m.role)).toEqual(['user']);
    expect(fixAsk.startsWith('This program was written for: make it faster\nIt failed at the marked line: t is not defined\n')).toBe(true);
    expect(fixAsk).toContain('// >>> ERROR: t is not defined\nsetTimeout(() => send(t), 100);\n// <<< ERROR');
    const fixed = FASTER.replace('send(t)', 'send(1)');
    expect(executed[2]).toBe(fixed);
    // The broken reply isn't edited; the fix's own message holds the working program for that turn
    const messages = orchestrator.memoryStore.getMessages();
    const fasterTurn = messages.find((m) => m.role === 'user' && m.canonicalContent === 'make it faster')!.turnId;
    expect(messages.find((m) => m.id === `msg_assistant_${fasterTurn}`)?.rawCode).toBe(FASTER);
    expect(messages.find((m) => m.fixesTurnId === fasterTurn)?.rawCode).toBe(fixed);
  });
});

describe('a fix that says the same thing again', () => {
  it('adds no second bubble with the same words', async () => {
    const FIXED = DRAWING.replace('"red"', '"crimson"');
    const llm = new QueueLlm([DRAWING, FIXED]);
    const { executed, runtime } = fakeRuntime([
      { error: 'boom is not defined', errorLine: 3, spokenTexts: ['Drawing a red circle.'] },
      { spokenTexts: ['Drawing a red circle.'] },
    ]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('draw a red circle');
    await vi.waitFor(() => expect(llm.turns).toHaveLength(2), { timeout: 3000 });
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
    const said = orchestrator.memoryStore
      .getMessages()
      .filter((m) => m.role === 'assistant' && m.canonicalContent === 'Drawing a red circle.');
    expect(said).toHaveLength(1);
    // The fix did run
    expect(executed).toEqual([DRAWING, FIXED]);
  });
});

describe('a fix that comes back cut off', () => {
  it('is not run, and the status says so', async () => {
    const CUT = DRAWING.slice(0, DRAWING.indexOf(', 0, Math.PI'));
    const llm = new QueueLlm([DRAWING, CUT]);
    const { executed, runtime } = fakeRuntime([{ error: 'boom is not defined', errorLine: 3 }]);
    const statuses: RunStatus[] = [];
    const orchestrator = orchestratorFor(llm, {
      autoFixErrors: true,
      javascriptRuntime: runtime,
      events: { onRunStatus: (_id, status) => statuses.push(status) },
    });
    await orchestrator.submitUserInput('draw a red circle');
    await vi.waitFor(() => expect(statuses.some((s) => s.text.includes('came back incomplete'))).toBe(true), { timeout: 3000 });
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
    expect(executed).toEqual([DRAWING]);
  });
});


describe('fix turns and compaction', () => {
  it('a fix turn skips the compaction check and asks for an exact reply', async () => {
    const llm = new QueueLlm([DRAWING, 'ctx.fillStyle = "red";']);
    const { runtime } = fakeRuntime([{ error: 'boom is not defined', errorLine: 3 }]);
    const store = new ConversationMemoryStore();
    const check = vi.spyOn(store, 'isContextCompactionNeeded').mockReturnValue(true);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime, memoryStore: store });
    await orchestrator.submitUserInput('draw a red circle');
    await vi.waitFor(() => expect(llm.turns.length).toBe(2), { timeout: 3000 });
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
    // Only the normal turn asked (and compacted); the fix turn did not
    expect(check).toHaveBeenCalledTimes(1);
    expect(llm.turns.at(-1)!.systemPrompt).toBe(FIX_SYSTEM_PROMPT);
    expect(llm.turns.at(-1)!.exact).toBe(true);
    expect(llm.turns[0].exact).toBeUndefined();
  });

  it('fix turns do not count toward the verbatim turns kept', () => {
    const store = new ConversationMemoryStore({ maxVerbatimTurns: 2, compactionSlack: 0 });
    const add = (id: string, turnId: string, role: 'user' | 'assistant', autoFix = false) =>
      store.addMessage({ id, turnId, role, canonicalContent: id, timestamp: 0, ...(autoFix ? { autoFix: true } : {}) });
    add('u1', 't1', 'user');
    add('a1', 't1', 'assistant');
    add('fixu', 't2', 'user', true);
    add('fixa', 't2', 'assistant');
    expect(store.compactIfNecessary()).toBeNull();
    expect(store.getMessages().length).toBe(4);
    add('u3', 't3', 'user');
    add('a3', 't3', 'assistant');
    store.compactIfNecessary();
    expect(store.getMessages().map((m) => m.id)).toEqual(['fixu', 'fixa', 'u3', 'a3']); // the fix turns stay but count for nothing
  });
});

describe('the optional rules follow the request', () => {
  const canvas = 'Use <canvas>';
  const sound = 'Sound: music and instruments: out is ready to use';
  const facts = 'public API';
  const cases: Array<[string, { canvas?: boolean; sound?: boolean; facts?: boolean }]> = [
    ['Draw a rainbow over green hills on a canvas', { canvas: true }],
    ['Play a music loop with a G major chord on piano, a walking bass line and a boom-chuck drum track', { sound: true }],
    ['Animate a ball bouncing around the screen', { canvas: true }],
    ['Code a tip calculator app with a UI for the bill and tip %', {}],
    ['Show a big ten second countdown on screen', {}],
    ['Who was Ada Lovelace?', { facts: true }],
    ["What's 15 percent of 84?", {}],
  ];
  it.each(cases)('%s', (request, want) => {
    const rules = promptRules(request, true);
    expect(rules.includes(canvas)).toBe(!!want.canvas);
    expect(rules.includes(sound)).toBe(!!want.sound);
    expect(rules.includes(facts)).toBe(!!want.facts);
  });

  it('does not match "start" as a star or "article" as art', () => {
    expect(promptRules('start the timer, then read the article', true).includes(canvas)).toBe(false);
  });
});

describe('the fix log', () => {
  it('records each fix turn and its outcome in localStorage, keeping the last 50', async () => {
    const store: Record<string, string> = { chatty_fix_log: JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ time: i }))) };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
    });
    try {
      const llm = new QueueLlm([DRAWING, 'Sure, let me fix that for you right away.']);
      const { runtime } = fakeRuntime([{ error: 'boom is not defined', errorLine: 3 }]);
      const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
      await orchestrator.submitUserInput('draw a red circle');
      await vi.waitFor(() => expect(llm.turns.length).toBe(2), { timeout: 3000 });
      await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
      const log = JSON.parse(store.chatty_fix_log);
      expect(log.length).toBe(50);
      expect(log.at(-1)).toMatchObject({ modelId: 'queue', error: 'boom is not defined', line: 3, outcome: 'lost' });
      expect(log.at(-1).markedLine).toBe('root.appendChild(canvas);');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('missing methods', () => {
  it('corrects a slipped method name before the program runs, without the model', async () => {
    const program = 'document.body.innerHTML = "<p></p>";\nconst box = document.getElementById("b");\nbox.querySelectorall("p");\nspeak("Done.");';
    const llm = new QueueLlm([program]);
    const { executed, runtime } = fakeRuntime([]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Make a box');
    await vi.waitFor(() => expect(executed.length).toBe(1), { timeout: 5000 });
    expect(executed[0]).toContain('box.querySelectorAll("p");');
    // No fix turn: the model was asked once, for the program
    expect(llm.turns.length).toBe(1);
  });

  it('gives the fix request the real methods of the object when the name is not a slip', async () => {
    const program = 'const box = document.getElementById("b");\nbox.vanish();\nspeak("Gone.");';
    const llm = new QueueLlm([program, 'box.remove();']);
    const { runtime } = fakeRuntime([{ error: 'box.vanish is not a function', errorLine: 2 }]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Make the box vanish');
    await vi.waitFor(() => expect(llm.turns.length).toBe(2), { timeout: 5000 });
    expect(llm.turns[1].messages.at(-1)!.content).toMatch(/box is a HTMLElement, which has no vanish\(\)\. Its closest methods: /);
  });
});

describe('a reply that only talks', () => {
  it('is written again once, cooler, when the request asks for something to be made', async () => {
    const llm = new QueueLlm(['speak("Starting the loop now.");', 'const x = 1;\nspeak("Here it is.");']);
    const { executed, runtime } = fakeRuntime([]);
    const orchestrator = orchestratorFor(llm, { javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Play a music loop');
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
    expect(llm.turns.length).toBe(2);
    expect(llm.turns[1].retry).toBe(1);
    expect(llm.turns[1].messages.at(-1)!.content).toBe('Play a music loop\n(Write the JavaScript program that does this, then one speak() sentence about it.)');
    expect(executed).toEqual(['const x = 1;\nspeak("Here it is.");']);
  });

  it('is left alone for plain conversation', async () => {
    const llm = new QueueLlm(['speak("Doing well, thanks!");']);
    const orchestrator = orchestratorFor(llm, { javascriptRuntime: fakeRuntime([]).runtime });
    await orchestrator.submitUserInput('How are you?');
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
    expect(llm.turns.length).toBe(1);
  });
});

describe('a fix that changes nothing', () => {
  it('is followed once by a fix of the whole function around the failing line', async () => {
    const program = 'function playAll() {\n  const plays = [1, 2].map((n) => play(n));\n  plays.forEach((p) => p.stop());\n}\nplayAll();\nspeak("Playing.");';
    const fixedFunction = 'function playAll() {\n  [1, 2].forEach((n) => play(n));\n}';
    const llm = new QueueLlm([program, '// Cause: p is undefined\nplays.forEach((p) => p.stop());', `// Cause: play() returns nothing\n${fixedFunction}`]);
    const { executed, runtime } = fakeRuntime([{ error: "undefined is not an object (evaluating 'p.stop')", errorLine: 3 }]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Play two notes');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 8000 });
    const blockAsk = llm.turns[2].messages.at(-1)!.content;
    expect(blockAsk).toContain('the whole marked function, corrected');
    expect(blockAsk).toContain('// >>> ERROR');
    expect(executed[1]).toBe(`${fixedFunction}\nplayAll();\nspeak("Playing.");`);
  });
});

describe('more than one fix attempt', () => {
  it("fixes a fix's own failing program, up to five attempts, each sampled differently and told earlier errors", async () => {
    const program = 'function draw() {\n  boom();\n}\ndraw();\nspeak("Drawn.");';
    const fixes = ['bang', 'bang2', 'zap', 'ok', 'fin', 'never'].map((name) => `// Cause: try ${name}\n  ${name}();`);
    const llm = new QueueLlm([program, ...fixes]);
    const { executed, runtime } = fakeRuntime([
      { error: 'boom is not defined', errorLine: 2 },
      { error: 'bang is not defined', errorLine: 2 },
      { error: 'bang is not defined', errorLine: 2 },
      { error: 'zap is not defined', errorLine: 2 },
      { error: 'ok is not defined', errorLine: 2 },
      { error: 'fin is not defined', errorLine: 2 },
    ]);
    const notices: string[] = [];
    const orchestrator = orchestratorFor(llm, {
      autoFixErrors: true,
      javascriptRuntime: runtime,
      events: { onMessageCreated: (m) => m.fixNotice && notices.push(m.fixNotice) },
    });
    await orchestrator.submitUserInput('Draw it');
    await vi.waitFor(() => expect(executed.length).toBe(6), { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1500));
    // The request, then five fixes; the sixth error gets no sixth fix
    expect(llm.turns.length).toBe(6);
    // The first fix is the most likely one; each later one samples warmer and wider
    expect(llm.turns[1].exact).toBe(true);
    const temps = llm.turns.slice(2).map((t) => t.sampling?.temperature);
    const topPs = llm.turns.slice(2).map((t) => t.sampling?.topP);
    expect(new Set(temps).size).toBe(4);
    expect(new Set(topPs).size).toBe(4);
    // The fifth fix is told each earlier error that differs from the current one, once
    const last = llm.turns[5].messages.at(-1)!.content;
    expect(last).toContain('The first program failed at line 2: boom is not defined');
    expect(last).toContain('Fix 1 failed at line 2: bang is not defined');
    expect(last).not.toContain('Fix 2 failed');
    expect(last).toContain('Fix 3 failed at line 2: zap is not defined');
    expect(last).not.toMatch(/Fix 4 failed/);
    // Each attempt says in the chat what it is fixing
    expect(notices).toEqual([
      'Trying to fix: boom is not defined',
      'Trying to fix: bang is not defined',
      'Trying to fix: bang is not defined',
      'Trying to fix: zap is not defined',
      'Trying to fix: ok is not defined',
    ]);
    // The first fix has nothing earlier to be told
    expect(llm.turns[1].messages.at(-1)!.content).not.toContain('Earlier attempts');
  }, 30000);

  it('does not run a function fix that drops the function, and asks again', async () => {
    const program = 'function compile(gl) {\n  gl.make();\n  gl.bad();\n}\ncompile(x);\nspeak("Done.");';
    const llm = new QueueLlm([
      program,
      '// Cause: same line\n  gl.make();',
      '// Cause: dropped the function\nconst shader = 1;',
      '// Cause: bad is wrong\nfunction compile(gl) {\n  gl.make();\n  gl.good();\n}',
    ]);
    const { executed, runtime } = fakeRuntime([{ error: 'gl.bad is not a function', errorLine: 2 }, {}]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Compile it');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    expect(llm.turns.length).toBe(4);
    expect(executed[1]).toContain('gl.good();');
    expect(executed[1]).toContain('function compile(gl)');
  });
});
