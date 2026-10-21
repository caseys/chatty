import { describe, expect, it } from 'vitest';
import { dropHelperCopies, errorHint, fixAudioNodeProperties, fixCaseSlips, loopOneFrameAnimations } from '../src/core/error-hints.ts';
import { callUncalledFunctions, inspectExecutableCode, speakClosingComment } from '../src/tools/javascript-runtime.ts';
import { droppedCapabilities } from '../src/core/orchestrator.ts';

// Each repair here fired on a correct program, or on a guess, before it was tightened: the
// correct program is now left alone, and the failure it was written for is still repaired

describe("a program's own clear() of several statements", () => {
  it('is kept under another name with every reference to it, not renamed as the program', () => {
    const code = 'let score = 0;\nfunction clear() {\n  ctx.clearRect(0, 0, 10, 10);\n  balls = [];\n  score = 0;\n}\nbtn.onclick = clear;\nclear();';
    const out = dropHelperCopies(code);
    expect(out.renamed).toEqual([]);
    expect(out.kept).toEqual(['clear → clear_']);
    expect(out.code).toContain('btn.onclick = clear_;');
    expect(out.code.trim().endsWith('clear_();')).toBe(true);
  });
  it('still renames a speak() that holds the whole program', () => {
    const out = dropHelperCopies('const speak = () => {\n  const bpm = 100;\n  play(bpm);\n  speak("Playing.");\n};\nspeak();');
    expect(out.renamed).toEqual(['speak → main']);
  });
});

describe('a name the sandbox provides', () => {
  it('is never taken for a case slip of a declared one', () => {
    const code = 'const three = 3;\nconst scene = new THREE.Scene();\nspeak(String(three));';
    expect(fixCaseSlips(code).fixed).toEqual([]);
    expect(fixCaseSlips('const Start = 1;\nout.send({ notes: "C4", time: start });').fixed).toEqual([]);
  });
  it('while a real case slip is still corrected', () => {
    expect(fixCaseSlips('const myCount = 1;\nspeak(mycount);').fixed).toEqual([{ from: 'mycount', to: 'myCount' }]);
  });
});

describe('an audio node read as a property of a context', () => {
  it('is left alone on a parameter of the same name as the context (a gain node called ctx)', () => {
    const code = 'const ctx = new AudioContext();\nfunction setVolume(ctx) {\n  ctx.gain.value = 0.5;\n}\nsetVolume(ctx.createGain());';
    expect(fixAudioNodeProperties(code).fixed).toEqual([]);
  });
  it('is still made with its create call on the context itself', () => {
    expect(fixAudioNodeProperties('const ctx = new AudioContext();\nconst osc = ctx.oscillator;').fixed).toEqual(['oscillator → createOscillator()']);
  });
});

describe('a frame asked for a function something else drives', () => {
  it('is not looped when a timer, or a loop that asks for its own frames, keeps it going', () => {
    const timer = 'let n = 0;\nfunction tick() {\n  n++;\n  draw();\n}\nsetInterval(tick, 100);\nrequestAnimationFrame(tick);';
    expect(loopOneFrameAnimations(timer).looped).toEqual([]);
    const loop = 'let x = 0;\nfunction update() {\n  x += 1;\n}\nfunction loop() {\n  update();\n  draw();\n  requestAnimationFrame(loop);\n}\nrequestAnimationFrame(update);\nloop();';
    expect(loopOneFrameAnimations(loop).looped).toEqual([]);
  });
  it('is still looped when nothing else drives it', () => {
    expect(loopOneFrameAnimations('let n = 0;\nfunction tick() {\n  n++;\n  draw();\n}\nrequestAnimationFrame(tick);').looped).toEqual(['tick']);
  });
});

describe('a name declared twice', () => {
  it('is assigned the second time in its own block only: another function’s declaration of the name stays', () => {
    const code = 'function a() {\n  const t = 1;\n  return t;\n}\nconst t = 2;\nplay(t);\nconst t = 3;';
    const hint = errorHint(code, "Identifier 't' has already been declared", 7)!;
    expect(hint.correction!.code).toBe('function a() {\n  const t = 1;\n  return t;\n}\nlet t = 2;\nplay(t);\nt = 3;');
  });
});

describe('a slip of a browser global', () => {
  it('is not taken for a name the program only forgot to declare (data is no use of Date)', () => {
    expect(errorHint('speak(String(data.length));', 'data is not defined', 1)?.correction).toBeUndefined();
  });
  it('is corrected when the program uses it as that global (called, or its own member read)', () => {
    expect(errorHint('setTimeot(draw, 10);', 'setTimeot is not defined', 1)?.correction?.note).toBe('setTimeot → setTimeout');
    expect(errorHint('speak(String(Maht.random()));', 'Maht is not defined', 1)?.correction?.code).toBe('speak(String(Math.random()));');
  });
  it('renames only the references, not a property or key of the same name', () => {
    const code = "const colour = 'red';\nconst ball = { color: 1 };\nctx.fillStyle = color;\nspeak(ball.color);";
    const hint = errorHint(code, 'color is not defined', 3)!;
    expect(hint.correction!.code).toBe("const colour = 'red';\nconst ball = { color: 1 };\nctx.fillStyle = colour;\nspeak(ball.color);");
  });
  it('needs the declared name to be visible where the missing one is used', () => {
    expect(errorHint('function a() {\n  const total = 1;\n}\nspeak(totl);', 'totl is not defined', 4)?.correction).toBeUndefined();
  });
});

describe('an id one slip from one on the page', () => {
  it('is corrected in its lookup only, not in a class name or a message of the same word', () => {
    const code = "const btn = document.getElementById('startBtn');\nbtn.classList.add('startBtn');\nspeak('startBtn');";
    const hint = errorHint(code, "Cannot read properties of null (reading 'classList')", 2, { ids: ['startbtn'] })!;
    expect(hint.correction!.code).toBe("const btn = document.getElementById('startbtn');\nbtn.classList.add('startBtn');\nspeak('startBtn');");
  });
});

describe("a program's own copy of a helper", () => {
  it('is left where the error is about something else', () => {
    const code = "const out = new Out({ instrument: 'piano' });\nout.send({ notes: bpm });";
    expect(errorHint(code, 'bpm is not defined', 2)?.correction).toBeUndefined();
  });
  it('still goes when the error names it', () => {
    expect(errorHint("const out = new Out({ instrument: 'piano' });\nout.send({ notes: 'C4' });", 'Out is not defined', 1)?.correction?.code).toBe("out.send({ notes: 'C4' });");
  });
});

describe('a closing comment', () => {
  it('is not said when it is a note to a programmer', () => {
    expect(speakClosingComment('draw();\n// TODO: add collision detection later.')).toBeNull();
    expect(speakClosingComment('draw();\n// draw the ball at its new position')).toBeNull();
    expect(speakClosingComment('draw();\n// Fixme: the ball leaves the canvas sometimes.')).toBeNull();
  });
  it('is said when it is a sentence to the user', () => {
    expect(speakClosingComment('draw();\n// This draws a red ball that bounces around.')?.text).toBe('This draws a red ball that bounces around.');
  });
});

describe('two code blocks alike in their drawing lines', () => {
  it('are both kept when they declare nothing in common (two parts of one program)', () => {
    const a = 'const a = 1;\nctx.beginPath();\nctx.arc(10, 10, 5, 0, 7);\nctx.fill();\nctx.stroke();';
    const b = 'const b = 2;\nctx.beginPath();\nctx.arc(20, 20, 5, 0, 7);\nctx.fill();\nctx.stroke();';
    const prepared = inspectExecutableCode('```js\n' + a + '\n```\n\n```js\n' + b + '\n```');
    expect(prepared.repeatedBlocks).toBeUndefined();
    expect(prepared.code).toContain('const a = 1;');
    expect(prepared.code).toContain('const b = 2;');
  });
});

describe('a program that starts itself', () => {
  it('has its other functions left for it to call', () => {
    const code = 'function showHelp() {\n  speak("Help.");\n}\nfunction setup() {\n  draw();\n}\nsetup();';
    expect(callUncalledFunctions(code)).toBe(code);
    const awaited = 'async function main() {\n  speak("Hi.");\n}\nfunction showHelp() {\n  speak("Help.");\n}\nawait main();';
    expect(callUncalledFunctions(awaited)).toBe(awaited);
  });
  it('one that only defines its functions still gets its call', () => {
    const code = 'function helper() { return 1; }\nfunction drawScene() {\n  helper();\n}';
    expect(callUncalledFunctions(code)).toBe(`${code}\nawait drawScene();`);
  });
});

describe('a fix that keeps building the page', () => {
  it('is not taken for one that dropped the page when it sets text instead of markup', () => {
    expect(droppedCapabilities('make a todo list app', "root.innerHTML = '<p>Buy milk</p>';", "root.textContent = 'Buy milk';")).toEqual([]);
  });
  it('one that only talks has dropped it', () => {
    expect(droppedCapabilities('make a todo list app', "root.innerHTML = '<p>Buy milk</p>';", "speak('Buy milk');")).toEqual(['page']);
  });
});
