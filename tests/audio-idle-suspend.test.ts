// The shared AudioContext sleeps after AUDIO_IDLE_SUSPEND_MS with nothing using it, and wakes on next use
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_IDLE_SUSPEND_MS, SharedAudioSubsystem } from '../src/audio/audio-subsystem.ts';

class FakeSource {
  onended: (() => void) | null = null;
  buffer: unknown = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  finish(): void {
    this.onended?.();
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  onstatechange: (() => void) | null = null;
  sources: FakeSource[] = [];
  resume = vi.fn(async () => this.setState('running'));
  suspend = vi.fn(async () => this.setState('suspended'));
  close = vi.fn(async () => this.setState('closed'));
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  private setState(state: FakeAudioContext['state']): void {
    this.state = state;
    this.onstatechange?.();
  }
  createAnalyser() {
    return { fftSize: 0, smoothingTimeConstant: 0, connect: vi.fn(), disconnect: vi.fn() };
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
}

const IDLE = AUDIO_IDLE_SUSPEND_MS;
const lastContext = () => FakeAudioContext.instances[FakeAudioContext.instances.length - 1];

describe('AudioContext idle suspend', () => {
  let audio: SharedAudioSubsystem;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudioContext.instances = [];
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    audio = new SharedAudioSubsystem();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('suspends after the idle time with nothing in use, not before', async () => {
    await audio.ensureAudioContext();
    const ctx = lastContext();
    expect(ctx.state).toBe('running');
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(ctx.suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe('suspended');
  });

  it('never suspends while the host says the audio is in use', async () => {
    audio.setAudioInUse(true);
    await audio.ensureAudioContext();
    const ctx = lastContext();
    await vi.advanceTimersByTimeAsync(IDLE * 10);
    expect(ctx.suspend).not.toHaveBeenCalled();
  });

  it('cancels the pending suspend when activity starts and counts the idle time from when it ends', async () => {
    await audio.ensureAudioContext();
    const ctx = lastContext();
    await vi.advanceTimersByTimeAsync(IDLE - 1000);
    audio.setAudioInUse(true);
    await vi.advanceTimersByTimeAsync(IDLE * 2);
    expect(ctx.suspend).not.toHaveBeenCalled();
    audio.setAudioInUse(false);
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(ctx.suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
  });

  it('stays awake while Chatty speaks, and sleeps after the last chunk ends', async () => {
    const playing = audio.schedulePcmPlayback(new Float32Array(2205), 22050);
    await vi.advanceTimersByTimeAsync(0);
    const ctx = lastContext();
    expect(ctx.sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(IDLE * 3);
    expect(ctx.suspend).not.toHaveBeenCalled();
    ctx.sources[0].finish();
    await playing;
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(ctx.suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
  });

  it('stopping playback starts the idle clock', async () => {
    void audio.schedulePcmPlayback(new Float32Array(2205), 22050);
    await vi.advanceTimersByTimeAsync(0);
    const ctx = lastContext();
    audio.stopAllPlaybackImmediately();
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
  });

  it('resumes a sleeping context before playing', async () => {
    await audio.ensureAudioContext();
    const ctx = lastContext();
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(ctx.state).toBe('suspended');
    ctx.resume.mockClear();
    void audio.schedulePcmPlayback(new Float32Array(2205), 22050);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe('running');
    expect(ctx.sources[0].start).toHaveBeenCalled();
  });

  it('wakes in a tap and sleeps again afterwards', async () => {
    await audio.ensureAudioContext();
    const ctx = lastContext();
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(ctx.state).toBe('suspended');
    audio.unlockInGesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.state).toBe('running');
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(ctx.suspend).toHaveBeenCalledTimes(2);
  });

  it('an ensureAudioContext that lands while the suspend is on its way still ends up running', async () => {
    await audio.ensureAudioContext();
    const ctx = lastContext();
    let finish!: () => void;
    ctx.suspend.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            ctx.state = 'suspended';
            resolve();
          };
        })
    );
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(ctx.state).toBe('running');
    const woken = audio.ensureAudioContext();
    finish();
    await woken;
    expect(ctx.state).toBe('running');
  });

  it('holdAudio keeps a context awake for the length of a tune', async () => {
    audio.holdAudio(IDLE * 4);
    await audio.ensureAudioContext();
    const ctx = lastContext();
    await vi.advanceTimersByTimeAsync(IDLE * 4 - 1);
    expect(ctx.suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
  });

  it('coming back to the page does not wake a context that went idle', async () => {
    await audio.ensureAudioContext();
    const ctx = lastContext();
    await vi.advanceTimersByTimeAsync(IDLE);
    ctx.resume.mockClear();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(ctx.state).toBe('suspended');
  });
});
