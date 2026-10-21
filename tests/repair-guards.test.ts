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
    expect(cut).toEqual({ code: 'function a() {\n  const x = 1;\n}', dropped: 1, closed: 1 });
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
