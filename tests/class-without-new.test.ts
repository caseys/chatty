// @vitest-environment jsdom
// @ts-expect-error jsdom ships no type declarations here
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { addNewToClasses, errorHint } from '../src/core/error-hints.ts';
import { withLibraryClassNames } from '../src/core/method-hints.ts';
import { repairBeforeRunning } from '../src/core/orchestrator.ts';
import { JavascriptRuntime } from '../src/tools/javascript-runtime.ts';

// The page's Tone, as the built bundle has it: classes (its names shortened), functions that work without new
class PluckSynth {
  triggerAttackRelease() {}
  toDestination() {
    return this;
  }
}
class PolySynth extends PluckSynth {}
class MembraneSynth extends PluckSynth {}
class MetalSynth extends PluckSynth {}
const Frequency = (value: string) => value;
const scope = { Tone: { PluckSynth, PolySynth, MembraneSynth, MetalSynth, Frequency, now: () => 0 }, Number, String, Date, Symbol } as unknown as Record<string, unknown>;

// The program from the live log (iPhone Safari): four classes called as functions, then a member Tone's PolySynth does not have
const PROGRAM = [
  'const piano = Tone.PluckSynth();',
  'const gMinor = Tone.PolySynth();',
  'gMinor.setInstruments({ piano: Tone.PluckSynth(), bass: Tone.MembraneSynth(), drums: Tone.MetalSynth() });',
  'const note = Tone.Frequency("C4");',
  'speak(String(Number("5")) + String(Date()));',
].join('\n');
const SAFARI = 'Cannot call a class constructor e without |new|';

describe('a class called as a function', () => {
  it('gets new at every call, all at once, in the program from the iPhone log', () => {
    const added = addNewToClasses(PROGRAM, scope)!;
    expect(added.count).toBe(5);
    expect(added.names.sort()).toEqual(['MembraneSynth', 'MetalSynth', 'PluckSynth', 'PolySynth']);
    expect(added.code).toBe(
      [
        'const piano = new Tone.PluckSynth();',
        'const gMinor = new Tone.PolySynth();',
        'gMinor.setInstruments({ piano: new Tone.PluckSynth(), bass: new Tone.MembraneSynth(), drums: new Tone.MetalSynth() });',
        'const note = Tone.Frequency("C4");',
        'speak(String(Number("5")) + String(Date()));',
      ].join('\n')
    );
  });

  it('is the repair for Safari’s wording too, whatever line the error names (it is inside the library) and whatever the class is called', () => {
    // Line 199 is the throw inside the bundle: the program has five lines
    const hint = errorHint(PROGRAM, SAFARI, 199, { ids: [], scope });
    expect(hint?.correction?.code).toBe(addNewToClasses(PROGRAM, scope)!.code);
    expect(hint?.correction?.note).toContain('a class is made with new');
    // No line at all, and the other browsers' words
    for (const error of [SAFARI, "Class constructor Cu cannot be invoked without 'new'", 'Cannot call a class as a function', "Class constructors must be invoked with 'new'"]) {
      expect(errorHint(PROGRAM, error, undefined, { ids: [], scope })?.correction?.code, error).toBe(addNewToClasses(PROGRAM, scope)!.code);
    }
  });

  it('leaves what is no class: Number(x), String(y), Date(), a function written to work without new, a call in a chain, and code that has new already', () => {
    const fine = [
      'function makeBall(x) { return { x }; }',
      'const ball = makeBall(1);',
      'const text = String(ball.x) + Number("2");',
      'const when = Date();',
      'const sym = Symbol("a");',
      'const f = Tone.Frequency("C4");',
      'const made = new Tone.PolySynth();',
      'const nested = getTone().PolySynth();',
      'speak(text);',
    ].join('\n');
    expect(addNewToClasses(fine, scope)).toBeNull();
    // (with a page that knows no such class, and an error naming a class that is no class here)
    expect(addNewToClasses('Tone.PolySynth();', { Tone: {} })).toBeNull();
    expect(errorHint('const x = Number("3");', SAFARI, 1, { ids: [], scope })?.correction).toBeUndefined();
  });

  it('is made for a class the program declares itself, before it runs', () => {
    const own = 'class Ball {\n  constructor(x) { this.x = x; }\n}\nconst ball = Ball(5);\nconst other = makeBall();\nfunction makeBall() { return {}; }\nspeak(String(ball.x));';
    const added = addNewToClasses(own)!;
    expect(added.code).toBe(own.replace('= Ball(5)', '= new Ball(5)'));
    const notes: string[] = [];
    const repaired = repairBeforeRunning(own, false, (text) => notes.push(text));
    expect(repaired.code).toContain('const ball = new Ball(5);');
    expect(notes).toEqual(['1 call of a class (Ball) → made with new (a class called as a function always throws): corrected before running']);
    // A function of the same name as nothing, and a shadowing name, are left alone
    expect(addNewToClasses('function Ball() { return {}; }\nconst b = Ball();')).toBeNull();
    expect(addNewToClasses('class Ball {}\nfunction f(Ball) { return Ball(); }')).toBeNull();
  });
});

describe('Safari’s name for a class the bundle shortened', () => {
  it('is replaced by the library’s name only when one export has it, and never when many do', () => {
    class e {
      go() {}
    }
    class OtherE {
      go() {}
    }
    Object.defineProperty(e, 'name', { value: 'e' });
    Object.defineProperty(OtherE, 'name', { value: 'e' });
    const one = { Tone: { Param: e } } as unknown as Record<string, unknown>;
    expect(withLibraryClassNames(`line 3: ${SAFARI}`, 'Tone.Param();', one)).toBe('line 3: Cannot call a class constructor Tone.Param without |new|');
    // "e" is many classes in a bundle: no way to say which
    const many = { Tone: { Param: e, Signal: OtherE } } as unknown as Record<string, unknown>;
    expect(withLibraryClassNames(SAFARI, 'Tone.Param();', many)).toBe(SAFARI);
    expect(withLibraryClassNames('Cannot call a class constructor Ball without |new|', 'class Ball {}\nBall();', one)).toBe('Cannot call a class constructor Ball without |new|');
  });
});

describe('an error thrown inside a library', () => {
  const run = async (code: string) => {
    const runtime = new JavascriptRuntime();
    const html = (runtime as unknown as { buildRunnerHtml(trial: boolean, host?: string, token?: string): string }).buildRunnerHtml(false, undefined, 'tok');
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
    const posted: any[] = [];
    dom.window.addEventListener('message', (e: MessageEvent) => posted.push(e.data));
    dom.window.postMessage({ type: 'execute', id: 'l1', code }, '*');
    await new Promise((r) => setTimeout(r, 60));
    const found = posted.find((m) => m.type === 'program_error' || (m.type === 'result' && m.error));
    dom.window.close();
    return found;
  };

  it('has no line of the program (the bundle’s line is not one), where the error says it came from the bundle', async () => {
    // Safari's error carries the line of the throw, and where it was thrown
    const library = await run('const e = new Error("Cannot call a class constructor e without |new|");\ne.line = 199;\ne.sourceURL = "https://localhost/chatty/assets/tone-global-ab12.js";\ne.stack = "";\nthrow e;');
    expect(library).toBeDefined();
    expect(library.line ?? library.errorLine).toBeUndefined();
  });

  it('keeps the line when the error carries one and says nothing of a library', async () => {
    const own = await run('const e = new Error("boom");\ne.line = 4;\ne.stack = "";\nthrow e;');
    expect(own).toBeDefined();
    // (the line is read as the program's, whatever the sandbox's offset makes of it)
    expect('line' in own || 'errorLine' in own).toBe(true);
  });
});
