import { describe, expect, it } from 'vitest';
import { applyCorrection, argumentCountFact, closestMethods, methodHint, missingMethod, nearMiss, objectType } from '../src/core/method-hints.ts';

class FakeContext2D {
  arc() {}
  fill() {}
  fillRect() {}
  fillText() {}
  clearRect() {}
  beginPath() {}
}
const scope = { CanvasRenderingContext2D: FakeContext2D } as unknown as Record<string, unknown>;

describe('missing methods', () => {
  it('reads the object and method from Chrome and Safari errors', () => {
    expect(missingMethod('ctx.fillCircle is not a function')).toEqual({ object: 'ctx', method: 'fillCircle' });
    expect(missingMethod("document.body.clear is not a function. (In 'document.body.clear()', 'document.body.clear' is undefined)")).toEqual({
      object: 'document.body',
      method: 'clear',
    });
    expect(missingMethod("Cannot read properties of undefined (reading 'get')")).toBeNull();
  });

  it('works out what an object is from the code that made it', () => {
    const code = "const canvas = document.createElement('canvas');\nconst ctx = canvas.getContext('2d');";
    expect(objectType(code, 'ctx')).toBe('CanvasRenderingContext2D');
    expect(objectType(code, 'canvas')).toBe('element:canvas');
    expect(objectType(code, 'document.body')).toBe('HTMLElement');
    expect(objectType('const box = document.getElementById("b");', 'box')).toBe('HTMLElement');
    expect(objectType('', 'mystery')).toBeNull();
  });

  it('ranks the real methods closest to the missing one', () => {
    const closest = closestMethods('fillCircle', ['arc', 'fill', 'fillRect', 'beginPath', 'fillText']);
    expect(closest).toContain('fill');
    expect(closest).toContain('fillRect');
    expect(closest).not.toContain('beginPath');
  });

  it('corrects only a sure slip', () => {
    expect(nearMiss('fillrect', ['fillRect', 'fillText'])).toBe('fillRect');
    expect(nearMiss('getElementByID', ['getElementById', 'getElementsByName'])).toBe('getElementById');
    expect(nearMiss('fillCircle', ['fill', 'fillRect', 'arc'])).toBeNull();
  });

  it('gives the fix request the candidates, and a correction for a slip', () => {
    const code = "const ctx = c.getContext('2d');\nctx.fillCircle(1, 2, 3);";
    const hint = methodHint(code, 'ctx.fillCircle is not a function', scope)!;
    expect(hint.text).toMatch(/^ctx is a CanvasRenderingContext2D, which has no fillCircle\(\)\. Its closest methods: /);
    expect(hint.text).toContain('fill()');
    expect(hint.correction).toBeUndefined();
    const slip = methodHint("const ctx = c.getContext('2d');\nctx.fillrect(0, 0, 9, 9);", 'ctx.fillrect is not a function', scope)!;
    expect(slip.correction).toEqual({ object: 'ctx', from: 'fillrect', to: 'fillRect' });
  });

  it('renames every call of the slipped method on that object', () => {
    const code = 'ctx.fillrect(0, 0, 1, 1);\nother.fillrect();\nctx . fillrect(2, 2, 1, 1);';
    expect(applyCorrection(code, { object: 'ctx', from: 'fillrect', to: 'fillRect' })).toBe(
      'ctx.fillRect(0, 0, 1, 1);\nother.fillrect();\nctx . fillRect(2, 2, 1, 1);'
    );
  });

  it('knows real browser types (document.body is an element)', () => {
    const hint = methodHint('document.body.clear();', 'document.body.clear is not a function')!;
    expect(hint.text).toContain('document.body is a HTMLElement, which has no clear()');
  });
});

describe('argument count facts', () => {
  class Ctx {
    arc(_x: number, _y: number, _r: number, _s: number, _e: number) {}
    fillRect(_x: number, _y: number, _w: number, _h: number) {}
    beginPath() {}
    fillText(_t: string, _x: number, _y: number, _max?: number) {}
  }
  Object.defineProperty(Ctx.prototype.fillText, 'length', { value: 3 });
  const sc = { CanvasRenderingContext2D: Ctx } as unknown as Record<string, unknown>;
  const code = (call: string) => `const c = document.createElement('canvas');\nconst ctx = c.getContext('2d');\n${call}`;

  it('gives the count and the names for a call with too few (Chrome message)', () => {
    const fact = argumentCountFact(code('ctx.arc(10, 10, 5);'), "Failed to execute 'arc' on 'CanvasRenderingContext2D': 5 arguments required, but only 3 present.", 3, sc);
    expect(fact).toBe('ctx.arc needs 5 arguments (x, y, radius, startAngle, endAngle); this call gives 3.');
  });

  it('works from the failing line alone (Safari message), and counts nested commas once', () => {
    const fact = argumentCountFact(code('ctx.fillRect(Math.max(1, 2), 5);'), 'Not enough arguments', 3, sc);
    expect(fact).toBe('ctx.fillRect needs 4 arguments (x, y, width, height); this call gives 2.');
  });

  it('gives only the count when the names are not known', () => {
    class Other { poke(_a: number, _b: number) {} }
    const fact = argumentCountFact("const a = new AudioContext();\na.poke(1);", 'Not enough arguments', 2, { AudioContext: Other } as unknown as Record<string, unknown>);
    expect(fact).toBe('a.poke needs 2 arguments; this call gives 1.');
  });

  it('says nothing for a complete call, a spread, optional arguments, other errors, or unknown objects', () => {
    const msg = 'Not enough arguments';
    expect(argumentCountFact(code('ctx.arc(1, 2, 3, 4, 5);'), msg, 3, sc)).toBeNull();
    expect(argumentCountFact(code('ctx.arc(...args);'), msg, 3, sc)).toBeNull();
    expect(argumentCountFact(code('ctx.fillText("a", 1, 2);'), msg, 3, sc)).toBeNull();
    expect(argumentCountFact(code('ctx.arc(1, 2);'), 'x is not a function', 3, sc)).toBeNull();
    expect(argumentCountFact('mystery.arc(1, 2);', msg, 1, sc)).toBeNull();
  });
});
