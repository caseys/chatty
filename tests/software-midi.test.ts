import { describe, expect, it, vi } from 'vitest';
import { parseMidiMessages, SoftwareMIDIAccess, SoftwareMIDIOutput } from '../src/audio/software-midi.ts';

describe('forgiving MIDI messages', () => {
  it('reads correct messages as they are', () => {
    expect(parseMidiMessages([0x90, 60, 100, 0x80, 60, 0])).toEqual([
      [0x90, 60, 100],
      [0x80, 60, 0],
    ]);
  });

  it('fixes the mistakes small models make instead of throwing', () => {
    // A program change written like a note (3 bytes) is the note it was meant to be
    expect(parseMidiMessages([0xc1, 60, 100])).toEqual([[0x91, 60, 100]]);
    expect(parseMidiMessages([0xc0, 33])).toEqual([[0xc0, 33]]);
    // Bare channel number for drums
    expect(parseMidiMessages([9, 36, 100])).toEqual([[0x99, 36, 100]]);
    // Missing velocity
    expect(parseMidiMessages([0x90, 60])).toEqual([[0x90, 60, 100]]);
    expect(parseMidiMessages([0x80, 60])).toEqual([[0x80, 60, 0]]);
    // SysEx and stray bytes are skipped
    expect(parseMidiMessages([0xf0, 1, 2, 0xf7, 0x90, 64, 90])).toEqual([[0x90, 64, 90]]);
    expect(parseMidiMessages([200.4, 300, -1])).toEqual([]);
  });
});

describe('friendly MIDI messages', () => {
  const setup = () => {
    const sent: number[][] = [];
    let clock = 1000;
    const output = new SoftwareMIDIOutput({
      synth: { send: (message: number[]) => sent.push(message), setAudioContext() {}, setTsMode() {}, reset() {} },
      now: () => clock,
      resumeFromCurrentCall() {},
    });
    return { sent, output, advance: (ms: number) => { clock += ms; vi.advanceTimersByTime(ms); } };
  };

  it('plays a chord by name on its own channel and stops it after the duration', () => {
    vi.useFakeTimers();
    const { sent, output, advance } = setup();
    output.send(['piano', ['G3', 'B3', 'D4'], 90, 500]);
    expect(sent).toEqual([[0xc0, 0], [0x90, 55, 90], [0x90, 59, 90], [0x90, 62, 90]]);
    advance(500);
    expect(sent.slice(4)).toEqual([[0x80, 55, 0], [0x80, 59, 0], [0x80, 62, 0]]);
    vi.useRealTimers();
  });

  it('gives each instrument a channel, drums channel 9, and reads note names in raw bytes', () => {
    const { sent, output } = setup();
    output.send(['piano', 'C4']);
    output.send(['bass', 'Bb1', 100]);
    output.send(['drums', 'hi-hat', 60]);
    output.send([0x90, 'C#4', 80]);
    output.send([0x99, 'snare', 70]);
    expect(sent).toEqual([
      [0xc0, 0], [0x90, 60, 100],
      [0xc1, 33], [0x91, 34, 100],
      [0x99, 42, 60],
      [0x90, 61, 80],
      [0x99, 38, 70],
    ]);
  });
});

describe('note, chord and scale names', () => {
  const play = (data: unknown) => {
    const sent: number[][] = [];
    const output = new SoftwareMIDIOutput({
      synth: { send: (message: number[]) => sent.push(message), setAudioContext() {}, setTsMode() {}, reset() {} },
      now: () => 0,
      resumeFromCurrentCall() {},
    });
    output.send(data as never);
    return sent.filter((m) => (m[0] & 0xf0) === 0x90).map((m) => m[1]);
  };

  it('reads chord names, flats and bare digits as chords', () => {
    expect(play(['piano', 'G major'])).toEqual([55, 59, 62]);
    expect(play(['piano', 'Am7'])).toEqual([57, 60, 64, 67]);
    expect(play(['piano', 'Bbm'])).toEqual([58, 61, 65]);
    expect(play(['piano', 'E7 chord'])).toEqual([52, 56, 59, 62]);
    expect(play(['piano', 'G4'])).toEqual([67]);
  });

  it('keeps bass in range and reads drum words', () => {
    expect(play(['bass', 'C4'])).toEqual([48]);
    expect(play(['bass', 'E'])).toEqual([40]);
    expect(play(['drums', ['boom', 'chuck', 'hat']])).toEqual([36, 38, 42]);
  });

  it('accepts the object form and loose instrument names', () => {
    expect(play({ instrument: 'string', notes: 'C major' })).toEqual([48, 52, 55]);
  });
});

describe('overlapping loops', () => {
  it('skips a note already starting at the same moment', () => {
    const sent: number[][] = [];
    const output = new SoftwareMIDIOutput({
      synth: { send: (message: number[]) => sent.push(message), setAudioContext() {}, setTsMode() {}, reset() {} },
      now: () => 0,
      resumeFromCurrentCall() {},
    });
    output.send(['drums', 'kick', 100]);
    output.send(['drums', 'kick', 100]);
    output.send(['drums', 'snare', 100]);
    expect(sent.filter((m) => m[0] === 0x99).map((m) => m[1])).toEqual([36, 38]);
  });
});

describe('instrument names', () => {
  it('prefers the exact name over a longer one that starts the same', () => {
    const sent: number[][] = [];
    const output = new SoftwareMIDIOutput({
      synth: { send: (message: number[]) => sent.push(message), setAudioContext() {}, setTsMode() {}, reset() {} },
      now: () => 0,
      resumeFromCurrentCall() {},
    });
    output.send(['synth', 'C4']);
    output.send(['synth bass', 'C2']);
    output.send(['acoustic grand piano', 'C4']);
    expect(sent.filter((m) => (m[0] & 0xf0) === 0xc0).map((m) => m[1])).toEqual([80, 38, 0]);
  });
});

describe('arguments out of place', () => {
  it('finds the notes after a word that is not one, and the duration after them', () => {
    vi.useFakeTimers();
    const sent: number[][] = [];
    let clock = 0;
    const output = new SoftwareMIDIOutput({
      synth: { send: (message: number[]) => sent.push(message), setAudioContext() {}, setTsMode() {}, reset() {} },
      now: () => clock,
      resumeFromCurrentCall() {},
    });
    output.send(['bass', 'walking', 'G', 375]);
    expect(sent.slice(1)).toEqual([[0x90, 43, 100]]);
    clock = 375;
    vi.advanceTimersByTime(375);
    expect(sent.slice(2)).toEqual([[0x80, 43, 0]]);
    vi.useRealTimers();
  });
});

describe('invented method names', () => {
  it('plays with play() and playNote() as with send()', () => {
    const sent: number[][] = [];
    const output = new SoftwareMIDIOutput({
      synth: { send: (message: number[]) => sent.push(message), setAudioContext() {}, setTsMode() {}, reset() {} },
      now: () => 0,
      resumeFromCurrentCall() {},
    });
    output.play(['piano', 'C4']);
    output.playNote(['piano', 'E4']);
    expect(sent.filter((m) => (m[0] & 0xf0) === 0x90).map((m) => m[1])).toEqual([60, 64]);
  });
});

describe('finding the synth output', () => {
  it('finds the one output however a program looks it up', () => {
    const output = new SoftwareMIDIOutput({
      synth: { send() {}, setAudioContext() {}, setTsMode() {}, reset() {} },
      now: () => 0,
      resumeFromCurrentCall() {},
    });
    const access = new SoftwareMIDIAccess(output);
    expect(access.outputs.values().next().value).toBe(output);
    expect(access.outputs.get('AudioOut')).toBe(output);
    expect((access.outputs as unknown as SoftwareMIDIOutput[])[0]).toBe(output);
    expect(access.outputs.size).toBe(1);
  });
});
