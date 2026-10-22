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

describe("the hint's Web MIDI output line copied wrong", () => {
  it("becomes the hint's own line, keeping the program's name and declaration", async () => {
    const { restoreMidiOutputLine } = await import('../src/core/example-copy.ts');
    const { parsesAsProgram } = await import('../src/core/error-hints.ts');
    // From a live drum-beat run
    const live = 'speak("Playing a drum beat.")\n\noutput = [...]await navigator.requestMIDIAccess().outputs.values()[0];\noutput.send("drums", ["kick"], 400);';
    expect(restoreMidiOutputLine(live, parsesAsProgram)).toEqual({
      code: 'speak("Playing a drum beat.")\n\noutput = [...(await navigator.requestMIDIAccess()).outputs.values()][0];\noutput.send("drums", ["kick"], 400);',
      line: 3,
    });
    expect(restoreMidiOutputLine('const out = [...await navigator.requestMIDIAccess().outputs.values()[0];', parsesAsProgram)?.code).toBe(
      'const out = [...(await navigator.requestMIDIAccess()).outputs.values()][0];'
    );
  });

  it('leaves a program that parses alone, and a broken line that is not the output line', async () => {
    const { restoreMidiOutputLine } = await import('../src/core/example-copy.ts');
    const { parsesAsProgram } = await import('../src/core/error-hints.ts');
    const fine = 'const midi = await navigator.requestMIDIAccess();\nconst output = midi.outputs.values().next().value;';
    expect(restoreMidiOutputLine(fine, parsesAsProgram)).toBeNull();
    expect(restoreMidiOutputLine('const output = [...(await navigator.requestMIDIAccess()).outputs.values()][0];\nlet x = ;', parsesAsProgram)).toBeNull();
  });
});
