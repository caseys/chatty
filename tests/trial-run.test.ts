// @vitest-environment jsdom
// @ts-expect-error jsdom ships no type declarations here
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { JavascriptRuntime } from '../src/tools/javascript-runtime.ts';

type Internals = { buildRunnerHtml(trial: boolean): string };

describe('trialRun', () => {
  it('builds the trial page from the same sandbox, with a quiet host', async () => {
    const runtime = new JavascriptRuntime();
    const real = (runtime as unknown as Internals).buildRunnerHtml(false);
    const trial = (runtime as unknown as Internals).buildRunnerHtml(true);
    expect(real).toContain('const __chattyHost = window.parent;');
    expect(trial).not.toContain('const __chattyHost = window.parent;');
    expect(trial).toContain('OfflineAudioContext');
    // Same helpers and watchers
    expect(trial.length - real.length).toBeLessThan(2500);

    const posted: unknown[] = [];
    const dom = new JSDOM(trial, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
    const win = dom.window as unknown as Window & typeof globalThis & { speak(t: string): void };
    // The page's parent is itself under jsdom; watch what it sends up
    (win as any).parent.postMessage = (m: unknown) => posted.push(m);
    posted.length = 0;
    win.speak('hi');
    expect((posted[0] as any).type).toBe('speak'); // reaches the host, which a trial ignores
    const access: any = await (win.navigator as any).requestMIDIAccess();
    const output = access.outputs.values().next().value;
    expect(() => output.send([0x90, 60, 100])).not.toThrow();
    win.close();
  });

  it('resolves null, removes its frame and leaves the visible card alone', async () => {
    const runtime = new JavascriptRuntime();
    const before = document.querySelectorAll('iframe').length;
    const p = runtime.trialRun('1 + 1', 50);
    await Promise.resolve();
    expect(document.querySelectorAll('iframe').length).toBe(before + 1);
    const frame = document.querySelector('iframe[aria-hidden="true"]') as HTMLIFrameElement;
    expect(frame.style.visibility).toBe('hidden');
    expect(await p).toMatchObject({ error: null });
    expect(document.querySelectorAll('iframe').length).toBe(before);
    expect(runtime.getActiveIframe()).toBeNull();
    expect(runtime.pageIds()).toEqual([]);
    expect(runtime.standInIds()).toEqual([]);
  });

  it('runs queued trials one at a time, in order', async () => {
    const runtime = new JavascriptRuntime();
    let most = 0;
    const watch = setInterval(() => (most = Math.max(most, document.querySelectorAll('iframe').length)), 5);
    const a = runtime.trialRun('1', 30);
    const b = runtime.trialRun('2', 30);
    expect(await Promise.all([a, b])).toMatchObject([{ error: null }, { error: null }]);
    clearInterval(watch);
    expect(most).toBe(1); // never two frames at once
    expect(document.querySelectorAll('iframe').length).toBe(0);
  });
});
