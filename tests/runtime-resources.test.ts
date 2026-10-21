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
    await vi.waitFor(() => expect(posted.find((m) => m.type === 'result')).toBeDefined(), { timeout: 1000 });
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

describe('console.log and the speech check', () => {
  const said = (posted: any[]) => posted.filter((m) => m.type === 'speak').map((m) => m.text);
  const failed = (posted: any[]) => posted.find((m) => m.type === 'program_error' || (m.type === 'result' && m.error));

  it('speaks console.log only for a program that has no speak() of its own', async () => {
    const quiet = loadRunner(false);
    quiet.win.postMessage({ type: 'execute', id: 'l1', code: 'console.log("Total: 12");' }, '*');
    await wait(30);
    expect(said(quiet.posted)).toEqual(['Total: 12']);
    quiet.win.close();
    const talker = loadRunner(false);
    talker.win.postMessage({ type: 'execute', id: 'l2', code: 'speak("Here it is.");\nconsole.log("debug", 3);' }, '*');
    await wait(30);
    expect(said(talker.posted)).toEqual(['Here it is.']);
    talker.win.close();
  });

  it('does not read out a log in a loop over and over', async () => {
    const { win, posted } = loadRunner(false);
    win.postMessage({ type: 'execute', id: 'l3', code: 'for (let i = 0; i < 20; i++) console.log("hit");\nfor (let i = 0; i < 20; i++) console.log("frame " + i);' }, '*');
    await wait(30);
    expect(said(posted)).toEqual(['hit', 'frame 0', 'frame 1']);
    win.close();
  });

  it('leaves NaN and Infinity alone when they are what was asked about', async () => {
    const asked = loadRunner(false);
    asked.win.postMessage({ type: 'execute', id: 'n1', code: 'speak(`0 / 0 is ${0 / 0}`);', valuesExpected: true }, '*');
    await wait(30);
    expect(failed(asked.posted)).toBeUndefined();
    asked.win.close();
    const own = loadRunner(false);
    own.win.postMessage({ type: 'execute', id: 'n2', code: 'const note = "Dividing by zero gives Infinity";\nspeak("1 / 0 = " + 1 / 0);' }, '*');
    await wait(30);
    expect(failed(own.posted)).toBeUndefined();
    own.win.close();
    // Not asked about: still a bug
    const bug = loadRunner(false);
    bug.win.postMessage({ type: 'execute', id: 'n3', code: 'let total;\nspeak("Your total is " + total);' }, '*');
    await wait(30);
    expect(failed(bug.posted)).toBeDefined();
    bug.win.close();
  });
});

describe('values the browser quietly refuses, and event names it never fires', () => {
  const failed = (posted: any[]) => posted.find((m) => m.type === 'program_error' || (m.type === 'result' && m.error));

  it('reports a value that did not take, read back on a fresh element', async () => {
    const { win, posted } = loadRunner(false);
    win.postMessage({ type: 'execute', id: 'r1', code: 'const i = document.createElement("input");\ni.type = "phone";\ndocument.body.append(i);' }, '*');
    await wait(30);
    expect(JSON.stringify(failed(posted))).toMatch(/type = 'phone' didn't take/);
    win.close();
  });

  it('leaves values that took alone, a URL set again included', async () => {
    const { win, posted } = loadRunner(false);
    win.postMessage({ type: 'execute', id: 'r2', code: 'const im = document.createElement("img");\nim.src = "a.png";\nim.src = "a.png";\nim.alt = "x";\nconst i = document.createElement("input");\ni.type = "Number";\ni.placeholder = "Bill";\ndocument.body.append(im, i);' }, '*');
    await wait(30);
    expect(failed(posted)).toBeUndefined();
    win.close();
  });

  it('turns a handler-property name or a case slip into the event, and leaves real and own events alone', async () => {
    const { win, posted } = loadRunner(false);
    const code = [
      'const b = document.createElement("button");',
      'document.body.append(b);',
      'window.__hits = [];',
      'b.addEventListener("onclick", () => __hits.push("click"));',
      'b.addEventListener("mouse_down", () => __hits.push("down"));',
      'b.addEventListener("focusin", () => __hits.push("focusin"));',
      'b.addEventListener("Ready", () => __hits.push("ready"));',
      'b.dispatchEvent(new MouseEvent("click"));',
      'b.dispatchEvent(new MouseEvent("mousedown"));',
      'b.dispatchEvent(new Event("Ready"));',
    ].join('\n');
    win.postMessage({ type: 'execute', id: 'e1', code }, '*');
    await wait(30);
    expect(win.__hits).toEqual(['click', 'down', 'ready']);
    const notes = posted.filter((m) => m.type === 'imagined').map((m) => m.text);
    expect(notes).toEqual(["addEventListener('onclick') → 'click': corrected while running", "addEventListener('mouse_down') → 'mousedown': corrected while running"]);
    win.close();
  });
});

describe('misspelt writes and refused keywords, repaired while running', () => {
  const failed = (posted: any[]) => posted.find((m) => m.type === 'program_error' || (m.type === 'result' && m.error));
  const notes = (posted: any[]) => posted.filter((m) => m.type === 'imagined').map((m) => m.text);

  it('moves a misspelt handler or property to the real one, and leaves the program\'s own extras', async () => {
    const { win, posted } = loadRunner(false);
    const code = [
      'const b = document.createElement("button");',
      'document.body.append(b);',
      'window.__hits = 0;',
      'b.onClick = () => __hits++;',
      'b.innerHtml = "<i>Go</i>";',
      'b.speed = 3;',
      'b.vx = 2;',
      'window.__b = b;',
    ].join('\n');
    win.postMessage({ type: 'execute', id: 'w1', code }, '*');
    await wait(30);
    win.__b.click();
    expect(win.__hits).toBe(1);
    expect(win.__b.innerHTML).toBe('<i>Go</i>');
    expect(win.__b.speed).toBe(3);
    expect(win.__b.vx).toBe(2);
    expect(notes(posted)).toEqual(['button.onClick → button.onclick: corrected while running', 'button.innerHtml → button.innerHTML: corrected while running']);
    win.close();
  });

  it('corrects a refused keyword that is surely a slip, and lists the ones that work otherwise', async () => {
    const slip = loadRunner(false);
    slip.win.postMessage({ type: 'execute', id: 'k1', code: 'const i = document.createElement("input");\ni.type = "nubmer";\ndocument.body.append(i);\nwindow.__i = i;' }, '*');
    await wait(30);
    expect(slip.win.__i.type).toBe('number');
    expect(failed(slip.posted)).toBeUndefined();
    expect(notes(slip.posted)).toContain("element.type = 'nubmer' → 'number': corrected while running");
    slip.win.close();
    const other = loadRunner(false);
    other.win.postMessage({ type: 'execute', id: 'k2', code: 'const i = document.createElement("input");\ni.type = "slider";\ndocument.body.append(i);' }, '*');
    await wait(30);
    expect(JSON.stringify(failed(other.posted))).toMatch(/It takes: text, number, range/);
    other.win.close();
  });
});
