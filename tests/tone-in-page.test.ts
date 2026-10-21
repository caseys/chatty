// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { JavascriptRuntime, detectRecommendedMode } from '../src/tools/javascript-runtime.ts';

// Tone.js is not imported by the app's page: a program that uses Tone gets the bundle as a script
// in its own page (the way three.js does), and runs after the script has loaded.

type Internals = { ensureIframe(): HTMLIFrameElement; iframeReadyPromise: Promise<void>; executeInIframe(code: string): Promise<unknown> };

const trialFrame = () => document.querySelector<HTMLIFrameElement>('iframe[aria-hidden="true"]')!;
const tokenOf = (frame: HTMLIFrameElement) => /__chattyTrialToken = "([^"]+)"/.exec(frame.srcdoc)?.[1];
const toneScript = (frame: HTMLIFrameElement) => frame.contentDocument!.querySelector<HTMLScriptElement>('script[src*="tone-global"]');
const threeScript = (frame: HTMLIFrameElement) => frame.contentDocument!.querySelector<HTMLScriptElement>('script[src*="three-global"]');
const settle = () => new Promise((r) => setTimeout(r, 30));

/** What the frame's page was sent, and which bundles were in the page at the time, in order */
function watchFrame(frame: HTMLIFrameElement) {
  const events: string[] = [];
  const win = frame.contentWindow!;
  const send = win.postMessage.bind(win);
  win.postMessage = ((message: any, ...rest: any[]) => {
    events.push(`${message?.type}:${toneScript(frame) ? 'with-tone' : 'no-tone'}`);
    return (send as any)(message, ...rest);
  }) as typeof win.postMessage;
  return events;
}

describe('Tone.js in the program page', () => {
  it('the visible run gets the bundle before the program is sent, and nothing otherwise', async () => {
    const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 100 });
    const internals = runtime as unknown as Internals;
    const frame = internals.ensureIframe();
    internals.iframeReadyPromise = Promise.resolve();
    const events = watchFrame(frame);

    const plain = internals.executeInIframe('document.body.append("hi")');
    await settle();
    expect(events).toEqual(['execute:no-tone']);
    expect(frame.contentDocument!.querySelectorAll('script[src]').length).toBe(0);
    await plain;

    events.length = 0;
    const music = internals.executeInIframe('const synth = new Tone.PolySynth().toDestination();');
    await settle();
    const script = toneScript(frame)!;
    expect(script).toBeTruthy();
    expect(script.type).toBe('module'); // the bundle's own names stay out of the program's scope
    expect(script.parentElement?.ownerDocument).toBe(frame.contentDocument); // in the program's page, not this one
    expect(document.querySelector('script[src*="tone-global"]')).toBeNull();
    expect(threeScript(frame)).toBeNull(); // only the library the program uses
    expect(events).toEqual([]); // not sent while the bundle is still loading
    script.dispatchEvent(new Event('load'));
    await settle();
    expect(events).toEqual(['execute:with-tone']);
    await music;

    // Run again in the same page: it's there already, no second copy
    (frame.contentWindow as any).Tone = {};
    events.length = 0;
    const again = internals.executeInIframe('Tone.Transport.start();');
    await settle();
    expect(frame.contentDocument!.querySelectorAll('script[src*="tone-global"]').length).toBe(1);
    expect(events).toEqual(['execute:with-tone']);
    await again;
    runtime.dispose();
  });

  it('a program that uses both THREE and Tone gets both bundles first', async () => {
    const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 100 });
    const internals = runtime as unknown as Internals;
    const frame = internals.ensureIframe();
    internals.iframeReadyPromise = Promise.resolve();
    const events = watchFrame(frame);
    const run = internals.executeInIframe('const scene = new THREE.Scene(); const synth = new Tone.Synth();');
    await settle();
    expect(toneScript(frame)).toBeTruthy();
    expect(threeScript(frame)).toBeTruthy();
    toneScript(frame)!.dispatchEvent(new Event('load'));
    await settle();
    expect(events).toEqual([]); // still waiting for three.js
    threeScript(frame)!.dispatchEvent(new Event('load'));
    await settle();
    expect(events).toEqual(['execute:with-tone']);
    await run;
    runtime.dispose();
  });

  it('a trial of a Tone program gets the bundle in its page before the program is sent', async () => {
    const runtime = new JavascriptRuntime();
    const trial = runtime.trialRun('const synth = new Tone.MembraneSynth().toDestination(); synth.triggerAttackRelease("C1", "8n");', 800);
    await Promise.resolve();
    const frame = trialFrame();
    const events = watchFrame(frame);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'iframe_ready', __trial: tokenOf(frame) }, source: frame.contentWindow as Window }));
    await settle();

    const script = toneScript(frame)!;
    expect(script).toBeTruthy();
    expect(script.type).toBe('module');
    expect(script.parentElement?.ownerDocument).toBe(frame.contentDocument);
    expect(events).toEqual([]);
    script.dispatchEvent(new Event('load'));
    await settle();
    expect(events).toEqual(['execute:with-tone']);
    await trial;
    runtime.dispose();
  });

  it('a trial of a program without Tone loads nothing and runs at once', async () => {
    const runtime = new JavascriptRuntime();
    const trial = runtime.trialRun('const tone = "warm"; speak(tone + " welcome");', 800);
    await Promise.resolve();
    const frame = trialFrame();
    const events = watchFrame(frame);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'iframe_ready', __trial: tokenOf(frame) }, source: frame.contentWindow as Window }));
    await settle();
    expect(events).toEqual(['execute:no-tone']);
    expect(frame.contentDocument!.querySelectorAll('script[src]').length).toBe(0);
    await trial;
    runtime.dispose();
  });

  it('a trial that ended while the bundle loaded sends nothing', async () => {
    const runtime = new JavascriptRuntime();
    const trial = runtime.trialRun('Tone.Transport.start()', 800);
    await Promise.resolve();
    const frame = trialFrame();
    const events = watchFrame(frame);
    const token = tokenOf(frame);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'iframe_ready', __trial: token }, source: frame.contentWindow as Window }));
    await settle();
    const script = toneScript(frame)!;
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'program_error', message: 'boom', __trial: token }, source: frame.contentWindow as Window }));
    expect(await trial).toMatchObject({ error: 'boom' });
    script.dispatchEvent(new Event('load'));
    await settle();
    expect(events).toEqual([]);
    runtime.dispose();
  });

  it('a bundle that fails to load does not stop the program from running', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 100 });
    const internals = runtime as unknown as Internals;
    const frame = internals.ensureIframe();
    internals.iframeReadyPromise = Promise.resolve();
    const events = watchFrame(frame);
    const run = internals.executeInIframe('Tone.start()');
    await settle();
    toneScript(frame)!.dispatchEvent(new Event('error'));
    await settle();
    expect(events).toEqual(['execute:with-tone']);
    await run;
    warn.mockRestore();
    runtime.dispose();
  });

  it('the downloaded program carries the bundle too, after the host, only when it uses Tone', async () => {
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      fetched.push(String(url));
      return { text: async () => `/* bundle ${String(url).replace(/.*\//, '')} */` };
    }) as unknown as typeof fetch;
    try {
      for (const [code, tone] of [['Tone.Transport.start();', true], ['speak("hi");', false]] as const) {
        const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 100 });
        Object.assign(runtime, { downloadReady: true, downloadable: { code, timer: null } });
        fetched.length = 0;
        const html = (await runtime.standaloneHtml())!;
        expect(fetched.some((url) => url.includes('tone-global'))).toBe(tone);
        expect(html.includes('tone-global')).toBe(tone);
        if (tone) expect(html.indexOf('host')).toBeLessThan(html.indexOf('tone-global'));
        runtime.dispose();
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('a Tone program runs in the sandbox page', () => {
  it('is sent to the iframe, where Tone is, and not to a worker or eval', () => {
    expect(detectRecommendedMode('const synth = new Tone.Synth().toDestination();\nfor (let i = 0; i < 4; i++) synth.triggerAttackRelease("C4", "8n", i);')).toBe('iframe');
    expect(detectRecommendedMode('Tone.Transport.start();')).toBe('iframe');
    // "tone" the word is not Tone the library
    expect(detectRecommendedMode('return "a warm tone";')).toBe('eval');
  });
});


describe('an import of Tone.js', async () => {
  const { provideThree } = await import('../src/core/error-hints.ts');
  it('reads the ready-made Tone, as an import of three.js reads THREE', () => {
    expect(provideThree("import * as Tone from 'tone';\nconst s = new Tone.Synth();")).toEqual({ code: '\nconst s = new Tone.Synth();', changed: true, provided: ['Tone'] });
    expect(provideThree("import { Synth, Loop as L } from 'tone';").code).toBe('const { Synth, Loop: L } = Tone;');
    expect(provideThree("import * as T from 'three';\nimport * as Tone from 'tone';").provided.sort()).toEqual(['THREE', 'Tone']);
    expect(provideThree("import x from 'lodash';").changed).toBe(false);
  });
});
