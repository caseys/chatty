import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ConversationMemoryStore } from '../src/core/memory-store.ts';
import {
  COMPACTION_SYSTEM_PROMPT,
  ConversationOrchestrator,
  FORMAT_TURNS,
  type RunStatus,
} from '../src/core/orchestrator.ts';
import { prefersLineFix, promptRules } from '../src/core/orchestrator.ts';
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

/** An unusable fix reply given on every one of the 5 tries (each try asks a new question) */
const asked = (reply: string) => Array<string>(5).fill(reply);

/** Replies from a list, one per request; summaries for compaction. Records every call. */
class QueueLlm implements LlmRuntimeProvider {
  readonly id = 'queue';
  modelId = 'queue';
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = false;
  calls: LlmGenerationOptions[] = [];
  /** Requests made to write a reply (not compaction) */
  turns: LlmGenerationOptions[] = [];
  /** Line fixes asked again within the same try */
  reasks: LlmGenerationOptions[] = [];
  private lastAsked = '';
  private lastText = '';
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
    // A line fix asked again at once (same prompt, same try): the same unusable reply comes back,
    // and it is not one of the tries the tests below count
    const askedKey = JSON.stringify([options.systemPrompt, options.messages]);
    const again = !compacting && options.fixShape === 'line' && askedKey === this.lastAsked;
    if (!compacting) this.lastAsked = askedKey;
    if (again) this.reasks.push(recorded);
    else if (!compacting) this.turns.push(recorded);
    const text = compacting ? 'The user chatted at length.' : again ? this.lastText : (this.replies.shift() ?? 'speak("ok");');
    if (!compacting) this.lastText = text;
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
function fakeRuntime(
  results: Array<Partial<JavascriptExecutionResult>>,
  /** With `trials`, the runtime can trial-run programs (the blank stage); each trial takes the next result */
  page?: {
    trials?: Array<{ error: string | null; errorLine?: number; reached?: boolean }> | ((code: string) => { error: string | null; errorLine?: number; reached?: boolean });
    onTrial?: () => void;
    ids?: string[];
    fields?: string[];
  }
) {
  const executed: string[] = [];
  const trialled: string[] = [];
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
    ...(page?.trials
      ? {
          async trialRun(code: string) {
            trialled.push(code);
            page.onTrial?.();
            const trials = page.trials!;
            return typeof trials === 'function' ? trials(code) : (trials.shift() ?? { error: null });
          },
          pageIds: () => page.ids ?? [],
          pageFields: () => page.fields ?? [],
        }
      : {}),
  } as unknown as JavascriptRuntime;
  return { executed, trialled, runtime, state };
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
    const llm = new QueueLlm([DRAWING, ...asked(miss)]);
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
    const llm = new QueueLlm([DRAWING, ...asked(fixReply)]);
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
    // Each lost reply starts the next try at once; after the fifth Chatty gives up
    await vi.waitFor(() => expect(llm.turns.length).toBe(6), { timeout: 10000 });
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
    expect(fixReplyMsg.canonicalContent).toContain("I couldn't get this working after 5 tries");

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
    // The request stays, its program as what happened when it ran (not its code)
    const kept = later.messages.slice(FORMAT_TURNS.length);
    expect(kept[0]).toEqual({ role: 'user', content: 'draw a red circle' });
    expect(kept[1].role).toBe('assistant');
    expect(kept[1].content).toContain('it failed: boom is not defined');
    expect(kept[1].content).not.toContain('getContext');
    expect(kept.at(-1)).toEqual({ role: 'user', content: 'how are you?' });
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

    // The program stays in the history as what happened when it ran; the system prompt never
    // changes, and each turn only appends
    const [a, b, c, d] = llm.turns;
    expect(b.systemPrompt).toBe(a.systemPrompt);
    expect(b.messages.map((m) => m.content).join('\n')).toContain('(Your program showed something on screen');
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
    const filler = ' word'.repeat(600); // about 750 tokens a message
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
    // The system prompt's rules come to well over a 120-token stand-in
    expect(store.getCurrentContextTokens()).toBeGreaterThan(130);
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
    expect(tip).not.toContain('music and instruments play through Web MIDI');
    expect(tip).not.toContain('<canvas>');
    expect(tip).not.toMatch(/^\d+\. /m);
    const music = promptRules('Play a music loop with a G major chord on piano', true);
    expect(music).toContain('music and instruments play through Web MIDI');
    // An edit is matched against the program it changes too
    expect(promptRules('make it faster\nconst out = (await navigator.requestMIDIAccess())', true)).toContain('music and instruments play through Web MIDI');
    expect(promptRules('Draw a rainbow over green hills', true)).toContain('<canvas>');
    expect(promptRules('Who was Ada Lovelace?', true)).toContain('Wikipedia');
    // Unfiltered: every rule
    const all = promptRules();
    for (const part of ['music and instruments play through Web MIDI', '<canvas>', '<svg>', 'WebGL', 'Wikipedia']) expect(all).toContain(part);
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
    const llm = new QueueLlm([DRAWING, ...asked(CUT)]);
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
  const sound = 'Sound: music and instruments play through Web MIDI';
  const facts = 'en.wikipedia.org/api/rest_v1';
  const cases: Array<[string, { canvas?: boolean; sound?: boolean; facts?: boolean }]> = [
    ['Draw a beach sunset with rainbow sky and deep purple ocean', { canvas: true }],
    ['Build a blues music loop with piano, bass, and drums in G minor, 120 bpm, 4 measures', { sound: true }],
    ['Play a music loop with a G major chord on piano, a walking bass line and a boom-chuck drum track', { sound: true }],
    ['Animate 10 colored balls bouncing around the screen', { canvas: true }],
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
      const llm = new QueueLlm([DRAWING, ...asked('Sure, let me fix that for you right away.')]);
      const { runtime } = fakeRuntime([{ error: 'boom is not defined', errorLine: 3 }]);
      const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
      await orchestrator.submitUserInput('draw a red circle');
      await vi.waitFor(() => expect(llm.turns.length).toBe(5), { timeout: 3000 });
      await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
      const log = JSON.parse(store.chatty_fix_log);
      expect(log.length).toBe(50);
      // The lost fix is followed by another attempt, with its own entry
      const lost = log.find((e: { outcome?: string }) => e.outcome === 'lost');
      expect(lost).toMatchObject({ modelId: 'queue', error: 'boom is not defined', line: 3 });
      expect(lost.markedLine).toBe('root.appendChild(canvas);');
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
  it('goes to the chat; a question waits for the answer, a statement is followed by a request for the program', async () => {
    // A question: said, and nothing more is asked of the model
    const asking = new QueueLlm(['speak("Should the ball be red or blue?");']);
    const asked = fakeRuntime([{}]);
    (asked.runtime as unknown as { hasVisualContent: () => boolean }).hasVisualContent = () => false;
    const one = orchestratorFor(asking, { autoFixErrors: true, javascriptRuntime: asked.runtime });
    await one.submitUserInput('Animate a ball bouncing around the screen');
    await vi.waitFor(() => expect(asked.executed.length).toBe(1));
    await new Promise((r) => setTimeout(r, 2500));
    expect(asking.turns.length).toBe(1);
    expect(asked.executed[0]).toBe('speak("Should the ball be red or blue?");');

    // A statement: said, then the program is asked for (not retried out of sight)
    const telling = new QueueLlm(['speak("Starting the loop now.");', 'const x = 1;\nspeak("Here it is.");']);
    const told = fakeRuntime([{}, {}]);
    (told.runtime as unknown as { soundUseCount: () => number }).soundUseCount = () => 0;
    const two = orchestratorFor(telling, { autoFixErrors: true, javascriptRuntime: told.runtime });
    await two.submitUserInput('Play a music loop');
    await vi.waitFor(() => expect(telling.turns.length).toBe(2), { timeout: 10000 });
    expect(told.executed[0]).toBe('speak("Starting the loop now.");');
    expect(telling.turns[1].messages.at(-1)!.content).toContain('Write the complete JavaScript program for: Play a music loop');
  }, 20000);

  it('is left alone for plain conversation', async () => {
    const llm = new QueueLlm(['speak("Doing well, thanks!");']);
    const orchestrator = orchestratorFor(llm, { javascriptRuntime: fakeRuntime([]).runtime });
    await orchestrator.submitUserInput('How are you?');
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
    expect(llm.turns.length).toBe(1);
  });
});

describe('a fix that changes nothing', () => {
  it('is followed at once by a fix of the whole function around the failing line', async () => {
    const program = 'function playAll() {\n  const plays = [1, 2].map((n) => play(n));\n  plays.forEach((p) => p.stop());\n}\nplayAll();\nspeak("Playing.");';
    const fixedFunction = 'function playAll() {\n  [1, 2].forEach((n) => play(n));\n}';
    const llm = new QueueLlm([program, '// Cause: p is undefined\nplays.forEach((p) => p.stop());', `// Cause: play() returns nothing\n${fixedFunction}`]);
    const { executed, runtime } = fakeRuntime([{ error: "undefined is not an object (evaluating 'p.stop')", errorLine: 3 }]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Play two notes');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 8000 });
    expect(llm.turns.map((t) => t.fixShape)).toEqual([undefined, 'line', 'function']);
    const blockAsk = llm.turns[2].messages.at(-1)!.content;
    expect(blockAsk).toContain('the whole marked function, corrected');
    expect(blockAsk).toContain('// >>> ERROR');
    expect(executed[1]).toBe(`${fixedFunction}\nplayAll();\nspeak("Playing.");`);
  });
});

describe('more than one fix attempt', () => {
  it('moves on to the whole program after a top-level line whose fix did not parse', async () => {
    const program = 'const a = 1;\nboom();\nconst canvas = 2;\nspeak("Done.");';
    const llm = new QueueLlm([
      program,
      '// Cause: remove it\nconst canvas = 2;',
      '// Cause: remove it\nconst a = 1;\nconsole.log(a);\nconst canvas = 2;\nspeak("Done.");',
    ]);
    const { executed, runtime } = fakeRuntime([{ error: 'boom is not defined', errorLine: 2 }, {}]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Do it');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    // No enclosing function: the line, then the whole program (never the same question twice)
    expect(llm.turns.map((t) => t.fixShape)).toEqual([undefined, 'line', 'program']);
    expect(llm.turns[2].messages.at(-1)!.content).toContain('Your last reply was not a working fix');
    expect(executed[1]).toContain('console.log(a);');
  });

  it("fixes a fix's own failing program, up to five attempts, each sampled differently and told earlier errors", async () => {
    const program = 'function draw() {\n  boom();\n}\ndraw();\nspeak("Drawn.");';
    // Tries ask line, function, program, then the line again ("different"), then the program once more
    const asksFor = (name: string, shape: 'line' | 'function' | 'program') =>
      shape === 'line'
        ? `// Cause: try ${name}\n  ${name}();`
        : `// Cause: try ${name}\nfunction draw() {\n  ${name}();\n}${shape === 'program' ? '\ndraw();\nspeak("Drawn.");' : ''}`;
    const fixes = [
      asksFor('bang', 'line'),
      asksFor('bang2', 'function'),
      asksFor('zap', 'program'),
      asksFor('ok', 'line'),
      asksFor('fin', 'program'),
    ];
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
      events: { onMessageCreated: (m) => m.fixNotice && m.fixNotice !== 'Generating…' && notices.push(m.fixNotice) },
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
    // A small model's swings, scaled so the hottest is 1 (forModel)
    expect(llm.turns.slice(2).map((t) => t.sampling)).toEqual([
      { temperature: 0.77, topP: 0.99 },
      { temperature: 0.38, topP: 0.6 },
      { temperature: 1, topP: 0.95 },
      { temperature: 0.62, topP: 0.75 },
    ]);
    expect(new Set(temps).size).toBe(4);
    expect(new Set(topPs).size).toBe(4);
    // Each try asks the next kind of question; a new error starts again from the line
    expect(llm.turns.map((t) => t.fixShape)).toEqual([undefined, 'line', 'line', 'function', 'line', 'line']);
    // The fifth fix is told each earlier error that differs from the current one, once
    const last = llm.turns[5].messages.at(-1)!.content;
    expect(last).toContain('The first program failed at line 2: boom is not defined');
    expect(last).toContain('Fix 1 failed at line 2: bang is not defined');
    expect(last).not.toContain('Fix 2 failed');
    expect(last).toContain('Fix 3 failed at line 2: zap is not defined');
    expect(last).not.toMatch(/Fix 4 failed/);
    // Each attempt says in the chat what it is fixing
    expect(notices).toEqual([
      'Fixing (1 of 5): boom is not defined',
      'Fixing (2 of 5): bang is not defined',
      'Fixing (3 of 5): bang is not defined',
      'Fixing (4 of 5): zap is not defined',
      'Fixing (5 of 5): ok is not defined',
    ]);
    // Each fix is still for the original request, not for the fix request before it
    expect(last).toContain('This program was written for: Draw it\n');
    expect(last).not.toContain('written for: This program');
    // After the last attempt fails, Chatty says so and what to do (once, not after each attempt)
    const said = orchestrator.memoryStore.getMessages().filter((m) => m.role === 'assistant').map((m) => m.canonicalContent).join('\n');
    expect(said).toContain("I couldn't get this working after 5 tries (the last error: fin is not defined)");
    expect(said).not.toContain('Something went wrong');
    // The first fix has nothing earlier to be told
    expect(llm.turns[1].messages.at(-1)!.content).not.toContain('Earlier attempts');
  }, 30000);

  it('does not run a function fix that drops the function, and asks the next question', async () => {
    const program = 'function compile(gl) {\n  gl.make();\n  gl.bad();\n}\ncompile(x);\nspeak("Done.");';
    const llm = new QueueLlm([
      program,
      '// Cause: same line\n  gl.make();',
      '// Cause: dropped the function\nconst shader = 1;',
      '// Cause: bad is wrong\nfunction compile(gl) {\n  gl.make();\n  gl.good();\n}\ncompile(x);\nspeak("Done.");',
    ]);
    const { executed, runtime } = fakeRuntime([{ error: 'gl.bad is not a function', errorLine: 2 }, {}]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Compile it');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    expect(llm.turns.map((t) => t.fixShape)).toEqual([undefined, 'line', 'function', 'program']);
    expect(executed.length).toBe(2); // neither the unchanged line nor the dropped function ran
    expect(llm.turns[3].messages.at(-1)!.content).toContain('Your last reply was not a working fix');
    expect(executed[1]).toContain('gl.good();');
    expect(executed[1]).toContain('function compile(gl)');
  });
});

describe('a fix reply that is unusable starts the next try at once', () => {
  const program = 'function draw() {\n  boom();\n}\ndraw();\nspeak("Drawn.");';
  const unchanged = '// Cause: nothing\n  boom();';
  const unchangedFunction = '// Cause: nothing\nfunction draw() {\n  boom();\n}';
  const goodFunction = '// Cause: typo\nfunction draw() {\n  fixed();\n}';
  const goodProgram = '// Cause: typo\nfunction draw() {\n  fixed();\n}\ndraw();\nspeak("Drawn.");';
  const failing = () => [{ error: 'boom is not defined', errorLine: 2 }, {}];

  it('asks a different question with a different sampling, told what went wrong, with its own notice', async () => {
    const llm = new QueueLlm([program, unchanged, goodFunction]);
    const { executed, runtime } = fakeRuntime(failing());
    const notices: string[] = [];
    const orchestrator = orchestratorFor(llm, {
      autoFixErrors: true,
      javascriptRuntime: runtime,
      events: { onMessageCreated: (m) => void (m.fixNotice && m.fixNotice !== 'Generating…' && notices.push(m.fixNotice)) },
    });
    await orchestrator.submitUserInput('Draw it');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    expect(llm.turns.length).toBe(3);
    expect(executed[1]).toContain('fixed();');
    // The unchanged line was not run; the next try is the function, never the line again
    expect(llm.turns[1].exact).toBe(true);
    expect(llm.turns[2].messages).not.toEqual(llm.turns[1].messages);
    expect(llm.turns[2].messages.at(-1)!.content).toContain('Your last reply was not a working fix (');
    expect(llm.turns[2].sampling).toEqual({ temperature: 0.77, topP: 0.99 }); // scaled for a small model
    // (the unchanged line fix is asked again twice within the first try)
    expect(notices).toEqual([
      'Fixing (1 of 5): boom is not defined',
      'Fixing (2 of 5): boom is not defined',
    ]);
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
  });

  it('never asks the same question twice in a row, and samples each try with its own swing', async () => {
    const llm = new QueueLlm([program, unchanged, unchangedFunction, goodProgram]);
    const { executed, runtime } = fakeRuntime(failing());
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Draw it');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    expect(llm.turns.map((t) => t.fixShape)).toEqual([undefined, 'line', 'function', 'program']);
    expect(llm.turns.slice(2).map((t) => t.sampling)).toEqual([
      { temperature: 0.77, topP: 0.99 },
      { temperature: 0.38, topP: 0.6 },
    ]);
    expect(executed.length).toBe(2); // the unchanged replies never ran
  });

  it('tells the runtime the shape of the fix', async () => {
    const llm = new QueueLlm([program, unchanged, goodFunction]);
    const { executed, runtime } = fakeRuntime(failing());
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Draw it');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    expect(llm.turns[0].fixShape).toBeUndefined();
    expect(llm.turns[1].fixShape).toBe('line');
    expect(llm.turns[2].fixShape).toBe('function');
  });
});

describe('the order of a request\'s fix questions', () => {
  const program = 'function draw() {\n  boom();\n}\ndraw();\nspeak("Drawn.");';
  // A small model's swings, scaled so the hottest is 1 (forModel)
  const SWINGS = [
    { temperature: 0.77, topP: 0.99 },
    { temperature: 0.38, topP: 0.6 },
    { temperature: 1, topP: 0.95 },
    { temperature: 0.62, topP: 0.75 },
  ];
  /** A fix reply for a question that fails again with the error `name` (a different function body each time) */
  const bad = (name: string, shape: string) =>
    shape === 'line' ? `// Cause: ${name}\n  ${name}();` : `// Cause: ${name}\nfunction draw() {\n  ${name}();\n}${shape === 'program' ? '\ndraw();\nspeak("Drawn.");' : ''}`;
  // (the same error on every try: a new error would start again from the first question)
  const errors = (names: string[]) => [{ error: 'boom is not defined', errorLine: 2 }, ...names.map(() => ({ error: 'boom is not defined', errorLine: 2 }))];

  it('asks a small model the blank, line, function, program and a different question, then gives up', async () => {
    const TOTAL = [
      'function show() {',
      "  const label = document.getElementById('total');",
      '  const price = 12;',
      "  label.textContent = 'Total: ' + sumTotal;",
      '}',
      'show();',
      "speak('Done.');",
    ].join('\n');
    const err = { error: 'sumTotal is not defined', errorLine: 4 };
    const names = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const llm = new QueueLlm([
      TOTAL,
      'A', // the blank stage: the choice fails its test run, the expressions follow
      'zero', 'zero', 'zero',
      bad('b1', 'line'),
      bad('b2', 'function'),
      bad('b3', 'program'),
      bad('b4', 'line'),
    ]);
    llm.modelId = 'qwen3-0.6b';
    const { executed, runtime } = fakeRuntime([err, ...names.map((n) => ({ error: `${n} is not defined`, errorLine: 3 }))], {
      trials: () => ({ ...err }),
      ids: ['total'],
    });
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Add up my cart');
    await vi.waitFor(() => expect(llm.turns.filter((t) => t.fixShape && t.fixShape !== 'choice' && t.fixShape !== 'expression').length).toBeGreaterThanOrEqual(4), { timeout: 20000 });
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull(), { timeout: 20000 });
    const shapes = llm.turns.map((t) => t.fixShape);
    // Try 1 is the blank stage, then each try asks the next kind, never one it asked before
    expect(shapes[1]).toBe('choice');
    expect(shapes.slice(shapes.lastIndexOf('expression') + 1)).toEqual(['line', 'function', 'program', 'line']);
    const said = orchestrator.memoryStore.getMessages().filter((m) => m.role === 'assistant').map((m) => m.canonicalContent).join('\n');
    expect(said).toContain("I couldn't get this working after 5 tries");
    expect(executed.length).toBe(1); // no reply ran: each failed its test run
  }, 30000);

  it('goes through the five questions of a small model, each sampled differently, then says it gave up', async () => {
    // No test runs here, so the blank is not asked: the order starts at the line
    const llm = new QueueLlm([program, bad('b1', 'line'), bad('b2', 'function'), bad('b3', 'program'), bad('b4', 'line'), bad('b5', 'program')]);
    llm.modelId = 'qwen3-0.6b';
    const { executed, runtime } = fakeRuntime(errors(['b1', 'b2', 'b3', 'b4', 'b5']));
    const notices: string[] = [];
    const orchestrator = orchestratorFor(llm, {
      autoFixErrors: true,
      javascriptRuntime: runtime,
      events: { onMessageCreated: (m) => void (m.fixNotice && m.fixNotice !== 'Generating…' && notices.push(m.fixNotice)) },
    });
    await orchestrator.submitUserInput('Draw it');
    await vi.waitFor(() => expect(executed.length).toBe(6), { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1000));
    expect(llm.turns.length).toBe(6); // the request and five tries, nothing after the fifth
    expect(llm.turns.map((t) => t.fixShape)).toEqual([undefined, 'line', 'function', 'program', 'line', 'program']);
    expect(llm.turns[1].exact).toBe(true);
    expect(llm.turns.slice(2).map((t) => t.sampling)).toEqual(SWINGS);
    expect(notices.map((n) => n.replace(/:.*/, ''))).toEqual(['Fixing (1 of 5)', 'Fixing (2 of 5)', 'Fixing (3 of 5)', 'Fixing (4 of 5)', 'Fixing (5 of 5)']);
    const said = orchestrator.memoryStore.getMessages().filter((m) => m.role === 'assistant').map((m) => m.canonicalContent).join('\n');
    expect(said).toContain("I couldn't get this working after 5 tries (the last error: boom is not defined)");
    expect(said.match(/I couldn't get this working/g)).toHaveLength(1);
  }, 30000);

  it('asks a large model the line, function, blank, program and a different question', async () => {
    const TOTAL = [
      'function show() {',
      "  const label = document.getElementById('total');",
      '  const price = 12;',
      "  label.textContent = 'Total: ' + sumTotal;",
      '}',
      'show();',
      "speak('Done.');",
    ].join('\n');
    const typo = (n: number) => `// Cause: typo ${n}\n  label.textContent = 'Total: ' + sumTotl${n};`;
    const fn = `// Cause: typo\nfunction show() {\n  const label = document.getElementById('total');\n  label.textContent = 'Total: ' + sumTotl;\n}`;
    const err = { error: 'sumTotal is not defined', errorLine: 4 };
    const llm = new QueueLlm([TOTAL, typo(1), fn, 'A', 'z', 'z', 'z']);
    llm.modelId = 'gemma-4-e2b-it-web';
    const { runtime, executed } = fakeRuntime([err], { trials: () => ({ ...err }), ids: ['total'] });
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Add up my cart');
    await vi.waitFor(() => expect(llm.turns.some((t) => t.fixShape === 'expression')).toBe(true), { timeout: 20000 });
    const shapes = llm.turns.map((t) => t.fixShape);
    // The line first, then the function, then the blank stage (its choice and expressions)
    expect(shapes.slice(0, 4)).toEqual([undefined, 'line', 'function', 'choice']);
    expect(executed.length).toBe(1);
  }, 30000);

  it('skips a question that does not fit: no enclosing function moves from the line to the program', async () => {
    const flat = 'const a = 1;\nboom();\nspeak("Done.");';
    const llm = new QueueLlm([flat, '// Cause: x\nbang();', '// Cause: y\nconst a = 1;\nzap();\nspeak("Done.");']);
    const { executed, runtime } = fakeRuntime([{ error: 'boom is not defined', errorLine: 2 }, { error: 'boom is not defined', errorLine: 2 }, {}]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Do it');
    await vi.waitFor(() => expect(executed.length).toBe(3), { timeout: 10000 });
    expect(llm.turns.map((t) => t.fixShape)).toEqual([undefined, 'line', 'program']);
  });

  it('lists the earlier failed replies in the "different" question', async () => {
    const llm = new QueueLlm([program, bad('b1', 'line'), bad('b2', 'function'), bad('b3', 'program'), bad('b4', 'line')]);
    // Unchanged replies are remembered: the first line of each is listed
    const lines = ['// Cause: nothing\n  boom();', '// Cause: nothing\nfunction draw() {\n  boom();\n}', '// Cause: nothing\n  boom();'];
    llm.replies.splice(1, 4, lines[0], lines[1], 'Sure, let me fix that for you right away.', bad('b4', 'line'));
    const { runtime } = fakeRuntime(errors(['b1', 'b2', 'b3', 'b4', 'b5']));
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Draw it');
    await vi.waitFor(() => expect(llm.turns.length).toBe(5), { timeout: 20000 });
    const ask = llm.turns[4].messages.at(-1)!.content;
    expect(llm.turns[4].fixShape).toBe('line');
    expect(ask).toContain("Write a fix different from these, which didn't work:");
    expect(ask).toContain('`boom();`');
    expect(ask).toContain('`function draw() {`');
    expect(ask).toContain('`Sure, let me fix that for you right away.`');
  }, 30000);
});


describe('the blank stage', () => {
  const TOTAL = [
    'const cart = [3, 4, 5];',
    'const sum = cart.reduce((a, b) => a + b, 0);',
    "const label = document.getElementById('total');",
    "label.textContent = 'Total: ' + sumTotal;",
    "speak('Done.');",
  ].join('\n');
  const TOTAL_ERROR = { error: 'sumTotal is not defined', errorLine: 4 };
  const BOARD = ['const scores = [1, 2];', "const view = document.getElementById('board');", 'view.textContent = scores.length;'].join('\n');
  const BOARD_ERROR = { error: "Cannot set properties of null (setting 'textContent')", errorLine: 3 };

  it('runs the best-fitting choice at once when it runs cleanly, without asking for expressions', async () => {
    const llm = new QueueLlm([TOTAL, 'A']);
    const { executed, trialled, runtime } = fakeRuntime([TOTAL_ERROR, {}], {
      trials: (code) => (/'Total: ' \+ \(*\(globalThis\.__chattyReached = true\), sum\)*;|'Total: ' \+ sum;/.test(code) ? { error: null, reached: true } : { error: 'nope is not defined', errorLine: 4 }),
      ids: ['total'],
    });
    const notices: string[] = [];
    const orchestrator = orchestratorFor(llm, {
      autoFixErrors: true,
      javascriptRuntime: runtime,
      events: { onMessageCreated: (m) => m.fixNotice && m.fixNotice !== 'Generating…' && notices.push(m.fixNotice) },
    });
    await orchestrator.submitUserInput('Add up my cart');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    expect(llm.turns.map((t) => t.fixShape)).toEqual([undefined, 'choice']);
    expect(trialled.length).toBe(1);
    expect(executed[1]).toContain("'Total: ' + sum;");
    expect(notices).toEqual(['Fixing (1 of 5): sumTotal is not defined']);
  });

  it('asks for expressions when the best-fitting choice fails, and prefers a clean run to the votes', async () => {
    // sum fails here; the model writes cart.length three times, which runs
    const llm = new QueueLlm([TOTAL, 'A', 'cart.length', 'cart.length', 'cart.length']);
    const { executed, trialled, runtime } = fakeRuntime([TOTAL_ERROR, {}], {
      trials: (code) => (/cart\.length\)*;/.test(code) ? { error: null, reached: true } : { error: 'nope is not defined', errorLine: 4 }),
      ids: ['total'],
    });
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Add up my cart');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    expect(llm.turns.map((t) => t.fixShape)).toEqual([undefined, 'choice', 'expression', 'expression', 'expression']);
    expect(llm.turns[3].sampling).toBeDefined();
    expect(trialled.length).toBeLessThanOrEqual(6);
    expect(executed[1]).toContain("'Total: ' + cart.length;");
  });

  it('does not take a literal that only silences the error, nor a clean run that never reached the blank', async () => {
    const llm = new QueueLlm([TOTAL, 'A', '0', "''", '[]']);
    const { executed, trialled, runtime } = fakeRuntime([TOTAL_ERROR, {}], {
      // Every candidate "runs", but the blank's line never runs in the test
      trials: () => ({ error: null, reached: false }),
      ids: ['total'],
    });
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Add up my cart');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    expect(trialled.some((c) => /\+ \(*(?:0|''|\[\])\)*;/.test(c))).toBe(false);
    // Unproven runs tie, so the name decides
    expect(executed[1]).toContain("'Total: ' + sum;");
  });

  it('counts an error that is no longer about the blank as progress, and picks by name', async () => {
    // Both fields run (a test can't tell them apart); the name decides. The stage runs once per
    // request: what is left (tip) is for the next question
    const TIP = [
      "document.body.innerHTML = '<input id=\"billInput\"><input id=\"tipInput\"><p id=\"out\"></p>';",
      'const total = bill + bill * tip / 100;',
      "document.getElementById('out').textContent = total;",
    ].join('\n');
    const llm = new QueueLlm([TIP, 'B', 'x', 'x', 'x']);
    const { executed, runtime } = fakeRuntime(
      [{ error: 'bill is not defined', errorLine: 2 }, { error: 'tip is not defined', errorLine: 2 }, {}],
      {
        trials: (code) =>
          !/const bill\b/.test(code) && /\bbill\b(?!Input)/.test(code)
            ? { error: 'bill is not defined', errorLine: 2 }
            : !/const tip\b/.test(code) && /\btip\b(?!Input)/.test(code)
              ? { error: 'tip is not defined', errorLine: 3 }
              : { error: null },
        ids: ['billInput', 'tipInput', 'out'],
        fields: ['billInput', 'tipInput'],
      }
    );
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Code a tip calculator');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 20000 });
    // Declared once, after the page made its fields and before the line that uses it
    expect(executed[1].split('\n').slice(1, 3)).toEqual([
      "const bill = Number(document.getElementById('billInput').value);",
      'const total = bill + bill * tip / 100;',
    ]);
  }, 30000);

  it('falls back to the line fix as the next attempt when no candidate passes', async () => {
    const llm = new QueueLlm([BOARD, 'A', 'document.body', 'scores', 'view.parentNode', '// Cause: guard\nif (view) view.textContent = scores.length;']);
    const { executed, trialled, runtime } = fakeRuntime([BOARD_ERROR, {}], {
      // (the guarded line fix passes its own test run)
      trials: (code) => (code.includes('if (view)') ? { error: null } : { ...BOARD_ERROR }),
      ids: ['board', 'total'],
      fields: ['amount'],
    });
    const notices: string[] = [];
    const orchestrator = orchestratorFor(llm, {
      autoFixErrors: true,
      javascriptRuntime: runtime,
      events: { onMessageCreated: (m) => m.fixNotice && m.fixNotice !== 'Generating…' && notices.push(m.fixNotice) },
    });
    await orchestrator.submitUserInput('Show the score count');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 15000 });
    // The stage tried at most six candidates, each with a test run
    const candidates = trialled.filter((code) => !code.includes('if (view)'));
    expect(candidates.length).toBeGreaterThan(3);
    expect(candidates.length).toBeLessThanOrEqual(6);
    // Then the line fix, which is attempt 2 and is told the error
    expect(llm.turns.at(-1)!.fixShape).toBe('line');
    expect(notices).toEqual([`Fixing (1 of 5): ${BOARD_ERROR.error}`, `Fixing (2 of 5): ${BOARD_ERROR.error}`]);
    expect(executed[1]).toContain('if (view) view.textContent');
  }, 20000);

  it('stops when the user starts a new turn', async () => {
    const llm = new QueueLlm([BOARD, 'A', 'document.body', 'scores', 'view']);
    const holder: { o?: ConversationOrchestrator } = {};
    const { executed, trialled, runtime } = fakeRuntime([BOARD_ERROR, {}], {
      trials: Array.from({ length: 8 }, () => ({ ...BOARD_ERROR })),
      ids: ['board', 'total'],
      onTrial: () => void holder.o!.submitUserInput('Make it blue instead'),
    });
    holder.o = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await holder.o.submitUserInput('Show the score count');
    await vi.waitFor(() => expect(trialled.length).toBe(1), { timeout: 10000 });
    await vi.waitFor(() => expect(holder.o!.scheduler.getActiveTurnId()).toBeNull(), { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 300));
    // The stage stopped at the first test run, and no fix turn followed
    expect(trialled.length).toBe(1);
    expect(llm.turns.some((t) => t.fixShape === 'line' || t.fixShape === 'function')).toBe(false);
    expect(executed.length).toBeLessThanOrEqual(2);
  });

  // A request whose line fix repeats the error in its test run, then one that passes
  const LINE_TRIALS = (code: string) =>
    /\+ sum;|\+ \(*\(globalThis\.__chattyReached = true\), sum\)*;/.test(code) ? { error: null, reached: true } : { ...TOTAL_ERROR };

  it('moves on to the function when a line fix\'s test run repeats the error, and never runs that line', async () => {
    const program = 'function draw() {\n  boom();\n}\ndraw();\nspeak("Drawn.");';
    const llm = new QueueLlm([program, '// Cause: x\n  bang();', '// Cause: typo\nfunction draw() {\n  ok();\n}']);
    llm.modelId = 'gemma-4-e2b-it-web';
    const { executed, trialled, runtime } = fakeRuntime([{ error: 'boom is not defined', errorLine: 2 }, {}], {
      trials: (code) => (code.includes('ok();') ? { error: null } : { error: 'boom is not defined', errorLine: 2 }),
    });
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Draw it');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    expect(executed[1]).toContain('ok();');
    expect(executed.some((code) => code.includes('bang();'))).toBe(false);
    expect(trialled.length).toBe(4); // one test run per reply (the line fix asked three times)
    expect(llm.turns.map((t) => t.fixShape)).toEqual([undefined, 'line', 'function']);
    expect(llm.turns[2].sampling).toEqual({ temperature: 1, topP: 0.99 });
    expect(llm.turns[2].messages.at(-1)!.content).toContain('Your last reply was not a working fix');
  });

  it('asks a large model for the line fix first, and the blank stage second', async () => {
    const typo = "// Cause: typo\nlabel.textContent = 'Total: ' + sumTotl;";
    const llm = new QueueLlm([TOTAL, typo, 'A']);
    llm.modelId = 'gemma-4-e2b-it-web';
    const { executed, runtime } = fakeRuntime([TOTAL_ERROR, {}], { trials: LINE_TRIALS, ids: ['total'] });
    const notices: string[] = [];
    const orchestrator = orchestratorFor(llm, {
      autoFixErrors: true,
      javascriptRuntime: runtime,
      events: { onMessageCreated: (m) => m.fixNotice && m.fixNotice !== 'Generating…' && notices.push(m.fixNotice) },
    });
    await orchestrator.submitUserInput('Add up my cart');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    // The line fix (its test run repeats the error), then the next try: no function around the
    // line, so the blank stage
    expect(llm.turns.map((t) => t.fixShape)).toEqual([undefined, 'line', 'choice']);
    expect(executed[1]).toContain("'Total: ' + sum;");
    expect(notices).toEqual([
      'Fixing (1 of 5): sumTotal is not defined',
      'Fixing (2 of 5): sumTotal is not defined',
    ]);
  });

  it('keeps the blank stage first for a small model', async () => {
    const llm = new QueueLlm([TOTAL, 'A']);
    llm.modelId = 'qwen3-0.6b';
    const { executed, runtime } = fakeRuntime([TOTAL_ERROR, {}], { trials: LINE_TRIALS, ids: ['total'] });
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Add up my cart');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    expect(llm.turns.map((t) => t.fixShape)).toEqual([undefined, 'choice']);
  });

  it('knows which models are large', () => {
    for (const id of ['gemma-4-e2b-it-web', 'gemma-4-e4b-it-web', 'qwen2.5-coder-1.5b', 'qwen3-4b', 'qwen3.5-9b']) expect(prefersLineFix(id)).toBe(true);
    for (const id of ['qwen3-0.6b', 'llama-3.2-1b', 'qwen3.5-0.8b', 'queue']) expect(prefersLineFix(id)).toBe(false);
  });

  it('does nothing after it has given up, not even a sure correction', async () => {
    const program = "const total = () => 1;\nfunction draw() {\n  boom();\n}\ndraw();\nspeak('Drawn.');";
    const fn = (c: string) => `// Cause: try\nfunction draw() {\n  ${c}\n}`;
    const whole = (c: string) => `${fn(c)}\ndraw();\nspeak('Drawn.');`.replace('// Cause: try\n', "// Cause: try\nconst total = () => 1;\n");
    // (the questions asked: line, function, program, line again, program)
    const fixes = ['// Cause: try\n  bang();', fn('zap();'), whole('ok();'), '// Cause: try\n  fin();', whole('totl();')];
    const llm = new QueueLlm([program, ...fixes]);
    const { executed, runtime } = fakeRuntime([
      { error: 'boom is not defined', errorLine: 3 },
      { error: 'bang is not defined', errorLine: 3 },
      { error: 'zap is not defined', errorLine: 3 },
      { error: 'ok is not defined', errorLine: 3 },
      { error: 'fin is not defined', errorLine: 3 },
      { error: 'totl is not defined', errorLine: 3 },
    ]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Draw it');
    await vi.waitFor(() => expect(executed.length).toBe(6), { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(executed.length).toBe(6);
    const said = orchestrator.memoryStore.getMessages().filter((m) => m.role === 'assistant').map((m) => m.canonicalContent).join('\n');
    expect(said).toContain("I couldn't get this working after 5 tries");
  }, 30000);

  it('is skipped for a program that does not parse', async () => {
    const broken = 'const total = ;\nspeak("Done.");';
    const llm = new QueueLlm([broken, '// Cause: missing value\nconst total = 1;']);
    const { executed, trialled, runtime } = fakeRuntime([{ error: 'Unexpected token ;' }, {}], { trials: [] });
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Make a total');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    expect(trialled.length).toBe(1); // only the fix's own test run: no blank candidates
    expect(llm.turns[1].fixShape).toBe('function'); // the lines that don't parse, as before
  });
});

describe('which turns are about the last program, and which rules a request gets', () => {
  it('counts complaints as about the last program, and ordinary chat not', async () => {
    const { isComplaint } = await import('../src/core/phone-pipeline.ts');
    for (const t of ["it didn't work", 'no sound', 'still the same', 'nothing happened', "it doesn't loop", 'the car won’t move']) expect(isComplaint(t), t).toBe(true);
    for (const t of ['how are you?', 'draw a cat', 'thanks, that works', 'play it again']) expect(isComplaint(t), t).toBe(false);
  });

  it('sends the last program with a complaint, with a note saying so', async () => {
    const llm = new QueueLlm([DRAWING, 'speak("Fixed.");']);
    const orchestrator = orchestratorFor(llm);
    await orchestrator.submitUserInput('draw a red circle');
    await orchestrator.submitUserInput("it didn't work");
    const sent = llm.turns[1].messages;
    expect(sent.some((m) => m.role === 'assistant' && m.content === DRAWING)).toBe(true);
    expect(sent.at(-1)!.content).toContain('did not do what they asked');
  });

  it('gives three.js to games and 3D, and the facts rule to questions but not arithmetic', () => {
    const three = 'THREE (three.js) is ready to use';
    expect(promptRules('Build a racing game', true)).toContain(three);
    expect(promptRules('render a scene with a 3D cube', true)).toContain(three);
    expect(promptRules('Draw a cat', true)).not.toContain(three);
    const facts = 'For facts you lack';
    expect(promptRules('Who was Ada Lovelace?', true)).toContain(facts);
    expect(promptRules("What's 15 percent of 84?", true)).not.toContain(facts);
    expect(promptRules('Build a game where the car is steered by arrow keys', true)).not.toContain(facts);
    expect(promptRules('Build a racing game', true)).not.toContain('Use HTML and CSS for interfaces');
  });
});

describe('a program that does nothing the request asked for', () => {
  it('playing nothing for a sound request is its error, and a fix follows', async () => {
    const silent = 'const sounds = {};\nfunction playNote(n) { sounds[n] = 1; }\nplayNote("G");\nspeak("Playing.");';
    const llm = new QueueLlm([silent, '// Cause: never played\nout.send({ notes: "G major" });']);
    const { runtime } = fakeRuntime([{}, {}]);
    let uses = 0;
    Object.assign(runtime, { soundUseCount: () => uses });
    const statuses: string[] = [];
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime, events: { onRunStatus: (_id, s) => statuses.push(s.text) } });
    await orchestrator.submitUserInput('Play a G major chord');
    await vi.waitFor(() => expect(llm.turns.length).toBe(2), { timeout: 10000 });
    expect(statuses.some((t) => t.includes('The program played nothing'))).toBe(true);
    expect(llm.turns[1].messages.at(-1)!.content).toContain('Web MIDI output');
    uses = 1;
  }, 20000);

  it('a program that sounds is left alone', async () => {
    const llm = new QueueLlm(['out.send({ notes: "G major" });\nspeak("Playing.");']);
    const { runtime } = fakeRuntime([{}]);
    let uses = 0;
    Object.assign(runtime, {
      soundUseCount: () => uses,
      execute: async () => {
        uses++;
        return { success: true, logs: [], executionTimeMs: 1, mode: 'iframe' };
      },
    });
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Play a G major chord');
    await new Promise((r) => setTimeout(r, 300));
    expect(llm.turns.length).toBe(1);
  });
});

describe('speech mode says what is happening', () => {
  it('says "Generating." for a program and "Fixing." for each fix try, and nothing for a talk-only answer', async () => {
    const spoken: string[] = [];
    const llm = new QueueLlm(['speak("Hello!");', DRAWING, '// Cause: x\n  ctx.fill();']);
    const { runtime } = fakeRuntime([{}, { error: 'boom is not defined', errorLine: 3 }, {}]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, enableSpeechOutput: true, ttsProvider: countingTts(spoken), javascriptRuntime: runtime });
    await orchestrator.submitUserInput('hi');
    expect(spoken.join(' ')).not.toContain('Generating');
    await orchestrator.submitUserInput('draw a red circle');
    await vi.waitFor(() => expect(llm.turns.length).toBe(3), { timeout: 10000 });
    await vi.waitFor(() => expect(spoken.join(' ')).toContain('Fixing'), { timeout: 5000 });
    expect(spoken.join(' ')).toContain('Generating');
  }, 20000);
});

describe('a reply with no program in it', () => {
  it('asks for the whole program again, reminded to output only JavaScript, outside the tries and never shown as the user’s words', async () => {
    const llm = new QueueLlm(['```js\n// Plays a loop\n```', '// Cause: no program\nconst ctx = new AudioContext();\nconst osc = ctx.createOscillator();\nosc.connect(ctx.destination);\nosc.start();\nspeak("Done.");']);
    llm.modelId = 'qwen3-0.6b';
    const { runtime, executed } = fakeRuntime([{}, {}]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Play a looped melody');
    await vi.waitFor(() => expect(llm.turns.length).toBe(2), { timeout: 10000 });
    const ask = llm.turns[1].messages.at(-1)!.content;
    expect(ask).toContain('Write the complete JavaScript program for: Play a looped melody');
    expect(ask.split('\n')[0]).toBe('ONLY OUTPUT JAVASCRIPT. USE speak() TO CHAT WITH THE USER, AND WRITE THE PROGRAM THAT DOES THE REQUEST.');
    // Not one of the five tries, and no "Fixing" note in the chat
    expect(orchestrator.memoryStore.getMessages().some((m) => m.fixNotice)).toBe(false);
    expect(llm.turns[1].systemPrompt).not.toBe(FIX_SYSTEM_PROMPT);
    expect(ask).not.toContain('```');
    const asked = orchestrator.memoryStore.getMessages().filter((m) => m.role === 'user');
    expect(asked.at(-1)!.autoFix).toBe(true);
    await vi.waitFor(() => expect(executed.at(-1)).toContain('speak("Done.")'), { timeout: 5000 });
  }, 20000);
});

describe('a reply that only talks, for a request that shows something', () => {
  it('asks for a new program with the writing prompt, not a fix of the talk', async () => {
    const talk = 'speak("I could draw that for you.");';
    const llm = new QueueLlm([talk, talk, '// Cause: no canvas\nconst c = document.createElement("canvas");\ndocument.body.appendChild(c);\nspeak("A ball.");']);
    llm.modelId = 'qwen2.5-0.5b';
    const { runtime } = fakeRuntime([{}, {}]);
    (runtime as unknown as { hasVisualContent: () => boolean }).hasVisualContent = () => false;
    const statuses: RunStatus[] = [];
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime, events: { onRunStatus: (_id, status) => statuses.push(status) } });
    await orchestrator.submitUserInput('Animate a ball bouncing around the screen');
    await vi.waitFor(() => expect(llm.turns.length).toBeGreaterThanOrEqual(3), { timeout: 15000 });
    // Not shown as a failed program: the program is still to come
    expect(statuses[0]).toEqual({ kind: 'running', text: 'Writing the program…' });
    const fresh = llm.turns.at(-1)!;
    expect(fresh.messages.at(-1)!.content).toContain('Write the complete JavaScript program for: Animate a ball bouncing around the screen');
    expect(fresh.systemPrompt).not.toBe(FIX_SYSTEM_PROMPT);
    // A new program: no fix shape, no near-greedy decoding
    expect(fresh.fixShape).toBeUndefined();
    expect(fresh.exact).toBeUndefined();
  }, 30000);
});

describe('a program that showed nothing and puts nothing on the page', () => {
  it('gets a new program written, not a fix of what it did', async () => {
    const program = 'function animateBall() {\n  document.body.style.transform = "translate(5px, 0)";\n}\nanimateBall();';
    const llm = new QueueLlm([program, '// Cause: no canvas\nconst c = document.createElement("canvas");\ndocument.body.appendChild(c);\nspeak("A ball.");']);
    llm.modelId = 'qwen2.5-0.5b';
    const { runtime } = fakeRuntime([{}, {}]);
    let shown = false;
    (runtime as unknown as { hasVisualContent: () => boolean }).hasVisualContent = () => shown;
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Animate a ball bouncing around the screen');
    await vi.waitFor(() => expect(llm.turns.length).toBe(2), { timeout: 15000 });
    shown = true;
    const ask = llm.turns[1].messages.at(-1)!.content;
    expect(ask).toContain('Write the complete JavaScript program for: Animate a ball bouncing around the screen');
    expect(ask).not.toContain('document.body.style.transform');
    expect(llm.turns[1].systemPrompt).not.toBe(FIX_SYSTEM_PROMPT);
  }, 30000);
});

describe('a fix reply of only comments', () => {
  it('is not run: it lost the program', async () => {
    const program = 'const c = document.createElement("canvas");\ndocument.body.appendChild(c);\nboom();';
    const llm = new QueueLlm([program, "// Cause: no div\n// Solution: append a <div> instead of document.getElementById('canvas')", '// Cause: x\nconst c = 1;']);
    llm.modelId = 'qwen2.5-0.5b';
    const { executed, runtime } = fakeRuntime([{ error: "Can't find variable: boom", errorLine: 3 }, {}]);
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput('Draw a ball');
    await vi.waitFor(() => expect(llm.turns.length).toBeGreaterThanOrEqual(2), { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(executed.some((code) => /^\s*\/\/ Solution/.test(code))).toBe(false);
  }, 20000);
});

describe('notes on a run', () => {
  it('says Generating… once when a reply turns out to be a program, and Generation complete. when it says nothing', async () => {
    const llm = new QueueLlm(['const c = document.createElement("canvas");\ndocument.body.appendChild(c);']);
    const { runtime } = fakeRuntime([{ hasVisualOutput: true }]);
    const notes: string[] = [];
    const orchestrator = orchestratorFor(llm, { javascriptRuntime: runtime, events: { onMessageCreated: (m) => void (m.fixNotice && notes.push(m.fixNotice)) } });
    await orchestrator.submitUserInput('Draw a canvas');
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
    expect(notes).toEqual(['Generating…']);
    const reply = orchestrator.memoryStore.getMessages().filter((m) => m.role === 'assistant').at(-1)!;
    expect(reply.canonicalContent).toBe('Generation complete.');
    expect(reply.fromProgram).toBe(false);
  });
});
