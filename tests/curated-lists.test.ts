// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { errorHint, missingReadFacts } from '../src/core/error-hints.ts';
import { readsMayExplain } from '../src/core/orchestrator.ts';
import { helperListText, isRootPrototype, memberList, memberListText, methodHint } from '../src/core/method-hints.ts';
import { JavascriptRuntime } from '../src/tools/javascript-runtime.ts';

const scopeOf = (extra: Record<string, unknown> = {}) => new Proxy(globalThis as unknown as Record<string, unknown>, { get: (target, prop) => (typeof prop === 'string' && prop in extra ? extra[prop] : Reflect.get(target, prop)) });

describe('Chatty’s own helpers: what they really offer', () => {
  // The runner's helper objects, as the page has them
  const helpers = { out: { send() {}, play() {}, playNote() {} }, speak: function speak() {}, playNotes() {} };
  const scope = scopeOf({ __chattyHelpers: helpers, ...helpers });

  it('lists the members of the real helper object for a made-up one, the nearest first', () => {
    const hint = methodHint('out.say("hi");', 'out.say is not a function', scope, 1);
    expect(hint?.text).toBe("out is Chatty's out helper; it has no say(). Its methods: play(), send(), playNote().");
    expect(hint?.correction).toBeUndefined();
    // A slip of a real member is still corrected first
    expect(methodHint('out.sned("C4");', 'out.sned is not a function', scope, 1)?.correction).toEqual({ object: 'out', from: 'sned', to: 'send' });
    // A helper that is a function and has nothing of its own
    expect(errorHint('speak.loud("hi");', 'speak.loud is not a function', 1, { ids: [], scope })?.text).toBe('speak is a Chatty helper function with no members of its own; it has no loud. Call it directly: speak(…).');
  });

  it('is read from the helper object, not from a copy: another helper has other members', () => {
    const real = { out: { send() {}, flush() {} } };
    const other = scopeOf({ __chattyHelpers: real, ...real });
    expect(helperListText('out.go();', 'out', 'go', other)).toBe("out is Chatty's out helper; it has no go(). Its methods: send(), flush().");
  });

  it('gives nothing for a program’s own helper of that name, or without the page', () => {
    expect(helperListText('const out = { go() {} };\nout.say();', 'out', 'say', scope)).toBeNull();
    expect(helperListText('function speak() {}\nspeak.loud();', 'speak', 'loud', scope)).toBeNull();
    expect(methodHint('out.say("hi");', 'out.say is not a function', undefined, 1)).toBeNull();
    expect(helperListText('foo.bar();', 'foo', 'bar', scope)).toBeNull();
  });

  it('names each helper and its members from the runner’s own objects (what the blank stage offers)', () => {
    const runtime = new JavascriptRuntime();
    const frame = (runtime as unknown as { ensureIframe(): HTMLIFrameElement }).ensureIframe();
    (frame.contentWindow as any).__chattyHelpers = { out: { send() {}, play() {}, playNote() {} }, speak: function speak() {} };
    expect(runtime.helperMembers()).toEqual({ out: ['send', 'play', 'playNote'], speak: [] });
    runtime.dispose();
  });

  it('is what the page’s scope carries: the runner’s own helpers', () => {
    const runtime = new JavascriptRuntime();
    const frame = (runtime as unknown as { ensureIframe(): HTMLIFrameElement }).ensureIframe();
    (frame.contentWindow as any).__chattyHelpers = helpers;
    const page = runtime.pageScope()!;
    expect(page.__chattyHelpers).toBe(helpers);
    expect(page.out).toBe(helpers.out);
    expect(page.Math).toBe(Math);
    runtime.dispose();
  });
});

describe('a name that is not defined', () => {
  it('is the lists of the second round (see error-hints.test.ts): closest first, and Chatty’s helpers', () => {
    const scope = scopeOf({ __chattyHelpers: { out: {}, speak() {}, playNotes() {} } });
    const hint = errorHint('function playChord() {}\nfunction startLoop() {}\nplayNote("C4");', 'playNote is not defined', 3, { ids: [], scope });
    expect(hint?.text).toBe("playNote isn't defined; the program defines playChord(), startLoop(). Chatty provides playNotes(), out, speak().");
    // A program that declares a helper's name itself: that one is its own
    expect(errorHint('const out = 1;\nfoo();', 'foo is not defined', 2, { ids: [], scope })?.text).toBe("foo isn't defined; the program defines out. Chatty provides speak(), playNotes().");
  });
});

describe('the language’s own types and namespaces: what they really have', () => {
  const hint = (code: string, error: string) => errorHint(code, error, code.split('\n').length, { ids: [], scope: globalThis as unknown as Record<string, unknown> });

  it('lists an array’s own methods, the usual ones first, for a made-up one', () => {
    const text = hint('const words = ["a", "b"];\nwords.add("c");', 'words.add is not a function')?.text;
    expect(text).toMatch(/^words is an array; it has no add\(\)\. Its methods: at\(\), push\(\), pop\(\), shift\(\), unshift\(\), includes\(\), indexOf\(\), find\(\), findIndex\(\), map\(\), filter\(\), reduce\(\), …\. Its settings: length\.$/);
    // Safari's wording gives the same list
    expect(hint('const words = ["a"];\nwords.add("b");', "words.add is not a function. (In 'words.add(\"b\")', 'words.add' is undefined)")?.text).toBe(text?.replace('words is', 'words is'));
  });

  it('lists a string’s, a Map’s, a Set’s and a Date’s own members, never Object’s', () => {
    const str = hint('const str = "abc";\nif (str.contains("a")) speak("y");', 'str.contains is not a function')?.text;
    expect(str).toMatch(/^str is a string; it has no contains\(\)\. Its methods: includes\(\), /);
    expect(str).not.toMatch(/hasOwnProperty|toString\(\)|valueOf|isPrototypeOf/);
    expect(hint('const m = new Map();\nm.add(1);', 'm.add is not a function')?.text).toBe('m is a Map; it has no add(). Its methods: get(), set(), has(), delete(), clear(), forEach(), keys(), values(), entries(). Its settings: size (read-only).');
    expect(hint('const s = new Set();\ns.push(1);', 's.push is not a function')?.text).toMatch(/^s is a Set; it has no push\(\)\. Its methods: add\(\), has\(\), delete\(\), clear\(\), forEach\(\), values\(\), keys\(\), entries\(\), .*Its settings: size \(read-only\)\.$/);
    const date = hint('const date = new Date();\nconst y = date.getYears();', 'date.getYears is not a function')?.text;
    expect(date).toMatch(/^date is a Date; it has no getYears\(\)\. Its methods: getYear\(\), getFullYear\(\), /);
  });

  it('lists the functions and values of Math and JSON, and leaves a sure slip to its correction', () => {
    expect(hint('const n = Math.double(5);', 'Math.double is not a function')?.text).toMatch(/^Math has no double\(\)\. Its functions: random\(\), floor\(\), round\(\), ceil\(\), max\(\), min\(\), abs\(\), sqrt\(\), pow\(\), sin\(\), cos\(\), atan2\(\), …\. Its values: /);
    expect(hint('const o = JSON.read("{}");', 'JSON.read is not a function')?.text).toMatch(/^JSON has no read\(\)\. Its functions: parse\(\), stringify\(\)/);
    // One answer: corrected, not listed
    expect(hint('Math.rand();', 'Math.rand is not a function')?.correction?.code).toBe('Math.random();');
    expect(hint('JSON.parce("{}");', 'JSON.parce is not a function')?.correction?.code).toBe('JSON.parse("{}");');
  });

  it('is not said for a program’s own object, with its own fields and methods', () => {
    expect(hint('const bag = { items: [], add(x) { this.items.push(x); } };\nbag.remove(1);', 'bag.remove is not a function')?.text ?? '').not.toContain('Its methods');
    expect(hint('const list = [];\nlist.last = () => 1;\nlist.first();', 'list.first is not a function')?.text ?? '').toContain('list is an array');
  });
});

// The sandbox runner in a test run: reads of names the real object doesn't have are seen, the objects are the real ones
describe('names read from elements and events that they do not have (test runs only)', () => {
  async function load(trial: boolean, code: string) {
    const runtime = new JavascriptRuntime();
    const html = (runtime as unknown as { buildRunnerHtml(trial: boolean, host?: string, token?: string): string }).buildRunnerHtml(trial, undefined, 'tok');
    const { JSDOM } = await import('jsdom' as string);
    const dom = new (JSDOM as any)(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
    const win = dom.window as any;
    await new Promise((r) => setTimeout(r, 40));
    win.postMessage({ type: 'execute', id: 'r1', code, __trial: 'tok' }, '*');
    await new Promise((r) => setTimeout(r, 80));
    return win;
  }
  const PROGRAM = [
    'const input = document.createElement("input");',
    'document.body.append(input);',
    'input.value = "5";',
    'const n = Number(input.val);',
    'if (input.foo) { speak("never"); }',
    'const has = "bar" in input;',
    'input.score = 3;',
    'const s = input.score;',
    'const same = document.body.lastElementChild === input;',
    'const typed = input instanceof HTMLInputElement && input instanceof HTMLElement && input instanceof Element;',
    'document.body.addEventListener("click", (event) => { window.__target = event.target === document.body; window.__detail = event.targetx; });',
    'document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));',
    'window.__ok = { same, typed, has, s, n: String(n) };',
  ].join('\n');

  it('records the names that nothing in the chain has, and only in a test run; everything else is as it was', async () => {
    const trial = await load(true, PROGRAM);
    const reads = trial.__chattyMissingReads();
    expect(reads.map((r: any) => `${r.type}:${r.name}@${r.line}`).sort()).toEqual(['element:input:foo@5', 'element:input:val@4', 'event:MouseEvent:targetx@11']);
    // The objects are the real ones: identity, instanceof, appending, writes, 'in' checks, the program's own expando
    expect(trial.__ok).toEqual({ same: true, typed: true, has: false, s: 3, n: 'NaN' });
    expect(trial.__target).toBe(true);
    trial.close();
    // The real run: nothing is watched
    const real = await load(false, PROGRAM);
    expect(real.__chattyMissingReads()).toEqual([]);
    expect(real.__ok).toEqual({ same: true, typed: true, has: false, s: 3, n: 'NaN' });
    real.close();
  });

  it('does not record a read the program makes from a global (window.foo), or a name Object has', async () => {
    const trial = await load(true, 'const a = window.nothingHere;\nconst b = document.body.toString();\nconst c = document.body.hasOwnProperty("x");\nwindow.__done = [a, typeof b, c];');
    expect(trial.__chattyMissingReads()).toEqual([]);
    trial.close();
  });
});

describe('the facts for those reads', () => {
  const scope = globalThis as unknown as Record<string, unknown>;
  const reads = (code: string, list: Array<{ name: string; type: string; line: number }>) => missingReadFacts(code, list, scope);

  it('say what the object is and what it has, for a read the program makes', () => {
    const code = 'const input = document.getElementById("bill");\nconst total = Number(input.val) * 2;\nspeak(String(total));';
    const facts = reads(code, [{ name: 'val', type: 'element:input', line: 2 }]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatch(/^input\.val isn't a member of an <input> \(line 2\); its settings: .*value.*\.$/);
    // An event
    const handler = 'el.addEventListener("click", (e) => {\n  speak(e.positionX);\n});';
    expect(reads(handler, [{ name: 'positionX', type: 'event:MouseEvent', line: 2 }])[0]).toMatch(/^e\.positionX isn't a member of a MouseEvent \(line 2\); its settings: /);
  });

  it('are not said for a feature check: a guarded read, an optional chain, a typeof, or a name the line does not have', () => {
    for (const code of [
      'if (el.foo) speak("y");',
      'const v = el.foo ?? 3;',
      'const w = el.foo || 4;',
      'const x = !el.foo;',
      'const y = typeof el.foo;',
      'const z = el.foo ? 1 : 2;',
      'const q = el.foo?.bar;',
      'while (el.foo) { break; }',
    ]) {
      expect(reads(code, [{ name: 'foo', type: 'element:div', line: 1 }]), code).toEqual([]);
    }
    // An unguarded read on a line that also has a guarded one: said; a read on another line: not tied to this one
    expect(reads('const a = el.foo && 1; const b = el.foo + 2;', [{ name: 'foo', type: 'element:div', line: 1 }])).toHaveLength(1);
    expect(reads('const a = el.bar;', [{ name: 'foo', type: 'element:div', line: 1 }])).toEqual([]);
  });

  it('are only for the failures they may explain', () => {
    for (const error of ['The program showed nothing: …', 'The page has nothing to press or type in: …', "Cannot read properties of undefined (reading 'trim')", 'el.textContent = NaN is almost surely a bug', 'x.go is not a function']) {
      expect(readsMayExplain(error), error).toBe(true);
    }
    expect(readsMayExplain('boom is not defined')).toBe(false);
    expect(readsMayExplain(null)).toBe(false);
  });
});

describe('objects from the program’s page (another realm)', () => {
  it('never list what every object has: the page’s own Object.prototype is the end of a chain too', async () => {
    const { JSDOM } = await import('jsdom' as string);
    const other = new (JSDOM as any)('', { runScripts: 'outside-only' }).window;
    // Made in the page: its prototype chain ends in that page's Object.prototype, not this one's
    const out = other.eval('({ send() {}, play() {}, playNote() {} })');
    expect(Object.getPrototypeOf(out)).not.toBe(Object.prototype);
    expect(isRootPrototype(Object.getPrototypeOf(out))).toBe(true);
    expect(isRootPrototype(other.Function.prototype)).toBe(true);
    expect(isRootPrototype(Array.prototype)).toBe(false);
    const scope = scopeOf({ __chattyHelpers: { out }, out });
    expect(helperListText('out.say();', 'out', 'say', scope)).toBe("out is Chatty's out helper; it has no say(). Its methods: play(), send(), playNote().");
    // A class from that realm: its list stops at its own root too
    const Synth = other.eval('(class Synth { triggerAttackRelease() {} toDestination() {} })');
    const list = memberList('Tone.Synth', 'play', { Tone: { Synth } } as unknown as Record<string, unknown>)!;
    expect(list.methods).toEqual(['triggerAttackRelease', 'toDestination']);
    other.close();
  });
});
