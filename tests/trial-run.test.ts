// @vitest-environment jsdom
// @ts-expect-error jsdom ships no type declarations here
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JavascriptRuntime } from '../src/tools/javascript-runtime.ts';

type Internals = { buildRunnerHtml(trial: boolean, host?: string, token?: string): string };

const trialFrames = () => Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[aria-hidden="true"]'));
const tokenOf = (frame: HTMLIFrameElement) => /__chattyTrialToken = "([^"]+)"/.exec(frame.srcdoc)?.[1];
// A message as the frame's page would send it, stamped with the token of the page it came from
const fromPage = (frame: HTMLIFrameElement, data: object) =>
  window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow as Window }));

describe('trialRun', () => {
  it("never reaches the user's storage: a trial gets a copy in memory", async () => {
    const runtime = new JavascriptRuntime();
    const trial = (runtime as unknown as Internals).buildRunnerHtml(true, undefined, 'tok_s');
    let real: Storage | null = null;
    const dom = new JSDOM(trial, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'http://localhost/',
      beforeParse(w: Window) {
        real = w.localStorage;
        real.setItem('saved', 'yes');
      },
    });
    const win = dom.window as unknown as Window & typeof globalThis;
    // What a "Clear all" button in a to-do app does, clicked by a trial
    const seen = win.eval("const before = localStorage.getItem('saved'); localStorage.clear(); localStorage.setItem('x', '1'); [before, localStorage.getItem('x'), localStorage.length]");
    expect(Array.from(seen as unknown[])).toEqual(['yes', '1', 1]);
    expect(real!.getItem('saved')).toBe('yes');
    expect(real!.getItem('x')).toBeNull();
    dom.window.close();
  });

  it('builds the trial page from the same sandbox, with a quiet host', async () => {
    const runtime = new JavascriptRuntime();
    const real = (runtime as unknown as Internals).buildRunnerHtml(false);
    const trial = (runtime as unknown as Internals).buildRunnerHtml(true, undefined, 'tok_1');
    expect(real).toContain('const __chattyHost = window.parent;');
    expect(trial).not.toContain('const __chattyHost = window.parent;');
    expect(trial).toContain('OfflineAudioContext');
    // Same helpers and watchers
    expect(trial.length - real.length).toBeLessThan(3500);

    const posted: unknown[] = [];
    const dom = new JSDOM(trial, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
    const win = dom.window as unknown as Window & typeof globalThis & { speak(t: string): void };
    // The page's parent is itself under jsdom; watch what it sends up
    (win as any).parent.postMessage = (m: unknown) => posted.push(m);
    posted.length = 0;
    win.speak('hi');
    expect((posted[0] as any).type).toBe('speak'); // reaches the host, which a trial ignores
    expect((posted[0] as any).__trial).toBe('tok_1'); // stamped with its trial, so a late one can't pass for the next
    expect((win as any).__chattyTrialToken).toBe('tok_1');
    const access: any = await (win.navigator as any).requestMIDIAccess();
    const output = access.outputs.values().next().value;
    expect(() => output.send([0x90, 60, 100])).not.toThrow();
    win.close();
  });

  it('resolves null, keeps its hidden frame for the next trial and leaves the visible card alone', async () => {
    const runtime = new JavascriptRuntime();
    const before = document.querySelectorAll('iframe').length;
    const p = runtime.trialRun('1 + 1', 50);
    await Promise.resolve();
    expect(document.querySelectorAll('iframe').length).toBe(before + 1);
    const frame = trialFrames()[0];
    expect(frame.style.visibility).toBe('hidden');
    expect(await p).toMatchObject({ error: null });
    // Waiting for the next trial, holding an empty page (the program's is gone)
    expect(trialFrames()).toEqual([frame]);
    expect(frame.srcdoc).toBe('');
    expect(runtime.getActiveIframe()).toBeNull();
    expect(runtime.pageIds()).toEqual([]);
    expect(runtime.standInIds()).toEqual([]);
    runtime.dispose();
    expect(document.querySelectorAll('iframe').length).toBe(before);
  });

  it('guards loops in a test run as in a real run, so a fix with while (true) cannot freeze the app', async () => {
    const runtime = new JavascriptRuntime();
    const p = runtime.trialRun('let n = 0;\nwhile (true) { n++; }', 60);
    await vi.waitFor(() => expect(trialFrames()[0]).toBeDefined());
    const frame = trialFrames()[0];
    const sent: any[] = [];
    const win = frame.contentWindow!;
    const send = win.postMessage.bind(win);
    win.postMessage = ((message: any, ...rest: any[]) => {
      sent.push(message);
      return (send as any)(message, ...rest);
    }) as typeof win.postMessage;
    fromPage(frame, { type: 'iframe_ready', __trial: tokenOf(frame) });
    await vi.waitFor(() => expect(sent.some((m) => m?.type === 'execute')).toBe(true));
    expect(sent.find((m) => m?.type === 'execute').code).toContain('Loop exceeded');
    await p;
    runtime.dispose();
  });

  it('tries the program as it would really run: a const it changes later is a let, an await in a plain function is made async', async () => {
    const runtime = new JavascriptRuntime();
    // The balls Qwen3 0.6B wrote: balls is a const that createBalls() assigns
    const program = 'const balls = [];\nfunction createBalls() {\n  balls = [1, 2];\n}\nfunction load() {\n  const x = await fetch("/a");\n}\ncreateBalls();';
    const p = runtime.trialRun(program, 60);
    await vi.waitFor(() => expect(trialFrames()[0]).toBeDefined());
    const frame = trialFrames()[0];
    const sent: any[] = [];
    const win = frame.contentWindow!;
    const send = win.postMessage.bind(win);
    win.postMessage = ((message: any, ...rest: any[]) => {
      sent.push(message);
      return (send as any)(message, ...rest);
    }) as typeof win.postMessage;
    fromPage(frame, { type: 'iframe_ready', __trial: tokenOf(frame) });
    await vi.waitFor(() => expect(sent.some((m) => m?.type === 'execute')).toBe(true));
    const code = sent.find((m) => m?.type === 'execute').code as string;
    await p;
    runtime.dispose();
    expect(code).toMatch(/let\s+balls = \[\];/);
    expect(code).toContain('async function load()');
  });

  it('runs queued trials one at a time, in order, in one frame', async () => {
    const runtime = new JavascriptRuntime();
    const seen = new Set<Element>();
    let most = 0;
    const watch = setInterval(() => {
      most = Math.max(most, document.querySelectorAll('iframe').length);
      trialFrames().forEach((f) => seen.add(f));
    }, 5);
    const a = runtime.trialRun('1', 30);
    const b = runtime.trialRun('2', 30);
    const c = runtime.trialRun('3', 30);
    expect(await Promise.all([a, b, c])).toMatchObject([{ error: null }, { error: null }, { error: null }]);
    clearInterval(watch);
    expect(most).toBe(1); // never two frames at once
    expect(seen.size).toBe(1); // and the same one each time
    runtime.dispose();
    expect(document.querySelectorAll('iframe').length).toBe(0);
  });

  it('gives each trial a new page and ignores messages stamped for another', async () => {
    const runtime = new JavascriptRuntime();
    const first = runtime.trialRun('1', 40);
    await Promise.resolve();
    const frame = trialFrames()[0];
    const token1 = tokenOf(frame)!;
    expect(token1).toMatch(/^trial_/);
    await first;

    const second = runtime.trialRun('2', 400);
    await Promise.resolve();
    expect(trialFrames()).toEqual([frame]);
    const token2 = tokenOf(frame)!;
    expect(token2).not.toBe(token1);
    let done = false;
    void second.then(() => (done = true));
    // The first trial's page, late: not this trial's error
    fromPage(frame, { type: 'program_error', message: 'from the last trial', __trial: token1 });
    fromPage(frame, { type: 'program_error', message: 'unstamped' });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    fromPage(frame, { type: 'program_error', message: 'boom', line: 3, __trial: token2 });
    expect(await second).toMatchObject({ error: 'boom', errorLine: 3 });
    runtime.dispose();
  });

  describe('the shared frame', () => {
    afterEach(() => vi.useRealTimers());

    it('goes after 10 s idle, and a trial before that keeps it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const runtime = new JavascriptRuntime();
      const p1 = runtime.trialRun('1', 50);
      await vi.advanceTimersByTimeAsync(700);
      await p1;
      const frame = trialFrames()[0];
      expect(frame).toBeDefined();

      await vi.advanceTimersByTimeAsync(9000);
      expect(trialFrames()).toEqual([frame]);
      const p2 = runtime.trialRun('2', 50);
      await vi.advanceTimersByTimeAsync(700);
      await p2;
      expect(trialFrames()).toEqual([frame]); // the same one: its idle time started over
      await vi.advanceTimersByTimeAsync(9000);
      expect(trialFrames()).toEqual([frame]);
      await vi.advanceTimersByTimeAsync(1100);
      expect(trialFrames()).toEqual([]);

      const p3 = runtime.trialRun('3', 50); // after it went: a new one
      await vi.advanceTimersByTimeAsync(700);
      await p3;
      expect(trialFrames().length).toBe(1);
      expect(trialFrames()[0]).not.toBe(frame);
      runtime.dispose();
    });
  });
});
