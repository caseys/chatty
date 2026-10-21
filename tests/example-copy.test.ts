// A music program that copied the prompt's example (its notes, or "piano" for another instrument)
// fails the outcome check with a fact, even though sound is heard
import { describe, expect, it } from 'vitest';
import { copiedExampleNotes, wrongInstrument } from '../src/core/example-copy.ts';

const output = 'const output = [...(await navigator.requestMIDIAccess()).outputs.values()][0];\n';
// From a live Twinkle run: the fix copied the example, tags removed before running
const copied = `${output}output.send(\n    "piano",\n    [\n        "C4",\n        "E4",\n        "G4",\n        "C5"\n    ],\n    400\n);`;

describe('a copied music example', () => {
  it("names the example's notes when they stand in for the tune", () => {
    expect(copiedExampleNotes(copied, 'Play Twinkle Twinkle Little Star on the piano')).toBe(
      'The program plays the example\'s notes (C4, E4, G4, C5), not the music asked for ("Play Twinkle Twinkle Little Star on the piano"): put the notes of that music in the list, in order.'
    );
    // Flattened into send()'s arguments, as a violin run wrote it
    expect(copiedExampleNotes(`${output}output.send("C4", "E4", "G4", "C5", 400);`, 'Play a violin melody')).not.toBeNull();
  });

  it('leaves the notes alone when the request asks for them, and other notes alone', () => {
    expect(copiedExampleNotes(copied, 'Play a C major arpeggio')).toBeNull();
    expect(copiedExampleNotes(copied, 'Play C4 E4 G4 C5 on the piano')).toBeNull();
    expect(copiedExampleNotes(`${output}output.send("piano", ["C4", "C4", "G4", "G4", "A4", "A4", "G4"], 400);`, 'Play Twinkle Twinkle Little Star on the piano')).toBeNull();
  });

  it('names the instrument the request asks for when the program plays another', () => {
    expect(wrongInstrument(copied, 'Play a violin melody')).toBe('The request asks for violin, but the program plays "piano": the first value of output.send() is the instrument.');
    expect(wrongInstrument(copied, 'Play a drum beat')).toBe('The request asks for drums, but the program plays "piano": the first value of output.send() is the instrument.');
  });

  it('leaves the instrument alone when it matches, when the request names none, or for raw bytes', () => {
    expect(wrongInstrument(copied, 'Play Twinkle Twinkle Little Star on the piano')).toBeNull();
    expect(wrongInstrument(copied, 'Play a happy song')).toBeNull();
    expect(wrongInstrument(`${output}output.send("electric guitar", ["E2", "A2"], 300);`, 'Play an electric guitar riff')).toBeNull();
    expect(wrongInstrument(`${output}output.send([0x90, 60, 100]);`, 'Play a violin note')).toBeNull();
  });
});
