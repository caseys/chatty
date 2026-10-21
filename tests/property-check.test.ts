import { describe, expect, it } from 'vitest';
import { applyAssignmentFixes, unusableAssignments, renameMembers, unknownMemberError, unknownMembers } from '../src/core/property-check.ts';

class FakeContext2D {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  fillRect() {}
  arc() {}
  fill() {}
}
const scope = { CanvasRenderingContext2D: FakeContext2D, document } as unknown as Record<string, unknown>;
// Instance fields aren't on the prototype: put them there, as the browser does
for (const key of ['fillStyle', 'strokeStyle', 'lineWidth']) Object.defineProperty(FakeContext2D.prototype, key, { value: '', writable: true });

const canvasCode = (body: string) => `const c = document.createElement('canvas');\nconst ctx = c.getContext('2d');\n${body}`;

describe('members an object does not have', () => {
  it('finds a slipped property and the real name it means', () => {
    const [issue] = unknownMembers(canvasCode("ctx.fillstyle = 'red';\nctx.fillRect(0, 0, 9, 9);"), scope);
    expect(issue).toMatchObject({ line: 3, object: 'ctx', member: 'fillstyle', slip: 'fillStyle' });
    expect(renameMembers("ctx.fillstyle = 'red';", [{ object: 'ctx', from: 'fillstyle', to: 'fillStyle' }])).toBe("ctx.fillStyle = 'red';");
  });

  it('reports a made-up property with the closest real names', () => {
    const [issue] = unknownMembers(canvasCode("ctx.fillColor = 'red';"), scope);
    expect(issue.slip).toBeNull();
    expect(unknownMemberError(issue)).toMatch(/^ctx is a CanvasRenderingContext2D, which has no fillColor\. It has .*ctx\.fillStyle \(a property\).*: use the one you meant\.$/);
  });

  it("checks style objects, and leaves elements' own properties alone", () => {
    const code = "const b = document.getElementById('b');\nb.count = 0;\nb.style.backgroundColour = 'blue';";
    const issues = unknownMembers(code, scope);
    expect(issues.map((i) => `${i.object}.${i.member}`)).toEqual(['b.style.backgroundColour']);
    expect(issues[0].slip).toBe('backgroundColor');
  });

  it('leaves a property the program sets and reads itself', () => {
    expect(unknownMembers(canvasCode('ctx.myAngle = 1;\nctx.arc(0, 0, 5, 0, ctx.myAngle);'), scope)).toEqual([]);
  });
});

describe('no false alarms', () => {
  class FakeWebGL2 {
    createVertexArray() {}
    bindVertexArray() {}
  }
  const wider = { ...scope, WebGL2RenderingContext: FakeWebGL2, HTMLElement, HTMLCanvasElement, HTMLInputElement, HTMLVideoElement } as unknown as Record<string, unknown>;

  it('(A) knows an element found by id may be any element: canvas.getContext, video.play', () => {
    const code = "const canvas = document.getElementById('c');\nconst g = canvas.getContext('2d');\nconst v = document.querySelector('video');\nv.play();\nv.vanishNow();";
    expect(unknownMembers(code, wider).map((i) => i.member)).toEqual(['vanishNow']);
  });

  it('(A) asks a real element made by tag', () => {
    const code = "const input = document.createElement('input');\ninput.select();\ninput.focus();";
    expect(unknownMembers(code, wider)).toEqual([]);
  });

  it('(B) types a name from its declaration, not from what it is called', () => {
    const code = "const style = document.createElement('style');\nstyle.textContent = 'p { color: red }';\nconst body = JSON.parse('[]');\nbody.forEach((x) => x);";
    expect(unknownMembers(code, wider)).toEqual([]);
  });

  it('(C) leaves a name alone when it is also a parameter', () => {
    const code = "const ctx = c.getContext('2d');\nfunction tone(ctx) {\n  ctx.createOscillator();\n}";
    expect(unknownMembers(code, wider)).toEqual([]);
  });

  it('(D) leaves a helper the program adds and uses itself', () => {
    expect(unknownMembers('Math.clamp = (v, a, b) => Math.min(b, Math.max(a, v));\nMath.clamp(5, 0, 1);', wider)).toEqual([]);
  });

  it('(D) still reports a slip even when it is set and read back', () => {
    const code = "const b = document.getElementById('b');\nb.style.backgroundColour = 'red';\nspeak(b.style.backgroundColour);";
    expect(unknownMembers(code, wider)[0]).toMatchObject({ member: 'backgroundColour', slip: 'backgroundColor' });
  });

  it('(E) types webgl2 as WebGL2', () => {
    const code = "const gl = c.getContext('webgl2');\ngl.createVertexArray();\ngl.bindVertexArray(null);";
    expect(unknownMembers(code, wider)).toEqual([]);
  });
});

describe('writes that do nothing', () => {
  class FakeCanvas {
    width = 0;
  }
  Object.defineProperty(FakeCanvas.prototype, 'width', { get: () => 0, set: () => {}, configurable: true });
  Object.defineProperty(FakeCanvas.prototype, 'clientWidth', { get: () => 0, configurable: true });
  class FakeCtx2 {}
  Object.defineProperty(FakeCtx2.prototype, 'canvas', { get: () => null, configurable: true });
  const fakeDoc = { createElement: (tag: string) => (tag === 'canvas' ? new FakeCanvas() : { style: {} }) };
  const sc2 = { document: fakeDoc, CanvasRenderingContext2D: FakeCtx2 } as unknown as Record<string, unknown>;
  const canvas = (body: string) => `const canvas = document.createElement('canvas');\nconst ctx = canvas.getContext('2d');\n${body}`;

  it('corrects a read-only write with one writable counterpart', () => {
    const code = canvas('canvas.clientWidth = 300;');
    const [issue] = unusableAssignments(code, sc2);
    expect(issue).toMatchObject({ kind: 'read-only', object: 'canvas', member: 'clientWidth', line: 3 });
    expect(applyAssignmentFixes(code, [issue])).toContain('canvas.width = 300;');
  });

  it('reports a read-only write with no counterpart, without correcting', () => {
    const [issue] = unusableAssignments(canvas('ctx.canvas = canvas;'), sc2);
    expect(issue.fix).toBeUndefined();
    expect(issue.message).toMatch(/^ctx\.canvas can only be read/);
  });

  it('leaves writable properties, compound writes, and unknown objects alone', () => {
    expect(unusableAssignments(canvas('canvas.width = 300;'), sc2)).toEqual([]);
    expect(unusableAssignments('thing.clientWidth = 3;', sc2)).toEqual([]);
    const [compound] = unusableAssignments(canvas('canvas.clientWidth += 3;'), sc2);
    expect(compound.fix).toBeUndefined();
  });
});

describe('style values the browser would ignore', () => {
  const valid: Record<string, string[]> = { display: ['none', 'block', 'flex', 'grid', 'inline', 'inline-block', 'inline-flex', 'inline-grid', 'contents', 'table', 'flow-root'], color: ['red'] };
  const CSS = {
    supports: (property: string, value: string) => {
      if (value === 'inherit') return property in { display: 1, color: 1 };
      return (valid[property] ?? []).includes(value);
    },
  };
  const sc3 = { CSS, document: { createElement: () => ({ style: {} }) } } as unknown as Record<string, unknown>;
  const el = (line: string) => `const el = document.getElementById('box');\n${line}`;

  it('reports an invalid literal with the property and value', () => {
    const [issue] = unusableAssignments(el("el.style.display = 'flexbox';"), sc3);
    expect(issue).toMatchObject({ kind: 'invalid-value', member: 'display', line: 2 });
    expect(issue.message).toMatch(/^'flexbox' is not a valid display value/);
    expect(issue.fix).toBeUndefined();
  });

  it('corrects a near miss of one supported value', () => {
    const code = el("el.style.display = 'inline-bock';");
    const issues = unusableAssignments(code, sc3);
    expect(applyAssignmentFixes(code, issues)).toBe(el("el.style.display = 'inline-block';"));
  });

  it('leaves valid values, non-literals, empty resets, unknown properties, and a missing CSS', () => {
    expect(unusableAssignments(el("el.style.display = 'flex';"), sc3)).toEqual([]);
    expect(unusableAssignments(el('el.style.display = mode;'), sc3)).toEqual([]);
    expect(unusableAssignments(el("el.style.display = '';"), sc3)).toEqual([]);
    expect(unusableAssignments(el("el.style.fillstyle = 'x';"), sc3)).toEqual([]);
    expect(unusableAssignments(el("el.style.display = 'flexbox';"), {})).toEqual([]);
  });
});
