// ============================================================================
// Interface sounds: a short, quiet chime for each thing that happens in a chat, each its own
// note, so a turn can be followed by ear: the user's message, the model's reply, a program's
// output, a fix, and a program starting and ending.
// ============================================================================

export type InterfaceSound = 'user' | 'chat' | 'output' | 'fix' | 'start' | 'end';

/**
 * Each sound's notes (Hz), one after another, all in the eighth octave: above the voice (speech
 * carries most of its energy below about 4 kHz, where the speech detector and Whistle listen
 * hardest) and below 8 kHz, the top of what Whistle hears, so nothing folds back down when the
 * mic is resampled for it. Messages are one note each; the fix is the one note off the major
 * pentatonic the others share (E flat); a program's start rises and its end falls.
 */
const NOTES: Record<InterfaceSound, readonly number[]> = {
  user: [5274.04], // E8
  chat: [7040.0], // A8
  output: [4186.01], // C8
  fix: [4978.03], // E♭8
  start: [4186.01, 6271.93], // C8 → G8
  end: [6271.93, 4186.01], // G8 → C8
};

/** Peak level: quiet (the ear is keenest up here, so it needn't be loud to be heard) */
const VOLUME = 0.025;
/** From one note's start to the next one's (the sound after it waits as long) */
const NOTE_STEP_S = 0.1;
/** How long a note rings */
const NOTE_LENGTH_S = 0.22;

/**
 * Plays `sound` on `ctx` from `at` (context time): pure sines, struck and fading (an overtone
 * would land above 8 kHz). Returns when the next sound may start and when this one has died away.
 */
export function playInterfaceSound(
  ctx: BaseAudioContext,
  destination: AudioNode,
  sound: InterfaceSound,
  at: number
): { next: number; end: number } {
  const notes = NOTES[sound];
  notes.forEach((hz, i) => {
    const t = at + i * NOTE_STEP_S;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, t);
    envelope.gain.linearRampToValueAtTime(VOLUME, t + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + NOTE_LENGTH_S);
    envelope.connect(destination);
    const osc = ctx.createOscillator();
    osc.frequency.value = hz;
    osc.connect(envelope);
    osc.onended = () => {
      osc.disconnect();
      envelope.disconnect();
    };
    osc.start(t);
    osc.stop(t + NOTE_LENGTH_S + 0.02);
  });
  const last = at + (notes.length - 1) * NOTE_STEP_S;
  return { next: last + NOTE_STEP_S, end: last + NOTE_LENGTH_S };
}
