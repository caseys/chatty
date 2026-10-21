// A program that declares a name twice, or is written out twice, stops before it starts: it is
// repaired before running, and the fix request marks the line that really doesn't parse
import { describe, expect, it } from 'vitest';
import { declareOnce } from '../src/core/error-hints.ts';
import { brokenLines } from '../src/core/line-fix.ts';
import { inspectExecutableCode } from '../src/tools/javascript-runtime.ts';

const parses = (code: string) => {
  try {
    new (Object.getPrototypeOf(async function () {}).constructor)(code);
    return true;
  } catch {
    return false;
  }
};

describe('a name declared again in the same block', () => {
  it('is declared once and set again, for every such name at once', () => {
    const code = 'const velocity = 100;\nconst bass = 40;\nconst velocity = 90;\nconst bass = 41;\nspeak(velocity + bass);';
    const once = declareOnce(code)!;
    expect(once.names.sort()).toEqual(['bass', 'velocity']);
    expect(once.code).toBe('let velocity = 100;\nlet bass = 40;\nvelocity = 90;\nbass = 41;\nspeak(velocity + bass);');
    expect(parses(once.code)).toBe(true);
  });

  it('leaves names in different blocks alone, and a program that parses', () => {
    const inner = 'const x = 1;\nfunction f() {\n  const x = 2;\n  return x;\n}\nconst x = 3;';
    const once = declareOnce(inner)!;
    expect(once.code).toBe('let x = 1;\nfunction f() {\n  const x = 2;\n  return x;\n}\nx = 3;');
    expect(declareOnce('const a = 1;\nlet b = 2;')).toBeNull();
  });
});

describe('a declaration that repeats a name the block already has', () => {
  it('sets a parameter, a catch parameter or a function instead of declaring it again', () => {
    const code = [
      'function play(channel, note, time) {',
      '  const note = note * 0.8;',
      '  const time = time * 0.5;',
      '  return note + time;',
      '}',
      'const notes = [{ time: 1 }];',
      'notes.forEach(note => {',
      '  const note = note.time;',
      '});',
      'try { x(); } catch (e) { const e = 2; }',
      'function f() {}',
      'const f = 3;',
    ].join('\n');
    const once = declareOnce(code)!;
    expect(once.names.sort()).toEqual(['e', 'f', 'note', 'time']);
    expect(once.code).toContain('  note = note * 0.8;\n  time = time * 0.5;');
    expect(once.code).toContain('notes.forEach(note => {\n  note = note.time;');
    expect(once.code).toContain('catch (e) { e = 2; }');
    expect(once.code).toContain('function f() {}\nf = 3;');
    expect(parses(once.code)).toBe(true);
  });

  it('leaves what JavaScript allows: a var repeated, a name in an inner block', () => {
    expect(declareOnce('var v = 1;\nvar v = 2;')).toBeNull();
    expect(declareOnce('function g(n) {\n  { const n = 2; return n; }\n}')).toBeNull();
    // A var after a let does conflict
    expect(declareOnce('let w = 1;\nvar w = 2;')!.code).toBe('let w = 1;\nw = 2;');
  });
});

describe('a reply cut off and declaring names twice', () => {
  it('is repaired and closed, the one repair not blocking the other', () => {
    const reply = '```javascript\nconst tempo = 120;\nfunction play(note) {\n  const note = note * 0.8;\n  return note;\n}\nconst tempo = 120;\nconst loop = () => {\n  setTimeout(() => {\n    [1, 2].forEach(note => {\n      const note = note + 1;';
    const prepared = inspectExecutableCode(reply);
    expect(prepared.redeclared?.sort()).toEqual(['note', 'tempo']);
    expect(prepared.cutOff).toBeTruthy();
    expect(parses(prepared.code)).toBe(true);
  });
});

describe('a const with no value', () => {
  it('is a let', () => {
    const once = declareOnce('const score;\nscore = 3;\nspeak(`${score}`);')!;
    expect(once.code).toBe('let score;\nscore = 3;\nspeak(`${score}`);');
    expect(parses(once.code)).toBe(true);
  });
});

describe('a reply that writes its program out twice', () => {
  it('runs one copy: the fuller one', () => {
    const program = 'const bpm = 120;\nconst beat = 60000 / bpm;\nfunction play() {\n  out.send([0x90, 60, 100]);\n}\nplay();';
    const reply = '```javascript\nspeak("Here it is.");\n' + program + '\n```\n\n```javascript\n' + program + '\n```';
    const prepared = inspectExecutableCode(reply);
    expect(prepared.repeatedBlocks).toBe(1);
    expect(prepared.code.match(/const bpm/g)).toHaveLength(1);
    expect(prepared.code).toContain('speak("Here it is.")');
    expect(parses(prepared.code)).toBe(true);
  });

  it('keeps blocks that do different things', () => {
    const reply = '```js\nconst a = document.createElement("div");\na.textContent = "Hi";\ndocument.body.append(a);\n```\n\n```js\nconst b = 2;\nconst c = b * 3;\nspeak(`${c}`);\n```';
    const prepared = inspectExecutableCode(reply);
    expect(prepared.repeatedBlocks).toBeUndefined();
    expect(prepared.code).toContain('const a =');
    expect(prepared.code).toContain('const c =');
  });
});

describe('the lines that don\'t parse, in a program with a top-level await', () => {
  it('are not the await line', () => {
    // A name declared twice is no single line's fault: no lines are marked (the fix uses the error's line)
    expect(brokenLines('speak("a");\nconst midi = await navigator.requestMIDIAccess();\nconst v = 1;\nconst v = 2;')).toBeNull();
    expect(brokenLines('const midi = await navigator.requestMIDIAccess();\nconst x = (1;\nspeak("b");')).toEqual({ start: 2, end: 2 });
  });
});
