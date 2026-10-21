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

describe('a slipped member is renamed where the parser found it', () => {
  it('not in a string of the same text', () => {
    const [issue] = unknownMembers(canvasCode("ctx.fillstyle = 'red';\nspeak('ctx.fillstyle');\nctx.fillstyle = 'blue';"), scope);
    expect(issue.spans).toHaveLength(2);
    const renamed = renameMembers(canvasCode("ctx.fillstyle = 'red';\nspeak('ctx.fillstyle');\nctx.fillstyle = 'blue';"), [{ object: 'ctx', from: 'fillstyle', to: 'fillStyle', spans: issue.spans }]);
    expect(renamed).toBe(canvasCode("ctx.fillStyle = 'red';\nspeak('ctx.fillstyle');\nctx.fillStyle = 'blue';"));
  });
});

describe('JavaScript written inside a color string', () => {
  // The browser's rule for colors, as far as these programs go: numbers in rgb(), or a named color
  const isColor = (value: string) => /^rgba?\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*(?:,\s*[\d.]+\s*)?\)$/.test(value) || ['red', 'white', 'yellow'].includes(value);
  const CSS = { supports: (property: string, value: string) => (value === 'inherit' ? true : property === 'color' || property === 'background-color' ? isColor(value) : false) };
  class FakeCtx {}
  const scope = { CSS, CanvasRenderingContext2D: FakeCtx, document: { createElement: () => ({ style: {} }) } } as unknown as Record<string, unknown>;
  const program = (body: string) => `const canvas = document.createElement("canvas");\nconst ctx = canvas.getContext("2d");\n${body}`;

  it('becomes a template literal, as in the color Qwen3 0.6B wrote for a sunset sky', () => {
    // The real line: the math is inside the quotes
    const code = program('for (let i = 0; i < 60; i++) {\n  ctx.fillStyle = "rgb(255, 255, 255 - 255 * (i / 60))";\n  ctx.fillRect(0, i * 10, 800, 10);\n}');
    const issues = unusableAssignments(code, scope);
    expect(issues).toHaveLength(1);
    expect(issues[0].fix?.note).toContain('JavaScript in a color needs a template literal');
    expect(applyAssignmentFixes(code, issues)).toBe(code.replace('"rgb(255, 255, 255 - 255 * (i / 60))"', '`rgb(255, 255, ${255 - 255 * (i / 60)})`'));
  });

  it('also for a style color, with several computed arguments and the names of the program', () => {
    const code = "const el = document.getElementById('box');\nlet level = 3;\nel.style.backgroundColor = 'rgb(level * 20, Math.round(level / 2), 40)';";
    const fixed = applyAssignmentFixes(code, unusableAssignments(code, scope));
    expect(fixed).toContain('el.style.backgroundColor = `rgb(${level * 20}, ${Math.round(level / 2)}, 40)`;');
  });

  it('leaves valid colors, names the program lacks, and other invalid colors alone', () => {
    // Valid; a template already; a name nothing declares; words that are no expression; not a color function
    for (const line of [
      'ctx.fillStyle = "rgb(255, 255, 255)";',
      'ctx.fillStyle = `rgb(255, 255, ${255 - i})`;',
      'ctx.fillStyle = "rgb(255, 255, 255 - shade)";',
      'ctx.fillStyle = "rgb(red, green, blue)";',
      'ctx.fillStyle = "lavenderblues";',
    ]) {
      const issues = unusableAssignments(program(`let i = 1;\n${line}`), scope);
      expect(issues.filter((issue) => issue.fix), line).toEqual([]);
    }
  });
});

describe('drawing calls made on the canvas element itself', () => {
  // The real program from Qwen3 0.6B's beach sunset: the element is used where its context belongs
  const sunset = [
    'const canvas = document.createElement("canvas");',
    'document.body.appendChild(canvas);',
    'canvas.width = 800;',
    'canvas.fillStyle = "orange";',
    'canvas.beginPath();',
    'canvas.arc(400, 300, 100, 0, Math.PI * 2);',
    'canvas.fill();',
    'canvas.stroke();',
  ].join('\n');
  // The shapes of the browser's two types: the context has the drawing names, the element has width and height
  class FakeElement {
    width = 0;
    height = 0;
    getContext() {}
  }
  class FakeContext {
    beginPath() {}
    arc() {}
    fill() {}
    stroke() {}
    fillRect() {}
  }
  // (the browser's settings are accessors on the prototype)
  Object.defineProperty(FakeContext.prototype, 'fillStyle', { get: () => '', set: () => {}, configurable: true });
  Object.defineProperty(FakeElement.prototype, 'width', { get: () => 0, set: () => {}, configurable: true });
  const scope = { HTMLCanvasElement: FakeElement, CanvasRenderingContext2D: FakeContext } as unknown as Record<string, unknown>;

  it('goes through its context at every use at once, writes too', async () => {
    const { moveToContext } = await import('../src/core/property-check.ts');
    const fixed = moveToContext(sunset, scope);
    expect(fixed.code).toBe(
      [
        'const canvas = document.createElement("canvas");',
        'document.body.appendChild(canvas);',
        'canvas.width = 800;',
        'canvas.getContext("2d").fillStyle = "orange";',
        'canvas.getContext("2d").beginPath();',
        'canvas.getContext("2d").arc(400, 300, 100, 0, Math.PI * 2);',
        'canvas.getContext("2d").fill();',
        'canvas.getContext("2d").stroke();',
      ].join('\n')
    );
    expect(fixed.moved).toEqual([{ object: 'canvas', members: ['fillStyle', 'beginPath', 'arc', 'fill', 'stroke'] }]);
    // Without the browser's types, the methods every context has
    expect((await import('../src/core/property-check.ts')).moveToContext(sunset, {}).code).toContain('canvas.getContext("2d").beginPath();');
  });

  it('moves a call only for a context method, and a read or write only for a context setting', async () => {
    const { moveToContext } = await import('../src/core/property-check.ts');
    // A number kept on the element, named like a method (the reviewer's case): no context is meant
    const kept = 'const canvas = document.createElement("canvas");\nconst ctx = canvas.getContext("2d");\ncanvas.scale = devicePixelRatio;\nctx.scale(canvas.scale, canvas.scale);';
    expect(moveToContext(kept, scope).code).toBe(kept);
    expect(moveToContext(kept, {}).code).toBe(kept);
    // A setting written as a call, and a method written as a setting, stay as they are
    const mixed = 'const canvas = document.createElement("canvas");\ncanvas.fillStyle("red");\ncanvas.arc = 3;';
    expect(moveToContext(mixed, scope).code).toBe(mixed);
    // The right use of each is still moved
    expect(moveToContext('const canvas = document.createElement("canvas");\ncanvas.fillStyle = "red";\ncanvas.fill();', scope).code).toBe('const canvas = document.createElement("canvas");\ncanvas.getContext("2d").fillStyle = "red";\ncanvas.getContext("2d").fill();');
  });

  it('leaves the context itself, the element’s own members, and objects that are not canvas elements alone', async () => {
    const { moveToContext } = await import('../src/core/property-check.ts');
    const right = 'const canvas = document.createElement("canvas");\nconst ctx = canvas.getContext("2d");\nctx.fillStyle = "red";\nctx.beginPath();\ncanvas.width = 10;\nctx.fill();';
    expect(moveToContext(right, scope).code).toBe(right);
    // A made-up object of the program's own with a method of that name
    const own = 'const game = { fill() {}, beginPath() {} };\ngame.fill();\nconst canvas = document.createElement("canvas");';
    expect(moveToContext(own, scope).code).toBe(own);
    // A program that does not parse
    expect(moveToContext('const canvas = document.createElement("canvas");\ncanvas.fill(;', scope).code).toBe('const canvas = document.createElement("canvas");\ncanvas.fill(;');
  });
});

describe('a color name one slip away', () => {
  const NAMES = new Set(['white', 'lavenderblush', 'purple', 'violet', 'red', 'blue']);
  const CSS = { supports: (property: string, value: string) => (value === 'inherit' ? true : /color$/.test(property) || /^(?:color|fill|stroke|background)$/.test(property) ? NAMES.has(value) : false) };
  class FakeCtx {}
  const scope = { CSS, CanvasRenderingContext2D: FakeCtx, document: { createElement: () => ({ style: {} }) } } as unknown as Record<string, unknown>;
  const program = (body: string) => `const canvas = document.createElement("canvas");\nconst ctx = canvas.getContext("2d");\n${body}`;

  it('is corrected, as the colors Qwen3 0.6B misspelt in its beach sunset', () => {
    // The real lines: "whit", and "lavenderblues" from an earlier run
    const code = program('ctx.strokeStyle = "whit";\nctx.fillStyle = \'lavenderblues\';');
    expect(applyAssignmentFixes(code, unusableAssignments(code, scope))).toBe(program('ctx.strokeStyle = \'white\';\nctx.fillStyle = \'lavenderblush\';'));
    const el = "const el = document.getElementById('box');\nel.style.backgroundColor = 'purpel';";
    expect(applyAssignmentFixes(el, unusableAssignments(el, scope))).toContain("el.style.backgroundColor = 'purple';");
  });

  it('is corrected for SVG fill and stroke, a setAttribute of one, and a single-word background', () => {
    const svg = "const el = document.getElementById('dot');\nel.style.fill = 'purpel';\nel.setAttribute('stroke', 'whit');\nel.setAttribute('fill', 'blu');\nel.style.background = 'viollet';";
    const fixed = applyAssignmentFixes(svg, unusableAssignments(svg, scope));
    expect(fixed).toContain("el.style.fill = 'purple';");
    expect(fixed).toContain("el.setAttribute('stroke', 'white');");
    expect(fixed).toContain("el.style.background = 'violet';");
    // 'blu' is too short a name to be sure of
    expect(fixed).toContain("el.setAttribute('fill', 'blu');");
    // Other attributes, valid colors, and a background that is more than a word, stay
    const alone = "el.setAttribute('class', 'whit');\nel.setAttribute('fill', 'red');\nel.style.background = 'url(a.png) no-repeat';";
    expect(unusableAssignments(`const el = document.getElementById('x');\n${alone}`, scope).filter((issue) => issue.fix)).toEqual([]);
  });

  it('is the color alone when a shade word was put in front of one CSS has no such shade of (the deep purple ocean of the beach sunset)', () => {
    // The real line, in every one of the eight tries: CSS has purple and darkviolet, no deeppurple
    const code = program('ctx.fillStyle = "deeppurple";\nctx.fillRect(0, 0, 10, 10);');
    expect(applyAssignmentFixes(code, unusableAssignments(code, scope))).toBe(program('ctx.fillStyle = \'purple\';\nctx.fillRect(0, 0, 10, 10);'));
    // Case, spaces and hyphens do not matter, in a style, a setAttribute and a canvas
    const spelt = "const el = document.getElementById('box');\nel.style.backgroundColor = 'Deep Purple';\nel.setAttribute('fill', 'light-red');\nctx.strokeStyle = 'bright_blue';";
    const fixed = applyAssignmentFixes(program(spelt), unusableAssignments(program(spelt), scope));
    expect(fixed).toContain("el.style.backgroundColor = 'purple';");
    expect(fixed).toContain("el.setAttribute('fill', 'red');");
    expect(fixed).toContain("ctx.strokeStyle = 'blue';");
    // Not when the rest is no color the browser knows (the page's CSS here has no 'green'), nor for a word that is no shade
    for (const line of ['ctx.fillStyle = "deepgreen";', 'ctx.fillStyle = "fancypurple";', 'ctx.fillStyle = "deeppurplish";']) {
      expect(unusableAssignments(program(line), scope).filter((issue) => issue.fix), line).toEqual([]);
    }
  });

  it('leaves valid colors, names nothing is close to, and two equally close, alone', () => {
    for (const line of ['ctx.fillStyle = "white";', 'ctx.fillStyle = "deepSparkle";', 'ctx.fillStyle = "rainbow";', 'ctx.fillStyle = "blu";', 'ctx.fillStyle = "deep";', 'ctx.fillStyle = "mauve";']) {
      expect(unusableAssignments(program(line), scope).filter((issue) => issue.fix), line).toEqual([]);
    }
  });
});

describe('a ; written inside a color', () => {
  // The real line from Qwen2.5 0.5B's beach program: copied from CSS, so the browser ignores the color
  const CSS = {
    supports: (property: string, value: string) => {
      if (value === 'inherit') return property === 'color' || property === 'background-color';
      return /^(?:rgba?\([\d., ]+\)|red|#[0-9a-f]{6})$/.test(value);
    },
  };
  class FakeCtx {}
  const scope = { CSS, document: { createElement: () => ({ style: {} }) }, CanvasRenderingContext2D: FakeCtx } as unknown as Record<string, unknown>;
  const ctx = (body: string) => `const ctx = document.createElement('canvas').getContext('2d');\n${body}`;

  it('takes the ; out of a canvas color, a style color, and keeps the quote it was written with', () => {
    const code = ctx("ctx.fillStyle = 'rgba(255, 255, 255, 0.8);';");
    const [issue] = unusableAssignments(code, scope);
    expect(issue.fix?.text).toBe("'rgba(255, 255, 255, 0.8)'");
    expect(applyAssignmentFixes(code, [issue])).toContain("ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';");
    const [style] = unusableAssignments("const el = document.createElement('div');\nel.style.color = \"red; \";", scope);
    expect(style.fix?.text).toBe('"red"');
  });

  it('leaves valid colors alone, a value that is not a color without it, and a ; in other text', () => {
    expect(unusableAssignments(ctx("ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';"), scope)).toEqual([]);
    expect(unusableAssignments(ctx("ctx.fillStyle = '#87ceeb';"), scope)).toEqual([]);
    expect(unusableAssignments(ctx("ctx.fillStyle = 'notacolor;';"), scope).filter((i) => i.fix?.text.includes('notacolor'))).toEqual([]);
    expect(unusableAssignments(ctx("ctx.font = '12px serif;';"), scope)).toEqual([]);
  });
});
