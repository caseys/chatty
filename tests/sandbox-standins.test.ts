// @vitest-environment jsdom
// @ts-expect-error jsdom ships no type declarations here
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JavascriptRuntime } from '../src/tools/javascript-runtime.ts';

// Loads the real sandbox runner page (the srcdoc the runtime builds) in its own window
function loadRunner() {
  const runtime = new JavascriptRuntime();
  const iframe = (runtime as unknown as { ensureIframe(): HTMLIFrameElement }).ensureIframe();
  const html = iframe.srcdoc;
  iframe.remove();
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
  return dom.window as unknown as Window & typeof globalThis & { root: HTMLElement };
}

describe('sandbox stand-ins for elements the program never made', () => {
  let win: ReturnType<typeof loadRunner>;
  afterEach(() => win?.close());

  it('gives getElementById a div for a missing id', () => {
    win = loadRunner();
    const el = win.document.getElementById('app')!;
    expect(el.tagName).toBe('DIV');
    expect(win.root.contains(el)).toBe(true);
    expect(win.document.getElementById('app')).toBe(el);
  });

  it('gives a canvas-like id a sized <canvas> that has getContext', () => {
    win = loadRunner();
    for (const id of ['gameCanvas', 'myCANVAS', 'canvas']) {
      const el = win.document.getElementById(id) as HTMLCanvasElement;
      expect(el.tagName).toBe('CANVAS');
      expect(el.getAttribute('width')).toBe('400');
      expect(el.getAttribute('height')).toBe('300');
      expect(typeof el.getContext).toBe('function');
    }
    expect(win.document.getElementById('board')!.tagName).toBe('DIV');
  });

  it('gives querySelector("#id") the same stand-in, from document, the card and the body', () => {
    win = loadRunner();
    const a = win.document.querySelector('#score')!;
    expect(a.tagName).toBe('DIV');
    expect(win.document.getElementById('score')).toBe(a);
    const b = win.root.querySelector('#lives')!;
    expect(b.id).toBe('lives');
    const c = win.document.body.querySelector('#gameCanvas')!;
    expect(c.tagName).toBe('CANVAS');
    expect(win.document.querySelector(' #gameCanvas ')).toBe(c);
  });

  it('still returns real matches, and null for anything but a plain id selector', () => {
    win = loadRunner();
    win.root.innerHTML = '<p id="real" class="x">hi</p>';
    expect(win.document.querySelector('#real')).toBe(win.root.firstElementChild);
    // A fresh page for each: jsdom's selector engine looks ids up through getElementById itself,
    // so one selector's lookup would leave a stand-in behind for the next (browsers don't)
    for (const selector of ['.nope', 'div .nope', '#nope.x', '#nope:hover', '[id=nope]', 'button']) {
      win.close();
      win = loadRunner();
      expect(win.document.querySelector(selector), selector).toBeNull();
    }
    // An invalid selector still throws like it does natively
    expect(() => win.document.querySelector('#1abc')).toThrow();
  });

  it('leaves a loose element that is not on the page alone', () => {
    win = loadRunner();
    const loose = win.document.createElement('div');
    loose.innerHTML = '<span id="in">x</span>';
    expect(loose.querySelector('#in')).not.toBeNull();
    expect(loose.querySelector('#out')).toBeNull();
    expect(win.document.getElementById('out')).not.toBeNull();
  });

  it('carries listeners from a stand-in to the real element, canvas or not', async () => {
    win = loadRunner();
    const seen: string[] = [];
    win.document.querySelector('#go')!.addEventListener('click', () => seen.push('go'));
    const stand = win.document.querySelector('#gameCanvas') as HTMLCanvasElement;
    stand.addEventListener('click', () => seen.push('canvas'));
    win.root.innerHTML = '<button id="go">Go</button><canvas id="gameCanvas" width="80" height="60"></canvas>';
    await new Promise((r) => setTimeout(r, 0));
    const go = win.document.getElementById('go')!;
    const canvas = win.document.getElementById('gameCanvas') as HTMLCanvasElement;
    expect(go.tagName).toBe('BUTTON');
    expect(canvas.getAttribute('width')).toBe('80');
    expect(win.document.querySelectorAll('#gameCanvas, #go').length).toBe(2);
    go.click();
    canvas.click();
    expect(seen).toEqual(['go', 'canvas']);
  });
});

// A runner page whose window has a 2D context the way a browser does: its drawing methods (which
// the runner passes on and counts) and a canvas that hands one out. jsdom draws nothing, so a canvas
// "paints" a mark the thumbnail can read back.
function loadRunnerWithContext() {
  const runtime = new JavascriptRuntime();
  const html = (runtime as unknown as { buildRunnerHtml(trial: boolean): string }).buildRunnerHtml(false);
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/page.html',
    beforeParse(w: any) {
      class Context {
        canvas: any;
        paint = 0;
        constructor(canvas: any) {
          this.canvas = canvas;
        }
        beginPath() {}
        arc() {}
        fill() {
          this.canvas._paint = (this.canvas._paint ?? 0) + 1;
        }
        fillRect(x: number) {
          this.canvas._paint = (this.canvas._paint ?? 0) + x + 1;
        }
        clearRect() {}
        drawImage(source: any) {
          this.paint = source._paint ?? 0;
        }
        getImageData() {
          return { data: [this.paint] };
        }
      }
      w.CanvasRenderingContext2D = Context;
      class Gl {
        canvas: any;
        constructor(canvas: any) {
          this.canvas = canvas;
        }
      }
      w.HTMLCanvasElement.prototype.getContext = function (type: string) {
        return type === 'webgl' ? (this._gl ??= new Gl(this)) : (this._context ??= new Context(this));
      };
    },
  });
  return dom.window as any;
}

describe('a canvas nothing was drawn on', () => {
  let win: any;
  afterEach(() => win?.close());

  const state = (w: any) => ({ visual: w.__chattyHasVisual(), drawing: w.__chattyHasDrawing() });

  it('is something on the page, but not a drawing, as the Pong a small model wrote that never drew', () => {
    win = loadRunnerWithContext();
    win.root.innerHTML = '<canvas width="300" height="150"></canvas>';
    // Even with a context made and a path begun: nothing is painted yet
    const canvas = win.root.firstElementChild;
    canvas.getContext('2d').beginPath();
    canvas.getContext('2d').arc();
    expect(state(win)).toEqual({ visual: true, drawing: false });
  });

  it('is a drawing once something is painted on it, or when anything else is shown with it', () => {
    win = loadRunnerWithContext();
    win.root.innerHTML = '<canvas id="c" width="300" height="150"></canvas>';
    win.document.getElementById('c').getContext('2d').fillRect(0, 0, 10, 10);
    expect(state(win)).toEqual({ visual: true, drawing: true });
    win.root.innerHTML = '<canvas width="300" height="150"></canvas><p>Score: 0</p>';
    expect(state(win)).toEqual({ visual: true, drawing: true });
    win.root.innerHTML = '<svg width="10" height="10"></svg>';
    expect(state(win).drawing).toBe(true);
  });

  it('reads no pixels back to tell: no dataURL of the canvas is ever made', () => {
    win = loadRunnerWithContext();
    let read = 0;
    win.HTMLCanvasElement.prototype.toDataURL = () => {
      read++;
      return '';
    };
    win.root.innerHTML = '<canvas width="3000" height="2000"></canvas>';
    state(win);
    win.__chattySignature();
    expect(read).toBe(0);
  });

  it('is left to the page for a canvas whose drawing is not seen (another kind of context)', () => {
    win = loadRunnerWithContext();
    win.root.innerHTML = '<canvas width="300" height="150"></canvas>';
    const canvas = win.root.firstElementChild;
    // A WebGL-like context made on it: its drawing isn't counted, so it is not called blank
    canvas.getContext('webgl');
    expect(state(win).drawing).toBe(true);
  });

  // jsdom has no layout: a box takes room only when it has text, as in a browser
  const withLayout = (w: any) => {
    w.Element.prototype.getBoundingClientRect = function () {
      const html = this === w.document.documentElement;
      const filled = html || (this.textContent ?? '').trim() !== '' || this.hasAttribute('style');
      return { width: filled ? 100 : 0, height: filled ? (html ? 800 : 20) : 0 };
    };
  };

  it('is shown nothing for elements with nothing in them, as in the clock Qwen3 0.6B made', () => {
    win = loadRunner();
    withLayout(win);
    // The real markup: a clock face whose time was never filled in
    win.root.innerHTML = '<div class="clock">\n    <div id="time"></div>\n  </div>';
    expect(state(win)).toEqual({ visual: true, drawing: false });
    // Filled in, it shows
    win.document.getElementById('time')!.textContent = '12:30:05';
    expect(state(win)).toEqual({ visual: true, drawing: true });
  });

  it('names the empty elements, as selectors with counts', () => {
    win = loadRunner();
    withLayout(win);
    win.root.innerHTML = '<div class="chart"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div><div id="time"></div>';
    expect((win as any).__chattyEmptyElements()).toEqual(['div.chart', 'div.bar ×3', 'div#time']);
  });

  it('shows an empty element that has room of its own, and anything else that is there', () => {
    win = loadRunner();
    withLayout(win);
    win.root.innerHTML = '<div style="width:50px;height:50px;background:red"></div>';
    expect(state(win).drawing).toBe(true);
    win.root.innerHTML = '<input id="bill"><div id="out"></div>';
    expect(state(win).drawing).toBe(true);
    win.root.innerHTML = '<ul><li></li></ul>';
    expect(state(win).drawing).toBe(false);
  });

});

describe('a script in markup set through innerHTML', () => {
  let win: ReturnType<typeof loadRunner>;
  afterEach(() => win?.close());
  const run = async (w: any, posted: any[], code: string) => {
    const id = `s${posted.length}`;
    w.postMessage({ type: 'execute', id, code }, '*');
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'result' && m.id === id)).toBe(true), { timeout: 2000 });
  };
  const load = () => {
    const runtime = new JavascriptRuntime();
    const html = (runtime as unknown as { buildRunnerHtml(trial: boolean): string }).buildRunnerHtml(false);
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/page.html' });
    const posted: any[] = [];
    dom.window.addEventListener('message', (e: MessageEvent) => posted.push(e.data));
    return { win: dom.window as any, posted };
  };

  it('runs, as the program meant: the cat Qwen3 0.6B drew inside a <script> in its markup', async () => {
    const { win: w, posted } = load();
    win = w;
    // The real shape: a canvas and the script that draws on it, in one innerHTML
    const program = [
      'document.body.innerHTML = `',
      '  <canvas id="catCanvas" width="200" height="200"></canvas>',
      '  <script>',
      '    const canvas = document.getElementById("catCanvas");',
      '    window.drawn = (window.drawn || 0) + 1;',
      '    canvas.dataset.drawn = "cat";',
      '  </script>`;',
    ].join('\n');
    await run(w, posted, program);
    expect(w.drawn).toBe(1);
    expect((w.document.getElementById('catCanvas') as HTMLElement).dataset.drawn).toBe('cat');
    expect(posted.some((m) => m.type === 'imagined' && /<script> in markup/.test(m.text))).toBe(true);
  });

  it('runs once, also when the body is added to later, and for insertAdjacentHTML', async () => {
    const { win: w, posted } = load();
    win = w;
    await run(w, posted, 'document.body.innerHTML = "<p>a</p><script>window.n = (window.n || 0) + 1;</script>";\ndocument.body.innerHTML += "<p>b</p>";\ndocument.body.insertAdjacentHTML("beforeend", "<script>window.m = (window.m || 0) + 1;</script>");');
    expect(w.n).toBe(1);
    expect(w.m).toBe(1);
  });

  it('leaves markup without scripts, and a script the parser already ran, alone', async () => {
    const { win: w, posted } = load();
    win = w;
    await run(w, posted, 'document.body.innerHTML = "<p>hello</p>";');
    expect(w.root.innerHTML).toBe('<p>hello</p>');
    expect(posted.some((m) => m.type === 'imagined' && /<script> in markup/.test(m.text))).toBe(false);
    // document.write runs its scripts itself: not twice
    await run(w, posted, 'document.write("<p>x</p><script>window.once = (window.once || 0) + 1;</script>");');
    expect(w.once).toBe(1);
  });
});

describe('what the card looks like over time', () => {
  let win: ReturnType<typeof loadRunner> & { __chattySignature(): string | null };
  afterEach(() => win?.close());

  it('differs when its text changes, and not otherwise', () => {
    win = loadRunner() as typeof win;
    win.root.innerHTML = '<div id="t">10</div>';
    const first = win.__chattySignature();
    expect(win.__chattySignature()).toBe(first);
    win.document.getElementById('t')!.textContent = '9';
    expect(win.__chattySignature()).not.toBe(first);
  });

  it('reads a canvas as a small picture: it differs when what is drawn changes, and not otherwise', () => {
    const w = loadRunnerWithContext();
    w.root.innerHTML = '<canvas id="c" width="800" height="600"></canvas>';
    const context = w.document.getElementById('c').getContext('2d');
    const first = w.__chattySignature();
    expect(w.__chattySignature()).toBe(first);
    context.fillRect(40, 40, 10, 10);
    const moved = w.__chattySignature();
    expect(moved).not.toBe(first);
    expect(w.__chattySignature()).toBe(moved);
    w.close();
  });

  it('is moving while an animation runs', () => {
    win = loadRunner() as typeof win;
    // A page with a CSS animation changes without any markup changing
    win.root.innerHTML = '<div id="spin">x</div>';
    (win.document as any).getAnimations = () => [{ playState: 'running' }];
    const a = win.__chattySignature();
    expect(a).toMatch(/^animation:/);
    (win.document as any).getAnimations = () => [];
    expect(win.__chattySignature()).not.toMatch(/^animation:/);
  });
});

describe('a program that makes elements without end', () => {
  const load = () => {
    const runtime = new JavascriptRuntime();
    const html = (runtime as unknown as { buildRunnerHtml(trial: boolean): string }).buildRunnerHtml(false);
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/page.html' });
    const posted: any[] = [];
    dom.window.addEventListener('message', (e: MessageEvent) => posted.push(e.data));
    return { w: dom.window as any, posted };
  };

  // The page's element count, as the watcher reads it, set by the test (a real 20,000 are slow to make in jsdom)
  const counting = (w: any, next: () => number) => {
    const real = w.document.getElementsByTagName.bind(w.document);
    w.document.getElementsByTagName = (tag: string) => (tag === '*' ? { length: next() } : real(tag));
  };
  const caughtBy = 'setInterval(() => { try { document.createElement("div"); } catch (e) { window.__caught = e.message; } }, 50);';

  it('is stopped once the page keeps growing past 20,000 elements: its timers end, it is told once, and the next element it makes is an error that says why', async () => {
    const { w, posted } = load();
    let count = 20000;
    counting(w, () => (count += 1500));
    w.postMessage({ type: 'execute', id: 'flood', code: 'window.__ticks = 0; setInterval(() => { window.__ticks++; }, 50);' }, '*');
    const told = () => posted.filter((m) => m.type === 'program_error' && /keeps adding more/.test(m.message));
    await vi.waitFor(() => expect(told().length).toBe(1), { timeout: 8000 });
    // Its interval was ended with it
    const ticks = w.__ticks;
    await new Promise((r) => setTimeout(r, 300));
    expect(w.__ticks).toBe(ticks);
    // A handler that makes an element after that gets the error (the same text), and it is not told again
    expect(() => w.document.createElement('div')).toThrow(/^The page has \d{5} elements and the program keeps adding more without taking the old ones away/);
    expect(told().length).toBe(1);
    w.close();
  }, 15000);

  it('leaves a big grid made once, and a program that takes away what it adds, alone', async () => {
    // Forty thousand at once and then still; or a count that goes up and down
    for (const next of [() => 40000, (() => { let n = 0; return () => 25000 + (n++ % 2) * 3000; })()]) {
      const { w } = load();
      counting(w, next);
      w.postMessage({ type: 'execute', id: 'quiet', code: caughtBy }, '*');
      await new Promise((r) => setTimeout(r, 3200));
      expect(w.__caught).toBeUndefined();
      w.close();
    }
  }, 20000);
});

describe('an error that repeats every frame', () => {
  it('is told to the host once, not at every frame', async () => {
    const runtime = new JavascriptRuntime();
    const html = (runtime as unknown as { buildRunnerHtml(trial: boolean): string }).buildRunnerHtml(false);
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/page.html' });
    const posted: any[] = [];
    dom.window.addEventListener('message', (e: MessageEvent) => posted.push(e.data));
    const w = dom.window as any;
    // Qwen3 0.6B's balls: a loop of frames that fail the same way each time
    w.postMessage({ type: 'execute', id: 'frames', code: 'let n = 0;\nfunction frame() {\n  n++;\n  const balls = 10;\n  balls.forEach((b) => b);\n}\nsetInterval(frame, 5);' }, '*');
    await new Promise((r) => setTimeout(r, 300));
    expect(posted.filter((m) => m.type === 'program_error' && /forEach is not a function/.test(m.message)).length).toBe(1);
    w.close();
  });
});

describe('a program’s own names next to the runner’s', () => {
  it('can be the ones the runner uses itself: setup, draw, shown, contexts, hashText, wiring, OUT', async () => {
    const runtime = new JavascriptRuntime();
    const html = (runtime as unknown as { buildRunnerHtml(trial: boolean): string }).buildRunnerHtml(false);
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/page.html' });
    const posted: any[] = [];
    dom.window.addEventListener('message', (e: MessageEvent) => posted.push(e.data));
    const w = dom.window as any;
    // A top-level function or var of the program's, named like something the runner keeps: the real
    // failure was "Identifier 'setup' has already been declared" for Play the first notes of Twinkle Twinkle
    const code = 'function setup() { return 1; }\nfunction draw() { return setup(); }\nfunction shown() { return 2; }\nvar contexts = [1];\nvar wiring = 3;\nfunction hashText() { return 4; }\nvar OUT = 5;\nspeak(String(setup() + draw() + shown() + contexts[0] + wiring + hashText() + OUT));';
    w.postMessage({ type: 'execute', id: 'names', code }, '*');
    await vi.waitFor(() => expect(posted.find((m) => m.type === 'result' && m.id === 'names')).toBeDefined(), { timeout: 3000 });
    const result = posted.find((m) => m.type === 'result' && m.id === 'names');
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(posted.find((m) => m.type === 'speak' && m.id === 'names')?.text).toBe('17');
    w.close();
  });
});

describe('what the runner leaves global for the libraries’ scripts', () => {
  it('names its host, which Tone.js looks up to play through the app’s audio', () => {
    const runtime = new JavascriptRuntime();
    const html = (runtime as unknown as { buildRunnerHtml(trial: boolean): string }).buildRunnerHtml(false);
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/page.html' });
    const w = dom.window as any;
    // (a module script of the page reads `__chattyHost` as a global: tone-realm.ts pageHost)
    expect(w.eval('typeof __chattyHost')).toBe('object');
    expect(w.__chattyHost).toBe(w.parent);
    w.close();
  });
});

describe('markup set on a container that holds scripts already', () => {
  const load = () => {
    const runtime = new JavascriptRuntime();
    const html = (runtime as unknown as { buildRunnerHtml(trial: boolean): string }).buildRunnerHtml(false);
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/page.html' });
    const posted: any[] = [];
    dom.window.addEventListener('message', (e: MessageEvent) => posted.push(e.data));
    return { w: dom.window as any, posted };
  };
  const run = async (w: any, posted: any[], id: string, code: string) => {
    w.postMessage({ type: 'execute', id, code }, '*');
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'result' && m.id === id)).toBe(true), { timeout: 3000 });
  };

  it('does not run the runner’s own script again when the body is added to', async () => {
    const { w, posted } = load();
    // (the page's own iframe_ready was sent as it loaded)
    const ready = () => posted.filter((m) => m.type === 'iframe_ready').length;
    await vi.waitFor(() => expect(ready()).toBe(1));
    const before = ready();
    await run(w, posted, 'a', "document.querySelector('body').innerHTML += '<h1>Hi</h1>';\ndocument.querySelector('body').insertAdjacentHTML('afterend', '<p>x</p>');");
    await new Promise((r) => setTimeout(r, 50));
    expect(ready()).toBe(before);
    // Later programs run once
    await run(w, posted, 'b', 'speak("once");');
    expect(posted.filter((m) => m.type === 'speak' && m.id === 'b').length).toBe(1);
    w.close();
  });

  it('still runs a script the new text adds, and skips one that was there already', async () => {
    const { w, posted } = load();
    await run(w, posted, 'c', 'document.body.innerHTML = "<p>a</p><script>window.n = (window.n || 0) + 1;</script>";\ndocument.body.innerHTML += "<p>b</p><script>window.m = (window.m || 0) + 1;</script>";');
    expect(w.n).toBe(1);
    expect(w.m).toBe(1);
    w.close();
  });
});

describe("the card's speak()", () => {
  let win: ReturnType<typeof loadRunner>;
  afterEach(() => win?.close());

  const said = (call: (speak: (...parts: unknown[]) => void) => void): string[] => {
    win = loadRunner();
    const texts: string[] = [];
    win.postMessage = ((message: { type?: string; text?: string }) => {
      if (message?.type === 'speak') texts.push(message.text ?? '');
    }) as typeof win.postMessage;
    call((win as unknown as { speak: (...parts: unknown[]) => void }).speak);
    return texts;
  };

  it('says every argument it is given, not only the first', () => {
    expect(said((speak) => speak('Ada Lovelace was', 'a mathematician.'))).toEqual(['Ada Lovelace was a mathematician.']);
    expect(said((speak) => speak('Total:', 12.6))).toEqual(['Total: 12.6']);
  });

  it('says an object or a list as its values in words', () => {
    expect(said((speak) => speak({ temperature: 18, rain: 0 }))).toEqual(['temperature 18, rain 0']);
    expect(said((speak) => speak('Picked:', ['red', 'blue']))).toEqual(['Picked: red, blue']);
    expect(said((speak) => speak(undefined))).toEqual(['']);
  });
});
