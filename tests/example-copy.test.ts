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

describe("the example's empty list of notes, copied as it is", () => {
  it('says the list is empty, with drum sounds for a drum request', async () => {
    const { emptyExampleNotes } = await import('../src/core/example-copy.ts');
    // From a live drum-beat run
    const live = 'const output = [...(await navigator.requestMIDIAccess()).outputs.values()][0];\nconst notes = [/* the music\'s notes, like "C4" */];\noutput.send("piano", notes, 400);';
    expect(emptyExampleNotes(live, 'Play a drum beat')).toBe(
      'The list of notes is empty (the example\'s placeholder), so nothing plays: fill it with the notes of "Play a drum beat", in order, as drum sounds ("kick", "snare", "hihat") with "drums" as the instrument.'
    );
    expect(emptyExampleNotes(live, 'Play a lullaby')).toContain('(note names like "C4")');
    expect(emptyExampleNotes(live.replace('[/* the music\'s notes, like "C4" */]', '["C4", "D4"]'), 'Play a lullaby')).toBeNull();
  });
});

describe('round 24: drums', () => {
  it('reads a note name on drums as its General MIDI drum, and an inline empty list as empty', async () => {
    const { noteNumber } = await import('../src/audio/software-midi.ts');
    const { emptyExampleNotes } = await import('../src/core/example-copy.ts');
    expect(noteNumber('C4', true)).toBe(60);
    expect(noteNumber('kick', true)).toBe(36);
    // From a live drum-beat run: the list written empty right in send()
    expect(emptyExampleNotes('output.send("piano", [], 400);', 'Play a drum beat')).toContain('The list of notes is empty');
  });
});

describe('the instrument held in a variable', () => {
  it('is read from where the program sets it', async () => {
    const { wrongInstrument } = await import('../src/core/example-copy.ts');
    const code = 'const instrument = "violin";\nconst notes = ["C4", "D4"];\noutput.send(instrument, notes, 400);';
    expect(wrongInstrument(code, 'Play a short song on the flute')).toBe('The request asks for flute, but the program plays "violin": the first value of output.send() is the instrument.');
    expect(wrongInstrument(code, 'Play a violin melody')).toBeNull();
  });
});

describe('the one instrument the request names', () => {
  it('replaces another instrument where it is written, in send() or in the name passed to it', async () => {
    const { useRequestedInstrument } = await import('../src/core/example-copy.ts');
    expect(useRequestedInstrument('const instrument = "violin";\noutput.send(instrument, notes, 400);', 'Play a short song on the flute')).toEqual({
      code: 'const instrument = "flute";\noutput.send(instrument, notes, 400);',
      from: 'violin',
      to: 'flute',
    });
    // A made-up name copied from the hint's comment (a live run)
    expect(useRequestedInstrument('const instrument = "General MIDI Instrument Library";\noutput.send(instrument, notes, 400);', 'Play Twinkle Twinkle Little Star on the piano')?.code).toBe(
      'const instrument = "piano";\noutput.send(instrument, notes, 400);'
    );
    expect(useRequestedInstrument('output.send("piano", ["kick"], 400);', 'Play a drum beat')?.code).toBe('output.send("drums", ["kick"], 400);');
  });

  it('leaves it alone with no single answer: none named, two named, two played, or the right one', async () => {
    const { useRequestedInstrument } = await import('../src/core/example-copy.ts');
    const one = 'output.send("violin", notes, 400);';
    expect(useRequestedInstrument(one, 'Play Happy Birthday')).toBeNull();
    expect(useRequestedInstrument(one, 'Play a duet for piano and flute')).toBeNull();
    expect(useRequestedInstrument('output.send("piano", a, 400);\noutput.send("drums", b, 400);', 'Play a song on the guitar')).toBeNull();
    expect(useRequestedInstrument(one, 'Play a violin melody')).toBeNull();
    expect(useRequestedInstrument('output.send("electric guitar", n, 300);', 'Play an electric guitar riff')).toBeNull();
  });
});
