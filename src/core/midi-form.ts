/**
 * How a program plays notes through Chatty's Web MIDI: the plain form the software output takes (audio/software-midi.ts),
 * taught by one example line. The music rule, the outcome messages and the facts about an output all point at that same
 * line, so what the model is told before it writes and after it fails agree.
 */

/** Getting the output: the first of the access's outputs (a Map) */
export const MIDI_OUTPUT = 'const output = [...(await navigator.requestMIDIAccess()).outputs.values()][0]';

/** The notes the example once showed (a program that plays them copied it: example-copy.ts) */
export const MIDI_EXAMPLE_NOTES = ['C4', 'E4', 'G4', 'C5'];

/** The example's list of notes: empty, for the model to fill with the music asked for (shown notes were copied) */
export const MIDI_NOTES_LINE = 'const notes = []; // the music\'s notes in order, like "C4" (for drums: "kick", "snare", "hihat")';

/**
 * The example track, as the music rule shows it: the instrument and the notes left empty, each with what goes
 * in it. In testing (Qwen3 0.6B, six music requests twice) this played on the first try 10 times in 12, where
 * the example with "piano" written in and an empty list did 0 in 6; the instrument it copies from the comment
 * is corrected to the one the request names (example-copy.ts useRequestedInstrument).
 */
export const MIDI_EXAMPLE_LINES = `const instrument = ""; // the General MIDI instrument asked for, like "violin", "bass" or "drums"
${MIDI_NOTES_LINE}
output.send(instrument, notes, 400); // 400 is each note's length in ms`;

/** The example's call, on its own */
export const MIDI_EXAMPLE = 'output.send(instrument, notes, 400)';

/** What the example's call does, as a sentence that follows "then" */
export const MIDI_PLAIN_FORM = `${MIDI_EXAMPLE} plays the notes one after another (instrument: the General MIDI name asked for, like "violin", "bass" or "drums"; notes: their names in order, like "C4", or "kick", "snare" and "hihat" for drums; 400 is each note's length in ms)`;

/** The music rule of the prompt */
export const MIDI_RULE = `- For music, this browser has a General MIDI software instrument library, available through Web MIDI. One track plays like this:
\`\`\`js
${MIDI_OUTPUT};
${MIDI_EXAMPLE_LINES}
\`\`\`
The notes play one after another.`;
