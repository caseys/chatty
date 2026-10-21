// Interface sounds: a different note for each event, quiet, one after another, only on a context a
// tap made, and never heard by the speech detector as the start of an utterance
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playInterfaceSound, type InterfaceSound } from '../src/audio/interface-sounds.ts';
import { SharedAudioSubsystem } from '../src/audio/audio-subsystem.ts';

class FakeParam {
  value = 0;
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  onended: (() => void) | null = null;
  connect = vi.fn((node: unknown) => node);
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeContext {
  state: 'suspended' | 'running' = 'running';
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeNode();
  oscillators: FakeNode[] = [];
  gains: FakeNode[] = [];
  onstatechange: (() => void) | null = null;
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  close = vi.fn(async () => {});
  createOscillator() {
    const node = new FakeNode();
    this.oscillators.push(node);
    return node;
  }
  createGain() {
    const node = new FakeNode();
    this.gains.push(node);
    return node;
  }
  createAnalyser() {
    return { fftSize: 0, smoothingTimeConstant: 0, connect: vi.fn(), disconnect: vi.fn() };
  }
}

const SOUNDS: InterfaceSound[] = ['user', 'chat', 'output', 'fix', 'start', 'end', 'tap'];

/** The notes a sound played */
function notesOf(sound: InterfaceSound): number[] {
  const ctx = new FakeContext();
  playInterfaceSound(ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode, sound, 0);
  return ctx.oscillators.map((o) => o.frequency.value);
}

describe('interface sounds', () => {
  it('gives every event its own notes', () => {
    const played = SOUNDS.map((s) => notesOf(s).join(','));
    expect(new Set(played).size).toBe(SOUNDS.length);
    // A fix sounds unlike a program's ordinary output; a start rises and an end falls
    expect(notesOf('fix')).not.toEqual(notesOf('output'));
    const [s1, s2] = notesOf('start');
    const [e1, e2] = notesOf('end');
    expect(s2).toBeGreaterThan(s1);
    expect(e2).toBeLessThan(e1);
  });

  it('stays above the voice and inside what Whistle hears (below 8 kHz, so nothing aliases)', () => {
    for (const sound of SOUNDS) {
      for (const hz of notesOf(sound)) {
        expect(hz).toBeGreaterThan(4000);
        expect(hz).toBeLessThan(8000);
      }
    }
  });

  it('plays quietly and frees its nodes when it ends', () => {
    const ctx = new FakeContext();
    const { next, end } = playInterfaceSound(ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode, 'start', 1);
    expect(next).toBeGreaterThan(1);
    expect(end).toBeGreaterThan(next - 0.1);
    const envelopes = ctx.gains.filter((g) => g.gain.linearRampToValueAtTime.mock.calls.length > 0);
    for (const e of envelopes) expect(e.gain.linearRampToValueAtTime.mock.calls[0][0]).toBeLessThanOrEqual(0.03);
    for (const o of ctx.oscillators) o.onended?.();
    for (const e of envelopes) expect(e.disconnect).toHaveBeenCalled();
  });
});

describe('SharedAudioSubsystem interface sounds', () => {
  let audio: SharedAudioSubsystem;

  beforeEach(() => {
    vi.useFakeTimers();
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    audio = new SharedAudioSubsystem();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('makes no context for a sound (only a tap or a program does)', () => {
    audio.playInterfaceSound('user');
    expect(audio.getAudioContext()).toBeNull();
  });

  it('plays sounds one after another, and drops one that would come long after', async () => {
    const ctx = (await audio.ensureAudioContext()) as unknown as FakeContext;
    audio.playInterfaceSound('user');
    audio.playInterfaceSound('start');
    const starts = ctx.oscillators.map((o) => o.start.mock.calls[0][0] as number);
    expect(Math.min(...starts.slice(1))).toBeGreaterThan(starts[0]);
    const before = ctx.oscillators.length;
    for (let i = 0; i < 20; i++) audio.playInterfaceSound('chat');
    // A backlog of more than a quarter second is dropped
    const latest = Math.max(...ctx.oscillators.map((o) => o.start.mock.calls[0][0] as number));
    expect(latest).toBeLessThanOrEqual(0.4);
    expect(ctx.oscillators.length).toBeLessThan(before + 20);
  });

  it('keeps the speech detector from starting an utterance on a sound, but not from hearing speech already under way', async () => {
    await audio.ensureAudioContext();
    const heard = (frame: Float32Array) =>
      (audio as unknown as { heardByDetector(f: Float32Array): Float32Array }).heardByDetector(frame);
    const loud = new Float32Array(1280).fill(0.3);
    expect(heard(loud)).toBe(loud);
    audio.playInterfaceSound('fix');
    expect(Array.from(heard(loud)).every((v) => v === 0)).toBe(true);
    // The user is already speaking: their words go through
    (audio as unknown as { vad: { isSpeaking: boolean } }).vad.isSpeaking = true;
    expect(heard(loud)).toBe(loud);
    (audio as unknown as { vad: { isSpeaking: boolean } }).vad.isSpeaking = false;
    // Once it has rung out, the mic is heard again
    vi.advanceTimersByTime(1000);
    expect(heard(loud)).toBe(loud);
  });

  it('wakes a sleeping context for a sound', async () => {
    const ctx = (await audio.ensureAudioContext()) as unknown as FakeContext;
    ctx.state = 'suspended';
    audio.playInterfaceSound('chat');
    await vi.waitFor(() => expect(ctx.oscillators.length).toBeGreaterThan(0));
    expect(ctx.resume).toHaveBeenCalled();
  });
});
