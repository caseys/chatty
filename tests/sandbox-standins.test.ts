// @vitest-environment jsdom
// @ts-expect-error jsdom ships no type declarations here
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
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
