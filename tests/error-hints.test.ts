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

  it('lists what the program does declare when nothing is close', () => {
    const code = 'function playMusic() {}\nconst bpm = 90;\nsetupSynth();';
    expect(errorHint(code, 'setupSynth is not defined', 3)!.text).toBe(
      "Nothing named setupSynth is declared. The program's functions: playMusic(). Its variables: bpm."
    );
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
    expect(errorHint(code, 'zap is not defined', 3)?.text).toContain('Its variables: getBody, c.');
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
    expect(text).toContain('navigator.requestMIDIAccess');
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

describe('a stray quote ending a line', () => {
  it('is removed when that alone makes the program parse', async () => {
    const { dropStrayQuote } = await import('../src/core/error-hints.ts');
    const code = 'const bpm = 60;\nout.send({ notes: "G major" });\nspeak("Playing.");`';
    expect(dropStrayQuote(code)).toEqual({ code: 'const bpm = 60;\nout.send({ notes: "G major" });\nspeak("Playing.");', line: 3 });
  });

  it('leaves a program that parses, and one a quote alone can’t fix, alone', async () => {
    const { dropStrayQuote } = await import('../src/core/error-hints.ts');
    expect(dropStrayQuote('const s = `a`;')).toBeNull();
    expect(dropStrayQuote('const a = (1;\nspeak("x");`')).toBeNull();
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
