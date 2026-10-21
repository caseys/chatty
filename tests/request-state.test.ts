import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, COMPACTION_SYSTEM_PROMPT } from '../src/core/orchestrator.ts';
import { MAX_REQUESTS_KEPT, setForRecentRequests } from '../src/core/recent-requests.ts';
import { StateMachineCoordinator } from '../src/core/state-machine.ts';
import type { JavascriptExecutionResult, JavascriptRuntime } from '../src/tools/javascript-runtime.ts';
import type { LlmGenerationOptions, LlmGenerationResult, LlmRuntimeProvider } from '../src/types/index.ts';

describe('setForRecentRequests', () => {
  it('keeps the entry just set and the most recently written requests, dropping older ones', () => {
    const map = new Map<string, number>();
    for (let i = 0; i < 30; i++) setForRecentRequests(map, `r${i}`, i);
    expect(map.size).toBe(MAX_REQUESTS_KEPT);
    expect([...map.keys()][0]).toBe('r10');
    expect(map.get('r29')).toBe(29);
    expect(map.has('r9')).toBe(false);
  });

  it('counts requests, not entries, when a request has several; writing again makes it recent', () => {
    const map = new Map<string, string>();
    const requestOf = (k: string) => k.split('\n')[0];
    for (let i = 0; i < 20; i++) setForRecentRequests(map, `r${i}\nerror one`, 'x', requestOf);
    setForRecentRequests(map, 'r0\nerror two', 'x', requestOf); // r0 written again: now the newest
    setForRecentRequests(map, 'r20\nerror one', 'x', requestOf); // a 21st request: r1 is the oldest, and goes
    expect(map.has('r1\nerror one')).toBe(false);
    expect(map.has('r0\nerror one')).toBe(true);
    expect(map.has('r0\nerror two')).toBe(true);
    expect(map.size).toBe(21);
    const requests = new Set([...map.keys()].map(requestOf));
    expect(requests.size).toBe(MAX_REQUESTS_KEPT);
  });
});

/** Replies from a list, one per request; summaries for compaction */
class QueueLlm implements LlmRuntimeProvider {
  readonly id = 'queue';
  modelId = 'queue';
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = false;
  readonly contextLimit = 8192;
  readonly maxOutputTokens = 512;
  turns: LlmGenerationOptions[] = [];
  constructor(readonly replies: string[]) {}
  async initialize(): Promise<void> {}
  async generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    const compacting = options.systemPrompt === COMPACTION_SYSTEM_PROMPT;
    if (!compacting) this.turns.push(structuredClone({ ...options, signal: undefined, onToken: undefined, tools: undefined }));
    const text = compacting ? 'The user chatted at length.' : (this.replies.shift() ?? 'speak("ok");');
    options.onToken?.(text, 0);
    return { turnId: options.turnId, text, aborted: false, timeToFirstTokenMs: 1, totalTimeMs: 1, tokensGenerated: 1, tokensPerSecond: 1 };
  }
  cancel(): void {}
  async reset(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function orchestratorFor(llm: LlmRuntimeProvider, runtime: JavascriptRuntime) {
  return new ConversationOrchestrator({
    stateCoordinator: new StateMachineCoordinator(),
    llmProvider: llm,
    enableSpeechOutput: false,
    getConversationId: () => 'c1',
    shouldAutoTitle: () => false,
    autoFixErrors: true,
    javascriptRuntime: runtime,
  });
}

/** A runtime that gives each run the next result in the list (a clean run when the list is empty) */
function fakeRuntime(results: Array<Partial<JavascriptExecutionResult>>, trial?: (code: string) => { error: string | null; errorLine?: number }) {
  const executed: string[] = [];
  const runtime = {
    async execute(code: string): Promise<JavascriptExecutionResult> {
      executed.push(code);
      const r = results.shift() ?? {};
      return { success: !r.error, logs: [], hasVisualOutput: false, executionTimeMs: 1, code, mode: 'eval', ...r };
    },
    async resetVisual() {},
    hasRunningProgram: () => false,
    ...(trial ? { async trialRun(code: string) { return trial(code); }, pageIds: () => [], pageFields: () => [] } : {}),
  } as unknown as JavascriptRuntime;
  return { executed, runtime };
}

/** The per-request state the orchestrator keeps (see recent-requests.ts) */
interface Internals {
  lastRun: { turnId: string; originalTurnId?: string; code: string };
  fixKindsUsed: Map<string, Set<string>>;
  failedReplies: Map<string, string[]>;
  fixProgress: Map<string, unknown>;
  correctedPrograms: Map<string, { code: string; request: string }>;
}

const requestsIn = (keys: Iterable<string>) => new Set([...keys].map((k) => k.split('\n')[0]));

/** Leaves 25 earlier requests' state in every map, as a long session would */
function seedOldRequests(o: Internals) {
  for (let i = 0; i < 25; i++) {
    const req = `old${i}`;
    o.fixKindsUsed.set(`${req}\nsome error`, new Set(['line']));
    o.failedReplies.set(req, ['x = 1;']);
    o.fixProgress.set(req, { best: { code: 'old' }, score: 1, latest: 1, latestCode: 'old', stale: 0, rolledBack: true, errors: new Set() });
    o.correctedPrograms.set(`t${i}`, { code: 'old program', request: req });
  }
}

describe('per-request fix state is capped at the most recent requests', () => {
  const program = 'function draw() {\n  boom();\n}\ndraw();\nspeak("Drawn.");';
  const fix = (n: number) => `// Cause: ${n}\n  zap${n}();`;
  const worse = { error: "SyntaxError: Unexpected token '}'", errorLine: 2 };

  it('drops the oldest requests as new ones come in, whatever they did', async () => {
    const llm = new QueueLlm(Array.from({ length: 24 }, (_, i) => `speak("Hello ${i}.");`));
    const { runtime } = fakeRuntime([]);
    const orchestrator = orchestratorFor(llm, runtime);
    const o = orchestrator as unknown as Internals;
    for (let i = 0; i < 24; i++) {
      await orchestrator.submitUserInput(`Say hello number ${i}`);
      await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
    }
    expect(o.fixProgress.size).toBeLessThanOrEqual(MAX_REQUESTS_KEPT);
    expect(o.fixProgress.has(o.lastRun.originalTurnId ?? o.lastRun.turnId)).toBe(true);
  }, 30000);

  it('still rolls back to the best version within a request, with 25 older requests behind it', async () => {
    const llm = new QueueLlm([program, fix(1), fix(2), fix(3), fix(4), fix(5)]);
    llm.modelId = 'qwen3-0.6b';
    // The request's program fails; every fix that runs does worse
    const { executed, runtime } = fakeRuntime([{ error: 'boom is not defined', errorLine: 2 }, worse, worse, worse, worse, worse, {}]);
    const orchestrator = orchestratorFor(llm, runtime);
    const o = orchestrator as unknown as Internals;
    seedOldRequests(o);
    await orchestrator.submitUserInput('Draw it');
    await vi.waitFor(() => expect(llm.turns.length).toBeGreaterThanOrEqual(3), { timeout: 20000 });
    // The second try fixes the request's own program (fixBase read its progress), not the first fix
    const second = llm.turns[2].messages.at(-1)!.content;
    expect(second).toContain('boom();');
    expect(second).not.toContain('zap1();');
    // Tries get nowhere: Chatty stops and the best version runs again (rollBackToBest)
    await vi.waitFor(() => expect(executed.at(-1)).toBe(program), { timeout: 20000 });
    expect(o.lastRun.code).toBe(program);

    // This request's state is there; the oldest of the 25 earlier requests' is gone, in every map
    const key = o.lastRun.originalTurnId ?? o.lastRun.turnId;
    expect(o.fixProgress.has(key)).toBe(true);
    expect(o.failedReplies.get(key)?.length).toBeGreaterThan(0);
    expect([...o.fixKindsUsed.keys()].some((k) => k.startsWith(`${key}\n`))).toBe(true);
    expect(o.fixProgress.size).toBeLessThanOrEqual(MAX_REQUESTS_KEPT);
    expect(o.failedReplies.size).toBeLessThanOrEqual(MAX_REQUESTS_KEPT);
    expect(requestsIn(o.fixKindsUsed.keys()).size).toBeLessThanOrEqual(MAX_REQUESTS_KEPT);
    expect(o.fixProgress.has('old0')).toBe(false);
    expect(o.failedReplies.has('old0')).toBe(false);
    expect([...o.fixKindsUsed.keys()].some((k) => k.startsWith('old0\n'))).toBe(false);
    expect(o.fixProgress.has('old24')).toBe(true);
  }, 40000);

  it('keeps a corrected program standing for its turn in later prompts, and drops old ones', async () => {
    const typo = "const total = 5;\nconst label = document.createElement('p');\nlabel.textContent = `Total: ${totl}`;\nroot.appendChild(label);";
    const corrected = typo.replace('${totl}', '${total}');
    const llm = new QueueLlm([typo, 'speak("A joke.");']);
    const { executed, runtime } = fakeRuntime([{ error: 'totl is not defined', errorLine: 3 }, {}], () => ({ error: null }));
    const orchestrator = orchestratorFor(llm, runtime);
    const o = orchestrator as unknown as Internals;
    seedOldRequests(o);
    await orchestrator.submitUserInput('Show the total');
    await vi.waitFor(() => expect(executed.length).toBe(2), { timeout: 10000 });
    await vi.waitFor(() => expect(orchestrator.scheduler.getActiveTurnId()).toBeNull());
    expect(executed[1]).toBe(corrected);
    expect(o.correctedPrograms.size).toBeLessThanOrEqual(MAX_REQUESTS_KEPT);
    expect(requestsIn([...o.correctedPrograms.values()].map((v) => v.request)).size).toBeLessThanOrEqual(MAX_REQUESTS_KEPT);
    expect([...o.correctedPrograms.values()].some((v) => v.code === corrected)).toBe(true);
    expect(o.correctedPrograms.has('t0')).toBe(false);

    // The next prompt describes the earlier program as the version that ran, not the one that failed
    await orchestrator.submitUserInput('Tell me a joke');
    await vi.waitFor(() => expect(llm.turns.length).toBe(2), { timeout: 10000 });
    const history = llm.turns[1].messages.map((m) => m.content).join('\n');
    expect(history).toContain('it ran without an error');
    expect(history).not.toContain('totl is not defined');
  }, 30000);
});
