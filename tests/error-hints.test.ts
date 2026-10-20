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
    expect(dropHelperCopies(code)).toEqual({ code: 'speak("Hi.");\nspeak("Hi.");', dropped: ['speak'] });
    expect(dropHelperCopies('const total = 1;\nspeak(total);').dropped).toEqual([]);
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
