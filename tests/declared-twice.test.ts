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
