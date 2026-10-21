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

describe('errors from browser calls', () => {
  it('name a library object by the library’s export, not its bundle’s shortened class name', async () => {
    const { win, posted } = loadRunner(false);
    // The bundle's Tone.PolySynth is a class called Cu; the program's own class keeps its name
    win.eval('window.Tone = { PolySynth: class Cu {} }; window.Ball = class Ball {};');
    win.postMessage({ type: 'execute', id: 'n1', code: 'const list = document.createElement("ul");\ndocument.body.append(list);\nlist.appendChild(new Tone.PolySynth());' }, '*');
    await wait(30);
    expect(JSON.stringify(posted.find((m) => m.type === 'program_error' || (m.type === 'result' && m.error)))).toMatch(/appendChild\(a Tone\.PolySynth\) failed: /);
    win.postMessage({ type: 'execute', id: 'n2', code: 'document.body.querySelector("ul").appendChild(new Ball());' }, '*');
    await wait(30);
    expect(JSON.stringify(posted.filter((m) => m.type === 'program_error' || (m.type === 'result' && m.error)).at(-1))).toMatch(/appendChild\(a Ball\) failed: /);
    win.close();
  });

  it('say what the call was given', async () => {
    const { win, posted } = loadRunner(false);
    win.postMessage({ type: 'execute', id: 'x1', code: 'const list = document.createElement("ul");\ndocument.body.append(list);\nlist.appendChild("Buy milk");' }, '*');
    await wait(30);
    const error = posted.find((m) => m.type === 'program_error' || (m.type === 'result' && m.error));
    expect(JSON.stringify(error)).toMatch(/appendChild\(a string 'Buy milk'\) failed: /);
    win.close();
  });
});

describe('the timers a stuck screen may still be waiting for', () => {
  it('counts a timer or interval of a second or more, not a frame loop or a fast interval, and drops each when it ends', async () => {
    const { win } = loadRunner(false);
    win.postMessage(
      {
        type: 'execute',
        id: 's1',
        code: [
          'let frames = 0;',
          'function loop() { frames++; requestAnimationFrame(loop); }',
          'loop();',
          'window.__fast = setInterval(() => {}, 50);',
          'window.__quick = setTimeout(() => {}, 300);',
          'window.__slow = setTimeout(() => {}, 4000);',
          'window.__tick = setInterval(() => {}, 1000);',
        ].join('\n'),
      },
      '*'
    );
    await wait(30);
    // (the page's own timers: the slow timeout and the one-second interval)
    expect(win.__chattySlowWork()).toBe(2);
    win.clearTimeout(win.__slow);
    expect(win.__chattySlowWork()).toBe(1);
    win.clearInterval(win.__tick);
    expect(win.__chattySlowWork()).toBe(0);
    win.close();
  });

  it('is what the host calls scheduled work: a frame loop alone is not', async () => {
    const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 100 });
    expect(runtime.hasScheduledWork()).toBe(false);
    const frame = (runtime as unknown as { ensureIframe(): HTMLIFrameElement }).ensureIframe();
    (frame.contentWindow as any).__chattySlowWork = () => 0;
    expect(runtime.hasScheduledWork()).toBe(false);
    (frame.contentWindow as any).__chattySlowWork = () => 1;
    expect(runtime.hasScheduledWork()).toBe(true);
    runtime.dispose();
  });
});

describe('a program that keeps adding elements however it does it', () => {
  const growing = (code: string) => async () => {
    // (a low limit, to keep the test short: the real one is 20,000 elements)
    const runtime = new JavascriptRuntime();
    const html = (runtime as unknown as Internals).buildRunnerHtml(false, undefined, 'tok');
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/', beforeParse: (w: any) => (w.__chattyMaxLive = 300) });
    const win: any = dom.window;
    const posted: any[] = [];
    win.addEventListener('message', (e: MessageEvent) => posted.push(e.data));
    win.postMessage({ type: 'execute', id: 'g1', code }, '*');
    const told = () => posted.filter((m) => m.type === 'program_error' && /keeps adding more/.test(m.message));
    // The watcher counts twice a second and stops a count that has grown four times above the limit
    await vi.waitFor(() => expect(told().length).toBeGreaterThan(0), { timeout: 9000, interval: 100 });
    const first = win.document.getElementsByTagName('*').length;
    await wait(700);
    // Stopped: nothing more is added, and it is told once
    expect(win.document.getElementsByTagName('*').length).toBe(first);
    expect(told().length).toBe(1);
    win.close();
  };

  it('is stopped when it grows through insertAdjacentHTML in a timer', growing('setInterval(() => { document.body.insertAdjacentHTML("beforeend", "<i></i>".repeat(100)); }, 100);'), 15000);

  it('is stopped when it grows through cloneNode in an animation frame loop', growing('const seed = document.createElement("div");\nfunction loop() { for (let i = 0; i < 10; i++) document.body.appendChild(seed.cloneNode(true)); requestAnimationFrame(loop); }\nloop();'), 15000);

  it('leaves a program that stays under the limit alone', async () => {
    const runtime = new JavascriptRuntime();
    const html = (runtime as unknown as Internals).buildRunnerHtml(false, undefined, 'tok');
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/', beforeParse: (w: any) => (w.__chattyMaxLive = 300) });
    const win: any = dom.window;
    const posted: any[] = [];
    win.addEventListener('message', (e: MessageEvent) => posted.push(e.data));
    // A particle system that takes away what it made
    win.postMessage({ type: 'execute', id: 'q1', code: 'setInterval(() => { document.body.querySelectorAll("i").forEach((el) => el.remove()); document.body.insertAdjacentHTML("beforeend", "<i></i>".repeat(250)); }, 50);' }, '*');
    await wait(2800);
    expect(posted.some((m) => /keeps adding more/.test(String(m.message ?? '')))).toBe(false);
    win.close();
  }, 10000);
});

describe('a loop that ran too long', () => {
  it('ends the program’s frames and timers with it, so the next frame does not stop the page again', async () => {
    const { win, posted } = loadRunner(false);
    // The guard in every loop throws this after 1.5 seconds; the frame asked for its next frame first
    win.postMessage(
      {
        type: 'execute',
        id: 'lp1',
        code: 'window.__frames = 0; window.__ticks = 0;\nsetInterval(() => { window.__ticks++; }, 20);\nfunction frame() { window.__frames++; requestAnimationFrame(frame); throw new Error("Loop exceeded 1500ms — possible infinite loop"); }\nrequestAnimationFrame(frame);',
      },
      '*'
    );
    await wait(150);
    const frames = win.__frames;
    const ticks = win.__ticks;
    expect(frames).toBe(1);
    await wait(150);
    // Nothing runs any more: no more frames, no more ticks
    expect(win.__frames).toBe(frames);
    expect(win.__ticks).toBe(ticks);
    expect(posted.some((m) => m.type === 'program_error' && /Loop exceeded/.test(m.message))).toBe(true);
    win.close();
  });

  it('does the same when the program’s first run throws it, and leaves another error’s timers alone', async () => {
    const first = loadRunner(false);
    first.win.postMessage({ type: 'execute', id: 'lp2', code: 'window.__n = 0;\nsetInterval(() => { window.__n++; }, 20);\nthrow new Error("Loop exceeded 1500ms — possible infinite loop");' }, '*');
    await wait(120);
    const n = first.win.__n;
    await wait(120);
    expect(first.win.__n).toBe(n);
    first.win.close();
    // An ordinary error does not stop the program's other work
    const other = loadRunner(false);
    other.win.postMessage({ type: 'execute', id: 'lp3', code: 'window.__n = 0;\nsetInterval(() => { window.__n++; }, 20);\nthrow new Error("boom");' }, '*');
    await wait(100);
    const m = other.win.__n;
    await wait(120);
    expect(other.win.__n).toBeGreaterThan(m);
    other.win.close();
  });
});

describe('a program that keeps allocating memory', () => {
  it('is stopped (frames and timers) and told once when its memory grows past the limit, where the browser says', async () => {
    const runtime = new JavascriptRuntime();
    const html = (runtime as unknown as Internals).buildRunnerHtml(false, undefined, 'tok');
    let used = 50e6;
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'http://localhost/',
      beforeParse: (w: any) => {
        w.__chattyMaxHeap = 100e6;
        Object.defineProperty(w.performance, 'memory', { get: () => ({ usedJSHeapSize: used }) });
      },
    });
    const win: any = dom.window;
    const posted: any[] = [];
    win.addEventListener('message', (e: MessageEvent) => posted.push(e.data));
    win.postMessage({ type: 'execute', id: 'm1', code: 'window.__n = 0;\nfunction frame() { window.__n++; requestAnimationFrame(frame); }\nframe();' }, '*');
    await wait(200);
    // Within the limit: the program goes on
    used = 120e6;
    await wait(700);
    expect(posted.some((m) => /MB of memory/.test(String(m.message ?? '')))).toBe(false);
    used = 400e6;
    await vi.waitFor(() => expect(posted.filter((m) => /MB of memory/.test(String(m.message ?? ''))).length).toBe(1), { timeout: 3000, interval: 100 });
    const n = win.__n;
    await wait(200);
    expect(win.__n).toBe(n);
    expect(posted.find((m) => /MB of memory/.test(String(m.message ?? ''))).message).toMatch(/^The program has taken 3\d\d MB of memory since it started/);
    win.close();
  }, 10000);

  it('does nothing where the browser does not say how much memory is used', async () => {
    const { win, posted } = loadRunner(false);
    win.postMessage({ type: 'execute', id: 'm2', code: 'window.__n = 0;\nfunction frame() { window.__n++; requestAnimationFrame(frame); }\nframe();' }, '*');
    await wait(900);
    expect(posted.some((m) => /MB of memory/.test(String(m.message ?? '')))).toBe(false);
    const n = win.__n;
    await wait(150);
    expect(win.__n).toBeGreaterThan(n);
    win.close();
  });
});
