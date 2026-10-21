// @vitest-environment jsdom
// @ts-expect-error jsdom ships no type declarations here
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { JavascriptRuntime, registersHandlers } from '../src/tools/javascript-runtime.ts';

type Win = Window & typeof globalThis & { root: HTMLElement; out: any; start: number; __chattyHasVisual(): boolean };

// Loads the real sandbox runner page; its host (window.parent) is itself, so posts arrive as messages
function loadRunner(): { win: Win; posted: any[] } {
  const runtime = new JavascriptRuntime();
  const iframe = (runtime as unknown as { ensureIframe(): HTMLIFrameElement }).ensureIframe();
  const html = iframe.srcdoc;
  iframe.remove();
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
  const win = dom.window as unknown as Win;
  const posted: any[] = [];
  win.addEventListener('message', (e: MessageEvent) => posted.push(e.data));
  return { win, posted };
}
// The page gives a program its `out` when it runs one
async function programOut(win: Win) {
  win.postMessage({ type: 'execute', id: 'x', code: 'window.testOut = out;' }, '*');
  await wait(20);
  return (win as any).testOut;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runner reliability', () => {
  let win: Win;
  afterEach(() => win?.close());

  it('does not count an empty stand-in as visual output, but does once filled', () => {
    ({ win } = loadRunner());
    expect(win.__chattyHasVisual()).toBe(false);
    const el = win.document.getElementById('missing')!;
    expect(win.__chattyHasVisual()).toBe(false);
    el.textContent = 'hi';
    expect(win.__chattyHasVisual()).toBe(true);
  });

  it('flags a value that is the bad token, not words in ordinary text', async () => {
    // Only a program's first such value is reported, so each text gets its own page
    const reported = async (text: string) => {
      const { win: w, posted } = loadRunner();
      win = w;
      const el = w.document.createElement('div');
      w.document.body.appendChild(el);
      el.textContent = text;
      await wait(5);
      w.close();
      return posted.some((m) => m.type === 'program_error');
    };
    for (const ok of ['Infinity War', 'undefined behaviour is nasty', 'Movies: Infinity War', 'NaNa']) {
      expect(await reported(ok), ok).toBe(false);
    }
    for (const bad of ['Total: NaN', 'undefined', 'Score: Infinity', 'x = undefined', '$NaN', 'NaN%']) {
      expect(await reported(bad), bad).toBe(true);
    }
  });

  it('registersHandlers sees event wiring, not comments', () => {
    expect(registersHandlers("b.addEventListener('click', f)")).toBe(true);
    expect(registersHandlers('b.onclick = f')).toBe(true);
    expect(registersHandlers('<button onchange="f()">')).toBe(true);
    expect(registersHandlers('// b.addEventListener(\nlet x = 1')).toBe(false);
  });

  it('the smoke pass uses every control and reports an error thrown inside a handler', async () => {
    let posted: any[];
    ({ win, posted } = loadRunner());
    const d = win.document;
    const btn = d.createElement('button');
    const input = d.createElement('input');
    input.type = 'number';
    d.body.append(btn, input);
    let seen = '';
    input.addEventListener('input', () => (seen = input.value));
    btn.addEventListener('click', () => {
      throw new Error('boom in handler');
    });
    win.postMessage({ type: 'smoke' }, '*');
    await wait(450);
    expect(seen).toBe('5');
    expect(posted.some((m) => m.type === 'smoke_done')).toBe(true);
    const err = posted.find((m) => m.type === 'program_error');
    expect(err?.message).toContain('boom in handler');
  });
});

describe('real browser interfaces in the sandbox', () => {
  it('sends alert() messages to the chat, as speak() does', async () => {
    const { win, posted } = loadRunner();
    win.postMessage({ type: 'execute', id: 'a', code: 'alert("Done!");' }, '*');
    await wait(30);
    expect(posted.some((m) => m.type === 'speak' && m.text === 'Done!')).toBe(true);
    win.close();
  });

  it('says console.log() messages too, during the run and from a timer after it', async () => {
    const { win, posted } = loadRunner();
    win.postMessage({ type: 'execute', id: 'l', code: 'console.log("Total:", 42); setTimeout(() => console.log({ done: true }), 10);' }, '*');
    await wait(60);
    const said = posted.filter((m) => m.type === 'speak').map((m) => m.text);
    expect(said).toEqual(['Total: 42', '{"done":true}']);
    win.close();
  });
});

describe('adapting what programs do in the page', () => {
  it('adds px to a bare number given as a CSS length', async () => {
    const { win } = loadRunner();
    win.postMessage({ type: 'execute', id: 'p', code: 'const d = document.createElement("div");\nd.style.left = 42;\nd.style.width = "10";\nd.style.opacity = 0.5;\ndocument.body.appendChild(d);\nwindow.__d = d;' }, '*');
    await wait(30);
    const d = (win as any).__d as HTMLElement;
    expect(d.style.left).toBe('42px');
    expect(d.style.width).toBe('10px');
    expect(d.style.opacity).toBe('0.5');
    win.close();
  });

  it('adds to the card what was made to be seen but never added, when the card shows nothing', async () => {
    const { win } = loadRunner();
    win.postMessage({ type: 'execute', id: 'o', code: 'const ball = document.createElement("div");\nball.style.background = "red";\nconst c = document.createElement("canvas");\nconst scratch = document.createElement("span");\nwindow.__made = [ball, c, scratch];' }, '*');
    await wait(30);
    expect(((win as any).__made as HTMLElement[])[0].isConnected).toBe(false); // not at once
    await wait(700);
    const [ball, c, scratch] = (win as any).__made as HTMLElement[];
    expect(ball.isConnected).toBe(true);
    expect(c.isConnected).toBe(true);
    expect(scratch.isConnected).toBe(false);
    win.close();
  });

  it('runs a callback once a frame, however often it is asked for before its frame', async () => {
    const { win } = loadRunner();
    win.postMessage({ type: 'execute', id: 'f', code: 'window.__runs = 0;\nfunction tick() { window.__runs++; }\nconst a = requestAnimationFrame(tick);\nconst b = requestAnimationFrame(tick);\nwindow.__same = a === b;' }, '*');
    await wait(120);
    expect((win as any).__same).toBe(true);
    expect((win as any).__runs).toBe(1);
    win.close();
  });
});

describe('leaving off-page what is meant to stay off-page', () => {
  it('attaches nothing when the card already shows something (a buffer canvas, a sprite)', async () => {
    const { win } = loadRunner();
    win.postMessage({ type: 'execute', id: 'b', code: 'const shown = document.createElement("div");\nshown.textContent = "Score: 0";\ndocument.body.appendChild(shown);\nconst buffer = document.createElement("canvas");\nconst sprite = document.createElement("img");\nwindow.__off = [buffer, sprite];' }, '*');
    await wait(750);
    const [buffer, sprite] = (win as any).__off as HTMLElement[];
    expect(buffer.isConnected).toBe(false);
    expect(sprite.isConnected).toBe(false);
    win.close();
  });

  it('schedules a frame again after it was cancelled', async () => {
    const { win } = loadRunner();
    win.postMessage({ type: 'execute', id: 'c', code: 'window.__runs = 0;\nfunction loop() { window.__runs++; }\nconst a = requestAnimationFrame(loop);\ncancelAnimationFrame(a);\nrequestAnimationFrame(loop);' }, '*');
    await wait(150);
    expect((win as any).__runs).toBe(1);
    win.close();
  });
});

describe('undefined where a browser call needs a value', () => {
  it('is the program error, like NaN', async () => {
    const { win, posted } = loadRunner();
    win.postMessage({ type: 'execute', id: 'u', code: 'const d = document.createElement("div");\nd.setAttribute("title", undefined);' }, '*');
    await wait(40);
    const result = posted.find((m) => m.type === 'result');
    expect(result.success).toBe(false);
    expect(result.error).toContain('setAttribute');
    win.close();
  });
});

describe('a sound the program never made', () => {
  it('plays a note on play() instead of failing', async () => {
    const { win, posted } = loadRunner();
    win.postMessage({ type: 'execute', id: 's', code: 'document.getElementById("sound").play();\nspeak("Played.");', idKinds: { sound: 'media' } }, '*');
    await wait(60);
    const result = posted.find((m) => m.type === 'result');
    expect(result.success).toBe(true);
    expect(posted.some((m) => m.type === 'imagined' && /no such sound/.test(m.text))).toBe(true);
    win.close();
  });
});
