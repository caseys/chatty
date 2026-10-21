// @vitest-environment jsdom
// @ts-expect-error jsdom ships no type declarations here
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { ConversationOrchestrator, offCanvasFact } from '../src/core/orchestrator.ts';
import { JavascriptRuntime, type CanvasTrace } from '../src/tools/javascript-runtime.ts';

const outcome = (request: string, runtime: object, code = '') =>
  (ConversationOrchestrator.prototype as any).missingOutcome.call({ javascriptRuntime: runtime }, request, { uses: 0, heard: 0, silent: 0 }, code) as Promise<string | null>;

// The program of the live log: canvas sized to the window, ten balls that drift right and never come back
const BALLS = [
  'const canvas = document.createElement("canvas");',
  'canvas.width = innerWidth; canvas.height = innerHeight;',
  'document.body.appendChild(canvas);',
  'const ctx = canvas.getContext("2d");',
  'const balls = Array.from({ length: 10 }, (_, i) => ({ x: 50 * i, y: 100 }));',
  'function frame() {',
  '  ctx.clearRect(0, 0, canvas.width, canvas.height);',
  '  for (const ball of balls) {',
  '    ball.x -= 0.15; ball.x += 10; ball.y = Math.random() * canvas.height; ball.y += 5;',
  '    ctx.beginPath(); ctx.arc(ball.x, ball.y, 10, 0, Math.PI * 2); ctx.fill();',
  '  }',
  '  requestAnimationFrame(frame);',
  '}',
  'frame();',
].join('\n');

describe('the facts about a canvas that shows nothing', () => {
  const trace = (kinds: CanvasTrace['kinds'], nonIdentity = 0): CanvasTrace[] => [{ width: 390, height: 700, nonIdentity, kinds }];

  it('say where the calls landed, from the coordinates, when the canvas is not transformed', () => {
    expect(offCanvasFact(trace([{ kind: 'arc', count: 40, minX: 2090, maxX: 2610, minY: 90, maxY: 120 }]))).toBe('Every arc() is drawn at x 2090–2610, outside the 390×700 canvas: what is drawn has left it.');
    expect(offCanvasFact(trace([{ kind: 'fillRect', count: 3, minX: 10, maxX: 80, minY: -400, maxY: -300 }, { kind: 'fillText', count: 1, minX: 5, maxX: 5, minY: 900, maxY: 900 }]))).toBe(
      'Every fillRect() is drawn at y -400–-300, outside the 390×700 canvas; every fillText() is drawn at y 900, outside the 390×700 canvas: what is drawn has left it.'
    );
  });

  it('say only that nothing is visible under a transform, and when the calls are inside the canvas', () => {
    expect(offCanvasFact(trace([{ kind: 'arc', count: 4, minX: 10, maxX: 30, minY: 10, maxY: 30 }], 4))).toBe('Nothing drawn is visible on the canvas.');
    expect(offCanvasFact(trace([{ kind: 'arc', count: 4, minX: 10, maxX: 30, minY: 10, maxY: 30 }]))).toBe('Nothing drawn is visible on the canvas.');
    expect(offCanvasFact([])).toBeNull();
    expect(offCanvasFact(trace([]))).toBeNull();
  });
});

describe('the outcome check on a canvas that is drawn on all the time', () => {
  // A runtime whose drawing calls keep counting; `shows` is what its picture shows at the end
  const drawing = (shows: boolean, growing = true, kinds: CanvasTrace['kinds'] = [{ kind: 'arc', count: 30, minX: 2100, maxX: 2600, minY: 100, maxY: 140 }]) => {
    let calls = 0;
    return {
      soundUseCount: () => 0,
      hasVisualContent: () => true,
      hasDrawnContent: () => true,
      canvasState: () => [{ calls: (calls += growing ? 40 : 0) + 40, flat: !shows, width: 390, height: 700 }],
      seenNow: () => shows,
      traceDrawing: async () => [{ width: 390, height: 700, nonIdentity: 0, kinds }] as CanvasTrace[],
    };
  };
  const request = 'Animate 10 colored balls bouncing around the screen';

  it('fails the balls that left the canvas, with the fact about where they were drawn', async () => {
    const error = await outcome(request, drawing(false), BALLS);
    expect(error).toContain('Nothing the program draws is visible on its canvas at the end');
    expect(error).toContain('Every arc() is drawn at x 2100–2600, outside the 390×700 canvas: what is drawn has left it.');
  }, 15000);

  it('passes a program that draws once and stays visible, one whose things wrap around or bounce, and a slow mover still on screen', async () => {
    // Draws once: the drawing calls stop growing, and the picture is judged as before (by the calls)
    expect(await outcome(request, drawing(true, false), BALLS)).toBeNull();
    // Wraps around, bounces, or is still on screen at the end: something shows in the picture
    expect(await outcome(request, drawing(true), BALLS)).toBeNull();
    // Draws once, though flat (a solid color asked for): not judged by the picture, the calls did not go on
    expect(await outcome('Draw a blue sky', drawing(false, false), 'ctx.fillStyle = "blue"; ctx.fillRect(0, 0, 400, 300);')).toBeNull();
  }, 20000);

  it('is not asked of a runtime that cannot say, or a request with no canvas drawn on', async () => {
    expect(await outcome(request, { soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => true }, BALLS)).toBeNull();
    expect(await outcome(request, { ...drawing(false), canvasState: () => [] }, BALLS)).toBeNull();
  }, 15000);
});

// The runner page, with a 2D context that keeps a picture of its own (jsdom draws nothing): a shape is on the
// canvas when its box meets it
describe('the sandbox runner reads what is visible on a canvas', () => {
  function load() {
    const runtime = new JavascriptRuntime();
    const html = (runtime as unknown as { buildRunnerHtml(trial: boolean, host?: string, token?: string): string }).buildRunnerHtml(false, undefined, 'tok');
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'http://localhost/',
      beforeParse(w: any) {
        class Ctx2D {
          canvas: any;
          shifted = false;
          path: { x: number; y: number; r: number } | null = null;
          picture = new Set<number>();
          source: any = null;
          constructor(canvas: any) {
            this.canvas = canvas;
          }
          clearRect() { this.canvas.__seen = false; }
          beginPath() {}
          arc(x: number, y: number, r: number) { this.path = { x, y, r }; }
          fill() {
            const p = this.path;
            if (p && !this.shifted && p.x + p.r >= 0 && p.x - p.r <= this.canvas.width && p.y + p.r >= 0 && p.y - p.r <= this.canvas.height) this.canvas.__seen = true;
          }
          fillRect() { if (!this.shifted) this.canvas.__seen = true; }
          translate() { this.shifted = true; }
          getTransform() { return this.shifted ? { a: 1, b: 0, c: 0, d: 1, e: 2000, f: 0 } : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
          drawImage(source: any) { this.source = source; }
          getImageData() {
            const data = new Uint8ClampedArray(24 * 24 * 4);
            if (this.source && this.source.__seen) for (let i = 0; i < 40; i++) data[i * 4 + 3] = 255;
            return { data };
          }
        }
        w.CanvasRenderingContext2D = Ctx2D;
        w.HTMLCanvasElement.prototype.getContext = function (type: string) {
          if (type !== '2d') return null;
          return (this.__ctx ??= new Ctx2D(this));
        };
      },
    });
    return dom.window as any;
  }
  const run = async (win: any, code: string) => {
    win.postMessage({ type: 'execute', id: 'c1', code }, '*');
    await new Promise((r) => setTimeout(r, 120));
  };
  const program = (x: string, extra = '') =>
    `const c = document.createElement("canvas"); c.width = 390; c.height = 700; document.body.append(c);\nconst ctx = c.getContext("2d");\n${extra}\nlet x = ${x};\nfunction frame() { ctx.clearRect(0, 0, 390, 700); ctx.beginPath(); ctx.arc(x, 100, 10, 0, 7); ctx.fill(); x += 1; requestAnimationFrame(frame); }\nframe();`;

  it('says nothing is seen while the calls go on and every arc is far outside, and where they are', async () => {
    const win = load();
    await run(win, program('2100'));
    const state = win.__chattyCanvasState();
    expect(state).toHaveLength(1);
    expect(state[0].calls).toBeGreaterThan(0);
    expect(state[0].flat).toBe(true);
    expect(win.__chattySeen()).toBe(false);
    const traced = await win.__chattyTrace(80);
    expect(traced).toHaveLength(1);
    const arc = traced[0].kinds.find((k: any) => k.kind === 'arc');
    expect(arc.minX).toBeGreaterThan(2000);
    expect(traced[0].nonIdentity).toBe(0);
    expect(offCanvasFact(traced)).toMatch(/^Every arc\(\) is drawn at x 2\d{3}–2\d{3}, outside the 390×700 canvas: what is drawn has left it\.$/);
    win.close();
  });

  it('sees a canvas with something on it, and counts a transformed one as nothing visible with only that to say', async () => {
    const seen = load();
    await run(seen, program('100'));
    expect(seen.__chattySeen()).toBe(true);
    expect(seen.__chattyCanvasState()[0].flat).toBe(false);
    seen.close();
    const moved = load();
    await run(moved, program('100', 'ctx.translate(2000, 0);'));
    expect(moved.__chattySeen()).toBe(false);
    const traced = await moved.__chattyTrace(80);
    expect(traced[0].nonIdentity).toBeGreaterThan(0);
    expect(offCanvasFact(traced)).toBe('Nothing drawn is visible on the canvas.');
    moved.close();
  });

  it('does not count a canvas that is flat but was never drawn on, or a page with text', async () => {
    const win = load();
    await run(win, 'const c = document.createElement("canvas"); c.width = 50; c.height = 50; document.body.append(c); document.body.append("a score: 3");');
    expect(win.__chattyCanvasState()).toEqual([]);
    expect(win.__chattySeen()).toBe(true);
    win.close();
  });
});

describe('the sandbox runner says whether the card holds more than text', () => {
  async function page(code: string, laidOut = true) {
    const runtime = new JavascriptRuntime();
    const html = (runtime as unknown as { buildRunnerHtml(trial: boolean, host?: string, token?: string): string }).buildRunnerHtml(false, undefined, 'tok');
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'http://localhost/',
      beforeParse(w: any) {
        // (jsdom has no layout: every element is 120 x 60 where the test says the page is laid out)
        w.Element.prototype.getBoundingClientRect = function () {
          return laidOut ? { width: 120, height: 60, top: 0, left: 0, right: 120, bottom: 60 } : { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
        };
        class Ctx2D {
          canvas: any;
          constructor(canvas: any) { this.canvas = canvas; }
          fillRect() {}
          clearRect() {}
          getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
        }
        w.CanvasRenderingContext2D = Ctx2D;
        w.HTMLCanvasElement.prototype.getContext = function () { return (this.__ctx ??= new Ctx2D(this)); };
      },
    });
    const win = dom.window as any;
    await new Promise((r) => setTimeout(r, 50));
    win.postMessage({ type: 'execute', id: 'g1', code }, '*');
    await new Promise((r) => setTimeout(r, 80));
    return win;
  }

  it('says only text for the sailboat of words, and a picture for a canvas, an svg, or a box with a color', async () => {
    const words = await page(`document.body.innerHTML = "<div id='a'>Sailboat in the ocean</div><div id='b'>Blue water</div>";`);
    expect(words.__chattyGraphic()).toBe(false);
    words.close();
    const canvas = await page('const c = document.createElement("canvas"); c.width = 50; c.height = 50; document.body.append(c); c.getContext("2d").fillRect(0, 0, 9, 9);');
    expect(['canvas', canvas.__chattyGraphic()]).toEqual(['canvas', true]);
    canvas.close();
    const blank = await page('const c = document.createElement("canvas"); c.width = 50; c.height = 50; document.body.append(c);');
    expect(blank.__chattyGraphic()).toBe(false);
    blank.close();
    const svg = await page(`document.body.innerHTML = "<svg width='20' height='20'><circle r='5'/></svg>";`);
    expect(['svg', svg.__chattyGraphic()]).toEqual(['svg', true]);
    svg.close();
    const box = await page(`document.body.innerHTML = "<div style='background-color: blue'>water</div>";`);
    expect(['box', box.__chattyGraphic()]).toEqual(['box', true]);
    box.close();
  });

  it('counts a page of empty boxes as laid out when the window has a width (its page height is 0 then)', async () => {
    // The real card from the tic-tac-toe Qwen3 0.6B wrote: two empty divs, the board never drawn
    const board = await page(`document.body.innerHTML = "<div id='game'></div><div id='status'></div>";`, false);
    expect(board.__chattyEmptyElements()).toEqual([]);
    Object.defineProperty(board.document.documentElement, 'clientWidth', { value: 400, configurable: true });
    expect(board.__chattyEmptyElements()).toEqual(['div#game', 'div#status']);
    expect(board.__chattyHasDrawing()).toBe(false);
    // (waiting for a tap does not make boxes with nothing in them something to see)
    expect(board.__chattyHasDrawing(true)).toBe(false);
    board.close();
    // ... but a canvas nothing was drawn on yet may be waiting for the tap that draws it
    const waiting = await page('const c = document.createElement("canvas"); c.width = 50; c.height = 50; document.body.append(c);');
    expect(waiting.__chattyHasDrawing()).toBe(false);
    expect(waiting.__chattyHasDrawing(true)).toBe(true);
    waiting.close();
  });

  it('names the functions an inline handler calls that the page does not have (the die button that rolled nothing)', async () => {
    // The real card from Qwen3 0.6B's "Roll a six-sided die when I tap a button": onclick="rollDice()" and no rollDice
    const dead = await page(`document.body.innerHTML = "<button onclick='rollDice()'>Roll</button>";`);
    expect(dead.__chattyDeadHandlers()).toEqual(['rollDice']);
    dead.close();
    // (defined in the program, a function of the window, of the element or of the document, a condition, or no call at all)
    const fine = await page(
      `function rollDice() {}\nwindow.rollDice = rollDice;\ndocument.body.innerHTML = "<button onclick='rollDice()'>Roll</button><button onclick='alert(1)'>a</button><button onclick='this.focus()'>b</button><button onclick='if (true) rollDice(); document.write(1)'>c</button><button onclick='go = 1'>d</button>";`
    );
    expect(fine.__chattyDeadHandlers()).toEqual([]);
    fine.close();
  });

  it('says when a canvas was cleared after its last drawing, naming the function, and not when drawing came last', async () => {
    const setup = 'const c = document.createElement("canvas"); c.width = 50; c.height = 50; document.body.append(c); const ctx = c.getContext("2d");';
    const cleared = await page(`${setup}\nfunction draw() { ctx.fillRect(0, 0, 9, 9); }\nfunction wipe() { ctx.clearRect(0, 0, 50, 50); }\ndraw(); wipe();`);
    expect(cleared.__chattyClearedLast()).toEqual({ fn: expect.anything() });
    cleared.close();
    const never = await page(`${setup}\nctx.clearRect(0, 0, 50, 50);`);
    expect(never.__chattyClearedLast()).not.toBeNull();
    never.close();
    const fine = await page(`${setup}\nctx.clearRect(0, 0, 50, 50);\nctx.fillRect(0, 0, 9, 9);`);
    expect(fine.__chattyClearedLast()).toBeNull();
    fine.close();
    // (a clear of part of the canvas is not a clear)
    const part = await page(`${setup}\nctx.fillRect(0, 0, 9, 9);\nctx.clearRect(0, 0, 5, 5);`);
    expect(part.__chattyClearedLast()).toBeNull();
    part.close();
  });

  it('cannot say for a page with no layout, and says false for an empty one', async () => {
    const hidden = await page('document.body.innerHTML = "<div>text</div>";', false);
    expect(hidden.__chattyGraphic()).toBeNull();
    hidden.close();
    const empty = await page('const x = 1;', false);
    expect(empty.__chattyGraphic()).toBe(false);
    empty.close();
  });
});
