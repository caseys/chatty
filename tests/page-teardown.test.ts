// @vitest-environment jsdom
// @ts-expect-error jsdom ships no type declarations here
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JavascriptRuntime } from '../src/tools/javascript-runtime.ts';
import { sharedContextForTone } from '../src/standalone/tone-realm.ts';

// What a page holds that the browser frees only when the page is collected: canvas pixels, WebGL
// contexts, sources still playing, an audio context of its own. The sandbox runner frees them when
// the host throws the page away (clear, a new run, the end of a trial), and not before.

type Internals = { buildRunnerHtml(trial: boolean, host?: string, token?: string): string; ensureIframe(): HTMLIFrameElement };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A source node as Web Audio makes it: start() once, stop() only after, 'ended' by itself */
function fakeSource() {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    started: false,
    stops: 0,
    disconnects: 0,
    loop: false,
    start() {
      this.started = true;
    },
    stop() {
      if (!this.started) throw new Error('InvalidStateError');
      this.stops++;
    },
    connect: () => undefined,
    disconnect() {
      this.disconnects++;
    },
    addEventListener(type: string, fn: () => void) {
      (listeners[type] ??= []).push(fn);
    },
    end() {
      for (const fn of listeners.ended ?? []) fn();
    },
  };
}
type Source = ReturnType<typeof fakeSource>;

/** The app's shared audio: a context that must never be closed or suspended */
function fakeShared() {
  const made: Source[] = [];
  const context = {
    destination: {},
    close: vi.fn(),
    suspend: vi.fn(),
    createOscillator: () => made[made.push(fakeSource()) - 1],
    createBufferSource: () => made[made.push(fakeSource()) - 1],
    createConstantSource: () => made[made.push(fakeSource()) - 1],
    createGain: () => ({ connect: () => undefined, disconnect: () => undefined, gain: {}, get context() { return context; } }),
    createAnalyser: () => ({ connect: () => undefined, disconnect: () => undefined, get context() { return context; } }),
    createBuffer: () => ({ length: 1 }),
  };
  return { shared: { context, output: {} }, made };
}

/** The runner page in its own window; canvases get a stand-in 2D or WebGL context (jsdom draws nothing) */
function loadRunner(options: { shared?: ReturnType<typeof fakeShared>['shared']; ownContext?: { closes: number }; lost?: boolean } = {}) {
  const runtime = new JavascriptRuntime();
  const html = (runtime as unknown as Internals).buildRunnerHtml(false);
  const lose = vi.fn();
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/',
    beforeParse(w: any) {
      w.HTMLCanvasElement.prototype.getContext = function (type: string) {
        return /webgl/.test(type)
          ? { canvas: this, getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: lose } : null), isContextLost: () => !!options.lost }
          : { canvas: this, fillRect() {} };
      };
      if (options.shared) w.__chattySharedAudio = () => options.shared;
      const own = options.ownContext;
      if (own) {
        w.AudioContext = class {
          close() {
            own.closes++;
            return Promise.resolve();
          }
        };
      }
    },
  });
  return { win: dom.window as any, lose };
}

const run = async (win: any, code: string, id = 'p1') => {
  win.postMessage({ type: 'execute', id, code }, '*');
  await wait(30);
};

describe('the page frees its sound when it is thrown away', () => {
  let win: any;
  afterEach(() => win?.close());

  it('stops and unplugs every source still going, and leaves the app’s audio context alone', async () => {
    const audio = fakeShared();
    ({ win } = loadRunner({ shared: audio.shared }));
    await run(
      win,
      [
        'const ctx = new AudioContext();',
        'const beep = ctx.createOscillator(); beep.connect(ctx.destination); beep.start();', // never stopped
        'const loop = ctx.createBufferSource(); loop.loop = true; loop.connect(ctx.destination); loop.start();', // loops for ever
        'const hum = ctx.createConstantSource(); hum.start();',
        'const spare = ctx.createOscillator();', // made, never started
        'const done = ctx.createOscillator(); done.start(); window.__done = done;', // ends by itself
        'ctx.close(); ctx.suspend();',
      ].join('\n')
    );
    const [beep, loop, hum, spare, done] = audio.made;
    done.end();
    win.__chattyTeardown();
    for (const source of [beep, loop, hum]) {
      expect(source.stops).toBe(1);
      expect(source.disconnects).toBe(1);
    }
    // Not started: stop() throws, which is let go; it is unplugged all the same
    expect(spare.stops).toBe(0);
    expect(spare.disconnects).toBe(1);
    // A source that ended by itself is off the list: nothing more to do for it
    expect(done.stops).toBe(0);
    expect(done.disconnects).toBe(0);
    expect(audio.shared.context.close).not.toHaveBeenCalled();
    expect(audio.shared.context.suspend).not.toHaveBeenCalled();
  });

  it('does it once, however often it is asked', async () => {
    const audio = fakeShared();
    ({ win } = loadRunner({ shared: audio.shared }));
    await run(win, 'const ctx = new AudioContext(); const o = ctx.createOscillator(); o.start();');
    win.__chattyTeardown();
    win.__chattyTeardown();
    expect(audio.made[0].stops).toBe(1);
  });

  it('stops the sources Tone makes on the app’s context too (handed over by its context stand-in)', async () => {
    const audio = fakeShared();
    ({ win } = loadRunner({ shared: audio.shared }));
    // Tone's context is the app's behind a stand-in (tone-realm.ts); it runs in the page, so the page's own list is what it tells
    (globalThis as any).__chattyRememberSource = win.__chattyRememberSource;
    try {
      const context = sharedContextForTone(audio.shared.context as unknown as AudioContext, audio.shared.output as AudioNode) as any;
      const tone = context.createOscillator();
      tone.start();
      const noise = context.createBufferSource();
      noise.loop = true;
      noise.start();
      const gain = context.createGain();
      expect(typeof gain.connect).toBe('function');
      // The stand-in still makes the context's own nodes, and close() is still nothing
      expect(tone).toBe(audio.made[0]);
      await context.close();
      expect(audio.shared.context.close).not.toHaveBeenCalled();
      win.__chattyTeardown();
      expect(tone.stops).toBe(1);
      expect(noise.stops).toBe(1);
      expect(tone.disconnects).toBe(1);
    } finally {
      delete (globalThis as any).__chattyRememberSource;
    }
  });

  it('closes the page’s own audio context, the one made when the app has none', async () => {
    const own = { closes: 0 };
    ({ win } = loadRunner({ ownContext: own }));
    await run(win, 'const a = new AudioContext(); const b = new AudioContext(); window.__same = a === b;');
    expect(win.__same).toBe(true);
    win.__chattyTeardown();
    expect(own.closes).toBe(1);
    win.__chattyTeardown();
    expect(own.closes).toBe(1);
  });

  it('keeps no history of sources that ended, and no more than a thousand that did not', async () => {
    const audio = fakeShared();
    ({ win } = loadRunner({ shared: audio.shared }));
    await run(win, 'const ctx = new AudioContext(); window.__ctx = ctx; for (let i = 0; i < 1200; i++) ctx.createOscillator().start();');
    win.__chattyTeardown();
    expect(audio.made.length).toBe(1200);
    expect(audio.made.filter((s) => s.stops === 1).length).toBe(1000);
    // The oldest were let go; the newest are stopped
    expect(audio.made[1199].stops).toBe(1);
  });
});

describe('a node made on the app’s audio', () => {
  let win: any;
  afterEach(() => win?.close());

  it('hands out the program’s context stand-in as its context, so close() and suspend() through it stop nothing', async () => {
    const audio = fakeShared();
    ({ win } = loadRunner({ shared: audio.shared }));
    // A program that reaches the context through a node (the reviewer's probe)
    await run(
      win,
      [
        'const ctx = new AudioContext();',
        'const gain = ctx.createGain();',
        'const analyser = ctx.createAnalyser();',
        'window.__same = gain.context === ctx && analyser.context === ctx;',
        'gain.context.close(); gain.context.suspend(); analyser.context.suspend();',
        'window.__buffer = ctx.createBuffer(1, 1, 8000);',
      ].join('\n')
    );
    expect(win.__same).toBe(true);
    expect(audio.shared.context.close).not.toHaveBeenCalled();
    expect(audio.shared.context.suspend).not.toHaveBeenCalled();
    // A thing that is no node (a buffer) is left as it is
    expect(Object.getOwnPropertyNames(win.__buffer)).toEqual(['length']);
  });
});

describe('the page frees its canvases and WebGL contexts when it is thrown away', () => {
  let win: any;
  afterEach(() => win?.close());

  const program = [
    'const flat = document.createElement("canvas"); flat.width = 400; flat.height = 300; document.body.append(flat);',
    'flat.getContext("2d").fillRect(0, 0, 10, 10);',
    // three.js: its renderer makes a canvas, takes a WebGL context from it and may never put it on the page
    'const gl = document.createElement("canvas"); gl.width = 640; gl.height = 480;',
    'gl.getContext("webgl2");',
    'window.__flat = flat; window.__gl = gl;',
  ].join('\n');

  it('sets every canvas to size 0 and has each WebGL context lose itself, once', async () => {
    const loaded = loadRunner();
    win = loaded.win;
    await run(win, program);
    expect(win.__flat.width).toBe(400);
    win.__chattyTeardown();
    expect([win.__flat.width, win.__flat.height, win.__gl.width, win.__gl.height]).toEqual([0, 0, 0, 0]);
    expect(loaded.lose).toHaveBeenCalledTimes(1);
    win.__chattyTeardown();
    expect(loaded.lose).toHaveBeenCalledTimes(1);
  });

  it('leaves a context that is lost already alone, and a canvas that never got a context still shrinks', async () => {
    const loaded = loadRunner({ lost: true });
    win = loaded.win;
    await run(win, program + '\nconst bare = document.createElement("canvas"); bare.width = 50; document.body.append(bare); window.__bare = bare;');
    win.__chattyTeardown();
    expect(loaded.lose).not.toHaveBeenCalled();
    expect(win.__gl.width).toBe(0);
    expect(win.__bare.width).toBe(0);
  });

  it('is not what the program’s own clear() does: that keeps the page and its canvases', async () => {
    const loaded = loadRunner();
    win = loaded.win;
    await run(win, program + '\nclear();');
    expect(win.__gl.width).toBe(640);
    expect(loaded.lose).not.toHaveBeenCalled();
  });

  it('runs when the page goes away by itself (pagehide), but not when it is put away for later', async () => {
    const away = loadRunner();
    win = away.win;
    await run(win, program);
    const kept = new win.Event('pagehide');
    Object.defineProperty(kept, 'persisted', { value: true });
    win.dispatchEvent(kept);
    expect(win.__gl.width).toBe(640);
    const gone = new win.Event('pagehide');
    Object.defineProperty(gone, 'persisted', { value: false });
    win.dispatchEvent(gone);
    expect(win.__gl.width).toBe(0);
    expect(away.lose).toHaveBeenCalledTimes(1);
  });
});

describe('the host asks only for the page it is throwing away', () => {
  const hostCanvas = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 200;
    document.body.append(canvas);
    return canvas;
  };
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('clearing the screen asks the program’s page before it is removed, and nothing else on the app’s page', async () => {
    const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 100 });
    const frame = (runtime as unknown as Internals).ensureIframe();
    const own = hostCanvas();
    const seen: boolean[] = [];
    (frame.contentWindow as any).__chattyTeardown = vi.fn(() => seen.push(frame.isConnected));
    await runtime.resetVisual();
    expect(seen).toEqual([true]);
    expect(frame.isConnected).toBe(false);
    // The app's own canvas is not in the sandbox page, so it is not touched
    expect([own.width, own.height]).toEqual([300, 200]);
    runtime.dispose();
  });

  it('a new run, which starts by clearing, asks once for the page that is replaced', async () => {
    const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 100 });
    const first = (runtime as unknown as Internals).ensureIframe();
    const firstAsked = vi.fn();
    (first.contentWindow as any).__chattyTeardown = firstAsked;
    await runtime.resetVisual();
    await runtime.resetVisual();
    expect(firstAsked).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('a trial that ends asks its own page, not the page showing the program, and not a page that is not its own', async () => {
    const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 100 });
    const showing = (runtime as unknown as Internals).ensureIframe();
    const showingAsked = vi.fn();
    (showing.contentWindow as any).__chattyTeardown = showingAsked;

    const trial = runtime.trialRun('const x = 1;', 800);
    await Promise.resolve();
    const frame = document.querySelector<HTMLIFrameElement>('iframe[aria-hidden="true"]')!;
    const token = /__chattyTrialToken = "([^"]+)"/.exec(frame.srcdoc)![1];
    await wait(30);
    const page = frame.contentWindow as any;
    page.__chattyTrialToken = token;
    page.__chattyTeardown = vi.fn();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'program_error', message: 'boom', __trial: token }, source: frame.contentWindow as Window }));
    expect(await trial).toMatchObject({ error: 'boom' });
    expect(page.__chattyTeardown).toHaveBeenCalledTimes(1);
    expect(showingAsked).not.toHaveBeenCalled();

    // The frame holds another page than this trial's (token differs): left alone
    const second = runtime.trialRun('const y = 2;', 800);
    await Promise.resolve();
    const token2 = /__chattyTrialToken = "([^"]+)"/.exec(frame.srcdoc)![1];
    await wait(30);
    const page2 = frame.contentWindow as any;
    page2.__chattyTrialToken = 'someone else';
    page2.__chattyTeardown = vi.fn();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'program_error', message: 'bang', __trial: token2 }, source: frame.contentWindow as Window }));
    await second;
    expect(page2.__chattyTeardown).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('survives a page that has no teardown (still loading) or that throws', async () => {
    const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 100 });
    const frame = (runtime as unknown as Internals).ensureIframe();
    await expect(runtime.resetVisual()).resolves.toBeUndefined();
    const second = (runtime as unknown as Internals).ensureIframe();
    (second.contentWindow as any).__chattyTeardown = () => {
      throw new Error('gone');
    };
    await expect(runtime.resetVisual()).resolves.toBeUndefined();
    expect(frame).not.toBe(second);
    runtime.dispose();
  });
});
