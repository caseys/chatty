// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { JavascriptRuntime } from '../src/tools/javascript-runtime.ts';

// three.js is not imported by the app's page: a program that uses THREE gets the bundle as a
// script in its own page (so it goes with that page), and runs after the script has loaded.

type Internals = { ensureIframe(): HTMLIFrameElement; iframeReadyPromise: Promise<void>; executeInIframe(code: string): Promise<unknown> };

const trialFrame = () => document.querySelector<HTMLIFrameElement>('iframe[aria-hidden="true"]')!;
const tokenOf = (frame: HTMLIFrameElement) => /__chattyTrialToken = "([^"]+)"/.exec(frame.srcdoc)?.[1];
const threeScript = (frame: HTMLIFrameElement) => frame.contentDocument!.querySelector<HTMLScriptElement>('script[src*="three-global"]');
const settle = () => new Promise((r) => setTimeout(r, 30));

/** What the frame's page was sent, and when the bundle was in the page, in order */
function watchFrame(frame: HTMLIFrameElement) {
  const events: string[] = [];
  const win = frame.contentWindow!;
  const send = win.postMessage.bind(win);
  win.postMessage = ((message: any, ...rest: any[]) => {
    events.push(`${message?.type}:${threeScript(frame) ? 'with-three' : 'no-three'}`);
    return (send as any)(message, ...rest);
  }) as typeof win.postMessage;
  return events;
}

describe('three.js in the program page', () => {
  it('a trial of a THREE program gets the bundle in its page before the program is sent', async () => {
    const runtime = new JavascriptRuntime();
    const trial = runtime.trialRun('const scene = new THREE.Scene(); scene.add(new THREE.Mesh());', 800);
    await Promise.resolve();
    const frame = trialFrame();
    const events = watchFrame(frame);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'iframe_ready', __trial: tokenOf(frame) }, source: frame.contentWindow as Window }));
    await settle();

    const script = threeScript(frame)!;
    expect(script).toBeTruthy();
    expect(script.type).toBe('module'); // the bundle's own names stay out of the program's scope
    expect(script.parentElement?.ownerDocument).toBe(frame.contentDocument); // in the trial's page, not this one
    expect(document.querySelector('script[src*="three-global"]')).toBeNull();
    expect(events).toEqual([]); // not sent while the bundle is still loading

    script.dispatchEvent(new Event('load'));
    await settle();
    expect(events).toEqual(['execute:with-three']);
    await trial;
    runtime.dispose();
  });

  it('a trial of a program without THREE loads nothing and runs at once', async () => {
    const runtime = new JavascriptRuntime();
    const trial = runtime.trialRun('const x = 1 + 1;', 800);
    await Promise.resolve();
    const frame = trialFrame();
    const events = watchFrame(frame);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'iframe_ready', __trial: tokenOf(frame) }, source: frame.contentWindow as Window }));
    await settle();
    expect(events).toEqual(['execute:no-three']);
    expect(frame.contentDocument!.querySelectorAll('script[src]').length).toBe(0);
    await trial;
    runtime.dispose();
  });

  it('a trial that ended while the bundle loaded sends nothing', async () => {
    const runtime = new JavascriptRuntime();
    const trial = runtime.trialRun('new THREE.Scene()', 800);
    await Promise.resolve();
    const frame = trialFrame();
    const events = watchFrame(frame);
    const token = tokenOf(frame);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'iframe_ready', __trial: token }, source: frame.contentWindow as Window }));
    await settle();
    const script = threeScript(frame)!;
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'program_error', message: 'boom', __trial: token }, source: frame.contentWindow as Window }));
    expect(await trial).toMatchObject({ error: 'boom' });
    script.dispatchEvent(new Event('load'));
    await settle();
    expect(events).toEqual([]);
    runtime.dispose();
  });

  it('the visible run gets the bundle first for THREE, and nothing otherwise', async () => {
    const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 100 });
    const internals = runtime as unknown as Internals;
    const frame = internals.ensureIframe();
    internals.iframeReadyPromise = Promise.resolve();
    const events = watchFrame(frame);

    const plain = internals.executeInIframe('document.body.append("hi")');
    await settle();
    expect(events).toEqual(['execute:no-three']);
    await plain;

    events.length = 0;
    const withThree = internals.executeInIframe('const cube = new THREE.BoxGeometry(1, 1, 1);');
    await settle();
    const script = threeScript(frame)!;
    expect(script).toBeTruthy();
    expect(script.type).toBe('module');
    expect(events).toEqual([]);
    script.dispatchEvent(new Event('load'));
    await settle();
    expect(events).toEqual(['execute:with-three']);
    await withThree;

    // Run again in the same page: it's there already, no second copy
    (frame.contentWindow as any).THREE = {};
    events.length = 0;
    const again = internals.executeInIframe('new THREE.Scene()');
    await settle();
    expect(frame.contentDocument!.querySelectorAll('script[src*="three-global"]').length).toBe(1);
    expect(events).toEqual(['execute:with-three']);
    await again;
    runtime.dispose();
  });

  it('a bundle that fails to load does not stop the program from running', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 100 });
    const internals = runtime as unknown as Internals;
    const frame = internals.ensureIframe();
    internals.iframeReadyPromise = Promise.resolve();
    const events = watchFrame(frame);
    const run = internals.executeInIframe('new THREE.Scene()');
    await settle();
    threeScript(frame)!.dispatchEvent(new Event('error'));
    await settle();
    expect(events).toEqual(['execute:with-three']);
    await run;
    warn.mockRestore();
    runtime.dispose();
  });
});
