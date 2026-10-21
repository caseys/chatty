// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorHint, shareDeclarations } from '../src/core/error-hints.ts';
import { unknownMembers } from '../src/core/property-check.ts';
import { objectType } from '../src/core/method-hints.ts';

// Each repair here was keyed to one API or one statement shape; the browser's own types, or the
// parser's other shapes of the same thing, let it cover more of the same mistake. For each: a
// case it now fixes, and a correct program it still leaves alone.

describe('a property called like a method', () => {
  const el = "const el = document.createElement('p');\n";
  it('becomes an assignment for any property the browser gives a setter', () => {
    const hint = errorHint(`${el}el.hidden(true);`, 'el.hidden is not a function', 2)!;
    expect(hint.correction!.code).toBe(`${el}el.hidden = true;`);
    expect(hint.correction!.note).toBe('el.hidden(value) → el.hidden = value');
  });
  it('is left alone for a property with only a getter, and a real method', () => {
    expect(errorHint(`${el}el.children('x');`, 'el.children is not a function', 2)?.correction).toBeUndefined();
    expect(errorHint(`${el}el.remove();`, 'el.remove is not a function', 2)?.correction).toBeUndefined();
  });
});

describe('a timed AudioParam call without its time', () => {
  it('gets 0 for every method that reaches a value at a time, in Chrome’s or Firefox’s words', () => {
    const code = 'const g = ctx.createGain();\ng.gain.linearRampToValueAtTime(0.5);\ng.gain.exponentialRampToValueAtTime(0.1);';
    const chrome = errorHint(code, "Failed to execute 'linearRampToValueAtTime' on 'AudioParam': 2 arguments required, but only 1 present.", 2)!;
    expect(chrome.correction!.code.split('\n')[1]).toBe('g.gain.linearRampToValueAtTime(0.5, 0);');
    expect(chrome.correction!.code.split('\n')[2]).toBe('g.gain.exponentialRampToValueAtTime(0.1);');
    const firefox = errorHint(code, 'AudioParam.exponentialRampToValueAtTime: At least 2 arguments required, but only 1 passed', 3)!;
    expect(firefox.correction!.code.split('\n')[2]).toBe('g.gain.exponentialRampToValueAtTime(0.1, 0);');
  });
  it('leaves a method whose missing values can’t be guessed, and calls that have their time', () => {
    expect(errorHint('g.gain.setTargetAtTime(0.5);', "Failed to execute 'setTargetAtTime' on 'AudioParam': 3 arguments required, but only 1 present.", 1)?.correction).toBeUndefined();
    const timed = 'g.gain.setValueAtTime(0.5, ctx.currentTime);';
    expect(errorHint(timed, "Failed to execute 'setValueAtTime' on 'AudioParam': 2 arguments required, but only 1 present.", 1)?.correction).toBeUndefined();
  });
});

describe('a method called on what a function returned', () => {
  it('makes an arrow function held in a const return its last call too', () => {
    const code = 'const playNote = (n) => {\n  out.send({ notes: n });\n};\nconst p = playNote(60);\np.stop();';
    const hint = errorHint(code, "Cannot read properties of undefined (reading 'stop')", 5)!;
    expect(hint.correction!.code.split('\n')[1]).toBe('  return out.send({ notes: n });');
  });
  it('leaves a function that already returns something', () => {
    const code = 'const make = () => {\n  const o = ctx.createOscillator();\n  return o;\n};\nconst p = make();\np.stop();';
    expect(errorHint(code, "Cannot read properties of undefined (reading 'stop')", 6)?.correction).toBeUndefined();
  });
});

describe('a variable declared inside one function and used in another', () => {
  it('is shared when the function is an arrow or function expression held in a top-level const', () => {
    const code = 'const check = () => {\n  const ball = { x: 1 };\n  return ball.x;\n};\nfunction move() {\n  ball.x += 1;\n}';
    const out = shareDeclarations(code);
    expect(out.shared).toEqual([{ name: 'ball', from: 'check', line: 1 }]);
    expect(out.code).toBe('let ball;\nconst check = () => {\n  ball = { x: 1 };\n  return ball.x;\n};\nfunction move() {\n  ball.x += 1;\n}');
  });
  it('is left alone in an async arrow, or one handed straight to a call', () => {
    expect(shareDeclarations('const check = async () => {\n  const ball = { x: 1 };\n  return ball.x;\n};\nfunction move() {\n  ball.x += 1;\n}').shared).toEqual([]);
    expect(shareDeclarations("btn.addEventListener('click', () => {\n  const ball = { x: 1 };\n  draw(ball);\n});\nfunction move() {\n  ball.x += 1;\n}").shared).toEqual([]);
  });
});

describe('an audio node made by the context', () => {
  class AudioNode {
    connect() {}
  }
  class AnalyserNode extends AudioNode {
    getByteFrequencyData() {}
  }
  Object.defineProperty(AnalyserNode.prototype, 'fftSize', { value: 0, writable: true, configurable: true });
  afterEach(() => vi.unstubAllGlobals());

  it('is typed by the browser’s own node type, so its slipped members are corrected and made-up ones reported', () => {
    vi.stubGlobal('AudioNode', AudioNode);
    vi.stubGlobal('AnalyserNode', AnalyserNode);
    const code = 'const ctx = new AudioContext();\nconst analyser = ctx.createAnalyser();\nanalyser.fftsize = 256;\nanalyser.volume = 1;';
    expect(objectType(code, 'analyser')).toBe('AnalyserNode');
    const issues = unknownMembers(code, globalThis as unknown as Record<string, unknown>);
    expect(issues.map((i) => [i.member, i.slip])).toEqual([
      ['fftsize', 'fftSize'],
      ['volume', null],
    ]);
  });
  it('leaves a correct program alone, and a program’s own factory untyped', () => {
    vi.stubGlobal('AudioNode', AudioNode);
    vi.stubGlobal('AnalyserNode', AnalyserNode);
    const right = 'const ctx = new AudioContext();\nconst analyser = ctx.createAnalyser();\nanalyser.fftSize = 256;\nanalyser.getByteFrequencyData(data);';
    expect(unknownMembers(right, globalThis as unknown as Record<string, unknown>)).toEqual([]);
    const own = 'const mixer = { createAnalyser() { return { level: 0 }; } };\nconst analyser = mixer.createAnalyser();\nanalyser.level = 1;';
    expect(objectType(own, 'analyser')).toBeNull();
  });
});
