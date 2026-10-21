import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { midiSummary, resetMidiSummary, SoftwareMIDIOutput } from '../src/audio/software-midi.ts';
import { ConversationOrchestrator } from '../src/core/orchestrator.ts';
import { JavascriptRuntime } from '../src/tools/javascript-runtime.ts';

// A software output on a fake synth: nothing is ever played
const output = (now = 5000) =>
  new SoftwareMIDIOutput({
    synth: { send() {}, setAudioContext() {}, setTsMode() {}, reset() {} },
    now: () => now,
    resumeFromCurrentCall() {},
  });

beforeEach(() => resetMidiSummary());

describe('what a program sent as MIDI, by the spec', () => {
  it.each([
    ['a note-off', [0x83, 60, 0], '[0x83, 60, 0] is a note-off'],
    ['a note-off with a release velocity', [0x80, 60, 64], '[0x80, 60, 64] is a note-off'],
    ['a note-on with velocity 0 (which means note-off)', [0x90, 60, 0], '[0x90, 60, 0] is a note-on with velocity 0, which means note-off'],
    ['aftertouch ([0x90 + 19] is 0xA3)', [0x90 + 19, 60, 0], '[0xA3, 60, 0] is polyphonic aftertouch'],
    ['a control change', [0xb0, 7, 100], '[0xB0, 7, 100] is a control change'],
    ['a program change', [0xc0, 5], '[0xC0, 5] is a program change'],
    ['a program change with an extra byte', [0xc0 + 9, 36, 0], '[0xC9, 36, 0] is a program change with an extra byte'],
    ['channel pressure', [0xd2, 80], '[0xD2, 80] is channel pressure (aftertouch)'],
    ['a pitch bend', [0xe0, 0, 64], '[0xE0, 0, 64] is a pitch bend'],
    ['a system message', [0xf8], '[0xF8] is a system message (timing clock)'],
    ['an undefined system message', [0xf4], '[0xF4] is a system message (undefined)'],
    ['system exclusive', [0xf0, 1, 2, 0xf7], '[0xF0, 1, 2, 0xF7] is a system message (system exclusive, which is not supported here)'],
    ['a data byte where a status byte belongs', [60, 100], '[60, 100] starts with a data byte where a status byte belongs'],
    ['a message missing its data bytes', [0xb0], '[0xB0] is a control change missing its data bytes'],
  ])('names %s', (_kind, bytes, meaning) => {
    output().send(bytes);
    expect(midiSummary()).toEqual({ noteOns: 0, sent: 1, others: [meaning] });
  });

  it('counts a note-on with a velocity above 0, however it was written', () => {
    const out = output();
    out.send([0x90, 60, 100]);
    out.send([0x99, 36, 1]);
    // Repaired into a note-on that sounds: a program change with a note and a velocity
    out.send([0xc1, 60, 100]);
    // A note-on without its velocity plays at 100
    out.send([0x90, 62]);
    out.send('piano', 'C4', 500);
    expect(midiSummary()).toMatchObject({ noteOns: 5, others: [] });
  });

  it('keeps one entry for repeats and the first few kinds', () => {
    const out = output();
    for (let i = 0; i < 5; i++) out.send([0xa3, 60, 0]);
    expect(midiSummary()).toEqual({ noteOns: 0, sent: 5, others: ['[0xA3, 60, 0] is polyphonic aftertouch'] });
    for (const channel of [1, 2, 3, 4, 5, 6]) out.send([0x80 + channel, 60, 0]);
    const { others, sent } = midiSummary();
    expect(sent).toBe(11);
    expect(others).toHaveLength(4);
    expect(others[0]).toContain('aftertouch');
  });

  it('describes the friendly form by what it sent, too', () => {
    // A velocity of 0 starts nothing
    output().send('piano', 'C4', 0, 500, 0);
    expect(midiSummary().noteOns).toBe(0);
    expect(midiSummary().others[0]).toMatch(/^\[0x90, 60, 0\] is a note-on with velocity 0/);
  });

  it('counts only the program\'s own messages, and does not flag a send time in the past', () => {
    const out = output(5000);
    // The instrument's own program change and note-off are not the program's messages
    out.send('piano', 'C4', 100, 500, 1000);
    expect(midiSummary()).toEqual({ noteOns: 1, sent: 1, others: [] });
    // A time already gone plays now: not a problem
    out.send([0x90, 64, 100], 4500);
    expect(midiSummary()).toEqual({ noteOns: 2, sent: 2, others: [] });
    out.send([0xa3, 64, 0], 100);
    expect(midiSummary().others).toEqual(['[0xA3, 64, 0] is polyphonic aftertouch']);
  });

  it('starts over with each program run', () => {
    output().send([0xa3, 60, 0]);
    expect(midiSummary().sent).toBe(1);
    resetMidiSummary();
    expect(midiSummary()).toEqual({ noteOns: 0, sent: 0, others: [] });
    // The copy it hands out is not the tally itself
    midiSummary().others.push('x');
    expect(midiSummary().others).toEqual([]);
  });

  it('is reset by the runtime when a program run starts, and read through midiSummary()', async () => {
    const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 20 });
    const internals = runtime as unknown as { ensureIframe(): unknown; iframeReadyPromise: Promise<void>; activeIframe: unknown };
    const frame = { contentWindow: { postMessage() {} } };
    internals.ensureIframe = () => (internals.activeIframe = frame);
    internals.iframeReadyPromise = Promise.resolve();

    output().send([0xa3, 60, 0]);
    expect(runtime.midiSummary().sent).toBe(1);
    await (runtime as unknown as { executeInIframe(code: string): Promise<unknown> }).executeInIframe('1 + 1');
    expect(runtime.midiSummary()).toEqual({ noteOns: 0, sent: 0, others: [] });
  });
});

describe('the run log when MIDI was silent', () => {
  const soundCheck = async (send: () => void) => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const runtime = new JavascriptRuntime({ mode: 'iframe', onRunLog: (_kind, text) => logs.push(text) });
      // A context that hears nothing
      const context = { state: 'running', sampleRate: 48000, createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData() {} }) };
      const node = { connect() {}, disconnect() {} };
      send();
      (runtime as unknown as { reportProgramSoundLevel(c: unknown, o: unknown): void }).reportProgramSoundLevel(context, node);
      await vi.advanceTimersByTimeAsync(2500);
      return logs;
    } finally {
      vi.useRealTimers();
    }
  };

  it('says what the messages were when no note-on above 0 was sent', async () => {
    const logs = await soundCheck(() => {
      const out = output();
      out.send([0x90 + 19, 60, 0]);
      out.send([0xc0 + 9, 36, 0]);
      out.send([0x80, 60, 0]);
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('no MIDI note-on above velocity 0 was sent');
    expect(logs[0]).toContain('[0xA3, 60, 0] is polyphonic aftertouch; [0xC9, 36, 0] is a program change with an extra byte; [0x80, 60, 0] is a note-off');
  });

  it('keeps the old line when notes were started, or no MIDI was used', async () => {
    const started = await soundCheck(() => output().send([0x90, 60, 100]));
    expect(started[0]).toContain('notes were sent, but nothing reached the speakers');
    const none = await soundCheck(() => {});
    expect(none[0]).toContain('notes were sent, but nothing reached the speakers');
  });
});

describe('the fix for silence', () => {
  const outcome = (runtime: object) =>
    (ConversationOrchestrator.prototype as any).missingOutcome.call({ javascriptRuntime: runtime }, 'Play a G major chord', { uses: 0, heard: 0, silent: 0 }, '') as Promise<string | null>;
  const silent = { soundUseCount: () => 1, hasVisualContent: () => false, soundHeardCount: () => 0, soundSilentCount: () => 1 };

  it('explains MIDI when no note-on above 0 was sent', async () => {
    const message = await outcome({
      ...silent,
      midiSummary: () => ({ noteOns: 0, sent: 3, others: ['[0xA3, 60, 0] is polyphonic aftertouch', '[0xC9, 36, 0] is a program change with an extra byte'] }),
    });
    expect(message).toBe(
      'No note was started: every MIDI message was something else ([0xA3, 60, 0] is polyphonic aftertouch; [0xC9, 36, 0] is a program change with an extra byte). ' +
        'A note starts with output.send([0x90 + channel, note, velocity]) where channel is 0 to 15 and velocity 1 to 127, and ends with 0x80 + channel.'
    );
    expect(message).not.toContain('destination');
  });

  it('keeps the audio context advice for Web Audio silence, and when notes were started', async () => {
    const advice = 'never reached the speakers';
    expect(await outcome({ ...silent, midiSummary: () => ({ noteOns: 0, sent: 0, others: [] }) })).toContain(advice);
    expect(await outcome({ ...silent, midiSummary: () => ({ noteOns: 2, sent: 2, others: [] }) })).toContain(advice);
    // A runtime that does not tally MIDI
    expect(await outcome(silent)).toContain(advice);
  });

  it('keeps "played nothing" and the heard case as they were', async () => {
    const midi = { midiSummary: () => ({ noteOns: 0, sent: 3, others: ['[0xA3, 60, 0] is polyphonic aftertouch'] }) };
    expect(await outcome({ soundUseCount: () => 0, hasVisualContent: () => false, ...midi })).toContain('played nothing');
    expect(await outcome({ ...silent, soundHeardCount: () => 1, soundSilentCount: () => 0, ...midi })).toBeNull();
  });
});
