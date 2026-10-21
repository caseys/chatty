// ============================================================================
// Tone.js on Chatty's audio. A program's page is an iframe, and the audio that iPhone Safari lets
// play is the app's one AudioContext, in the parent page, unlocked by every tap. So Tone has to
// play through a context that belongs to another realm (the parent's), and Tone checks what it is
// given with `instanceof`, against the constructors of the realm it was loaded in (through
// standardized-audio-context). Three steps, in the order tone-global.ts imports them:
//   1. This file, as it evaluates (before 'tone' does): the page's AudioContext,
//      OfflineAudioContext, AudioBuffer and AudioWorkletNode are the parent's, so the constructors
//      Tone keeps for its checks are the ones the parent's objects pass. AudioNode, AudioParam and
//      BaseAudioContext, which Tone looks up again at every check, accept both realms' objects for
//      as long as the page lives.
//   2. tone-context.ts: Tone's global context is made the app's, before Tone's index builds its
//      Transport, Destination and the like on the global context (they keep that one for good).
//   3. tone-global.ts, once 'tone' has evaluated: restoreWindowAudio() gives the page its own
//      constructors back, so a program's raw Web Audio keeps the sandbox's SharedAudioContext.
// ============================================================================

export type Shared = { context: AudioContext; output: AudioNode };
export type Host = { AudioContext?: unknown; AudioWorkletNode?: unknown; __chattySharedAudio?: () => Shared | null };
type AudioGlobals = Record<string, unknown>;

/** The page's host: the app window, a trial's quiet host, or a downloaded program's own */
declare const __chattyHost: unknown;
export function pageHost(): Host | null {
  try {
    if (typeof __chattyHost !== 'undefined' && __chattyHost) return __chattyHost as Host;
  } catch {
    // not defined here
  }
  // A downloaded program: this script comes before the page's own, which names the host
  return (window as unknown as { __chattyStandaloneHost?: Host }).__chattyStandaloneHost ?? null;
}

/** The host's window, when it is another one (the app, for a program's card); null when the host shares this realm */
function otherRealm(host: Host | null): AudioGlobals | null {
  try {
    if (host && (host as unknown) !== window && typeof host.AudioContext === 'function') return host as unknown as AudioGlobals;
  } catch {
    // a parent that can't be read
  }
  return null;
}

// What Tone keeps when it evaluates ...
const KEPT_AT_LOAD = ['AudioContext', 'OfflineAudioContext', 'AudioBuffer', 'AudioWorkletNode'];
// ... and what it reads again at each check
const READ_EACH_TIME = ['AudioNode', 'AudioParam', 'BaseAudioContext'];

const globals = window as unknown as AudioGlobals;
const realm = otherRealm(pageHost());
const lent: Array<[string, PropertyDescriptor | undefined]> = [];
/** The parent's AudioWorkletNode: Tone's worklets (PluckSynth, reverbs) make theirs from the parent's context */
export const hostAudioWorkletNode = realm && typeof realm.AudioWorkletNode === 'function' ? (realm.AudioWorkletNode as new (context: unknown, name: string, options?: unknown) => AudioNode) : null;

/** A constructor that tells both realms' objects apart from the rest (`x instanceof it` is true for either's) */
function eitherRealm(own: Function, theirs: Function): unknown {
  return new Proxy(own, {
    get(target, prop, receiver) {
      if (prop === Symbol.hasInstance) return (value: unknown) => value instanceof own || value instanceof theirs;
      return Reflect.get(target, prop, receiver);
    },
  });
}

function lendHostConstructors(): void {
  if (!realm) return;
  for (const name of KEPT_AT_LOAD) {
    if (typeof realm[name] !== 'function') continue;
    lent.push([name, Object.getOwnPropertyDescriptor(globals, name)]);
    Object.defineProperty(globals, name, { value: realm[name], configurable: true, writable: true });
  }
  for (const name of READ_EACH_TIME) {
    const own = globals[name];
    const theirs = realm[name];
    if (typeof own === 'function' && typeof theirs === 'function') {
      Object.defineProperty(globals, name, { value: eitherRealm(own, theirs), configurable: true, writable: true });
    }
  }
}

// Tone's banner is a console.log, which a program's page speaks aloud
(window as unknown as { TONE_SILENCE_LOGGING?: boolean }).TONE_SILENCE_LOGGING = true;
// Runs as this file evaluates: before 'tone' (tone-global.ts imports this file first)
lendHostConstructors();

/** The page's own audio constructors back (what a program's raw Web Audio goes by) */
export function restoreWindowAudio(): void {
  for (const [name, descriptor] of lent.splice(0)) {
    if (descriptor) Object.defineProperty(globals, name, descriptor);
    else delete globals[name];
  }
}

// The worklet module Tone builds registers its processors by name, and the app's context outlives
// the page: a second program's page registers the same names again, which the spec makes an error
// (Chrome only logs it). The module goes in with a registerProcessor that leaves a taken name alone.
const REGISTER_ONCE =
  '(function(){var g=globalThis;if(!g.__chattyToneRegister){g.__chattyToneRegister=1;var r=g.registerProcessor;g.registerProcessor=function(n,c){try{r.call(g,n,c)}catch(e){}}}})();\n';

export async function addWorkletModule(context: AudioContext, url: string): Promise<void> {
  const source = await (await fetch(url)).text();
  const patched = URL.createObjectURL(new Blob([REGISTER_ONCE + source], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(patched);
  } finally {
    URL.revokeObjectURL(patched);
  }
}

/**
 * The app's context as Tone sees it: the same context, but what Tone sets on it (onstatechange
 * above all, which the app uses itself) stays with Tone, close() and suspend() do nothing (they
 * would stop the app's own audio), and its destination is the program's output node.
 */
export function sharedContextForTone(real: AudioContext, output: AudioNode): AudioContext {
  const local: Record<PropertyKey, unknown> = {};
  return new Proxy(real, {
    get(target, prop) {
      if (prop in local) return local[prop];
      if (prop === 'destination') return output;
      if (prop === 'close' || prop === 'suspend') return () => Promise.resolve();
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(_target, prop, value) {
      local[prop] = value;
      return true;
    },
  });
}
