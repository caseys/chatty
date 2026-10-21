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

  it('out.loop runs bars now and again each pass with start moved on, until stopped', async () => {
    ({ win } = loadRunner());
    const out = await programOut(win);
    const starts: number[] = [];
    const stop = out.loop((t: number) => starts.push(t), 60);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toBeGreaterThan(win.performance.now());
    await wait(300);
    expect(starts.length).toBeGreaterThanOrEqual(3);
    expect(starts[1] - starts[0]).toBe(60);
    stop();
    const n = starts.length;
    await wait(100);
    expect(starts.length).toBe(n);
  });

  it('out.loop with bad arguments does nothing and logs it as imagined', async () => {
    let posted: any[];
    ({ win, posted } = loadRunner());
    const out = await programOut(win);
    const stop = out.loop('nope', 0);
    await wait(5);
    expect(typeof stop).toBe('function');
    expect(posted.some((m) => m.type === 'imagined' && /out\.loop/.test(m.text))).toBe(true);
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
