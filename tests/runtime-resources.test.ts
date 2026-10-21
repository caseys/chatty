// @vitest-environment jsdom
// @ts-expect-error jsdom ships no type declarations here
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JavascriptRuntime, oncePerFrame } from '../src/tools/javascript-runtime.ts';

type Internals = { buildRunnerHtml(trial: boolean, host?: string, token?: string): string; watchCard(iframe: HTMLIFrameElement): void; activeIframe: HTMLIFrameElement | null };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('oncePerFrame', () => {
  it('runs once on the next frame however often it is asked, and sees the final state', () => {
    const frames: Array<() => void> = [];
    let state = 0;
    const seen: number[] = [];
    const soon = oncePerFrame(() => seen.push(state), (cb) => frames.push(cb));
    soon();
    state = 1;
    soon();
    state = 2;
    soon();
    expect(frames.length).toBe(1);
    expect(seen).toEqual([]);
    frames.shift()!();
    expect(seen).toEqual([2]);
    // A later burst gets its own frame
    state = 3;
    soon();
    soon();
    expect(frames.length).toBe(1);
    frames.shift()!();
    expect(seen).toEqual([2, 3]);
  });
});

describe('the card watcher', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('measures the card once a frame while a program changes it every few milliseconds', async () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
    const runtime = new JavascriptRuntime();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const win = iframe.contentWindow as any;
    win.ResizeObserver = class { observe() {} };
    const card = iframe.contentDocument!.createElement('div');
    card.id = 'root';
    iframe.contentDocument!.body.appendChild(card);
    let width = 100;
    const measure = vi.fn(() => ({ top: 0, left: 0, right: width, bottom: 50, width, height: 50 }));
    card.getBoundingClientRect = measure as any;
    (runtime as unknown as Internals).activeIframe = iframe;
    (runtime as unknown as Internals).watchCard(iframe);
    expect(measure).toHaveBeenCalledTimes(1); // once at the start

    for (let i = 0; i < 50; i++) {
      width = 100 + i;
      card.style.left = `${i}px`;
      card.textContent = String(i);
    }
    await wait(10); // observers deliver their records
    expect(measure).toHaveBeenCalledTimes(1);
    expect(frames.length).toBe(1);
    frames.shift()!();
    expect(measure).toHaveBeenCalledTimes(2);
    expect(iframe.style.clipPath).toContain(`${win.innerWidth - 149}px`); // the end state: width 149
    iframe.remove();
    runtime.dispose();
  });
});

// A runner page whose 5 s checking window is windowMs, with its host (window.parent) being itself
function loadRunner(trial: boolean, windowMs = 30): { win: any; posted: any[] } {
  const runtime = new JavascriptRuntime();
  const html = (runtime as unknown as Internals).buildRunnerHtml(trial, undefined, 'tok');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/',
    beforeParse(w: any) {
      const real = w.setTimeout.bind(w);
      w.setTimeout = (fn: () => void, ms?: number, ...rest: unknown[]) => real(fn, ms === 5000 ? windowMs : ms, ...rest);
    },
  });
  const posted: any[] = [];
  dom.window.addEventListener('message', (e: MessageEvent) => posted.push(e.data));
  return { win: dom.window, posted };
}
// A bug that only runs after the checking window: textContent set to a stringified NaN and a call
// given undefined, from a timer
const LATE_BUGS =
  'const d = document.createElement("div");\ndocument.body.appendChild(d);\nwindow.__d = d;\nsetTimeout(() => { d.textContent = "Total: NaN"; d.setAttribute("title", undefined); }, 120);';

describe('value checks on browser calls', () => {
  it('catch a bug in the first seconds of a run', async () => {
    const { win, posted } = loadRunner(false);
    win.postMessage({ type: 'execute', id: 'a', code: 'document.createElement("div").setAttribute("title", undefined);' }, '*');
    await wait(20);
    expect(posted.find((m) => m.type === 'result')).toMatchObject({ success: false });
    win.close();
  });

  it('stop after the window, and the calls still go through', async () => {
    const { win, posted } = loadRunner(false);
    win.postMessage({ type: 'execute', id: 'b', code: LATE_BUGS }, '*');
    await wait(250);
    expect(posted.some((m) => m.type === 'program_error')).toBe(false);
    expect(win.__d.textContent).toBe('Total: NaN');
    expect(win.__d.getAttribute('title')).toBe('undefined');
    win.close();
  });

  it('start again with the next run', async () => {
    const { win, posted } = loadRunner(false);
    win.postMessage({ type: 'execute', id: 'c', code: '1' }, '*');
    await wait(100); // the window is over
    win.postMessage({ type: 'execute', id: 'd', code: 'document.createElement("div").setAttribute("title", undefined);' }, '*');
    await wait(20);
    expect(posted.filter((m) => m.type === 'result').pop()).toMatchObject({ id: 'd', success: false });
    win.close();
  });

  it('a new run gets its own whole window, not what was left of the last one', async () => {
    const { win, posted } = loadRunner(false, 100);
    win.postMessage({ type: 'execute', id: 'e', code: '1' }, '*');
    await wait(60);
    // 70 ms into this run is 130 ms after the first started: past its window, inside this one
    win.postMessage({ type: 'execute', id: 'f', code: 'setTimeout(() => document.createElement("div").setAttribute("title", undefined), 70);' }, '*');
    await wait(150);
    expect(posted.some((m) => m.type === 'program_error')).toBe(true);
    win.close();
  });

  it('keep checking for the whole of a trial page', async () => {
    const { win, posted } = loadRunner(true);
    win.postMessage({ type: 'execute', id: 'g', code: LATE_BUGS }, '*');
    await wait(250);
    const error = posted.find((m) => m.type === 'program_error');
    expect(error?.message).toMatch(/NaN|undefined/);
    expect(error?.__trial).toBe('tok');
    win.close();
  });
});
