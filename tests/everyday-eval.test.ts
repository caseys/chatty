import { describe, expect, it } from 'vitest';
import {
  checkOutcome,
  EVAL_CASES,
  EVAL_CLASSES,
  formatEvalReport,
  numbersIn,
  parseRunLog,
  summarizeModel,
  type CardSnapshot,
  type EvalCase,
  type Observation,
} from '../src/evaluation/everyday-eval.ts';

const card = (o: Partial<CardSnapshot> = {}): CardSnapshot => ({
  interactive: 0,
  canvases: 0,
  paintedCanvases: 0,
  svgShapes: 0,
  elements: 0,
  ...o,
});
const obs = (runLog: string, o: Partial<Observation> = {}): Observation => ({
  runLog,
  card: card(),
  midiCalls: 0,
  ms: 1000,
  ...o,
});
const T = '[10:00:00]';
const ok = `${T} request: hi\n${T} program:\nspeak("x")`;
const find = (cls: string) => EVAL_CASES.find((c) => c.cls === cls)!;

describe('request list', () => {
  it('has 24 unique requests, 4 per class', () => {
    expect(EVAL_CASES).toHaveLength(24);
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(24);
    for (const cls of EVAL_CLASSES) expect(EVAL_CASES.filter((c) => c.cls === cls)).toHaveLength(4);
  });
  it('math cases carry an expected number; none are suggestion chips', () => {
    for (const c of EVAL_CASES.filter((c) => c.cls === 'math')) expect(c.expected).toBeTypeOf('number');
    const chips = ['rainbow', 'g major chord', 'bouncing', 'tip calculator', 'countdown', 'ada lovelace', '15 percent'];
    for (const c of EVAL_CASES) for (const chip of chips) expect(c.request.toLowerCase()).not.toContain(chip);
  });
});

describe('run log parsing', () => {
  it('reads kinds and block continuations', () => {
    const e = parseRunLog(`${T} program:\nconst a = 1;\nspeak("hi")\n${T} clear()\n${T} error: boom`);
    expect(e.map((x) => x.kind)).toEqual(['program', 'clear', 'error']);
    expect(e[0].text).toContain('speak("hi")');
  });
  it('finds numbers with commas', () => {
    expect(numbersIn('That is 604,800 seconds, or 26.1 miles')).toEqual([604800, 26.1]);
  });
});

describe('outcome checks', () => {
  it('app needs an interactive element and no error', () => {
    expect(checkOutcome(find('app'), obs(ok, { card: card({ interactive: 2 }) })).pass).toBe(true);
    expect(checkOutcome(find('app'), obs(ok)).pass).toBe(false);
    expect(checkOutcome(find('app'), obs(`${ok}\n${T} error: x`, { card: card({ interactive: 2 }) })).pass).toBe(false);
  });
  it('an error fixed by a later program passes but is counted', () => {
    const log = `${T} program:\na\n${T} error: bad\n${T} retry: fix\n${T} program:\nb`;
    const r = checkOutcome(find('app'), obs(log, { card: card({ interactive: 1 }) }));
    expect(r).toMatchObject({ pass: true, errors: 1, fixTurns: 1 });
  });
  it('drawing accepts canvas, svg or enough elements', () => {
    expect(checkOutcome(find('drawing'), obs(ok, { card: card({ paintedCanvases: 1 }) })).pass).toBe(true);
    expect(checkOutcome(find('drawing'), obs(ok, { card: card({ svgShapes: 4 }) })).pass).toBe(true);
    expect(checkOutcome(find('drawing'), obs(ok, { card: card({ canvases: 1 }) })).pass).toBe(false);
  });
  it('music counts notes that reached the synth', () => {
    expect(checkOutcome(find('music'), obs(ok, { midiCalls: 3 })).pass).toBe(true);
    expect(checkOutcome(find('music'), obs(ok)).pass).toBe(false);
  });
  it('facts need the right answer spoken, known or looked up', () => {
    const wall = EVAL_CASES.find((c) => c.id === 'facts-wall')!;
    expect(checkOutcome(wall, obs(`${T} program:\nspeak("1989")\n${T} speak: It fell in 1989`)).pass).toBe(true);
    expect(checkOutcome(wall, obs(`${T} program:\nspeak("1991")\n${T} speak: It fell in 1991`)).pass).toBe(false);
  });
  it('math checks the spoken number with tolerance', () => {
    const c: EvalCase = { id: 'm', cls: 'math', request: '', expected: 26.1, tolerance: 0.1 };
    const said = (t: string) => obs(`${T} program:\nspeak(1)\n${T} speak: ${t}`);
    expect(checkOutcome(c, said('About 26.1 miles')).pass).toBe(true);
    expect(checkOutcome(c, said('About 26.07 miles')).pass).toBe(true);
    expect(checkOutcome(c, said('About 30 miles')).pass).toBe(false);
    const big: EvalCase = { id: 'b', cls: 'math', request: '', expected: 604800 };
    expect(checkOutcome(big, said('604,800 seconds')).pass).toBe(true);
  });
  it('chat needs a speak; a timeout fails; imagined lines are counted', () => {
    const log = `${T} program:\nx\n${T} speak: hello\n${T} imagined: a → b: corrected`;
    expect(checkOutcome(find('chat'), obs(log))).toMatchObject({ pass: true, corrections: 1 });
    expect(checkOutcome(find('chat'), obs(`${T} program:\nx`)).pass).toBe(false);
    expect(checkOutcome(find('chat'), obs(log, { timedOut: true })).reason).toBe('timed out');
  });
});

describe('report', () => {
  it('renders a markdown table with failures', () => {
    const c = find('music');
    const pass = { id: c.id, cls: c.cls, request: c.request, ms: 2000, outcome: checkOutcome(c, obs(ok, { midiCalls: 1 })) };
    const fail = { ...pass, id: 'x', outcome: checkOutcome(c, obs(ok)) };
    const text = formatEvalReport({ models: [summarizeModel('m1', [pass, fail])] });
    expect(text).toContain('| model | music | total |');
    expect(text).toContain('| m1 | 1/2 | 1/2 |');
    expect(text).toContain('m1 / x: no notes reached the synth');
  });
});
