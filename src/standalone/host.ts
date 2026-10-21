// ============================================================================
// Standalone host: what Chatty's app does for a program's page (sound, MIDI, notes, Wikipedia,
// speech), for a downloaded program running on its own. Bundled into one plain script and
// inlined in the downloaded HTML file (see JavascriptRuntime.standaloneHtml).
// ============================================================================

import { softwareMidiAccess } from '../audio/software-midi.ts';
// Static, so the synth software-midi loads on demand is bundled into this one script too
import 'webaudio-tinysynth';
import { playNotesHelper } from '../tools/music-tool.ts';
import { fetchWikipediaSummary } from '../tools/web-tools.ts';

type Audio = { context: AudioContext; output: GainNode };
let audio: Audio | null = null;

/** One AudioContext for the page, started by the first tap or key press (browsers require one) */
function programAudio(): Audio {
  if (!audio) {
    const Context = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new Context();
    const output = context.createGain();
    output.connect(context.destination);
    audio = { context, output };
  }
  if (audio.context.state !== 'running') void audio.context.resume().catch(() => {});
  return audio;
}

const reply = (callId: string, result: unknown) => window.postMessage({ type: 'async_response', callId, result }, '*');

function speak(text: string): void {
  try {
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch {
    // no speech in this browser
  }
}

(window as unknown as { __chattyStandaloneHost: unknown }).__chattyStandaloneHost = {
  postMessage(message: { type?: string; [key: string]: unknown }) {
    switch (message?.type) {
      case 'speak':
        speak(String(message.text ?? ''));
        break;
      case 'playNotes':
        playNotesHelper(String(message.notes ?? ''), message.tempo as number, undefined, () => programAudio().context).then(
          (result) => reply(String(message.callId), result),
          (err) => reply(String(message.callId), { success: false, error: String(err?.message ?? err) })
        );
        break;
      case 'searchWikipedia':
        fetchWikipediaSummary(String(message.query ?? '')).then(
          (result) => reply(String(message.callId), result),
          (err) => reply(String(message.callId), { success: false, error: String(err?.message ?? err) })
        );
        break;
      case 'program_error':
        console.error(message.message);
        break;
      case 'result':
        if (!message.success) console.error(message.error);
        break;
    }
  },
  __chattySharedAudio: programAudio,
  __chattyMidi: (options: { sysex?: boolean } | undefined, now: () => number) => {
    const { context, output } = programAudio();
    return softwareMidiAccess(context, output, now, options);
  },
  __chattyUnlockAudio: () => {
    if (audio && audio.context.state !== 'running') void audio.context.resume().catch(() => {});
  },
};
