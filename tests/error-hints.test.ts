import { describe, expect, it } from 'vitest';
import { dropUnusedPackages, errorHint, fixCaseSlips } from '../src/core/error-hints.ts';

describe('"x is not defined"', () => {
  it('says where a name is really declared when it is used outside that function', () => {
    const code = 'function playTracks() {\n  const t = 1;\n}\nplayTracks();\nsend(t);';
    expect(errorHint(code, 't is not defined', 5)!.text).toBe('t is declared inside playTracks() at line 2, but line 5 is outside it.');
  });

  it('corrects a typo of a declared name, and nothing inside strings', () => {
    const code = 'const total = 5;\nspeak("totla");\nspeak(`${totla}`);';
    const hint = errorHint(code, "Can't find variable: totla", 3)!;
    expect(hint.correction!.note).toBe('totla → total');
    expect(hint.correction!.code).toBe('const total = 5;\nspeak("totla");\nspeak(`${total}`);');
  });

  it('lists what the program defines, closest to the missing name first, and what Chatty provides, when nothing is close', () => {
    const code = 'function startLoop() {}\nfunction playChord() {}\nclass Piano {}\nconst bpm = 90;\nplayNote("C4");';
    // The names that really exist: the program's own, from its scopes, the nearest first; Chatty's helpers from the page
    const scope = { __chattyHelpers: { out: {}, speak() {}, playNotes() {} } } as unknown as Record<string, unknown>;
    expect(errorHint(code, 'playNote is not defined', 5, { ids: [], scope })!.text).toBe("playNote isn't defined; the program defines playChord(), startLoop(), Piano, bpm. Chatty provides playNotes(), out, speak().");
    // Safari's wording, and no page: only what the program defines
    expect(errorHint(code, "Can't find variable: playNote", 5)!.text).toBe("playNote isn't defined; the program defines playChord(), startLoop(), Piano, bpm.");
    expect(errorHint('const x = 1;\nsetupSynth();', 'setupSynth is not defined', 2, { ids: [], scope })!.text).toBe("setupSynth isn't defined; the program defines x. Chatty provides out, speak(), playNotes().");
  });

  it('keeps a sure near-miss first: the slip is corrected, no list', () => {
    const code = 'function playChord() {}\nplayChrod();';
    expect(errorHint(code, 'playChrod is not defined', 2)!.correction?.code).toBe('function playChord() {}\nplayChord();');
  });
});

describe('reading a property of nothing', () => {
  const code = "const start = document.getElementById('startBtn');\nstart.addEventListener('click', go);";

  it('corrects an id one slip from an id on the page', () => {
    const hint = errorHint(code, "Cannot read properties of null (reading 'addEventListener')", 2, { ids: ['startbtn', 'status'] })!;
    expect(hint.correction!.note).toBe("id 'startBtn' → 'startbtn'");
    expect(hint.correction!.code).toContain("getElementById('startbtn')");
  });

  it("lists the page's ids when none is close", () => {
    const hint = errorHint(code, "null is not an object (evaluating 'start.addEventListener')", 2, { ids: ['startButton', 'status'] })!;
    expect(hint.text).toBe("No element has the id 'startBtn': the page's ids are 'startButton', 'status'.");
  });

  it('says a value comes from a function that returns nothing', () => {
    const music = 'function playMidiNote(n) {\n  playNote(n);\n}\nconst plays = notes.map(n => playMidiNote(n));\nplays.forEach(p => p.stop());';
    expect(errorHint(music, "undefined is not an object (evaluating 'p.stop')", 5)!.text).toBe(
      'p is undefined: it comes from playMidiNote(), which returns nothing.'
    );
  });
});

describe('what was left open', () => {
  it('points at an unclosed template string', () => {
    const code = 'clear();\ndocument.body.innerHTML = `\n<div>\n<p>hi</p>';
    expect(errorHint(code, 'Unexpected EOF', 4)!.text).toBe('The ` template string opened at line 2 is never closed.');
  });

  it('points at an unclosed brace', () => {
    const code = 'function loop() {\n  play();\n\nloop();';
    expect(errorHint(code, 'Unexpected end of input', 4)!.text).toBe('The { opened at line 1 is never closed: the program ends before it.');
  });
});

describe('used before its declaration', () => {
  it('names the declaration line', () => {
    const code = 'go();\nfunction go() {\n  console.log(beat);\n}\nconst beat = 500;';
    expect(errorHint(code, "Cannot access 'beat' before initialization", 3)!.text).toBe('beat is declared at line 5 but used at line 3, before it.');
  });
});

describe('repairs by rule', () => {
  it('awaits a promise used as its value', () => {
    const code = "const res = fetch('https://x.org/a');\nconst data = res.json();";
    const hint = errorHint(code, 'res.json is not a function', 2)!;
    expect(hint.correction!.code).toBe("const res = await fetch('https://x.org/a');\nconst data = res.json();");
  });

  it('turns = into : in an object', () => {
    const code = "out.send({ instrument = 'flute', notes: 'C5' });";
    const hint = errorHint(code, 'Invalid shorthand property initializer', 1)!;
    expect(hint.correction!.code).toBe("out.send({ instrument: 'flute', notes: 'C5' });");
  });

  it('quotes words left unquoted in an object', () => {
    const code = "out.send({ instrument: 'bass', notes: G major, duration: 500 });";
    const hint = errorHint(code, "Unexpected identifier 'major'", 1)!;
    expect(hint.correction!.code).toBe("out.send({ instrument: 'bass', notes: 'G major', duration: 500 });");
  });

  it('assigns a name declared twice the second time', () => {
    const code = 'const time = 1;\nplay(time);\nconst time = 2;\nplay(time);';
    const hint = errorHint(code, "Identifier 'time' has already been declared", 3)!;
    expect(hint.correction!.code).toBe('let time = 1;\nplay(time);\ntime = 2;\nplay(time);');
  });
});

describe('a program that makes its own copy of a helper', () => {
  it('drops the copy so the ready-made helper is used', () => {
    const code = "const out = new Out({ instrument: 'piano' });\nout.send({ notes: 'C4' });";
    const hint = errorHint(code, 'Out is not defined', 1)!;
    expect(hint.correction!.code).toBe("out.send({ notes: 'C4' });");
  });
});

describe('calls that pass too few values', () => {
  it('points at the call, not the line inside the function', () => {
    const code = [
      'function playNote(frequency, duration, startTime, type = "note") {',
      '  osc.frequency.setValueAtTime(frequency, startTime);',
      '}',
      "playNote(440, 500, 0, 'piano');",
      "playNote(100, start, 'kick');",
    ].join('\n');
    expect(errorHint(code, 'The provided value is non-finite', 2)!.text).toBe(
      "playNote(frequency, duration, startTime, type) is called with 4 values elsewhere, but with fewer here: line 5: playNote(100, start, 'kick')."
    );
  });
});

describe("a program's own copy of a helper", () => {
  it('is taken out before running, so the real helper is used', async () => {
    const { dropHelperCopies } = await import('../src/core/error-hints.ts');
    const code = 'speak("Hi.");\nfunction speak(text) {\n  console.log(text);\n}\nspeak("Hi.");';
    expect(dropHelperCopies(code)).toEqual({ code: 'speak("Hi.");\nspeak("Hi.");', dropped: ['speak'], renamed: [], kept: [] });
    expect(dropHelperCopies('const total = 1;\nspeak(total);').dropped).toEqual([]);
  });

  it("keeps a definition that does something of its own, renamed with its references", async () => {
    const { dropHelperCopies } = await import('../src/core/error-hints.ts');
    const canvasClear = dropHelperCopies('function clear(){ ctx.clearRect(0,0,10,10); }\nfunction loop(){ clear(); requestAnimationFrame(loop); }\nloop();');
    expect(canvasClear.code).toBe('function clear_(){ ctx.clearRect(0,0,10,10); }\nfunction loop(){ clear_(); requestAnimationFrame(loop); }\nloop();');
    expect(canvasClear.kept).toEqual(['clear → clear_']);
    const tree = dropHelperCopies('class TreeNode { constructor(v){ this.v = v; } }\nconst root = new TreeNode(50);\nconst o = { root };');
    expect(tree.code).toBe('class TreeNode { constructor(v){ this.v = v; } }\nconst root_ = new TreeNode(50);\nconst o = { root: root_ };');
    expect(dropHelperCopies('const out = new Float32Array(8);\nout[0] = 1;').code).toBe('const out_ = new Float32Array(8);\nout_[0] = 1;');
    // A name of the same spelling inside a function is another variable: left alone
    expect(dropHelperCopies('function f(){ const clear = 2; return clear; }\nfunction clear(){ ctx.fill(); }\nclear();').code).toBe(
      'function f(){ const clear = 2; return clear; }\nfunction clear_(){ ctx.fill(); }\nclear_();'
    );
  });

  it('still takes out a stand-in: one that only logs, or makes what cannot be made', async () => {
    const { dropHelperCopies } = await import('../src/core/error-hints.ts');
    expect(dropHelperCopies('function clear(){ console.log("cleared"); }\nclear();')).toMatchObject({ code: 'clear();', dropped: ['clear'] });
    expect(dropHelperCopies('const out = new MidiOut();\nout.send([0x90, 60, 100]);')).toMatchObject({ code: 'out.send([0x90, 60, 100]);', dropped: ['out'] });
  });
});

describe('letter-case slips, by scope', () => {
  it('leaves classes, catch parameters and named function expressions alone', async () => {
    const { fixCaseSlips } = await import('../src/core/error-hints.ts');
    for (const code of [
      'class Game { constructor(){ this.x = 1; } }\nconst game = new Game();',
      'function f(){ const particle = new Particle(); }\nclass Particle {}\nconst particle = 1;',
      'let E = 2;\ntry { x() } catch (e) { speak(e.message) }',
      'const fib = function Fib(n){ return n < 2 ? n : Fib(n-1) + fib(n-2) };\nconst FIB = 3;',
    ]) {
      expect(fixCaseSlips(code)).toEqual({ code, fixed: [] });
    }
  });

  it('still renames a real slip, shorthand keys included', async () => {
    const { fixCaseSlips } = await import('../src/core/error-hints.ts');
    expect(fixCaseSlips('let myCount = 0;\nmycount++;\nconst o = { mycount };').code).toBe('let myCount = 0;\nmyCount++;\nconst o = { mycount: myCount };');
    expect(fixCaseSlips('function drawScene(){}\ndrawscene();').fixed).toEqual([{ from: 'drawscene', to: 'drawScene' }]);
  });
});

describe('packages the browser does not have', () => {
  it('takes out a require whose names nothing uses', () => {
    const code = "speak('Hi');\nconst { getBody } = require('shelljs');\nconst canvas = document.createElement('canvas');\n";
    const { code: out, dropped } = dropUnusedPackages(code);
    expect(dropped).toEqual(['shelljs']);
    expect(out).toBe("speak('Hi');\nconst canvas = document.createElement('canvas');\n");
  });

  it('takes out unused import lines and bare requires', () => {
    const code = "import _ from 'lodash';\nimport { a as b } from \"x\";\nrequire('dotenv').config();\nspeak('ok');";
    const { code: out, dropped } = dropUnusedPackages(code);
    expect(dropped).toEqual(['lodash', 'x', 'dotenv']);
    expect(out).toBe("speak('ok');");
  });

  it('keeps a package the program uses, and tells the model what to do instead', () => {
    const code = "const _ = require('lodash');\nspeak(_.sum([1, 2]));";
    expect(dropUnusedPackages(code).dropped).toEqual([]);
    expect(errorHint(code, "Can't find variable: require", 1)?.text).toMatch(/browser features/);
  });

  it('lists each variable once', () => {
    const code = "const { getBody } = foo();\nconst c = 1;\nzap();";
    expect(errorHint(code, 'zap is not defined', 3)?.text).toContain('the program defines getBody, c.');
  });
});

describe('case slips before running', () => {
  it('renames a name that matches one declared name in everything but case', () => {
    const code = 'let myCount = 0;\nfunction drawScene() {\n  mycount++;\n}\ndrawscene();\nspeak(`${mycount}`);\nconst o = { mycount };';
    const out = fixCaseSlips(code);
    expect(out.code).toBe('let myCount = 0;\nfunction drawScene() {\n  myCount++;\n}\ndrawScene();\nspeak(`${myCount}`);\nconst o = { mycount: myCount };');
    expect(out.fixed).toEqual([{ from: 'mycount', to: 'myCount' }, { from: 'drawscene', to: 'drawScene' }]);
  });

  it('leaves properties, strings, globals, helpers, typeof, ambiguous and out-of-scope names', () => {
    const cases = [
      'const total = 1;\nobj.TOTAL = total;\nspeak("TOTAL");',
      'const Date2 = 1;\nconst x = date;',
      'const Speak = 1;\nspeak(Speak);',
      'const Foo = 1;\nif (typeof foo !== "undefined") {}',
      'const aB = 1;\nconst Ab = 2;\nspeak(ab);',
      'function f() {\n  const inner = 1;\n}\nspeak(INNER);',
      'const count = 1;\nfunction g(Count) { return Count; }',
    ];
    for (const code of cases) expect(fixCaseSlips(code).code).toBe(code);
  });
});

describe('a promise used as its value', () => {
  it('awaits an assignment without a declaration', () => {
    const code = "let data;\ndata = fetch('/a');\nspeak(data.json());";
    expect(errorHint(code, 'data.json is not a function', 3)!.correction!.code).toContain('data = await fetch');
  });

  it('awaits the one promise on the line for "Cannot read properties of undefined"', () => {
    const code = "const res = fetch('/a');\nconst title = res.title.length;";
    const hint = errorHint(code, "Cannot read properties of undefined (reading 'length')", 2)!;
    expect(hint.correction!.code).toBe("const res = await fetch('/a');\nconst title = res.title.length;");
  });

  it('awaits a promise call used in place: res.json().title.length', () => {
    const code = "const res = await fetch('/a');\nspeak(res.json().title.length);";
    const hint = errorHint(code, "Cannot read properties of undefined (reading 'length')", 2)!;
    expect(hint.correction!.code).toBe("const res = await fetch('/a');\nspeak((await res.json()).title.length);");
  });

  it('does nothing when the value is not a promise, is already awaited, or is a chained then', () => {
    const undef = "Cannot read properties of undefined (reading 'x')";
    expect(errorHint('const a = {};\nspeak(a.b.x);', undef, 2)?.correction).toBeUndefined();
    expect(errorHint("const res = await fetch('/a');\nspeak(res.b.x);", undef, 2)?.correction).toBeUndefined();
    expect(errorHint("fetch('/a').then(r => r.x);", undef, 1)?.correction).toBeUndefined();
    expect(errorHint('function json() { return 1; }\nspeak(json().a.x);', undef, 2)?.correction).toBeUndefined();
  });
});

describe('an element the program never made', () => {
  const code = [
    'function playSound(type, duration) {',
    '  const time = start + duration;',
    "  document.getElementById('sound').play();",
    '}',
    "playSound('piano', 4);",
  ].join('\n');

  it('says the id never existed and an empty div stood in, and where sound comes from', () => {
    const error = "document.getElementById('sound').play is not a function. (In 'document.getElementById('sound').play()', 'document.getElementById('sound').play' is undefined)";
    const text = errorHint(code, error, 3, { ids: ['sound'], standIns: [{ id: 'sound', tag: 'div', made: 'empty' }] })?.text ?? '';
    expect(text).toContain('#sound was never created');
    expect(text).toContain('a <div> has no play()');
    expect(text).toContain('Notes play through Web MIDI');
    expect(text).not.toContain('Tone');
  });

  it('follows a variable that holds the stand-in (Chrome names no id)', () => {
    const held = "const box = document.getElementById('panel');\nbox.showModal();";
    const text = errorHint(held, 'box.showModal is not a function', 2, { ids: ['panel'], standIns: [{ id: 'panel', tag: 'span', made: 'last' }] })?.text ?? '';
    expect(text).toContain('#panel was never created');
    expect(text).toContain('the <span> it made last stood in for it (a <span> has no showModal())');
    expect(text).not.toContain('out.send');
  });

  it('says nothing about real elements', () => {
    const error = "document.getElementById('sound').play is not a function";
    expect(errorHint(code, error, 3, { ids: ['sound'], standIns: [] })?.text ?? '').not.toContain('never created');
  });
});

describe('a sure method slip on a stand-in element', () => {
  it('is corrected, not explained by the stand-in hint', () => {
    const code = "const c = document.getElementById('canvas1');\nconst ctx = c.getcontext('2d');";
    const hint = errorHint(code, 'c.getcontext is not a function', 2, { ids: ['canvas1'], standIns: [{ id: 'canvas1', tag: 'canvas', made: 'empty' }] });
    expect(hint?.correction?.code).toContain('c.getContext(');
  });
});

describe('a missing name that an element on the page is named after', () => {
  it('says where its value is', () => {
    const code = "document.body.innerHTML = '<input id=\"billInput\">';\nconst total = bill * 2;";
    const text = errorHint(code, "Can't find variable: bill", 2, { ids: ['billInput', 'result'] })?.text ?? '';
    expect(text).toContain("The page has #billInput (document.getElementById('billInput').value).");
    expect(text).not.toContain('#result');
  });
});

describe("a program that declares one of Chatty's helpers", () => {
  // The whole program wrapped in its own speak(), left unclosed (it doesn't parse)
  const code = "const speak = () => {\n  const bpm = 120;\n  out.send({ notes: 'G major' });\nspeak('Playing.');";
  it("says the helper is ready-made, in each browser's words, even when the program doesn't parse", () => {
    for (const error of [
      "Cannot declare a const variable twice: 'speak'.",
      "Identifier 'speak' has already been declared",
      'redeclaration of const speak',
    ]) {
      const text = errorHint(code, error, 1)?.text ?? '';
      expect(text, error).toContain('speak is ready-made in Chatty: speak(text) says text to the user.');
    }
  });

  it('says nothing for a name of the program’s own', () => {
    expect(errorHint('const total = 1;\nconst total = 2;', "Identifier 'total' has already been declared", 2)?.text ?? '').not.toContain('ready-made');
  });
});

describe('a stray character ending a line', () => {
  it('is removed when that alone makes the program parse', async () => {
    const { dropStrayCharacter } = await import('../src/core/error-hints.ts');
    const code = 'const bpm = 60;\nout.send({ notes: "G major" });\nspeak("Playing.");`';
    expect(dropStrayCharacter(code)).toEqual({ code: 'const bpm = 60;\nout.send({ notes: "G major" });\nspeak("Playing.");', line: 3, removed: '`' });
  });

  it('removes a closing bracket nothing opened, as in the reply to "What\u2019s 15 percent of 84?"', async () => {
    const { dropStrayCharacter, errorHint } = await import('../src/core/error-hints.ts');
    // The real reply from Qwen3 0.6B (the lines end in two spaces, as written)
    const code = 'speak("What is 15% of 84?");  \nspeak("15% of 84 is 12.6.");)';
    expect(dropStrayCharacter(code)).toEqual({ code: 'speak("What is 15% of 84?");  \nspeak("15% of 84 is 12.6.");', line: 2, removed: ')' });
    // After the error too: the same correction, named by the character
    expect(errorHint(code, "Unexpected token ')'", 2)?.correction?.note).toBe('a stray ) on line 2 → removed');
    expect(dropStrayCharacter('speak("a");\nspeak("b"));\n'.replace('("b"));', '("b");]'))).toMatchObject({ line: 2, removed: ']' });
  });

  it('leaves a program that parses, and one a stray character alone can’t fix, alone', async () => {
    const { dropStrayCharacter } = await import('../src/core/error-hints.ts');
    expect(dropStrayCharacter('const s = `a`;')).toBeNull();
    expect(dropStrayCharacter('const a = (1;\nspeak("x");`')).toBeNull();
    // A capable model's program, brackets balanced
    expect(dropStrayCharacter('const nums = [1, 2, 3];\nfunction total() {\n  return nums.reduce((a, b) => a + b, 0);\n}\nspeak(`Total: ${total()}`);')).toBeNull();
    // A } is not taken, in a loop with no { whose last line has a stray } (the reviewer's case): a missing { is as good an answer
    const loop = 'for (let i = 0; i < 3; i++)\n  speak("a");\n  speak("b");\n}\nspeak("end");';
    expect(dropStrayCharacter(loop)).toBeNull();
    expect(dropStrayCharacter('function go() {\n  speak("x");\n}\n}')).toBeNull();
    // A bracket after something that is not a complete statement, in the middle of a line, or one whose removal still leaves a broken program
    expect(dropStrayCharacter('speak("a"\n)\n')).toBeNull();
    // (a closer alone mid-line may be a missing opener elsewhere; one typed twice is the same text whichever goes)
    expect(dropStrayCharacter('const total = a + b) * c;\nspeak("b");')).toBeNull();
    expect(dropStrayCharacter('speak("a"));\nspeak("b");')?.code).toBe('speak("a");\nspeak("b");');
    // The real line from Qwen3 0.6B's balls: ) typed twice inside an index
    expect(dropStrayCharacter('const ballColor = ["red", "blue"];\nconst color = ballColor[Math.floor(Math.random() * 5))];')).toMatchObject({ line: 2, removed: ')', code: 'const ballColor = ["red", "blue"];\nconst color = ballColor[Math.floor(Math.random() * 5)];' });
    expect(dropStrayCharacter('const a = {\n  b: 1,\n};\nif (a.b) {\n  speak("x");\n}}\nfunction f( {\n')).toBeNull();
  });
});

describe('markdown left on code lines', () => {
  it('is removed only when that makes the program parse', async () => {
    const { inspectExecutableCode, withoutMarkdownLeftovers } = await import('../src/tools/javascript-runtime.ts');
    // As in a real reply: the program fenced, then the speak line glued to the closing fence
    const reply = '```javascript\nconst bpm = 60;\nout.send({ notes: "G major" });\n```speak("Playing.");`';
    expect(inspectExecutableCode(reply).code).toBe('const bpm = 60;\nout.send({ notes: "G major" });\nspeak("Playing.");');
    expect(withoutMarkdownLeftovers('## Music\n**Code:**\n`out.send({ notes: "C4" });`')).toBe('out.send({ notes: "C4" });');
    // A template literal that parses is left alone
    expect(inspectExecutableCode('const s = `a`;\nspeak(s);').code).toContain('const s = `a`;');
  });
});

describe('a class called without new', () => {
  // The real program from Qwen3 0.6B for "Build a blues music loop…": Tone's classes called as functions
  const blues = [
    'speak("Build a blues music loop with piano, bass, and drums in G minor, 120 BPM, 4 measures.");',
    '',
    'const synth = Tone.PolySynth();',
    'const tempo = 120;',
    'const gSynth = Tone.PluckSynth();',
    'gSynth.instruments = [Tone.MetalSynth(), Tone.PolySynth()];',
    'const gNote = Tone.PolySynth().note("G4");',
  ].join('\n');
  const error = "Class constructor PolySynth cannot be invoked without 'new'";

  it('gets new at every call of the class the error names, and only that class', () => {
    const hint = errorHint(blues, error, 3);
    expect(hint?.correction?.note).toBe('PolySynth() → new PolySynth(): a class is made with new');
    expect(hint?.correction?.code).toBe(
      blues.replace('const synth = Tone.PolySynth();', 'const synth = new Tone.PolySynth();').replace('Tone.MetalSynth(), Tone.PolySynth()]', 'Tone.MetalSynth(), new Tone.PolySynth()]').replace('Tone.PolySynth().note', 'new Tone.PolySynth().note')
    );
  });

  it('gives new to every call of a class the page has, not only the one the error names (the blues loop made five corrections of one slip)', () => {
    class PolySynth {}
    class PluckSynth {}
    class MembraneSynth {}
    class MetalSynth {}
    const scope = { Tone: { PolySynth, PluckSynth, MembraneSynth, MetalSynth, Frequency: () => 1, now: () => 0 }, Date, String } as unknown as Record<string, unknown>;
    // The real program: each class called as a function, the first failure names only PolySynth
    const code = [
      'const synth = Tone.PolySynth();',
      'const bass = Tone.PluckSynth();',
      'const drums = Tone.MembraneSynth();',
      'const melody = Tone.MetalSynth();',
      'const note = Tone.Frequency("C4");',
      'const when = Date();',
      'speak(String(Tone.now()));',
    ].join('\n');
    const fixed = errorHint(code, "Class constructor PolySynth cannot be invoked without 'new'", 1, { ids: [], scope })?.correction?.code;
    expect(fixed).toBe(
      ['const synth = new Tone.PolySynth();', 'const bass = new Tone.PluckSynth();', 'const drums = new Tone.MembraneSynth();', 'const melody = new Tone.MetalSynth();', 'const note = Tone.Frequency("C4");', 'const when = Date();', 'speak(String(Tone.now()));'].join('\n')
    );
    // The minified name of the built bundle: the same
    expect(errorHint(code, "Class constructor Cu cannot be invoked without 'new'", 1, { ids: [], scope })?.correction?.code).toBe(fixed);
    // Without the page, only the class the error names
    expect(errorHint(code, "Class constructor PolySynth cannot be invoked without 'new'", 1)?.correction?.code).toBe(code.replace('= Tone.PolySynth()', '= new Tone.PolySynth()'));
  });

  it('does not give new to a built-in called on the same line (Number(vol) in a PolySynth call), nor when no name was given', () => {
    class Cu {
      triggerAttackRelease() {}
    }
    const scope = { Tone: { PolySynth: Cu, Synth: class Qa {} }, Number, String, Date } as unknown as Record<string, unknown>;
    // The reviewer's probe: the class called without new, with a Number() call in its options (Safari names no class)
    const code = 'let vol = -6;\nconst synth = Tone.PolySynth(Tone.Synth, { volume: Number(vol) });\nsynth.triggerAttackRelease("C4", "8n");';
    for (const error of ["Class constructor Cu cannot be invoked without 'new'", 'Cannot call a class as a function']) {
      expect(errorHint(code, error, 2, { ids: [], scope })?.correction?.code, error).toBe(code.replace('= Tone.PolySynth(', '= new Tone.PolySynth('));
    }
    // A line that calls only built-ins has no class to repair
    const plain = 'const total = Number("5");\nconst when = Date();\nconst label = String(total);';
    expect(errorHint(plain, 'Cannot call a class as a function', 2, { ids: [], scope })?.correction).toBeUndefined();
  });

  it('reads the library’s own name for the class too (Tone.PolySynth), the last part being the class', () => {
    const hint = errorHint(blues, "Class constructor Tone.PolySynth cannot be invoked without 'new'", 3);
    expect(hint?.correction?.code).toBe(
      blues.replace('const synth = Tone.PolySynth();', 'const synth = new Tone.PolySynth();').replace('Tone.MetalSynth(), Tone.PolySynth()]', 'Tone.MetalSynth(), new Tone.PolySynth()]').replace('Tone.PolySynth().note', 'new Tone.PolySynth().note')
    );
  });

  it('works for a class of the program’s own, with a plain name', () => {
    const code = 'class Ball {\n  constructor(x) { this.x = x; }\n}\nconst ball = Ball(5);\nspeak(String(ball.x));';
    expect(errorHint(code, "Class constructor Ball cannot be invoked without 'new'", 4)?.correction?.code).toBe(code.replace('= Ball(5)', '= new Ball(5)'));
  });

  it('finds the class in the page when the error names a minified one (Cu) or none (Safari)', () => {
    class PolySynth {
      triggerAttackRelease() {}
    }
    const scope = { Tone: { PolySynth, now: () => 0, Frequency: () => 1 } } as unknown as Record<string, unknown>;
    const code = 'const t = Tone.now();\nconst synth = Tone.PolySynth().toDestination();\nconst f = Tone.Frequency("C4");';
    // The built bundle's class is called Cu: no call in the program is named so
    const minified = errorHint(code, "Class constructor Cu cannot be invoked without 'new'", 2, { ids: [], scope });
    expect(minified?.correction?.code).toBe('const t = Tone.now();\nconst synth = new Tone.PolySynth().toDestination();\nconst f = Tone.Frequency("C4");');
    // Safari and Firefox name no class
    expect(errorHint(code, 'Cannot call a class as a function', 2, { ids: [], scope })?.correction?.code).toContain('new Tone.PolySynth()');
    expect(errorHint(code, "Class constructors must be invoked with 'new'", 2, { ids: [], scope })?.correction?.code).toContain('new Tone.PolySynth()');
    // Without the page, or when the program calls no class the page has: nothing
    expect(errorHint(code, "Class constructor Cu cannot be invoked without 'new'", 2)?.correction).toBeUndefined();
    const none = 'const t = Tone.now();\nconst f = Tone.Frequency("C4");';
    expect(errorHint(none, "Class constructor Cu cannot be invoked without 'new'", 2, { ids: [], scope })?.correction).toBeUndefined();
  });

  it('leaves a correct program, a call inside a chain, and the other browsers’ wording alone', () => {
    const correct = 'const synth = new Tone.PolySynth().toDestination();\nconst note = Tone.Frequency("C4").toNote();\nsynth.triggerAttackRelease(note, "8n");';
    expect(errorHint(correct, error, 1)?.correction).toBeUndefined();
    // A call in the chain: new would apply to the wrong thing
    expect(errorHint('const x = make().PolySynth();', error, 1)?.correction).toBeUndefined();
    expect(errorHint(blues, 'Cannot call a class as a function', 3)?.correction).toBeUndefined();
  });
});

describe('Tone notation slips (library-specific repairs)', () => {
  it('turns a note value added to a time in a scheduled callback into seconds', async () => {
    const { fixToneCalls } = await import('../src/core/error-hints.ts');
    const code = [
      'const synth = new Tone.Synth().toDestination();',
      'const loop = new Tone.Loop((time) => {',
      '  synth.triggerAttackRelease("C4", "8n", time);',
      '  time += "8n";',
      '  synth.triggerAttackRelease("E4", "8n", time + "4n");',
      '}, "2n").start(0);',
    ].join('\n');
    const fixed = fixToneCalls(code);
    expect(fixed.code).toBe(code.replace('time += "8n"', 'time += Tone.Time("8n").toSeconds()').replace('time + "4n"', 'time + Tone.Time("4n").toSeconds()'));
    expect(fixed.fixed).toEqual(['time += "8n" → time += Tone.Time("8n").toSeconds()', 'time + "4n" → time + Tone.Time("4n").toSeconds()']);
  });

  it('also for a time a variable holds from a number or Tone.now()', async () => {
    const { fixToneCalls } = await import('../src/core/error-hints.ts');
    const code = 'const synth = new Tone.Synth().toDestination();\nlet t = Tone.now();\nfor (const n of ["C4", "E4"]) {\n  synth.triggerAttackRelease(n, "8n", t);\n  t += "8n";\n}';
    expect(fixToneCalls(code).code).toBe(code.replace('t += "8n"', 't += Tone.Time("8n").toSeconds()'));
  });

  it('leaves a sum that is not a time, and times that already are seconds, alone', async () => {
    const { fixToneCalls } = await import('../src/core/error-hints.ts');
    // text joined to text, a counter, a time reassigned, a callback of something else
    const alone = [
      'const label = "note ";',
      'let text = label;',
      'text += "8n";',
      'const synth = new Tone.Synth().toDestination();',
      'let t = Tone.now();',
      't = "now";',
      't += "8n";',
      'setTimeout((time) => { time += "8n"; }, 10);',
      'const loop = new Tone.Loop((time) => {',
      '  synth.triggerAttackRelease("C4", "8n", time + Tone.Time("8n").toSeconds());',
      '  synth.triggerAttackRelease("C4", "8n", time + 0.5);',
      '}, "2n").start(0);',
    ].join('\n');
    expect(fixToneCalls(alone).code).toBe(alone);
    // Not a Tone program
    expect(fixToneCalls('let time = 0;\ntime += "8n";').code).toBe('let time = 0;\ntime += "8n";');
  });

  it('drops the pitch given to a NoiseSynth, which has none', async () => {
    const { fixToneCalls } = await import('../src/core/error-hints.ts');
    const code = [
      'const snare = new Tone.NoiseSynth({ noise: { type: "white" } }).toDestination();',
      'const loop = new Tone.Loop((time) => {',
      '  snare.triggerAttackRelease("D#4", "8n", time);',
      '  snare.triggerAttack("D4");',
      '}, "4n").start(0);',
    ].join('\n');
    const fixed = fixToneCalls(code);
    expect(fixed.code).toBe(code.replace('("D#4", "8n", time)', '("8n", time)').replace('triggerAttack("D4")', 'triggerAttack()'));
    expect(fixed.fixed[0]).toBe('snare.triggerAttackRelease("D#4", …): a Tone.NoiseSynth has no pitch → "D#4" dropped');
  });

  it('leaves a pitched synth, a NoiseSynth called right, and a name reused, alone', async () => {
    const { fixToneCalls } = await import('../src/core/error-hints.ts');
    const right = 'const snare = new Tone.NoiseSynth().toDestination();\nconst kick = new Tone.MembraneSynth().toDestination();\nsnare.triggerAttackRelease("8n", Tone.now());\nkick.triggerAttackRelease("C1", "8n");';
    expect(fixToneCalls(right).code).toBe(right);
    // Another declaration or an assignment makes the object unclear
    const reused = 'let drum = new Tone.NoiseSynth().toDestination();\ndrum = new Tone.MembraneSynth().toDestination();\ndrum.triggerAttackRelease("C2", "8n");';
    expect(fixToneCalls(reused).code).toBe(reused);
    // Another scope's own variable of that name
    const scoped = 'const snare = new Tone.NoiseSynth().toDestination();\nfunction hit(snare) { snare.triggerAttackRelease("C2", "8n"); }';
    expect(fixToneCalls(scoped).code).toBe(scoped);
  });

  it('runs after the general repairs when an error came: only when none applies', async () => {
    const { errorHint } = await import('../src/core/error-hints.ts');
    const code = 'const snare = new Tone.NoiseSynth().toDestination();\nsnare.triggerAttackRelease("D#4", "8n");\nconsole.log(missingName);';
    // A general repair (a missing name's hint) comes first
    expect(errorHint(code, 'missingName is not defined', 3)?.correction?.note ?? '').not.toContain('NoiseSynth');
    expect(errorHint('const snare = new Tone.NoiseSynth().toDestination();\nsnare.triggerAttackRelease("D#4", "8n");', 'Something odd happened', 2)?.correction?.code).toBe(
      'const snare = new Tone.NoiseSynth().toDestination();\nsnare.triggerAttackRelease("8n");'
    );
  });
});

describe('statements where an arrow function’s body should be a block', () => {
  // The real program from Qwen3 0.6B for "Draw a beach sunset…" (shortened to two of its four arrows)
  const sunset = [
    'const canvas = document.createElement("canvas");',
    'const rainbowSky = () => {',
    '  const colors = ["#e6dbf8", "#f5dd6b", "#8e74c5", "#5c36a2", "#4b1c3e"];',
    '  const rainbow = Array.from({ length: 50 }).map((_, i) => ',
    '    colors[Math.min(i % 5, 5)] ',
    '  ).map((color, i) => ',
    '    canvas.fillStyle = color;',
    '    canvas.beginPath();',
    '    canvas.arc(400, 300, 100, Math.PI * 2, 0, 2 * Math.PI);',
    '    canvas.fill();',
    '  );',
    '};',
    'const depthOcean = Array.from({ length: 100 }).map((_, i) => ',
    '  canvas.fillStyle = "#6b36a2";',
    '  canvas.fill();',
    ');',
    'rainbowSky();',
  ].join('\n');

  it('wraps each arrow’s statements in braces until the program parses', async () => {
    const { wrapBracelessArrows } = await import('../src/core/error-hints.ts');
    const fixed = wrapBracelessArrows(sunset);
    expect(fixed?.lines).toEqual([6, 13]);
    expect(fixed?.code).toContain('.map((color, i) => { \n    canvas.fillStyle = color;');
    expect(fixed?.code).toContain('    canvas.fill(); }\n  );');
    expect(fixed?.code).toContain('.map((_, i) => { \n  canvas.fillStyle = "#6b36a2";\n  canvas.fill(); }\n);');
    // The same by the error, after the run
    expect(errorHint(sunset, 'missing ) after argument list', 7)?.correction?.note).toBe("statements as an arrow function's body (lines 6, 13) → wrapped in { }");
  });

  it('leaves programs that parse, arrows with a second argument, and other syntax errors alone', async () => {
    const { wrapBracelessArrows } = await import('../src/core/error-hints.ts');
    const fine = 'const total = [1, 2, 3].map((n) => n * 2).filter((n) => n > 2);\nconst go = () => { total.forEach((n) => { speak(String(n)); }); };\ngo();';
    expect(wrapBracelessArrows(fine)).toBeNull();
    // A comma before the closing bracket: which statements belong to the arrow is unclear
    expect(wrapBracelessArrows('[1, 2].forEach((n) => speak(n); speak(n), this);')).toBeNull();
    // Another mistake in the program too: nothing is changed
    expect(wrapBracelessArrows('[1, 2].map((n) =>\n  speak(n);\n  speak(n);\n);\nconst x = ;')).toBeNull();
    // A bare number or name among the statements: a comma that became a semicolon (the delay of a timer), not statements
    expect(wrapBracelessArrows('setTimeout(() => speak("hi"); 1000);')).toBeNull();
    expect(wrapBracelessArrows('items.forEach((x) => show(x); step);')).toBeNull();
    // Not an arrow's statements: a stray semicolon in a call
    expect(wrapBracelessArrows('speak("a";')).toBeNull();
  });
});

describe('code written inside backticks', () => {
  // The real lines from Qwen3 0.6B's digital clock and beach sunset: statements written as template literals
  const clock = [
    'function drawClock() {',
    '  // Draw text',
    '  `const text = document.getElementById("time");`',
    '  `text.textContent = drawClock().format("h:mm:ss");`',
    '  document.body.appendChild(text);',
    '}',
    'for (let i = 0; i < 3; i++) {',
    '  `ctx.fillStyle = "rgb(255, 255, 255 - 255 * (i / 60))"`',
    '}',
  ].join('\n');

  it('takes the backticks off, and gives each statement its semicolon', async () => {
    const { unwrapBackticks } = await import('../src/core/error-hints.ts');
    const fixed = unwrapBackticks(clock);
    expect(fixed?.lines).toEqual([3, 4, 8]);
    expect(fixed?.code).toBe(
      clock
        .replace('`const text = document.getElementById("time");`', 'const text = document.getElementById("time");')
        .replace('`text.textContent = drawClock().format("h:mm:ss");`', 'text.textContent = drawClock().format("h:mm:ss");')
        .replace('`ctx.fillStyle = "rgb(255, 255, 255 - 255 * (i / 60))"`', 'ctx.fillStyle = "rgb(255, 255, 255 - 255 * (i / 60))";')
    );
  });

  it('leaves markup, text, placeholders and templates that are used, alone', async () => {
    const { unwrapBackticks } = await import('../src/core/error-hints.ts');
    const alone = [
      'document.body.innerHTML = `<button onclick="go()">Go</button>`;',
      'const label = `ctx.fillStyle = "red";`;',
      'speak(`Total: ${total()}`);',
      '`Done`;',
      '`<p onclick="go()">hi</p>`;',
      '`Draw the sky.`;',
      // A label and a call: a sentence with a colon (the reviewer's case)
      '`Example: greet("Bob")`;',
    ].join('\n');
    expect(unwrapBackticks(alone)).toBeNull();
    expect(unwrapBackticks('const a = ;')).toBeNull();
  });
});

describe('a function that calls itself with no end', () => {
  // The real shape from Qwen3 0.6B's bouncing balls: the frame request repeats animate(), and a plain call
  // at its end recursed until the stack was gone, after making ten elements at every level
  const balls = [
    'const balls = 10;',
    'function animate() {',
    '  requestAnimationFrame(animate);',
    '  for (let i = 0; i < balls; i++) {',
    '    const ball = document.createElement("div");',
    '    document.body.appendChild(ball);',
    '  }',
    '',
    '  animate();',
    '}',
    'animate();',
  ].join('\n');

  it('loses the direct call, and keeps the one that starts it', async () => {
    const { dropEndlessSelfCalls } = await import('../src/core/error-hints.ts');
    const fixed = dropEndlessSelfCalls(balls);
    expect(fixed.dropped).toEqual(['animate']);
    expect(fixed.code).toBe(balls.replace('\n  animate();\n}', '\n  \n}'));
    expect(fixed.code.endsWith('}\nanimate();')).toBe(true);
    // The same for an arrow function and a timer
    const arrow = 'const tick = () => {\n  setTimeout(tick, 1000);\n  show();\n  tick();\n};\ntick();';
    expect(dropEndlessSelfCalls(arrow).code).toBe('const tick = () => {\n  setTimeout(tick, 1000);\n  show();\n  \n};\ntick();');
  });

  it('leaves recursion with an end, a function that never repeats itself by a timer, and calls inside other functions alone', async () => {
    const { dropEndlessSelfCalls } = await import('../src/core/error-hints.ts');
    const programs = [
      // a base case before the call
      'function countdown(n) {\n  requestAnimationFrame(() => {});\n  if (n <= 0) return;\n  countdown(n - 1);\n}',
      // no frame request: not the same slip
      'function walk(node) {\n  show(node);\n  walk(node.next);\n}',
      // the call is in a callback or a condition
      'function animate() {\n  requestAnimationFrame(animate);\n  if (running) animate();\n  items.forEach(() => animate());\n}',
      // a loop the way a capable model writes it
      'function loop(time) {\n  draw(time);\n  requestAnimationFrame(loop);\n}\nrequestAnimationFrame(loop);',
    ];
    for (const program of programs) expect(dropEndlessSelfCalls(program).dropped, program).toEqual([]);
  });
});

describe('a pattern declared again', () => {
  // The real program from Qwen3 0.6B's "Play a short ascending C major scale": names and a pattern, each written twice
  const scale = [
    'speak("Play a short ascending C major scale.");',
    'const synth = new ToneJS();',
    'const synth = Tone.PolySynth();',
    'const { C4, D5, E6, F7, G7, A8, B9 } = Tone.SynthConstants;',
    'const scaleNotes = [C4, D5, E6, F7, G7, A8];',
    'const { C4, D5, E6, F7, G7, A8, B9 } = scaleNotes;',
  ].join('\n');

  it('sets the names again, with the parentheses an object pattern needs as an assignment', async () => {
    const { declareOnce } = await import('../src/core/error-hints.ts');
    const fixed = declareOnce(scale);
    expect(fixed?.names).toEqual(['synth', 'C4, D5, E6, F7, G7, A8, B9']);
    expect(fixed?.code).toBe(
      [
        'speak("Play a short ascending C major scale.");',
        'let synth = new ToneJS();',
        'synth = Tone.PolySynth();',
        'let { C4, D5, E6, F7, G7, A8, B9 } = Tone.SynthConstants;',
        'const scaleNotes = [C4, D5, E6, F7, G7, A8];',
        '({ C4, D5, E6, F7, G7, A8, B9 } = scaleNotes);',
      ].join('\n')
    );
    const arrays = declareOnce('const [a, b] = [1, 2];\nconst [a, b] = [3, 4];\nspeak(String(a + b));');
    expect(arrays?.code).toBe('let [a, b] = [1, 2];\n[a, b] = [3, 4];\nspeak(String(a + b));');
  });

  it('starts the assignment with a semicolon where the line before has none', async () => {
    const { declareOnce } = await import('../src/core/error-hints.ts');
    // Without semicolons a line that begins with [ or ( continues the call before it
    const noSemicolons = 'const [a, b] = [1, 2]\nconsole.log(a, b)\nconst [a, b] = [3, 4]\nconst { c } = pair\nconsole.log(c)\nconst { c } = other';
    const fixed = declareOnce(noSemicolons);
    expect(fixed?.code).toBe('let [a, b] = [1, 2]\nconsole.log(a, b)\n;[a, b] = [3, 4]\nlet { c } = pair\nconsole.log(c)\n;({ c } = other)');
    expect(fixed?.code).not.toContain('console.log(a, b)\n[a');
    // After a semicolon or a brace: none needed
    expect(declareOnce('const [a] = [1];\nconst [a] = [2];')?.code).toBe('let [a] = [1];\n[a] = [2];');
  });

  it('leaves a pattern with new names, one in another block, and programs that parse, alone', async () => {
    const { declareOnce } = await import('../src/core/error-hints.ts');
    // Only some names repeat: unclear what is meant (the program does not parse either way: the repeated const stays)
    expect(declareOnce('const a = 1;\nconst { a, b } = pair;')).toBeNull();
    expect(declareOnce('const { a } = pair;\nfunction f() { const { a } = other; return a; }\nconst x = 1;')).toBeNull();
    expect(declareOnce('const { a } = pair;\nconst { b } = pair;')).toBeNull();
  });
});

describe('options a Tone class does not have (a fact for the model)', () => {
  // The shapes of Tone's classes: each lists its options in a static getDefaults()
  class Loop {
    static getDefaults() {
      return { callback: () => {}, context: {}, humanize: false, interval: '4n', iterations: Infinity, mute: false, playbackRate: 1, probability: 1 };
    }
  }
  class Synth {
    static getDefaults() {
      return { context: {}, oscillator: {}, envelope: {}, volume: 0, portamento: 0 };
    }
  }
  const scope = { Tone: { Loop, Synth } } as unknown as Record<string, unknown>;

  it('names the options the class lacks, and the ones it has', async () => {
    const { toneOptionFacts, errorHint } = await import('../src/core/error-hints.ts');
    // The real line from the failing loop
    const code = 'const loop = new Tone.Loop({ duration: 4, tempo: 120 });\nloop.triggerAttackRelease("G4", 0.5);';
    expect(toneOptionFacts(code, scope)).toBe('Tone.Loop has no option duration or tempo (its options: callback, humanize, interval, iterations, mute, playbackRate, probability).');
    // The hint for the error carries it after the general facts
    const hint = errorHint(code, 'loop.nope is not a function', 2, { ids: [], scope });
    expect(hint?.text).toContain('Tone.Loop has no option duration or tempo');
    expect(hint?.correction).toBeUndefined();
  });

  it('leaves correct options, a callback in place of them, classes the page lacks, and spreads alone', async () => {
    const { toneOptionFacts } = await import('../src/core/error-hints.ts');
    expect(toneOptionFacts('const l = new Tone.Loop({ interval: "8n", humanize: true });', scope)).toBeNull();
    expect(toneOptionFacts('const s = new Tone.Synth({ oscillator: { type: "square" }, envelope: { attack: 0.1 } });', scope)).toBeNull();
    expect(toneOptionFacts('const l = new Tone.Loop((time) => {}, "4n");', scope)).toBeNull();
    expect(toneOptionFacts('const m = new Tone.Mystery({ a: 1 });', scope)).toBeNull();
    expect(toneOptionFacts('const o = { a: 1 };\nconst l = new Tone.Loop({ ...o });', scope)).toBeNull();
    // No Tone on the page: nothing to compare with
    expect(toneOptionFacts('const l = new Tone.Loop({ duration: 4 });', undefined)).toBeNull();
  });
});

describe('a case slip that would read a declaration inside itself', () => {
  it('is not made: new Oscillator() is not new oscillator() in the const oscillator is being made', async () => {
    const { fixCaseSlips } = await import('../src/core/error-hints.ts');
    // The real lines from Qwen3 0.6B's Twinkle Twinkle: the class name was invented, the variable is the one being declared
    const code = 'const audioContext = new AudioContext();\nconst oscillator = new Oscillator(audioContext);\nconst gain = audioContext.createGain();\noscillator.connect(gain);';
    expect(fixCaseSlips(code).fixed).toEqual([]);
    expect(fixCaseSlips(code).code).toBe(code);
    // Still made where the declaration is somewhere else, or in a function that runs later
    expect(fixCaseSlips('const myCount = 1;\nspeak(String(mycount));').fixed).toEqual([{ from: 'mycount', to: 'myCount' }]);
    expect(fixCaseSlips('const tick = () => tock();\nconst Tock = () => 1;\nconst tock2 = 2;').fixed).toEqual([{ from: 'tock', to: 'Tock' }]);
  });
});

describe('new on an object that is no class', () => {
  class Synth {}
  const Tone = { Synth, Transport: { start() {}, bpm: { value: 120 } }, Destination: {}, now: () => 0 };
  const scope = { Tone, Math, JSON } as unknown as Record<string, unknown>;
  const page = { ids: [], scope };

  it('becomes the object itself, as in the real blues program', () => {
    // The real line from Qwen3 0.6B: Tone.Transport made with new
    const code = 'let synth = new Tone.PolySynth();\nsynth = new Tone.Transport().bpm(tempo);\nspeak("Built.");';
    const hint = errorHint(code, 'Tone.Transport is not a constructor', 2, page);
    expect(hint?.correction?.code).toBe('let synth = new Tone.PolySynth();\nsynth = Tone.Transport.bpm(tempo);\nspeak("Built.");');
    expect(hint?.correction?.note).toBe('new Tone.Transport() → Tone.Transport: Tone.Transport is an object, not a class');
    expect(errorHint('const m = new Math();', 'Math is not a constructor', 1, page)?.correction?.code).toBe('const m = Math;');
    // Safari's wording
    expect(errorHint('const t = new Tone.Destination;', "undefined is not a constructor (evaluating 'new Tone.Destination()')", 1, page)?.correction?.code).toBe('const t = Tone.Destination;');
  });

  it('leaves a class, arguments, something that is not there, and a program’s own name alone', () => {
    // A real constructor, made right
    expect(errorHint('const s = new Tone.Synth();', 'Tone.Synth is not a constructor', 1, page)?.correction).toBeUndefined();
    // With arguments
    expect(errorHint('const t = new Tone.Transport(120);', 'Tone.Transport is not a constructor', 1, page)?.correction).toBeUndefined();
    // Not there at all, or no page
    expect(errorHint('const t = new Tone.Nothing();', 'Tone.Nothing is not a constructor', 1, page)?.correction).toBeUndefined();
    expect(errorHint('const t = new Tone.Transport();', 'Tone.Transport is not a constructor', 1)?.correction).toBeUndefined();
    // The program's own Tone
    expect(errorHint('const Tone = {};\nconst t = new Tone.Transport();', 'Tone.Transport is not a constructor', 2, page)?.correction).toBeUndefined();
  });
});

describe('a factory the object does not have, given the class to make', () => {
  class PolySynth {}
  class PluckSynth {}
  const Tone = { PolySynth, PluckSynth, Transport: { start() {} }, now: () => 0 };
  const page = { ids: [], scope: { Tone } as unknown as Record<string, unknown> };
  const error = 'Tone.create is not a function';

  it('makes the class with new, as in the real blues programs', () => {
    // The real lines from Qwen3 0.6B: Tone.create given the class, or its name
    const code = 'let synth = Tone.create(Tone.PolySynth);\nlet pluck = Tone.create("PluckSynth", { volume: -6 });\nsynth.toDestination();';
    const hint = errorHint(code, error, 1, page);
    expect(hint?.correction?.code).toBe('let synth = new Tone.PolySynth();\nlet pluck = new Tone.PluckSynth({ volume: -6 });\nsynth.toDestination();');
    expect(hint?.correction?.note).toContain('a class is made with new');
  });

  it('is only for a method that is a factory by its name (create, make, new, build): Tone.play(Tone.Synth, "C4") plays', () => {
    // The reviewer's probe: a method named for doing something else, given a class
    expect(errorHint('const s = Tone.play(Tone.PolySynth, "C4");', 'Tone.play is not a function', 1, page)?.correction).toBeUndefined();
    expect(errorHint('const s = Tone.start(Tone.PolySynth);', 'Tone.start is not a function', 1, page)?.correction).toBeUndefined();
    expect(errorHint('const s = Tone.creator(Tone.PolySynth);', 'Tone.creator is not a function', 1, page)?.correction).toBeUndefined();
    // The factory names still are
    for (const method of ['make', 'build', 'createInstrument', 'new']) {
      expect(errorHint(`const s = Tone.${method}(Tone.PolySynth);`, `Tone.${method} is not a function`, 1, page)?.correction?.code, method).toBe('const s = new Tone.PolySynth();');
    }
  });

  it('makes the class named in the method (Tone.createPolySynth), unless a class is handed over, and keeps all the arguments', () => {
    // The real lines from Qwen3 0.6B's Twinkle Twinkle program
    const code = 'const synth = Tone.createPolySynth();\nconst pluck = Tone.makePluckSynth({ volume: -6 });\nsynth.toDestination();';
    expect(errorHint(code, 'Tone.createPolySynth is not a function', 1, page)?.correction?.code).toBe('const synth = new Tone.PolySynth();\nconst pluck = Tone.makePluckSynth({ volume: -6 });\nsynth.toDestination();');
    expect(errorHint('const p = Tone.makePluckSynth({ volume: -6 });', 'Tone.makePluckSynth is not a function', 1, page)?.correction?.code).toBe('const p = new Tone.PluckSynth({ volume: -6 });');
    // (a class in the arguments is the one meant; a name that is no class of the object is not a factory)
    expect(errorHint('const s = Tone.createPluckSynth(Tone.PolySynth);', 'Tone.createPluckSynth is not a function', 1, page)?.correction?.code).toBe('const s = new Tone.PolySynth();');
    expect(errorHint('const s = Tone.createMelody();', 'Tone.createMelody is not a function', 1, page)?.correction).toBeUndefined();
    expect(errorHint('const s = Tone.createtransport();', 'Tone.createtransport is not a function', 1, page)?.correction).toBeUndefined();
  });

  it('leaves a call with no class in it, one the page does not know, and a program’s own Tone, alone', () => {
    // Another call of it that names no class: unclear what the rest mean
    expect(errorHint('const a = Tone.create(Tone.PolySynth);\nconst b = Tone.create(42);', error, 1, page)?.correction).toBeUndefined();
    expect(errorHint('const a = Tone.create(Tone.Nothing);', error, 1, page)?.correction).toBeUndefined();
    expect(errorHint('const Tone = { create() {} };\nconst a = Tone.create(Tone.PolySynth);', error, 2, page)?.correction).toBeUndefined();
    expect(errorHint('const a = Tone.create(Tone.PolySynth);', error, 1)?.correction).toBeUndefined();
    // A member the object has is not a missing factory
    expect(errorHint('const a = Tone.now(Tone.PolySynth);', 'Tone.now is not a function', 1, page)?.correction).toBeUndefined();
  });
});

describe('a fence label left in the code', () => {
  it('is taken out, as in the tip calculator Qwen3 0.6B wrote', async () => {
    const { dropFenceLabels } = await import('../src/core/error-hints.ts');
    // The real lines: the label of the second fence stayed on a line of its own
    const code = 'speak("Calculate.");\njavascript\n// Calculate and display the result:\nconst bill = parseFloat(document.getElementById("bill").value);\ndocument.getElementById("out").textContent = bill;';
    expect(dropFenceLabels(code)).toEqual({ code: 'speak("Calculate.");\n\n// Calculate and display the result:\nconst bill = parseFloat(document.getElementById("bill").value);\ndocument.getElementById("out").textContent = bill;', labels: ['javascript'] });
  });

  it('leaves a name the program declares, a call, a property, and a program without one alone', async () => {
    const { dropFenceLabels } = await import('../src/core/error-hints.ts');
    for (const code of ['const js = 3;\njs\nspeak(String(js));', 'function html() { return 1; }\nhtml', 'javascript.run();', 'speak(javascript);', 'const x = 1;\nspeak(String(x));']) {
      expect(dropFenceLabels(code).labels, code).toEqual([]);
    }
  });
});

describe('a speak() of the request’s own words', () => {
  // The real programs Qwen3 0.6B wrote: the request said back, then the work
  const countdown = 'speak("Show a big ten second countdown on screen.");\n\ndocument.getElementById("countdown").innerText = 10;\nsetInterval(() => {}, 1000);';
  const pong = 'const canvas = document.createElement("canvas");\ndocument.body.appendChild(canvas);\nspeak("Hi! Make a single-player Pong game with a paddle you move by mouse or touch.")';

  it('is taken out of a program that does something else, the lines staying where they were', async () => {
    const { dropRequestEcho } = await import('../src/core/error-hints.ts');
    expect(dropRequestEcho(countdown, 'Show a big ten second countdown on screen')).toEqual({ code: countdown.replace('speak("Show a big ten second countdown on screen.");', ''), dropped: 1 });
    expect(dropRequestEcho(pong, 'Make a single-player Pong game with a paddle you move by mouse or touch').code).toBe('const canvas = document.createElement("canvas");\ndocument.body.appendChild(canvas);\n');
    // Template text, a block, and every copy of it
    const twice = 'if (ok) {\n  speak(`Show a big ten second countdown on screen`);\n}\nspeak("Show a big ten second countdown on screen!");\nstart();';
    expect(dropRequestEcho(twice, 'Show a big ten second countdown on screen.').dropped).toBe(2);
  });

  it('leaves what is not the request alone: an answer, a sentence around it, a short request, a speak of its own, a program that is only the echo', async () => {
    const { dropRequestEcho } = await import('../src/core/error-hints.ts');
    const request = 'Show a big ten second countdown on screen';
    for (const code of [
      'speak("Counting down from ten.");\nstart();',
      'speak("You asked: Show a big ten second countdown on screen");\nstart();',
      'speak("Show a big ten second countdown on screen" + extra);\nstart();',
      'speak("Show a big ten second countdown on screen", 2);\nstart();',
      'function speak(t) { log(t); }\nspeak("Show a big ten second countdown on screen");\nstart();',
      'speak("Show a big ten second countdown on screen");',
      'const show = (t) => t;\nshow("Show a big ten second countdown on screen");',
    ]) {
      expect(dropRequestEcho(code, request), code).toEqual({ code, dropped: 0 });
    }
    // A greeting answered with a greeting, and an empty request
    expect(dropRequestEcho('speak("Hello there");\nstart();', 'Hello there').dropped).toBe(0);
    expect(dropRequestEcho(countdown, '').dropped).toBe(0);
  });
});

describe('a library named with its file’s ending', () => {
  const scope = { Tone: {}, THREE: {} } as unknown as Record<string, unknown>;

  it('is the library the page has (ToneJS for Tone), as in the Twinkle Twinkle program Qwen3 0.6B wrote', () => {
    const code = 'const synth = new ToneJS.PolySynth();\nsynth.triggerAttackRelease("C4", "8n");\nToneJS.start();';
    const hint = errorHint(code, 'ToneJS is not defined', 1, { ids: [], scope });
    expect(hint?.correction?.code).toBe('const synth = new Tone.PolySynth();\nsynth.triggerAttackRelease("C4", "8n");\nTone.start();');
    expect(errorHint('const m = new THREEjs.Mesh();', 'THREEjs is not defined', 1, { ids: [], scope })?.correction?.code).toBe('const m = new THREE.Mesh();');
    expect(errorHint('ThreeJS.go();', "Can't find variable: ThreeJS", 1, { ids: [], scope })?.correction?.code).toBe('THREE.go();');
  });

  it('is the library the page has when it is read off the window, where the read fails', () => {
    const code = 'const synth = new window.ToneJS.PolySynth();\nglobalThis.THREEjs.go();';
    const hint = errorHint(code, "Cannot read properties of undefined (reading 'PolySynth')", 1, { ids: [], scope });
    expect(hint?.correction?.code).toBe('const synth = new Tone.PolySynth();\nTHREE.go();');
    // (a window name the page really has, or another name, is left alone)
    expect(errorHint('window.Tone.start();', "Cannot read properties of undefined (reading 'start')", 1, { ids: [], scope })?.correction).toBeUndefined();
    expect(errorHint('window.ToneKit.start();', "Cannot read properties of undefined (reading 'start')", 1, { ids: [], scope })?.correction).toBeUndefined();
    expect(errorHint(code, "Cannot read properties of undefined (reading 'PolySynth')", 1, { ids: [], scope: {} })?.correction).toBeUndefined();
    expect(errorHint('const window = {};\nwindow.ToneJS.go();', "Cannot read properties of undefined (reading 'go')", 2, { ids: [], scope })?.correction).toBeUndefined();
  });

  it('is left alone without the library in the page, for another name, or when the program declares the name', () => {
    expect(errorHint('ToneJS.start();', 'ToneJS is not defined', 1, { ids: [], scope: {} })?.correction).toBeUndefined();
    expect(errorHint('ToneJS.start();', 'ToneJS is not defined', 1)?.correction).toBeUndefined();
    expect(errorHint('ToneKit.start();', 'ToneKit is not defined', 1, { ids: [], scope })?.correction).toBeUndefined();
    expect(errorHint('const ToneJS = {};\nToneJS.start(); Tone2.go();', 'Tone2 is not defined', 2, { ids: [], scope })?.correction).toBeUndefined();
  });
});

describe('Tone: a word where a pitch or a time goes', () => {
  // The real program and error from Qwen3 0.6B's "Play Twinkle Twinkle Little Star on the piano"
  const code = 'const synth = new Tone.PolySynth();\nconst note = "Twinkle";\nconst duration = 0.5;\nsynth.triggerAttackRelease(note, duration, 0.5);';

  it('names the word, the line it is on, and how a pitch and a time are written', () => {
    const hint = errorHint(code, 'Error: Invalid argument(s) to setValueAtTime: "Twinkle", 0.5', undefined, { ids: [], scope: {} });
    expect(hint?.text).toBe(
      '"Twinkle" (line 2) is not a number Tone can use there. A pitch is a note name such as "C4" or "F#3" (a letter, an optional # or b, an octave number) or a frequency in Hz such as 261.63; a time is seconds such as 0.5 or a Tone time such as "8n".'
    );
  });

  it('says nothing for numbers, other errors, or text it cannot read', () => {
    expect(errorHint(code, 'Error: Invalid argument(s) to setValueAtTime: null, 0.5', undefined, { ids: [], scope: {} })?.text).toBeUndefined();
    expect(errorHint(code, 'Error: Invalid argument(s) to setValueAtTime: 440, "0.5"', undefined, { ids: [], scope: {} })?.text).toBeUndefined();
    expect(errorHint(code, 'Invalid argument(s) to setValueAtTime: {oops', undefined, { ids: [], scope: {} })?.text).toBeUndefined();
  });
});

describe('a member the library does not have, in Safari’s words as in Chrome’s', () => {
  class Synth {}
  class PolySynth extends Synth {}
  class MembraneSynth extends Synth {}
  class Part {}
  class Loop {}
  const Tone = { Synth, PolySynth, MembraneSynth, Part, Loop, Transport: { start() {} }, now: () => 0 };
  const page = { ids: [], scope: { Tone } as unknown as Record<string, unknown> };
  // The real line from Qwen3 0.6B's Twinkle Twinkle program, and what each browser says of it
  const code = 'const synth = new Tone.PolySynth();\nconst melody = new Tone.Melody();\nmelody.start();';
  const forms = [
    'Tone.Melody is not a constructor',
    "undefined is not a constructor (evaluating 'new Tone.Melody()')",
    "TypeError: undefined is not a constructor (evaluating 'new Tone.Melody(\"C4\")')",
  ];

  it('says what the library has, for a class made with new', () => {
    for (const error of forms) {
      const text = errorHint(code, error, 2, page)?.text;
      expect(text, error).toContain('Tone has no Melody()');
      expect(text, error).toContain('Tone.Synth');
    }
  });

  it('says what the library has, for a method called, in Safari’s form as in Chrome’s', () => {
    for (const error of ['Tone.melody is not a function', "undefined is not a function (evaluating 'Tone.melody(...)')"]) {
      expect(errorHint('Tone.melody("C4");', error, 1, page)?.text, error).toContain('Tone has no melody()');
    }
  });

  it('corrects a sure slip of a class, and leaves a member that exists alone', () => {
    expect(errorHint('const s = new Tone.PolySynthh();', "undefined is not a constructor (evaluating 'new Tone.PolySynthh()')", 1, page)?.correction?.code).toBe('const s = new Tone.PolySynth();');
    expect(errorHint('const s = new Tone.PolySynth();', "undefined is not a constructor (evaluating 'new Tone.PolySynth()')", 1, page)?.text).toBeUndefined();
    // (a program’s own Tone is its own)
    expect(errorHint('const Tone = {};\nnew Tone.Melody();', 'Tone.Melody is not a constructor', 2, page)?.text ?? '').not.toContain('Tone has no Melody');
  });

  it('names the member to fill in for the blank stage in Safari’s form', async () => {
    const { memberBlank } = await import('../src/core/blank-fix.ts');
    for (const error of ['Tone.buildSynth is not a function', "undefined is not a function (evaluating 'Tone.buildSynth(...)')"]) {
      const found = memberBlank('const s = Tone.buildSynth("C4");\ns.triggerAttackRelease("C4", "8n");', error, 1, page.scope);
      expect(found?.blank.member?.object, error).toBe('Tone');
      expect(found?.blank.text, error).toBe('buildSynth');
    }
    const made = memberBlank('const s = new Tone.SynthPoly("C4");', "undefined is not a constructor (evaluating 'new Tone.SynthPoly(\"C4\")')", 1, page.scope);
    expect(made?.blank.member?.use).toBe('new');
  });
});

describe('a declaration nothing reads, made by a member the library does not have', () => {
  class Synth {}
  class PolySynth extends Synth {}
  class Loop {}
  const Tone = { Synth, PolySynth, Loop, Transport: { start() {} }, now: () => 0 };
  const page = { ids: [], scope: { Tone } as unknown as Record<string, unknown> };
  // The real program from the live iPhone run: melody is made by Tone.Melody and read by nothing
  const live = [
    'const synth = new Tone.PolySynth();',
    'const melody = new Tone.Melody();',
    'const tempo = 60; const beat = tempo / 12;',
    'synth.toDestination();',
    'synth.triggerAttackRelease("C4", "8n");',
  ].join('\n');

  it('takes the declaration out, in Chrome’s words and Safari’s', () => {
    for (const error of ['Tone.Melody is not a constructor', "undefined is not a constructor (evaluating 'new Tone.Melody()')"]) {
      const hint = errorHint(live, error, 2, page);
      expect(hint?.correction?.code, error).toBe(live.replace('const melody = new Tone.Melody();\n', ''));
      expect(hint?.correction?.note, error).toContain('melody');
    }
    // (a call may be the very thing asked for: it stays, and the model hears what the library has)
    expect(errorHint('const m = Tone.makeMelody("C4");\nspeak("hi");', 'Tone.makeMelody is not a function', 1, page)?.correction).toBeUndefined();
    // (and a program of nothing else is not emptied)
    expect(errorHint('const m = new Tone.Melody();', 'Tone.Melody is not a constructor', 1, page)?.correction).toBeUndefined();
  });

  it('keeps one that is read, one whose member exists, one with a call in it, and a slip that has a sure answer', () => {
    const read = 'const melody = new Tone.Melody();\nmelody.start();';
    expect(errorHint(read, 'Tone.Melody is not a constructor', 1, page)?.correction).toBeUndefined();
    expect(errorHint('const l = new Tone.Loop();', 'Tone.Loop is not a constructor', 1, page)?.correction).toBeUndefined();
    expect(errorHint('const m = new Tone.Melody(compute());', 'Tone.Melody is not a constructor', 1, page)?.correction).toBeUndefined();
    expect(errorHint('const s = new Tone.PolySynthh();', 'Tone.PolySynthh is not a constructor', 1, page)?.correction?.code).toBe('const s = new Tone.PolySynth();');
    // (named in a handler string: read)
    expect(errorHint('const m = new Tone.Melody();\nbtn.setAttribute("onclick", "m.start()");', 'Tone.Melody is not a constructor', 1, page)?.correction).toBeUndefined();
    // (a different declaration of the same name elsewhere: not unused)
    expect(errorHint('const m = new Tone.Melody();\nfunction f(m) { return m + 1; }', 'Tone.Melody is not a constructor', 1, page)?.correction).toBeUndefined();
  });
});

describe('Tone constructors handed arguments their parameters cannot take', () => {
  // (stand-ins with the source Tone's classes have: the parameter names are listed where the arguments are read)
  const optionsFromArguments = (..._args: unknown[]) => ({});
  class Synth {
    static getDefaults() {
      return { oscillator: {}, envelope: {} };
    }
  }
  class PolySynth {
    constructor() {
      optionsFromArguments(PolySynth.getDefaults(), arguments, ['voice', 'options']);
    }
    static getDefaults() {
      return { voice: Synth, options: {}, volume: 0 };
    }
  }
  class Loop {
    constructor() {
      optionsFromArguments(Loop.getDefaults(), arguments, ['callback', 'interval']);
    }
    static getDefaults() {
      return { callback: () => undefined, interval: '4n', iterations: Infinity };
    }
  }
  const Tone = { Synth, PolySynth, Loop };
  const page = { ids: [], scope: { Tone } as unknown as Record<string, unknown> };
  // The real program from Qwen2.5 0.5B on the live build, and what Tone said inside itself
  const live = 'var note = "C4"; var duration = 100; var time = 0;\nvar synth = new Tone.PolySynth(note, duration, time);\nsynth.triggerAttackRelease(note, 500, 1);';
  const inside = "t.voice.getDefaults is not a function. (In 't.voice.getDefaults()', 't.voice.getDefaults' is undefined)";

  it('reads the parameter names from the class itself', async () => {
    const { constructorParameters } = await import('../src/core/error-hints.ts');
    expect(constructorParameters(PolySynth)).toEqual(['voice', 'options']);
    expect(constructorParameters(Loop)).toEqual(['callback', 'interval']);
    expect(constructorParameters(Synth)).toBeNull();
    expect(constructorParameters(undefined)).toBeNull();
  });

  it('says what each parameter is, and what the program gave, for the live PolySynth and for a Loop given a string', async () => {
    const { toneArgumentFacts } = await import('../src/core/error-hints.ts');
    expect(toneArgumentFacts(live, page.scope)).toBe('new Tone.PolySynth(voice, options): the first argument is voice, an instrument class such as Tone.Synth; here it is a string.');
    expect(toneArgumentFacts('const note = "C4";\nconst loop = new Tone.Loop(note, 0.5);', page.scope)).toBe('new Tone.Loop(callback, interval): the first argument is callback, a function; here it is a string.');
    // It comes with the error's hint when there is no correction to make (the error is not one thrown inside Tone)
    expect(errorHint(live, 'The program showed nothing: what it adds to document.body appears in the card on screen.', undefined, page)?.text).toContain('new Tone.PolySynth(voice, options)');
  });

  it('leaves out the arguments from the first that cannot fit, so the call runs without them (the error is thrown inside Tone)', () => {
    const hint = errorHint(live, inside, undefined, page);
    expect(hint?.correction?.code).toBe('var note = "C4"; var duration = 100; var time = 0;\nvar synth = new Tone.PolySynth();\nsynth.triggerAttackRelease(note, 500, 1);');
    expect(hint?.correction?.note).toContain('new Tone.PolySynth(note, duration, time)');
    // A later argument goes with the first that cannot fit; an earlier one that fits stays
    expect(errorHint('const p = new Tone.PolySynth(Tone.Synth, "loud", 1);', 'Error: voice is not a function', undefined, page)?.correction?.code).toBe('const p = new Tone.PolySynth(Tone.Synth);');
    // The call on the failing line only
    expect(errorHint('const a = new Tone.PolySynth("C4");\nconst b = new Tone.PolySynth("D4");', inside, 2, page)?.correction?.code).toBe('const a = new Tone.PolySynth("C4");\nconst b = new Tone.PolySynth();');
  });

  it('leaves correct calls alone: a class and options, a callback, text for a time, no arguments, and a check on what the program did', () => {
    for (const ok of ['new Tone.PolySynth(Tone.Synth, { volume: -8 })', 'new Tone.PolySynth()', 'new Tone.PolySynth({ volume: -8 })', 'new Tone.Loop((time) => {}, "8n")', 'new Tone.Loop(function (time) {}, 0.5)']) {
      const code = `const x = ${ok};`;
      const hint = errorHint(code, inside, undefined, page);
      expect(hint?.correction?.code ?? '', ok).not.toContain('new Tone.PolySynth();');
      expect(hint?.text ?? '', ok).not.toContain('here it is');
    }
    expect(errorHint(live, 'The program showed nothing: what it adds to document.body appears in the card on screen.', undefined, page)?.correction).toBeUndefined();
    // (a callback declared as a function, and a time held in a name, fit)
    expect(errorHint('function tick(time) {}\nconst interval = "4n";\nnew Tone.Loop(tick, interval);', inside, undefined, page)?.correction).toBeUndefined();
    // (a program's own Tone is its own)
    expect(errorHint('const Tone = { PolySynth: class {} };\nnew Tone.PolySynth("C4");', inside, undefined, page)?.correction).toBeUndefined();
  });
});

describe('an element that was never made, used with the members of a value the program already has', () => {
  class CanvasRenderingContext2D {
    clearRect() {}
    translate() {}
    fillRect() {}
  }
  const page = { ids: [], standIns: [{ id: 'drawing-area', tag: 'div', made: 'empty' as const }], scope: { CanvasRenderingContext2D } as unknown as Record<string, unknown> };
  // The shape of the live beach program: a context, and a drawing area that nothing created
  const beach = [
    'const ctx = document.body.appendChild(document.createElement("canvas")).getContext("2d");',
    "const drawingArea = document.getElementById('drawing-area');",
    'drawingArea.clearRect(0, 0, 300, 150);',
    'drawingArea.translate(10, 10);',
  ].join('\n');

  it('points to the context the program has, instead of saying to create an element', () => {
    for (const code of [beach, beach.replace(/drawingArea\./g, "document.getElementById('drawing-area').").replace("const drawingArea = document.getElementById('drawing-area');\n", '')]) {
      const hint = errorHint(code, 'drawingArea.clearRect is not a function', 3, page);
      expect(hint?.text).toContain('belong to a CanvasRenderingContext2D, and the program already has one: ctx');
      expect(hint?.text).toContain('Use ctx.clearRect(');
      expect(hint?.text).not.toContain('Create the element');
    }
  });

  it('says to create the element when no value of that type is there, or the members are an element’s', () => {
    const none = beach.replace(/^const ctx.*\n/, '');
    expect(errorHint(none, 'drawingArea.clearRect is not a function', 2, page)?.text).not.toContain('already has one');
    const element = "const area = document.getElementById('drawing-area');\narea.focus();";
    expect(errorHint(element, 'area.focus is not a function', 2, page)?.text).toContain('Create the element');
  });
});
