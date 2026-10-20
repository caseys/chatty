/**
 * Everyday evaluation: 24 fixed requests in 6 classes, run against the live engine in the
 * browser, one model at a time. Each request gets an outcome check that reads what the program
 * DID (the sandbox card, the run log, the notes that reached the synth), never the model's words.
 * It measures changes; it must never be tuned against (see docs/everyday-eval.md).
 *
 * Console use (dev server; click the page once first so audio can start):
 *   const { runEverydayEval, formatEvalReport } = await import('/chatty/src/evaluation/everyday-eval.ts');
 *   const r = await runEverydayEval(window.chattyEngine, { models: ['qwen3-0.6b-q4f16_1-MLC'] });
 *   console.log(formatEvalReport(r));
 */

export type EvalClass = 'app' | 'drawing' | 'music' | 'facts' | 'math' | 'chat';

export const EVAL_CLASSES: readonly EvalClass[] = ['app', 'drawing', 'music', 'facts', 'math', 'chat'];

export interface EvalCase {
  id: string;
  cls: EvalClass;
  request: string;
  /** math: the number the spoken answer must contain */
  expected?: number;
  /** math: allowed difference (default 1% of expected, at least 0.05) */
  tolerance?: number;
  /** facts: words any of which the spoken answer must contain (known or looked up, either counts) */
  answer?: string[];
}

export const EVAL_CASES: readonly EvalCase[] = [
  { id: 'app-stopwatch', cls: 'app', request: 'Make me a stopwatch with start, stop and reset buttons.' },
  { id: 'app-todo', cls: 'app', request: 'Build a to-do list where I can add things and tick them off.' },
  { id: 'app-coin', cls: 'app', request: 'I need a coin flipper: a button that shows heads or tails.' },
  { id: 'app-converter', cls: 'app', request: 'Make a little converter from inches to centimeters with a box to type in.' },

  { id: 'draw-barn', cls: 'drawing', request: 'Draw a red barn with a blue sky behind it.' },
  { id: 'draw-stars', cls: 'drawing', request: 'Make a starry night sky where the stars twinkle.' },
  { id: 'draw-snake', cls: 'drawing', request: 'Let me play snake with the arrow keys.' },
  { id: 'draw-pinwheel', cls: 'drawing', request: 'Show a colourful pinwheel spinning slowly.' },

  { id: 'music-lullaby', cls: 'music', request: 'Play a slow lullaby on the piano.' },
  { id: 'music-bass', cls: 'music', request: 'Give me a funky bass line.' },
  { id: 'music-scale', cls: 'music', request: 'Play a C minor scale going up and then back down.' },
  { id: 'music-drums', cls: 'music', request: 'Play a simple drum beat with kick and snare.' },

  { id: 'facts-wall', cls: 'facts', request: 'When did the Berlin Wall fall?', answer: ['1989'] },
  { id: 'facts-reef', cls: 'facts', request: 'Tell me about the Great Barrier Reef.', answer: ['Australia', 'coral'] },
  { id: 'facts-capital', cls: 'facts', request: "What's the capital of Kazakhstan?", answer: ['Astana'] },
  { id: 'facts-phone', cls: 'facts', request: 'Who invented the telephone?', answer: ['Bell'] },

  { id: 'math-miles', cls: 'math', request: 'How many miles is 42 kilometers?', expected: 26.1, tolerance: 0.1 },
  { id: 'math-fahrenheit', cls: 'math', request: 'Convert 72 degrees Fahrenheit to Celsius.', expected: 22.2, tolerance: 0.1 },
  { id: 'math-week', cls: 'math', request: 'How many seconds are in a week?', expected: 604800 },
  { id: 'math-root', cls: 'math', request: 'What is the square root of 1764?', expected: 42 },

  { id: 'chat-hello', cls: 'chat', request: 'How are you today?' },
  { id: 'chat-joke', cls: 'chat', request: 'Tell me a joke about cats.' },
  { id: 'chat-dinner', cls: 'chat', request: 'What should I cook for dinner tonight?' },
  { id: 'chat-sleep', cls: 'chat', request: 'Give me one tip for sleeping better.' },
];

// ---- What a run produced --------------------------------------------------

export interface RunLogEntry {
  kind: string;
  text: string;
}

/** The sandbox card, summarised in the page (see snapshotCard) */
export interface CardSnapshot {
  /** buttons, inputs, selects, textareas, links, [onclick] */
  interactive: number;
  canvases: number;
  /** canvases with at least one painted pixel */
  paintedCanvases: number;
  /** svg shapes (path, circle, rect, ...) */
  svgShapes: number;
  /** visible elements other than script/style */
  elements: number;
}

export interface Observation {
  runLog: string;
  card: CardSnapshot;
  /** calls to the muted MIDI output's send() */
  midiCalls: number;
  /** milliseconds the turn took */
  ms: number;
  timedOut?: boolean;
}

export interface Outcome {
  pass: boolean;
  /** Why it failed (or a note), short */
  reason: string;
  spoke: boolean;
  fetched: boolean;
  errors: number;
  /** retries and fix requests logged for the turn */
  fixTurns: number;
  /** imagined lines corrected */
  corrections: number;
}

/** Parse the run log text (see src/core/run-log.ts): "[hh:mm:ss] kind: text", block kinds continue on later lines. */
export function parseRunLog(text: string): RunLogEntry[] {
  const entries: RunLogEntry[] = [];
  for (const line of text.split('\n')) {
    const m = /^\[\d\d:\d\d:\d\d\] ([a-z]+)(?:\(\))?:?(?: (.*))?$/.exec(line);
    if (m) entries.push({ kind: m[1], text: m[2] ?? '' });
    else if (entries.length) {
      const last = entries[entries.length - 1];
      last.text = last.text ? `${last.text}\n${line}` : line;
    }
  }
  return entries;
}

/** Numbers in a spoken text; "1,234" and "26.1" are single numbers */
export function numbersIn(text: string): number[] {
  const found = text.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(?:\.\d+)?/g) ?? [];
  return found.map(Number).filter(Number.isFinite);
}

export function spokenHasNumber(spoken: string, expected: number, tolerance?: number): boolean {
  const tol = tolerance ?? Math.max(0.05, Math.abs(expected) * 0.01);
  return numbersIn(spoken).some((n) => Math.abs(n - expected) <= tol);
}

const FETCH_RE = /\b(?:fetch|searchWikipedia|XMLHttpRequest)\b/;

export function checkOutcome(c: EvalCase, obs: Observation): Outcome {
  const entries = parseRunLog(obs.runLog);
  const spoken = entries.filter((e) => e.kind === 'speak').map((e) => e.text.trim()).filter(Boolean);
  const programs = entries.filter((e) => e.kind === 'program');
  const lastProgram = entries.map((e) => e.kind).lastIndexOf('program');
  // An error counts when no program ran after it (a fixed program has recovered from its error)
  const errorsTotal = entries.filter((e) => e.kind === 'error').length;
  const errorsAfter = entries.slice(lastProgram + 1).filter((e) => e.kind === 'error').length;
  const failedRun = lastProgram < 0 || errorsAfter > 0;
  const base = {
    spoke: spoken.length > 0,
    fetched: programs.some((p) => FETCH_RE.test(p.text)),
    errors: errorsTotal,
    fixTurns: entries.filter((e) => e.kind === 'retry').length,
    corrections: entries.filter((e) => e.kind === 'imagined').length,
  };
  const done = (pass: boolean, reason: string): Outcome => ({ ...base, pass, reason: pass ? '' : reason });
  if (obs.timedOut) return done(false, 'timed out');
  if (failedRun) return done(false, lastProgram < 0 ? 'no program ran' : 'error in the final program');
  const card = obs.card;
  switch (c.cls) {
    case 'app':
      return done(card.interactive > 0, 'no interactive element in the card');
    case 'drawing':
      return done(
        card.paintedCanvases > 0 || card.svgShapes > 0 || card.elements >= 3,
        'nothing drawn in the card'
      );
    case 'music':
      return done(obs.midiCalls > 0, 'no notes reached the synth');
    case 'facts':
      if (!base.spoke) return done(false, 'nothing spoken');
      // The prompt says to answer what the model knows: right is right, looked up or not
      return done(
        (c.answer ?? []).some((word) => spoken.join(' ').toLowerCase().includes(word.toLowerCase())),
        `spoken answer lacks ${(c.answer ?? []).join(' / ')}`
      );
    case 'math':
      if (!base.spoke) return done(false, 'nothing spoken');
      return done(
        c.expected !== undefined && spokenHasNumber(spoken.join(' '), c.expected, c.tolerance),
        `spoken answer lacks ${c.expected}`
      );
    case 'chat':
      return done(base.spoke, 'nothing spoken');
  }
}

// ---- Report ---------------------------------------------------------------

export interface RequestResult {
  id: string;
  cls: EvalClass;
  request: string;
  outcome: Outcome;
  ms: number;
}

export interface ModelResult {
  modelId: string;
  /** per class: [passed, total] */
  classes: Record<string, [number, number]>;
  passed: number;
  total: number;
  errors: number;
  fixTurns: number;
  corrections: number;
  meanMs: number;
  requests: RequestResult[];
}

export interface EvalResult {
  models: ModelResult[];
}

export function summarizeModel(modelId: string, requests: RequestResult[]): ModelResult {
  const classes: Record<string, [number, number]> = {};
  for (const r of requests) {
    const t = (classes[r.cls] ??= [0, 0]);
    t[1] += 1;
    if (r.outcome.pass) t[0] += 1;
  }
  const sum = (f: (r: RequestResult) => number) => requests.reduce((s, r) => s + f(r), 0);
  return {
    modelId,
    classes,
    passed: requests.filter((r) => r.outcome.pass).length,
    total: requests.length,
    errors: sum((r) => r.outcome.errors),
    fixTurns: sum((r) => r.outcome.fixTurns),
    corrections: sum((r) => r.outcome.corrections),
    meanMs: requests.length ? Math.round(sum((r) => r.ms) / requests.length) : 0,
    requests,
  };
}

export function formatEvalReport(result: EvalResult): string {
  const classes = EVAL_CLASSES.filter((c) => result.models.some((m) => m.classes[c]));
  const head = ['model', ...classes, 'total', 'errors', 'fixes', 'corr.', 'mean s'];
  const rows = result.models.map((m) => [
    m.modelId,
    ...classes.map((c) => (m.classes[c] ? `${m.classes[c][0]}/${m.classes[c][1]}` : '-')),
    `${m.passed}/${m.total}`,
    String(m.errors),
    String(m.fixTurns),
    String(m.corrections),
    (m.meanMs / 1000).toFixed(1),
  ]);
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const out = [line(head), line(head.map(() => '---')), ...rows.map(line)];
  const fails = result.models.flatMap((m) =>
    m.requests.filter((r) => !r.outcome.pass).map((r) => `- ${m.modelId} / ${r.id}: ${r.outcome.reason}`)
  );
  if (fails.length) out.push('', 'Failed:', ...fails);
  return out.join('\n');
}

// ---- Browser side ---------------------------------------------------------

export interface EvalOptions {
  models: string[];
  classes?: EvalClass[];
  perRequestTimeoutMs?: number;
  /** Progress callback, e.g. console.log */
  onProgress?: (message: string) => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Engine = any;

/** Summarise the card (document.body of the sandbox, #root) */
export function snapshotCard(doc: Document | null | undefined): CardSnapshot {
  const empty: CardSnapshot = { interactive: 0, canvases: 0, paintedCanvases: 0, svgShapes: 0, elements: 0 };
  const root = doc?.getElementById('root') ?? doc?.body;
  if (!root) return empty;
  const q = (s: string) => root.querySelectorAll(s);
  let painted = 0;
  const canvases = Array.from(q('canvas')) as HTMLCanvasElement[];
  for (const cv of canvases) {
    try {
      const ctx = cv.getContext('2d');
      if (!ctx || !cv.width || !cv.height) {
        painted += 1; // webgl or unreadable: it exists
        continue;
      }
      const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 3; i < data.length; i += 4 * 7) {
        if (data[i] !== 0) {
          painted += 1;
          break;
        }
      }
    } catch {
      painted += 1;
    }
  }
  return {
    interactive: q('button, input, select, textarea, a[href], [onclick]').length,
    canvases: canvases.length,
    paintedCanvases: painted,
    svgShapes: q('path, circle, rect, ellipse, polygon, line, polyline').length,
    elements: Array.from(q('*')).filter((e) => !/^(SCRIPT|STYLE|BR)$/.test(e.tagName)).length,
  };
}

/** Make every MIDI output count send() calls and never sound. Returns the counter and a restore function. */
export function muteMidi(win: any): { count: () => number; restore: () => void } {
  const original = win.__chattyMidi;
  let calls = 0;
  if (typeof original === 'function') {
    win.__chattyMidi = async (...args: unknown[]) => {
      const access = await original(...args);
      for (const output of access?.outputs?.values?.() ?? []) {
        output.send = () => {
          calls += 1;
        };
      }
      return access;
    };
  }
  return {
    count: () => calls,
    restore: () => {
      win.__chattyMidi = original;
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await sleep(250);
  }
  return test();
}

function sandboxDocument(engine: Engine): Document | null {
  const frame: HTMLIFrameElement | null =
    engine.jsRuntime?.activeIframe ?? (document.querySelector('iframe') as HTMLIFrameElement | null);
  return frame?.contentDocument ?? null;
}

export async function runEverydayEval(engine: Engine, options: EvalOptions): Promise<EvalResult> {
  const timeout = options.perRequestTimeoutMs ?? 120_000;
  const log = options.onProgress ?? (() => {});
  const cases = EVAL_CASES.filter((c) => !options.classes || options.classes.includes(c.cls));
  // Audio starts only after a tap in the page: the user clicks once first (docs/everyday-eval.md)
  await engine.audioSubsystem?.ensureAudioContext?.();
  const speechBefore = engine.speechEnabled;
  engine.setSpeechOutputEnabled(false);
  const midi = muteMidi(window);
  const models: ModelResult[] = [];
  try {
    for (const modelId of options.models) {
      log(`model ${modelId}: switching`);
      await engine.updateSettings({ chatModelId: modelId });
      const ready = await waitFor(() => engine.orchestrator.llmProvider.modelId === modelId, 10 * 60_000);
      if (!ready) throw new Error(`model ${modelId} did not become active`);
      const results: RequestResult[] = [];
      for (const c of cases) {
        await engine.createConversation(`eval ${c.id}`);
        await engine.jsRuntime.resetVisual();
        const before = midi.count();
        const start = performance.now();
        let timedOut = false;
        const turn = Promise.resolve(engine.submitText(c.request)).catch(() => null);
        const finished = await Promise.race([
          turn.then(() => true),
          sleep(timeout).then(() => false),
        ]);
        if (!finished) {
          timedOut = true;
          engine.orchestrator.interruptCurrentTurn?.('eval timeout');
        }
        await waitFor(() => !engine.orchestrator.scheduler.getActiveTurnId(), 15_000);
        await sleep(1500); // timers and scheduled notes in the program
        const obs: Observation = {
          runLog: engine.getRunLog(),
          card: snapshotCard(sandboxDocument(engine)),
          midiCalls: midi.count() - before,
          ms: Math.round(performance.now() - start),
          timedOut,
        };
        const outcome = checkOutcome(c, obs);
        results.push({ id: c.id, cls: c.cls, request: c.request, outcome, ms: obs.ms });
        log(`${modelId} ${c.id}: ${outcome.pass ? 'pass' : `FAIL (${outcome.reason})`} ${(obs.ms / 1000).toFixed(1)}s`);
        await engine.jsRuntime.resetVisual();
      }
      models.push(summarizeModel(modelId, results));
    }
  } finally {
    midi.restore();
    if (speechBefore !== undefined) engine.setSpeechOutputEnabled(speechBefore);
  }
  return { models };
}
