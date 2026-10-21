/**
 * How a program plays notes through Chatty's Web MIDI: the plain form the software output takes (audio/software-midi.ts),
 * taught by one example line. The music rule, the outcome messages and the facts about an output all point at that same
 * line, so what the model is told before it writes and after it fails agree.
 */

/** Getting the output: the first of the access's outputs (a Map) */
export const MIDI_OUTPUT = 'const output = [...(await navigator.requestMIDIAccess()).outputs.values()][0]';

/** The example track */
export const MIDI_EXAMPLE = 'output.send("piano", ["C4", "E4", "G4", "C5"], 400)';

/** What the example line does, as a sentence that follows "then" */
export const MIDI_PLAIN_FORM = `${MIDI_EXAMPLE} plays those notes one after another (the instrument can be any General MIDI name, such as "violin", "bass", or "drums" with "kick", "snare" and "hihat"; 400 is each note's length in ms)`;

/** The music rule of the prompt */
export const MIDI_RULE = `- For music, this browser has a General MIDI software instrument library, available through Web MIDI. One track plays like this:
\`\`\`js
${MIDI_OUTPUT};
${MIDI_EXAMPLE};
\`\`\`
The instrument can be any General MIDI name ("violin", "bass", or "drums" with "kick", "snare" and "hihat"), the notes play one after another, and 400 is each note's length in ms.`;
