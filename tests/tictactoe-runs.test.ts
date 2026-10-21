// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ConversationMemoryStore } from '../src/core/memory-store.ts';
import {
  COMPACTION_SYSTEM_PROMPT,
  ConversationOrchestrator,
  FORMAT_TURNS,
  type RunStatus,
} from '../src/core/orchestrator.ts';
import { prefersLineFix, promptRules, repairBeforeRunning, runScore, sameMissingMember } from '../src/core/orchestrator.ts';
import { FIX_SYSTEM_PROMPT } from '../src/core/line-fix.ts';
import { StateMachineCoordinator } from '../src/core/state-machine.ts';
import { runLogText } from '../src/core/run-log.ts';
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

/** A QueueLlm that can also score a multiple-choice question (scoreChoices), with the scores it is given */
class ScoringLlm extends QueueLlm {
  scored: Array<{ options: LlmGenerationOptions; labels: string[] }> = [];
  constructor(
    replies: string[],
    private readonly scores: number[] | null
  ) {
    super(replies);
  }
  async scoreChoices(options: LlmGenerationOptions, labels: string[]): Promise<number[] | null> {
    this.scored.push({ options: structuredClone({ ...options, signal: undefined }), labels });
    return this.scores;
  }
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
    tags?: Record<string, string>;
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
          pageTags: () => page.tags ?? {},
        }
      : {}),
  } as unknown as JavascriptRuntime;
  return { executed, trialled, runtime, state };
}

describe('the tic-tac-toe runs: lines, fills and the order of repairs', () => {
  // The program of the first live log: a canvas #board and two divs, an undeclared `canvas` in two functions
  const GAME = [
    'document.body.innerHTML = \'<div id="game"><canvas id="board"></canvas></div><div id="result"></div>\';',
    "let board = document.getElementById('board');",
    'function drawBoard() {',
    "  const ctx = canvas.getContext('2d');",
    '  ctx.fillRect(0, 0, 10, 10);',
    '}',
    'function drawBoardWithColors() {',
    "  const ctx = canvas.getContext('2d');",
    '  ctx.fillRect(0, 0, 20, 20);',
    '}',
    'drawBoardWithColors();',
  ].join('\n');
  const REQUEST = 'Make a tic-tac-toe game where two players take turns tapping the squares';
  const NOT_DEFINED = { error: 'canvas is not defined', errorLine: 8 };

  it('names the same line in the fix prompt as the runtime reports, after a repair took a line out at the top', async () => {
    // The request said back is taken out before the run; the runtime trims the program and counts from its first line
    const program = `speak("Hi! ${REQUEST}");\n${GAME.replace('canvas.getContext', 'boom.getContext')}`;
    const llm = new QueueLlm([program, '// Cause: boom is not defined\nconst ctx = board.getContext("2d");']);
    const { runtime, executed } = fakeRuntime([]);
    const run = runtime.execute.bind(runtime);
    runtime.execute = (async (code: string) => {
      const line = code.trim().split('\n').findIndex((l) => l.includes('boom.getContext')) + 1;
      const result = await run(code);
      return line ? { ...result, success: false, error: 'boom is not defined', errorLine: line } : result;
    }) as typeof runtime.execute;
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput(REQUEST);
    await vi.waitFor(() => expect(llm.turns.length).toBeGreaterThanOrEqual(2), { timeout: 15000 });
    // The program that ran is the program kept: no blank line at its top, the echo gone
    expect(executed[0]).toBe(executed[0].trim());
    expect(executed[0].startsWith('document.body.innerHTML')).toBe(true);
    const asked = llm.turns[1].messages.at(-1)!.content.split('\n');
    const marker = asked.findIndex((l) => l.includes('// >>> ERROR'));
    expect(asked[marker + 1]).toContain('boom.getContext');
  }, 30000);

  it('does not take an error at the fill itself as progress, and the mark is not in what is logged', async () => {
    const llm = new QueueLlm([GAME.replace('canvas', 'canvas'), 'A']);
    const lookups: string[] = [];
    const { executed, runtime } = fakeRuntime([NOT_DEFINED, {}], {
      trials: (code) => {
        // The candidate that is a div has no getContext: its failure is past the first line, in its own use
        const lookup = code.match(/getElementById\('(game|board|result)'\)\)?\.getContext|= \(*(?:\(globalThis\.__chattyReached = true\), )?document\.getElementById\('(game|board|result)'\)/);
        const id = (lookup?.[1] ?? lookup?.[2]) as string | undefined;
        if (id) lookups.push(id);
        return id && id !== 'board'
          ? { error: `(((globalThis.__chattyReached = true), document.getElementById('${id}'))).getContext is not a function. (In '(((globalThis.__chattyReached = true), document.getElementById('${id}'))).getContext('2d')', ...is undefined)`, errorLine: 9, reached: true }
          : { error: null, reached: true };
      },
      ids: ['game', 'board', 'result'],
      tags: { game: 'div', board: 'canvas', result: 'div' },
    });
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput(REQUEST);
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 20000 });
    // Declared once for both functions, from the element that works
    expect(executed[1]).toMatch(/const canvas = (?:board|document\.getElementById\('board'\));\nfunction drawBoard\(\)/);
    expect(executed[1].match(/const canvas/g)).toHaveLength(1);
    const log = runLogText();
    expect(log).not.toContain('__chattyReached');
    // A div that fails where it is used is no progress (the line says nothing of what ran)
    expect(log).not.toMatch(/getElementById\('(?:game|result)'\)` for `canvas` gave[^\n]*\(progress\)/);
  }, 30000);

  it('goes back to the program as it was when the fill fails where it is used, so the next try does not blank the fill', async () => {
    const llm = new QueueLlm([GAME, 'A', '// Cause: canvas is not defined\nconst canvas = board;']);
    // The test run passes, but the real run of the fill fails where the fill is used
    const { executed, runtime } = fakeRuntime([NOT_DEFINED, { error: 'canvas.getContext is not a function', errorLine: 5 }, {}], {
      trials: () => ({ error: null, reached: true }),
      ids: ['game', 'board', 'result'],
      tags: { game: 'div', board: 'canvas', result: 'div' },
    });
    const orchestrator = orchestratorFor(llm, { autoFixErrors: true, javascriptRuntime: runtime });
    await orchestrator.submitUserInput(REQUEST);
    await vi.waitFor(() => expect(llm.turns.length).toBeGreaterThanOrEqual(2), { timeout: 20000 });
    expect(runLogText()).toContain('failed where it was used');
    expect(runLogText()).toContain('back to the program as it was');
    // The next question is about the program as it was, with its own error: the fill is not in it
    const asked = llm.turns[1].messages.at(-1)!.content;
    expect(asked).toContain('canvas is not defined');
    expect(asked).not.toMatch(/const canvas = (?:\(?document|board)/);
  }, 30000);

  it('takes the request’s echo out after a syntax repair makes the program parse', () => {
    const code = 'speak("Show a big ten second countdown on screen.");\nlet n = 10;\nn > 5 && flag = true;\nspeak(String(n));';
    const notes: string[] = [];
    const out = repairBeforeRunning(code, false, (text) => notes.push(text), 'Show a big ten second countdown on screen');
    expect(out.code).toBe('let n = 10;\nn > 5 && (flag = true);\nspeak(String(n));');
    expect(notes.some((n) => n.includes("a speak() of the request's own words"))).toBe(true);
    expect(notes.some((n) => n.includes('wrapped in ( )'))).toBe(true);
  });
});
