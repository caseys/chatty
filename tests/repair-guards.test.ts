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
  it('scales temperatures down for models under about 1.5B (hottest 1), and leaves larger ones alone', () => {
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
