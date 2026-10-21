import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';
import { blankChoices, fillBlank, findBlank } from '../src/core/blank-fix.ts';
import { errorHint, fixIteratorResults } from '../src/core/error-hints.ts';

const parses = (code: string) => {
  parse(code, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  return true;
};

// From the Qwen3 0.6B music log: an iterator indexed, so every note went to undefined
const log = [
  'const midi = await navigator.requestMIDIAccess();',
  'const output = midi.outputs.values()[0];',
  'function playNote(ch, time) {',
  '  output.send([0x90 + ch, 60, 100], time);',
  '}',
  'function stopNote(ch) {',
  '  output.send([0x80 + ch, 60, 0]);',
  '}',
  'playNote(0, 0);',
].join('\n');
const safari = "TypeError: undefined is not an object (evaluating 'output.send')";

describe('an iterator indexed', () => {
  it('spreads the iterator first, for values(), keys() and entries()', () => {
    const { code, fixed } = fixIteratorResults(log);
    expect(code).toContain('const output = [...midi.outputs.values()][0];');
    expect(fixed).toEqual(['midi.outputs.values()[0] → [...midi.outputs.values()][0]']);
    expect(parses(code)).toBe(true);
    const more = fixIteratorResults('const a = arr.values()[i];\nconst b = m.keys()[arr.length - 1];\nconst c = m.entries()[0][1];');
    expect(more.code).toBe('const a = [...arr.values()][i];\nconst b = [...m.keys()][arr.length - 1];\nconst c = [...m.entries()][0][1];');
    expect(parses(more.code)).toBe(true);
  });

  it('works inside another index and a longer chain', () => {
    const { code } = fixIteratorResults('const a = x.values()[y.values()[0]].keys()[1];');
    expect(code).toBe('const a = [...[...x.values()][[...y.values()][0]].keys()][1];');
    expect(parses(code)).toBe(true);
  });

  it('leaves alone what is already right or may not be an iterator', () => {
    for (const same of [
      'const a = [...m.values()][0];',
      'const a = Array.from(m.values())[0];',
      'const a = Object.keys(o)[0];',
      'const a = m.values().next().value;',
      // a spread of nothing would throw where the chain gives undefined
      'const a = m?.values()[0];\nconst b = m.values()?.[0];',
      // an iterator's own members
      "const a = it.values()['next'];\nconst b = it.values()[Symbol.iterator];",
      // the program's own values() may return a list
      'const s = { values() { return [1, 2]; } };\nconst a = s.values()[0];',
    ]) {
      expect(fixIteratorResults(same)).toEqual({ code: same, fixed: [] });
    }
  });

  it('still takes the item from an iterator result used as the item', () => {
    const { code, fixed } = fixIteratorResults('const o = m.outputs.values().next();\no.send([1]);\nconst p = m.inputs.keys()[0];');
    expect(code).toBe('const o = m.outputs.values().next().value;\no.send([1]);\nconst p = [...m.inputs.keys()][0];');
    expect(fixed).toEqual(['o', 'm.inputs.keys()[0] → [...m.inputs.keys()][0]']);
  });
});

describe('?. only for a value not made yet', () => {
  const error = "Cannot read properties of undefined (reading 'stop')";
  it('is still applied to a let declared without a value, set later', () => {
    expect(errorHint('let osc;\nosc.stop();', error, 2)?.correction?.code).toBe('let osc;\nosc?.stop?.();');
    const later = 'var osc = null;\nif (go) osc = ctx.createOscillator();\nosc.stop();';
    expect(errorHint(later, "undefined is not an object (evaluating 'osc.stop')", 3)?.correction?.code).toBe(
      'var osc = null;\nif (go) osc = ctx.createOscillator();\nosc?.stop?.();'
    );
  });

  it('is still applied to a parameter and a loop item', () => {
    expect(errorHint('function halt(p) {\n  p.stop();\n}\nhalt();', error, 2)?.correction?.code).toContain('p?.stop?.();');
    expect(errorHint('for (const p of players) {\n  p.stop();\n}', error, 2)?.correction?.code).toContain('p?.stop?.();');
    expect(errorHint('players.forEach((p) => {\n  p.stop();\n});', error, 2)?.correction?.code).toContain('p?.stop?.();');
  });

  it('is never applied to the const the log set from an indexed iterator', () => {
    const hint = errorHint(log, safari, 4);
    expect(hint?.correction).toBeUndefined();
    expect(`${hint?.text ?? ''}`).not.toContain('?.');
  });

  it('is never applied to a const or a variable an expression made', () => {
    for (const code of ['const sound = makeSound();\nsound.stop();', 'let sound = lookup();\nsound.stop();', 'const { sound } = kit;\nsound.stop();']) {
      expect(errorHint(code, error, 2)?.correction).toBeUndefined();
    }
  });
});

describe('the blank at the source', () => {
  it('is the initializer of the const the failing use reads, once', () => {
    const blank = findBlank(log, safari, 4)!;
    expect(blank.text).toBe('midi.outputs.values()[0]');
    expect(blank.line).toBe(2);
    expect(blank.why).toBe('output is undefined; this line sets it');
    expect(blank.spans).toHaveLength(1);
    expect(log.slice(blank.spans[0].start, blank.spans[0].end)).toBe(blank.text);
    // (the uses, the failing one first, in both functions)
    expect(blank.uses!.map((u) => log.slice(u.start, u.end))).toEqual(['output', 'output']);
    expect(blank.uses![0].start).toBeLessThan(blank.uses![1].start);
  });

  it('fills the declaration once, so every use gets the value', () => {
    const blank = findBlank(log, safari, 4)!;
    const filled = fillBlank(log, blank, 'out')!;
    expect(filled).toContain('const output = out;');
    expect(filled.match(/output\.send/g)).toHaveLength(2);
    expect(fillBlank(log, blank, 'midi.outputs.get("a")')).toContain('const output = midi.outputs.get("a");');
    // (a value that needs brackets gets them)
    expect(fillBlank(log, blank, 'await pick()')).toContain('const output = (await pick());');
  });

  it('offers candidates for how the value is used: the ready MIDI output for send()', () => {
    const blank = findBlank(log, safari, 4)!;
    expect(blankChoices(log, blank, { ids: [], helpers: { out: ['send', 'play', 'playNote'] } })[0]).toBe('out');
  });

  it('also for Chrome wording, a let nothing writes to, and an iterable or constructor', () => {
    expect(findBlank(log, "Cannot read properties of undefined (reading 'send')", 4)?.text).toBe('midi.outputs.values()[0]');
    expect(findBlank('let el = document.getElementById("a");\nel.value = 1;', "Cannot set properties of null (setting 'value')", 2)?.text).toBe('document.getElementById("a")');
    expect(findBlank('const items = load();\nfor (const x of items) {}', 'items is not iterable', 2)?.text).toBe('load()');
    expect(findBlank('const Voice = lib.Voice;\nnew Voice();', 'Voice is not a constructor', 2)?.text).toBe('lib.Voice');
  });

  it('keeps today\'s blank for every other case', () => {
    const at = (code: string, error: string, line: number) => findBlank(code, error, line)?.text;
    // a let written to again
    expect(at('let out2 = pick();\nout2 = other();\nout2.send(1);', "Cannot read properties of undefined (reading 'send')", 3)).toBe('out2');
    // a parameter, a loop item
    expect(at('function go(p) {\n  p.send(1);\n}\ngo();', "Cannot read properties of undefined (reading 'send')", 2)).toBe('p');
    expect(at('for (const p of ps) {\n  p.send(1);\n}', "Cannot read properties of undefined (reading 'send')", 2)).toBe('p');
    // a value written out as data: the data isn't what went wrong
    expect(at('const cfg = {};\nconst { size } = cfg;', "Cannot destructure property 'size' of 'cfg' as it is undefined.", 2)).toBe('cfg');
    expect(at('const q = undefined;\nq.send(1);', "Cannot read properties of undefined (reading 'send')", 2)).toBe('q');
    // a receiver that exists but lacks the method
    expect(at("const ctx = canvas.getContext('2d');\nctx.fillCircle(1);", 'ctx.fillCircle is not a function', 2)).toBe('ctx');
    // a name declared in another function than the failing one
    const shadow = 'function a() {\n  const p = make();\n  return p;\n}\nfunction b(p) {\n  p.send(1);\n}';
    expect(at(shadow, "Cannot read properties of undefined (reading 'send')", 6)).toBe('p');
  });
});
