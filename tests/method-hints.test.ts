import { describe, expect, it } from 'vitest';
import { applyCorrection, closestMethods, methodHint, missingMethod, nearMiss, objectType } from '../src/core/method-hints.ts';

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
