import { describe, expect, it } from 'vitest';
import { errorHint } from '../src/core/error-hints.ts';
import { blankChoices, findBlank } from '../src/core/blank-fix.ts';

describe('repairs that would change what a program means', () => {
  it('does not take a plural for a slip of its singular (a list is not one of its items)', () => {
    const code = 'const ball = { x: 1 };\nfor (let i = 0; i < balls.length; i++) balls[i].x++;';
    const hint = errorHint(code, "Can't find variable: balls", 2);
    expect(hint?.correction).toBeUndefined();
  });

  it('still corrects a real slip of a declared name', () => {
    const code = 'const total = 5;\nspeak(`${totl}`);';
    expect(errorHint(code, "Can't find variable: totl", 2)?.correction?.note).toBe('totl → total');
  });

  it('offers no loop counter for a blank whose member a number lacks', () => {
    const code = 'const ball = { color: "red" };\nfor (var i = 0; i < 3; i++) {}\nctx.fillStyle = ball[i].color;';
    const blank = findBlank(code, "undefined is not an object (evaluating 'ball[i].color')", 3);
    expect(blank).not.toBeNull();
    expect(blankChoices(code, blank!, { ids: [] })).not.toContain('i');
  });
});

describe('fix sampling for small models', async () => {
  const { forModel } = await import('../src/core/orchestrator.ts');
  it('scales temperatures down on WebLLM (hottest 1), and leaves Gemma 4 on LiteRT alone', () => {
    expect(forModel({ temperature: 1.3, topP: 0.95 }, 'qwen3-4b').temperature).toBe(1);
    expect(forModel({ temperature: 1.3, topP: 0.95 }, 'qwen2.5-0.5b').temperature).toBe(1);
    expect(forModel({ temperature: 1, topP: 0.99 }, 'qwen2.5-0.5b').temperature).toBe(0.77);
    expect(forModel({ temperature: 1.3, topP: 0.95 }, 'gemma-4-e2b-it-web').temperature).toBe(1.3);
  });
});

describe('a reply cut off before its end', async () => {
  const { inspectExecutableCode } = await import('../src/tools/javascript-runtime.ts');
  const { closeCutOff } = await import('../src/core/error-hints.ts');
  const { parse } = await import('acorn');
  const parses = (code: string) => {
    try {
      parse(code, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true });
      return true;
    } catch {
      return false;
    }
  };

  it('closes its open blocks, then calls its function after them', () => {
    const reply = [
      '```javascript',
      'function animate() {',
      '  const canvas = document.createElement("canvas");',
      '  document.body.appendChild(canvas);',
      '  function frame() {',
      '    requestAnimationFrame(frame);',
      '    setTimeout(frame, 100); // Update every',
    ].join('\n');
    const prepared = inspectExecutableCode(reply);
    expect(prepared.cutOff).toBeDefined();
    expect(parses(prepared.code)).toBe(true);
    // The call comes after the closed function, not inside it
    expect(prepared.code.trim().split('\n').at(-1)).toMatch(/animate\(\);$/);
  });

  it('removes an unfinished last line first', () => {
    const cut = closeCutOff('function a() {\n  const x = 1;\n  const y = "unfinish');
    expect(cut).toEqual({ code: 'function a() {\n  const x = 1;\n}', dropped: 1, closed: 1, template: false });
  });

  it('closes a template string the reply was cut inside (the to-do list Qwen3 0.6B wrote), and the blocks after it', () => {
    // The real reply: markup being written into the page, stopped for repeating itself
    const reply = 'document.body.innerHTML = `\n  <div id="todo-app">\n    <h2>Make a to-do list</h2>\n    <div class="todo-container">\n      <div class="todo-item">Today\'s Tasks</div>';
    const cut = closeCutOff(reply);
    expect(cut).toEqual({ code: `${reply}\n\`;`, dropped: 0, closed: 0, template: true });
    const inFunction = 'function show() {\n  panel.innerHTML = `\n    <ul>\n      <li>one</li>';
    expect(closeCutOff(inFunction)).toEqual({ code: `${inFunction}\n\`;\n}`, dropped: 0, closed: 1, template: true });
    // A backtick missing in the middle (the reviewer's probe): lines of code follow the markup, so this is no cut-off
    const missing = "document.body.innerHTML = `<h1>Hi</h1>\n<button id=\"b\">Go</button>;\nconst btn = document.getElementById('b');\nbtn.onclick = () => speak('hi');";
    expect(closeCutOff(missing)).toBeNull();
    expect(closeCutOff("document.body.innerHTML = `<p>one</p>\nlet n = 0;")).toBeNull();
    // Words that parse as a program, and markup, are not code
    expect(closeCutOff('document.body.innerHTML = `\n<p>\nHello\n  world.</p>\n<hr>')).toEqual({ code: 'document.body.innerHTML = `\n<p>\nHello\n  world.</p>\n<hr>\n`;', dropped: 0, closed: 0, template: true });
    // A cut inside an expression of the template is not closed by guessing
    const inExpression = 'const html = `\n  <p>${items.map((i) => {';
    expect(closeCutOff(inExpression)).toBeNull();
  });

  it('leaves alone a program whose error is not at its end', () => {
    expect(closeCutOff('function a() {\n  x = ;\n  return 1;\n}')).toBeNull();
    expect(closeCutOff('const ok = 1;')).toBeNull();
  });
});

describe('fix reply length', async () => {
  const { fixReplyTokens } = await import('../src/core/orchestrator.ts');
  it('is about twice what the fix replaces, within the model limit', () => {
    const program = Array.from({ length: 30 }, (_, i) => `const value${i} = compute(${i}); // line ${i}`).join('\n');
    expect(fixReplyTokens(program, 3, undefined, 2048)).toBe(160);
    const whole = fixReplyTokens(program, undefined, undefined, 2048);
    expect(whole).toBeGreaterThan(800);
    expect(whole).toBeLessThanOrEqual(2048);
    expect(fixReplyTokens(program, 3, { start: 2, end: 6 }, 2048)).toBeLessThan(whole);
  });
});

describe('the repetition stop', async () => {
  const { repetitionCutIndex } = await import('../src/core/orchestrator.ts');
  it('catches two functions written again and again, taking turns', () => {
    const a = ['  function bounceBall() {', '    requestAnimationFrame(bounceFrame);', '    clear();', '    draw();', '  }'];
    const b = ['  function bounceFrame() {', '    requestAnimationFrame(bounceFrame);', '    clear();', '    draw();', '    bounceFrame();', '  }', ''];
    const unit = [...a, ...b];
    const text = ['const x = 1;', ...unit, ...unit, ...unit.slice(0, 3)].join('\n');
    const cut = repetitionCutIndex(text);
    expect(cut).toBeGreaterThan(0);
    expect(text.slice(0, cut).split('function bounceBall').length - 1).toBe(1);
  });
});

describe('an undeclared name the program uses again and again', () => {
  const program = [
    'function animate() {',
    '  for (let i = 0; i < 3; i++) {',
    '    ctx.beginPath();',
    '    ctx.arc(10, 10, 5, 0, 7);',
    "    ctx.fillStyle = 'red';",
    '    ctx.fill();',
    '  }',
    '}',
    'animate();',
  ].join('\n');

  it('is offered a new canvas on the page, by its real 2D context', () => {
    const blank = findBlank(program, "Can't find variable: ctx", 3)!;
    expect(blankChoices(program, blank, { ids: [] })).toContain('document.body.appendChild(document.createElement("canvas")).getContext("2d")');
  });

  it('is declared once, just before its first use, not written at every use', async () => {
    const { fillBlank } = await import('../src/core/blank-fix.ts');
    const blank = findBlank(program, "Can't find variable: ctx", 3)!;
    const filled = fillBlank(program, blank, 'document.body.appendChild(document.createElement("canvas")).getContext("2d")')!;
    expect(filled.split('\n')[2]).toBe('    const ctx = document.body.appendChild(document.createElement("canvas")).getContext("2d");');
    expect(filled.match(/getContext/g)).toHaveLength(1);
    expect(filled).toContain('    ctx.beginPath();');
    // `name = value` offered for the name declares it with that value
    const assigned = fillBlank(program, blank, 'ctx = canvas.getContext("2d")')!;
    expect(assigned.split('\n')[2]).toBe('    const ctx = canvas.getContext("2d");');
  });
});


describe('a drawing method called on the canvas', async () => {
  const { methodHint, applyCorrection } = await import('../src/core/method-hints.ts');
  it('says the method is its 2D context’s, and corrects it without the model', () => {
    const code = 'var ballCanvas = document.createElement("canvas");\ndocument.body.appendChild(ballCanvas);\nballCanvas.clearRect(0, 0, 10, 10);';
    const hint = methodHint(code, "ballCanvas.clearRect is not a function. (In 'ballCanvas.clearRect(0, 0, 10, 10)', 'ballCanvas.clearRect' is undefined)")!;
    expect(hint.text).toContain("ballCanvas.getContext('2d').clearRect");
    expect(applyCorrection(code, hint.correction!).split('\n')[2]).toBe('ballCanvas.getContext("2d").clearRect(0, 0, 10, 10);');
  });
});

describe('a page in a javascript fence, cut off inside its script', async () => {
  const { inspectExecutableCode } = await import('../src/tools/javascript-runtime.ts');
  const { parse } = await import('acorn');
  it('runs as a page: its script to the end, its open blocks closed', () => {
    const reply = [
      '```javascript',
      '<!DOCTYPE html>',
      '<html><body>',
      '<canvas id="ballCanvas"></canvas>',
      '<script>',
      '  function drawBall() {',
      '    const ctx = document.getElementById("ballCanvas").getContext("2d");',
      '    function animate() {',
      '      ctx.clearRect(0, 0, 100, 100);',
      '      requestAnimationFrame(animate); // Update',
    ].join('\n');
    const prepared = inspectExecutableCode(reply);
    expect(prepared.cutOff).toBeDefined();
    expect(prepared.code).toContain('document.body.insertAdjacentHTML("beforeend", "<canvas id=\\"ballCanvas\\"></canvas>")');
    expect(() => parse(prepared.code, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true })).not.toThrow();
    expect(prepared.code.trim().endsWith('drawBall();')).toBe(true);
  });
});

describe('adapting what small models write', async () => {
  const { errorHint, dropBrowserCopies } = await import('../src/core/error-hints.ts');
  const { declareMissing } = await import('../src/core/blank-fix.ts');

  it('turns a property called like a method into an assignment', () => {
    const code = 'const ctx = document.createElement("canvas").getContext("2d");\nctx.fillStyle("red");\nctx.fillRect(0, 0, 5, 5);';
    const hint = errorHint(code, 'ctx.fillStyle is not a function', 2)!;
    expect(hint.correction!.code.split('\n')[1]).toBe('ctx.fillStyle = "red";');
  });

  it('takes out its own copy of a browser function, wherever it is', () => {
    const code = 'function animate() {\n  function requestAnimationFrame() {\n    return requestAnimationFrame;\n  }\n  requestAnimationFrame(animate);\n}\nanimate();';
    const { code: out, dropped } = dropBrowserCopies(code);
    expect(dropped).toEqual(['requestAnimationFrame']);
    expect(out).not.toContain('function requestAnimationFrame');
    expect(out).toContain('requestAnimationFrame(animate);');
  });

  it('declares a drawing context the program never made, only when it has no canvas of its own', () => {
    const lone = 'function draw() {\n  fill.clearRect(0, 0, 10, 10);\n  fill.fillRect(1, 1, 2, 2);\n}\ndraw();';
    const made = declareMissing(lone);
    expect(made.declared).toEqual([{ name: 'fill', make: 'document.body.appendChild(document.createElement("canvas")).getContext("2d")' }]);
    expect(made.code.split('\n')[0]).toBe('const fill = document.body.appendChild(document.createElement("canvas")).getContext("2d");');
    // With a canvas of its own, its context is what it meant: left to the blank stage
    expect(declareMissing('const canvas = document.createElement("canvas");\nctx.fillRect(0, 0, 5, 5);').declared).toEqual([]);
    // Used some other way too (passed along), or set by the program: left alone
    expect(declareMissing('ctx.fillRect(0, 0, 5, 5);\ndraw(ctx);').declared).toEqual([]);
    expect(declareMissing('ctx = makeIt();\nctx.fillRect(0, 0, 5, 5);').declared).toEqual([]);
  });

  it('declares an audio context the program never made', () => {
    const made = declareMissing('const o = audio.createOscillator();\no.connect(audio.destination);\no.start();');
    expect(made.declared).toEqual([{ name: 'audio', make: 'new AudioContext()' }]);
  });
});

describe('repairs that leave correct programs alone', async () => {
  const { dropBrowserCopies } = await import('../src/core/error-hints.ts');
  const { declareMissing } = await import('../src/core/blank-fix.ts');
  it('keeps a working stand-in for a browser function', () => {
    const code = 'function fetch(url) {\n  return Promise.resolve({ json: () => ({ ok: true }) });\n}\nfetch("x").then((r) => speak(String(r.json().ok)));';
    expect(dropBrowserCopies(code).dropped).toEqual([]);
  });
  it('makes no audio context of a button, and no 2D context from save/scale alone', () => {
    expect(declareMissing('btn.addEventListener("click", () => speak("hi"));').declared).toEqual([]);
    expect(declareMissing('view.save();\nview.scale(2, 2);').declared).toEqual([]);
  });
  it('makes the canvas a program draws on but never made', () => {
    const made = declareMissing('const ctx = board.getContext("2d");\nctx.fillRect(0, 0, 5, 5);');
    expect(made.declared.map((d) => d.name)).toEqual(['board']);
  });
});

describe('a page whose buttons call its functions', async () => {
  const { inspectExecutableCode } = await import('../src/tools/javascript-runtime.ts');
  it('makes its indented functions reachable from inline handlers', () => {
    const page = '<button onclick="startGame()">Go</button>\n<script>\n  function startGame() { speak("Go!"); }\n  function init() { speak("Ready."); }\n</script>';
    const code = inspectExecutableCode(page).code;
    expect(code).toContain('window.startGame = startGame;');
  });
});

describe("Fable's repairs from the logs", async () => {
  const { errorHint, fixKeySlips } = await import('../src/core/error-hints.ts');

  it('a key its own literal lacks, one slip from one it has, is renamed', () => {
    const code = "const sounds = { drums: 'kick', piano: 'C4' };\nconst notes = { boomKick: 36 };\nplay(sounds.drum);\nplay(notes['boom_kick']);";
    const { code: out, fixed } = fixKeySlips(code);
    expect(out).toContain('play(sounds.drums);');
    expect(out).toContain("play(notes['boomKick']);");
    expect(fixed).toEqual([{ object: 'sounds', from: 'drum', to: 'drums' }, { object: 'notes', from: 'boom_kick', to: 'boomKick' }]);
  });

  it('leaves a literal alone once it is changed or handed elsewhere', () => {
    expect(fixKeySlips("const s = { drums: 1 };\ns.drum = 2;\nplay(s.drum);").fixed).toEqual([]);
    expect(fixKeySlips("const s = { drums: 1 };\nfill(s);\nplay(s.drum);").fixed).toEqual([]);
    // Two keys equally close: not sure which
    expect(fixKeySlips("const s = { tone: 1, bone: 2 };\nplay(s.cone);").fixed).toEqual([]);
  });

  it('setValueAtTime without a time gets 0', () => {
    const code = 'const g = ctx.createGain();\ng.gain.setValueAtTime(0.5);';
    const hint = errorHint(code, "Failed to execute 'setValueAtTime' on 'AudioParam': 2 arguments required, but only 1 present.", 2)!;
    expect(hint.correction!.code.split('\n')[1]).toBe('g.gain.setValueAtTime(0.5, 0);');
  });

  it('a list mapped through a function that returns nothing: the function returns its last call', () => {
    const code = [
      'function playNote(n) {',
      '  out.send({ notes: n });',
      '}',
      'const plays = [1, 2].map((n) => playNote(n));',
      'plays.forEach((p) => {',
      '  p.stop();',
      '});',
    ].join('\n');
    const hint = errorHint(code, "undefined is not an object (evaluating 'p.stop')", 6)!;
    expect(hint.correction!.code.split('\n')[1]).toBe('  return out.send({ notes: n });');
  });

  it('otherwise the call is made only when there is something to call', () => {
    const code = 'let sound;\nsound.stop();';
    const hint = errorHint(code, "Cannot read properties of undefined (reading 'stop')", 2)!;
    expect(hint.correction!.code.split('\n')[1]).toBe('sound?.stop?.();');
  });
});

describe('from the tip calculator log', async () => {
  const { dropCopiedExample } = await import('../src/core/orchestrator.ts');
  it("takes the example reply's words out of a program that copied them", () => {
    const code = 'document.body.innerHTML = "<p>Tip</p>";\nspeak("Hi! What would you like me to make?");\nspeak("Enter the bill.");';
    const { code: out, dropped } = dropCopiedExample(code);
    expect(dropped).toBe(true);
    expect(out).toBe('document.body.innerHTML = "<p>Tip</p>";\nspeak("Enter the bill.");');
    // A reply that is only the greeting stays (a greeting gets a greeting)
    expect(dropCopiedExample('speak("Hi! What would you like me to make?");').dropped).toBe(false);
  });

  it('also takes the question without its greeting, as Qwen3 0.6B wrote it for 15 percent of 84', () => {
    // The real program: the example's question, then the answer
    const code = 'speak("What would you like me to make?");\nvar result = (84 * 15) / 100;\nspeak("15 percent of 84 is " + result);';
    expect(dropCopiedExample(code)).toEqual({ code: 'var result = (84 * 15) / 100;\nspeak("15 percent of 84 is " + result);', dropped: true });
    // Other case and punctuation
    expect(dropCopiedExample('speak("what would you like me to make");\nroot.textContent = 1;').dropped).toBe(true);
    // Short likenesses and sentences of its own stay
    expect(dropCopiedExample('speak("What would you like?");\nroot.textContent = 1;').dropped).toBe(false);
    expect(dropCopiedExample('speak("What would you like me to make with the 3 blocks?");\nroot.textContent = 1;').dropped).toBe(false);
  });

  it('takes the request said back out of the program before it runs, logged, when told the request', async () => {
    const { repairBeforeRunning } = await import('../src/core/orchestrator.ts');
    const code = 'speak("Show a big ten second countdown on screen.");\nlet n = 10;\nsetInterval(() => { n--; root.textContent = n; }, 1000);';
    const notes: string[] = [];
    const out = repairBeforeRunning(code, false, (text) => notes.push(text), 'Show a big ten second countdown on screen');
    expect(out.code).toBe('let n = 10;\nsetInterval(() => { n--; root.textContent = n; }, 1000);');
    expect(notes).toEqual(["a speak() of the request's own words → taken out: corrected before running"]);
    // A phrase to answer, not an instruction: its echo is the answer (the reviewer's probes)
    for (const phrase of ['Happy birthday to you', 'Good morning everyone', 'Hello there my friend']) {
      const greeting = `speak("${phrase}!");\ndocument.body.innerHTML = '<h1>:)</h1>';`;
      expect(repairBeforeRunning(greeting, false, () => {}, phrase).code, phrase).toBe(greeting);
    }
    // A phrase with no verb of an instruction is left alone too (only a sure case is repaired); an instruction is
    expect(repairBeforeRunning('speak("A big red button on screen");\nroot.textContent = 1;', false, () => {}, 'A big red button on screen').code).toBe('speak("A big red button on screen");\nroot.textContent = 1;');
    expect(repairBeforeRunning('speak("Flip a coin and say heads or tails");\nroot.textContent = 1;', false, () => {}, 'Flip a coin and say heads or tails').code).toBe('root.textContent = 1;');
    // No request given (or another one): the program is as it was
    expect(repairBeforeRunning(code, false, () => {}).code).toBe(code);
    expect(repairBeforeRunning(code, false, () => {}, 'Draw a cat').code).toBe(code);
  });

  it('offers no element where text goes', () => {
    const code = 'const bill = document.getElementById("bill");\nconst total = 5;\nresult.innerHTML = `${input + " and "}`;';
    const blank = findBlank(code, 'input is not defined', 3)!;
    const choices = blankChoices(code, blank, { ids: ['bill'] });
    expect(choices).not.toContain('bill');
    expect(choices).toContain('total');
  });
});

describe("Fable's smaller repairs", async () => {
  const { errorHint, dropHelperCopies } = await import('../src/core/error-hints.ts');

  it('offers the looped item’s key for a name it never declared', () => {
    const code = "const tracks = [{ note: 'C4', time: 0 }, { note: 'E4', time: 500 }];\nfor (const track of tracks) {\n  play(track.note, time);\n}";
    const blank = findBlank(code, "Can't find variable: time", 3)!;
    expect(blankChoices(code, blank, { ids: [] })[0]).toBe('track.time');
  });

  it('renames a helper copy that holds the whole program, keeping the real helper for what it says', () => {
    const code = 'const speak = () => {\n  const bpm = 100;\n  play(bpm);\n  speak("Playing.");\n};\nspeak();';
    const out = dropHelperCopies(code);
    expect(out.renamed).toEqual(['speak → main']);
    expect(out.code).toContain('const main = () => {');
    expect(out.code).toContain('speak("Playing.");');
    expect(out.code.trim().endsWith('main();')).toBe(true);
  });

  it('takes out a call to a method a browser type lacks, when nothing uses its result', () => {
    const code = 'const gl = document.createElement("canvas").getContext("webgl");\ngl.shaderType(1);\nspeak("Ready.");';
    const hint = errorHint(code, 'gl.shaderType is not a function', 2)!;
    expect(hint.correction!.code).not.toContain('shaderType');
    // A name that says it does something stays with the model
    const draw = 'const ctx = document.createElement("canvas").getContext("2d");\nctx.fillCircle(5, 5, 3);';
    expect(errorHint(draw, 'ctx.fillCircle is not a function', 2)?.correction).toBeUndefined();
  });
});

describe('the shared name matcher', async () => {
  const { sureMatch, closestNames } = await import('../src/core/fuzzy-match.ts');
  it('is sure of case, _ and - slips, words in another order, and close spellings with the same first letter', () => {
    expect(sureMatch('getcontext', ['getContext', 'getImageData'])).toBe('getContext');
    expect(sureMatch('fill_rect', ['fillRect', 'fillText'])).toBe('fillRect');
    expect(sureMatch('colorBg', ['bgColor', 'color'])).toBe('bgColor');
    expect(sureMatch('totla', ['total', 'title'])).toBe('total');
    expect(sureMatch('oclor', ['color'])).toBe('color');
  });
  it('is not sure of a different first letter, a 3-letter word, a tie, or a list for its item', () => {
    expect(sureMatch('hello', ['jello'])).toBeNull();
    expect(sureMatch('zap', ['Map'])).toBeNull();
    expect(sureMatch('cone', ['cane', 'core'])).toBeNull();
    expect(sureMatch('balls', ['ball'])).toBeNull();
    expect(sureMatch('drum', ['drums'], { plural: true })).toBe('drums');
  });
  it('ranks hints by spelling, shared words and the first letter', () => {
    expect(closestNames('fillCircle', ['arc', 'fillRect', 'clearRect', 'fill'])[0]).toMatch(/^fill/);
  });
});

describe('a program that ends on a sentence in a comment', async () => {
  const { inspectExecutableCode, speakClosingComment } = await import('../src/tools/javascript-runtime.ts');
  it('says the sentence when the program says nothing', () => {
    const reply = '```javascript\nconst c = document.createElement("canvas");\ndocument.body.appendChild(c);\n// This draws a red ball that bounces around.\n```';
    const prepared = inspectExecutableCode(reply);
    expect(prepared.spokeComment).toBe('This draws a red ball that bounces around.');
    expect(prepared.code).toContain('speak("This draws a red ball that bounces around.");');
  });
  it('leaves code notes, and programs that already speak, alone', () => {
    expect(speakClosingComment('draw();\n// draw loop')).toBeNull();
    expect(speakClosingComment('draw();\n// x = 5 then redraw it')).toBeNull();
    expect(speakClosingComment('draw();\nspeak("Done.");\n// This draws a red ball.')).toBeNull();
  });
});

describe('an animation that runs one frame', async () => {
  const { loopOneFrameAnimations } = await import('../src/core/error-hints.ts');
  it('asks for the next frame when it moves things and never asks itself', () => {
    const code = 'const ball = { x: 0 };\nfunction updateBall() {\n  ball.x += 5;\n  ctx.fillRect(ball.x, 0, 5, 5);\n}\nrequestAnimationFrame(updateBall);';
    const { code: out, looped } = loopOneFrameAnimations(code);
    expect(looped).toEqual(['updateBall']);
    expect(out).toContain('  ctx.fillRect(ball.x, 0, 5, 5);\n  requestAnimationFrame(updateBall);\n}');
  });
  it('leaves a loop that already asks, and a one-off drawing that moves nothing', () => {
    expect(loopOneFrameAnimations('let x = 0;\nfunction tick() {\n  x += 1;\n  requestAnimationFrame(tick);\n}\nrequestAnimationFrame(tick);').looped).toEqual([]);
    expect(loopOneFrameAnimations('function paint() {\n  const y = 2;\n  ctx.fillRect(0, y, 5, 5);\n}\nrequestAnimationFrame(paint);').looped).toEqual([]);
  });
  it('sees a loop that asks through window, under a pause check, or through a helper', () => {
    const paused = 'let paused = false, x = 0;\nfunction loop() { x += 2; draw(); if (!paused) window.requestAnimationFrame(loop); }\nrequestAnimationFrame(loop);';
    expect(loopOneFrameAnimations(paused).looped).toEqual([]);
    const helper = 'let x = 0;\nfunction next() { requestAnimationFrame(loop); }\nfunction loop() { x += 1; draw(); next(); }\nrequestAnimationFrame(loop);';
    expect(loopOneFrameAnimations(helper).looped).toEqual([]);
  });
  it('leaves a frame a button asks for (a Step button)', () => {
    expect(loopOneFrameAnimations('let generation = 0;\nfunction step() { generation++; draw(); }\nbtn.onclick = () => requestAnimationFrame(step);').looped).toEqual([]);
    expect(loopOneFrameAnimations("let n = 0;\nfunction step() { n++; }\nbtn.addEventListener('click', () => requestAnimationFrame(step));").looped).toEqual([]);
  });
});

describe('from the beach sunset log', async () => {
  const { callUncalledFunctions } = await import('../src/tools/javascript-runtime.ts');
  it('calls the frame function a comment mentions but nothing calls', () => {
    const code = 'function draw() {\n  requestAnimationFrame(draw);\n}\n// Initialize canvas and draw\nspeak("Drawn.");';
    expect(callUncalledFunctions(code).trim().endsWith('await draw();')).toBe(true);
  });
});

describe('repairs made while preparing a reply are reported for the run log', async () => {
  const { inspectExecutableCode } = await import('../src/tools/javascript-runtime.ts');
  it('names the functions it called and the ones it made reachable', () => {
    expect(inspectExecutableCode('function draw() {\n  speak("Hi.");\n}').called).toEqual(['draw']);
    const page = '<button onclick="startGame()">Go</button>\n<script>\n  function startGame() { speak("Go!"); }\n</script>';
    expect(inspectExecutableCode(page).exposed).toEqual(['startGame']);
    expect(inspectExecutableCode('speak("Hi.");').called).toBeUndefined();
  });
});

describe('from the blues loop log', async () => {
  const { fixIteratorResults, fixAudioNodeProperties } = await import('../src/core/error-hints.ts');
  it('takes the item from an iterator result used as the item', () => {
    const code = 'const midi = await navigator.requestMIDIAccess();\nconst output = midi.outputs.values().next();\noutput.send([0x90, 60, 100]);';
    const { code: out, fixed } = fixIteratorResults(code);
    expect(fixed).toEqual(['output']);
    expect(out).toContain('const output = midi.outputs.values().next().value;');
    // Used as the result it is ({ value, done }): left alone
    expect(fixIteratorResults('const step = list.values().next();\nif (!step.done) speak(step.value);').fixed).toEqual([]);
  });

  it('makes an audio node read as a property with its create call', () => {
    const code = 'const ctx = new AudioContext();\nconst osc = ctx.oscillator;\nconst g = new AudioContext().gain;\nconst o2 = ctx.oscillator();';
    const { code: out, fixed } = fixAudioNodeProperties(code);
    expect(out).toContain('const osc = ctx.createOscillator();');
    expect(out).toContain('const g = new AudioContext().createGain();');
    expect(out).toContain('const o2 = ctx.createOscillator();');
    expect(fixed).toEqual(['oscillator → createOscillator()', 'gain → createGain()']);
  });

  it('offers no object for a number slot', () => {
    const code = 'const midi = await navigator.requestMIDIAccess();\nconst note = 60;\nconst level = 100;\nout.send([0x90 + 0, note, velocity]);';
    const blank = findBlank(code, "Can't find variable: velocity", 4)!;
    const choices = blankChoices(code, blank, { ids: [] });
    expect(choices).not.toContain('midi');
    expect(choices).toContain('level');
  });
});

describe('repairs that leave capable code alone', async () => {
  const { fixKeySlips, fixAudioNodeProperties } = await import('../src/core/error-hints.ts');
  it('does not rename a key an object adds to itself in its own methods', () => {
    expect(fixKeySlips('const game = { ball: { x: 0 }, init() { this.balls = []; } };\ngame.init();\nspeak(String(game.balls.length));').fixed).toEqual([]);
    expect(fixKeySlips('const sounds = { drums: 1 };\nspeak(String(sounds.drum));').fixed).toEqual([{ object: 'sounds', from: 'drum', to: 'drums' }]);
  });
  it('does not replace an audio node the program keeps on its context', () => {
    const had = (globalThis as { AudioContext?: unknown }).AudioContext;
    (globalThis as { AudioContext?: unknown }).AudioContext = class { createAnalyser() {} createGain() {} };
    try {
      expect(fixAudioNodeProperties('const ctx = new AudioContext();\nctx.analyser = ctx.createAnalyser();\nconst a = ctx.analyser;').fixed).toEqual([]);
      expect(fixAudioNodeProperties('const ctx = new AudioContext();\nconst g = ctx.gain;').fixed).toEqual(['gain → createGain()']);
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = had;
    }
  });
});

describe('a fence marker left on a line of its own', () => {
  it('is no code: the program of the countdown and the cat face, with a third ``` after its speak()', async () => {
    const { inspectExecutableCode } = await import('../src/tools/javascript-runtime.ts');
    // The real replies from Qwen3 0.6B: a closed block, a speak() after it, and a last fence with nothing after it
    const reply = '```javascript\nspeak("Draw a smiling cat face.");\nconst cat = document.createElement("div");\ndocument.body.appendChild(cat);\n```\n\nspeak("Draw a smiling cat face.");\n```';
    const prepared = inspectExecutableCode(reply);
    expect(prepared.code).not.toContain('`');
    expect(prepared.cutOff).toBeUndefined();
    expect(prepared.code).toContain('document.body.appendChild(cat);');
    // The same without a fenced block at all, and with a label on the stray fence
    expect(inspectExecutableCode('const a = 1;\nspeak(String(a));\n```').code).not.toContain('`');
    expect(inspectExecutableCode('```javascript\nconst a = 1;\n```\nspeak("x");\n```js').code).not.toContain('`');
    // A template string of the program's own stays
    expect(inspectExecutableCode('const html = `<p>x</p>`;\ndocument.body.innerHTML = html;').code).toContain('`<p>x</p>`');
    expect(inspectExecutableCode('document.body.innerHTML = `\n<p>one</p>\n`;').code).toContain('`\n<p>one</p>\n`');
  });
});

describe('the app’s own greeting copied into a program', () => {
  it('is taken out, like the example reply’s words, as in the countdown Qwen3 0.6B wrote', async () => {
    const { dropCopiedExample } = await import('../src/core/orchestrator.ts');
    const code = 'document.getElementById("countdown").innerHTML = "10";\nsetInterval(() => {}, 1000);\nspeak("Welcome back, what would you like to do with this browser?");';
    expect(dropCopiedExample(code)).toEqual({ code: 'document.getElementById("countdown").innerHTML = "10";\nsetInterval(() => {}, 1000);', dropped: true });
    expect(dropCopiedExample('speak("Welcome to Chatty, I can do anything your browser can do.");\nroot.textContent = 1;').dropped).toBe(true);
    // A greeting that is all there is stays (a greeting gets a greeting), and a sentence of its own does too
    expect(dropCopiedExample('speak("Welcome back, what would you like to do with this browser?");').dropped).toBe(false);
    expect(dropCopiedExample('speak("Welcome to the countdown!");\nroot.textContent = 1;').dropped).toBe(false);
  });
});

describe('the mark a test copy carries, as the browser prints it in an error', () => {
  it('is taken out whether or not the browser shows its assignment, with the expression whole', async () => {
    const { unmarkReached } = await import('../src/core/orchestrator.ts');
    // The real messages: Chrome prints the call site without the assignment; the with-assignment form is the source text
    expect(unmarkReached('(globalThis.__chattyReached , synth).create is not a function')).toBe('synth.create is not a function');
    expect(unmarkReached('((globalThis.__chattyReached = true), synth).create is not a function')).toBe('synth.create is not a function');
    expect(unmarkReached("(((globalThis.__chattyReached = true), document.getElementById('result'))).getContext is not a function")).toBe("(document.getElementById('result')).getContext is not a function");
    expect(unmarkReached('(globalThis.__chattyReached , a.b(c, (d))).e is not a function. (In \'x\', \'y\' is undefined)')).toBe("a.b(c, (d)).e is not a function. (In 'x', 'y' is undefined)");
    // Two marks in one message, and a message with none
    expect(unmarkReached('(globalThis.__chattyReached , a) and ((globalThis.__chattyReached = true), b)')).toBe('a and b');
    expect(unmarkReached('x.y is not a function')).toBe('x.y is not a function');
  });
});

describe('a made-up capitalized name next to a question', () => {
  it('is not taken for it: Tone.Note() is not Tone.isNote(), which asks a question', async () => {
    const { sureMatch } = await import('../src/core/fuzzy-match.ts');
    // The real slip from the happy birthday melody: a note was meant, isNote answers yes or no
    expect(sureMatch('Note', ['isNote', 'now', 'start'], { reshaped: true })).toBeNull();
    expect(sureMatch('Note', ['hasNote', 'start'], { reshaped: true })).toBeNull();
    // A name made by a verb of making still is the one
    expect(sureMatch('Note', ['createNote', 'now'], { reshaped: true })).toBe('createNote');
    // A lowercase name keeps all the verbs (open → isOpen)
    expect(sureMatch('open', ['isOpen', 'close'], { reshaped: true })).toBe('isOpen');
    expect(sureMatch('page', ['getPage', 'turn'], { reshaped: true })).toBe('getPage');
  });
});

describe('a reply cut off inside the callbacks of nested calls', () => {
  // The countdown Qwen3 0.6B wrote: a chain of setTimeout callbacks, stopped at the output limit
  const CUT = [
    'speak("Show a big ten second countdown on screen.");',
    "document.getElementById('countdown').innerHTML = \"Countdown: 10 seconds left\";",
    'setTimeout(() => {',
    "  document.getElementById('countdown').innerHTML = \"Countdown: 9 seconds left\";",
    '  setTimeout(() => {',
    "    document.getElementById('countdown').innerHTML = \"Countdown: 8 seconds left\";",
    '    setTimeout(() => {',
    "      document.getElementById('countdown').innerHTML = \"Countdown: 7 seconds left\";",
    '      setTimeout(() => {',
    '        ',
  ].join('\n');

  it('closes every open callback, so the program that was written so far runs', async () => {
    const { closeCutOff } = await import('../src/core/error-hints.ts');
    const cut = closeCutOff(CUT)!;
    expect(cut).toBeTruthy();
    expect(cut.closed).toBe(4);
    expect(() => new Function(cut.code)).not.toThrow();
    expect(cut.code).toContain('Countdown: 7 seconds left');
  });

  it('works for a function expression, an async arrow, and a name for the parameter', async () => {
    const { closeCutOff } = await import('../src/core/error-hints.ts');
    for (const open of ['items.forEach(function (item) {', 'items.forEach(async (item) => {', 'items.forEach(item => {', 'run((a, b) => {']) {
      const cut = closeCutOff(`const items = [1];\n${open}\n  speak(String(items.length));\n`);
      expect(cut, open).toBeTruthy();
      expect(() => new Function(`const run = (f) => f(1, 2);\n${cut!.code}`), open).not.toThrow();
    }
  });

  it('still drops a cut call or list instead of closing it', async () => {
    const { closeCutOff } = await import('../src/core/error-hints.ts');
    // (a call cut in its arguments, no callback in it: its line goes)
    const cut = closeCutOff('function a() {\n  ctx.arc(100, 100\n');
    expect(cut?.dropped).toBe(1);
    expect(closeCutOff('const list = [1, 2,\n')).toBeNull();
  });
});

describe('a line of markup between two code blocks', () => {
  // The real reply from Qwen3 0.6B's "Play Twinkle Twinkle Little Star on the piano": a <canvas> on a line of its own
  const reply = [
    '```javascript',
    'const synth = new Tone.PolySynth();',
    'synth.triggerAttackRelease("C4", 0.5);',
    '```',
    '',
    '<canvas id="canvas"></canvas>',
    '',
    '```javascript',
    'const ctx = document.getElementById("canvas").getContext("2d");',
    '```',
  ].join('\n');

  it('goes on the page like an html block, not into speak() as the word canvas', async () => {
    const { inspectExecutableCode } = await import('../src/tools/javascript-runtime.ts');
    const prepared = inspectExecutableCode(reply);
    expect(prepared.code).not.toContain('speak(');
    expect(prepared.code).toContain('insertAdjacentHTML("beforeend", "<canvas id=\\"canvas\\"></canvas>")');
    expect(prepared.markupBlocks).toBe(1);
    expect(() => new Function(prepared.code)).not.toThrow();
  });

  it('leaves a sentence that names a tag, and a reply with no markup, as they were', async () => {
    const { inspectExecutableCode } = await import('../src/tools/javascript-runtime.ts');
    const told = inspectExecutableCode(reply.replace('<canvas id="canvas"></canvas>', 'The <canvas> below shows the stars.'));
    expect(told.code).toContain('speak("The canvas below shows the stars.");');
    expect(told.markupBlocks).toBeUndefined();
    const plain = inspectExecutableCode(reply.replace('<canvas id="canvas"></canvas>', 'Now the picture.'));
    expect(plain.markupBlocks).toBeUndefined();
  });
});
