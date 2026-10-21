// Tone's global context, set before Tone's index evaluates: that is where Tone builds Tone.Transport,
// Tone.Destination, Tone.Listener and Tone.Draw, on whatever the global context is by then, and
// keeps them (a context set later would leave the program's Transport on another clock and its
// Destination on another output). So this imports Tone's own modules, not the package index.
import { addWorkletModule, hostAudioWorkletNode, pageHost, sharedContextForTone, type Shared } from './tone-realm.ts';
import { Context } from 'tone/build/esm/core/context/Context.js';
import { OfflineContext } from 'tone/build/esm/core/context/OfflineContext.js';
import { setContext } from 'tone/build/esm/core/Global.js';

/**
 * Tone's global context becomes the app's (see sharedContextForTone), so Tone.Destination plays
 * into the program's output and Tone.start() resumes the app's context, which a tap has already
 * unlocked. Asking the host for its audio counts as the program using sound. In a trial (hidden,
 * muted) the host's audio is an OfflineAudioContext that never renders: Tone gets that, so
 * everything a program calls works and nothing plays. Without any host audio, Tone makes its own
 * context, as it would anywhere.
 */
function useChattyAudio(): void {
  let shared: Shared | null = null;
  try {
    shared = pageHost()?.__chattySharedAudio?.() ?? null;
  } catch (err) {
    console.warn('Tone could not get the shared audio:', err);
  }
  if (!shared) return;
  const real = shared.context;
  if (real instanceof (window.OfflineAudioContext ?? Object)) {
    const quiet = new OfflineContext(sharedContextForTone(real, shared.output) as unknown as OfflineAudioContext);
    // No worklet module is loaded (it would start a thread for nothing): those nodes stay silent
    quiet.addAudioWorkletModule = () => new Promise<void>(() => {});
    setContext(quiet);
    return;
  }
  const context = new Context({ context: sharedContextForTone(real, shared.output) });
  let worklets: Promise<void> | null = null;
  context.addAudioWorkletModule = (url: string) => (worklets ??= addWorkletModule(real, url));
  const HostWorkletNode = hostAudioWorkletNode;
  if (HostWorkletNode) {
    // (the worklet node is made by the parent's constructor: it takes the app's real context, not the stand-in)
    context.createAudioWorkletNode = (name: string, options?: Partial<AudioWorkletNodeOptions>) =>
      new HostWorkletNode(real, name, options) as unknown as AudioWorkletNode;
  }
  setContext(context);
}

useChattyAudio();
