import { describe, expect, it } from 'vitest';
import { errorHint } from '../src/core/error-hints.ts';

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
