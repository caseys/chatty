// ============================================================================
// Shared Audio Subsystem: Microphone Capture, Resampling, VAD, & Gapless Playback
// (Spec Sections 3.1, 3.4, 5)
// ============================================================================

import { playInterfaceSound, type InterfaceSound } from './interface-sounds.ts';

export interface VadConfig {
  rmsThreshold: number;
  speechOnsetFrames: number;
  silenceHangoverFrames: number;
  maxUtteranceDurationMs: number;
}

export type AudioSessionType = 'play-and-record' | 'playback' | 'auto';

export interface AudioSubsystemEvents {
  onSpeechStarted?: () => void;
  onSpeechEnded?: (utteranceSamples16k: Float32Array, durationMs: number) => void;
  onAudioChunk16k?: (chunk16k: Float32Array, rms: number, isSpeaking: boolean) => void;
  onInputLevel?: (rms: number, isSpeaking: boolean) => void;
  onOutputLevel?: (rms: number) => void;
  onPlaybackEnded?: () => void;
  onAudioInterrupted?: () => void;
  onAudioResumed?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Linear interpolation resampler to convert arbitrary browser AudioContext sampleRate
 * (e.g., 44100 Hz or 48000 Hz) into 16000 Hz mono Float32 PCM required by Whistle STT.
 */
export function resampleTo16kHzMono(inputSamples: Float32Array, inputSampleRate: number): Float32Array {
  const targetRate = 16000;
  if (inputSampleRate === targetRate || inputSamples.length === 0) {
    return new Float32Array(inputSamples);
  }

  const ratio = inputSampleRate / targetRate;
  const outputLength = Math.max(1, Math.round(inputSamples.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, inputSamples.length - 1);
    const frac = srcPos - idx0;
    output[i] = inputSamples[idx0] * (1 - frac) + inputSamples[idx1] * frac;
  }

  return output;
}

export function computeRmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}

/**
 * Deterministic Energy + Zero-Crossing Rate Voice Activity Detector (VAD)
 */
export class VoiceActivityDetector {
  private readonly config: VadConfig;
  private isSpeaking = false;
  private activeSpeechFrames = 0;
  private silenceFrames = 0;
  private utteranceChunks: Float32Array[] = [];
  private utteranceSamplesCount = 0;
  private utteranceStartTime = 0;

  constructor(config?: Partial<VadConfig>) {
    this.config = {
      rmsThreshold: config?.rmsThreshold ?? 0.018,
      speechOnsetFrames: config?.speechOnsetFrames ?? 2,
      silenceHangoverFrames: config?.silenceHangoverFrames ?? 10, // ~800ms at 1280 samples/frame
      maxUtteranceDurationMs: config?.maxUtteranceDurationMs ?? 28_000, // Whistle max 30s limit
    };
  }

  processFrame16k(
    samples16k: Float32Array,
    nowMs = performance.now()
  ): {
    rms: number;
    event: 'none' | 'speech_started' | 'speech_continuing' | 'speech_ended';
    completedUtterance?: Float32Array;
    durationMs?: number;
  } {
    const rms = computeRmsLevel(samples16k);
    const isVoiceFrame = rms >= this.config.rmsThreshold;

    if (!this.isSpeaking) {
      if (isVoiceFrame) {
        this.activeSpeechFrames++;
        this.utteranceChunks.push(new Float32Array(samples16k));
        this.utteranceSamplesCount += samples16k.length;

        if (this.activeSpeechFrames >= this.config.speechOnsetFrames) {
          this.isSpeaking = true;
          this.silenceFrames = 0;
          this.utteranceStartTime = nowMs;
          return { rms, event: 'speech_started' };
        }
      } else {
        this.activeSpeechFrames = 0;
        this.utteranceChunks = [];
        this.utteranceSamplesCount = 0;
      }
      return { rms, event: 'none' };
    }

    // Currently speaking
    this.utteranceChunks.push(new Float32Array(samples16k));
    this.utteranceSamplesCount += samples16k.length;

    const elapsedMs = nowMs - this.utteranceStartTime;

    if (isVoiceFrame) {
      this.silenceFrames = 0;
    } else {
      this.silenceFrames++;
    }

    if (
      this.silenceFrames >= this.config.silenceHangoverFrames ||
      elapsedMs >= this.config.maxUtteranceDurationMs
    ) {
      const completed = this.flushUtterance();
      return {
        rms,
        event: 'speech_ended',
        completedUtterance: completed,
        durationMs: Math.max(100, elapsedMs),
      };
    }

    return { rms, event: 'speech_continuing' };
  }

  flushUtterance(): Float32Array {
    const merged = new Float32Array(this.utteranceSamplesCount);
    let offset = 0;
    for (const chunk of this.utteranceChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.reset();
    return merged;
  }

  reset(): void {
    this.isSpeaking = false;
    this.activeSpeechFrames = 0;
    this.silenceFrames = 0;
    this.utteranceChunks = [];
    this.utteranceSamplesCount = 0;
    this.utteranceStartTime = 0;
  }

  get speaking(): boolean {
    return this.isSpeaking;
  }
}

/** A running context keeps the audio hardware awake, which drains a phone: it sleeps after this long unused */
export const AUDIO_IDLE_SUSPEND_MS = 30_000;

export class SharedAudioSubsystem {
  private audioCtx: AudioContext | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private suspendInFlight: Promise<void> | null = null;
  // Set when the idle timer suspended the context: the foreground and route handlers leave it asleep
  private suspendedForIdle = false;
  /** The host's say-so that something outside this class needs the audio (mic, Chatty's voice, a program) */
  private audioInUse = false;
  private holdUntil = 0;
  // Created before the mic was ever opened (typed input, a program): rebuilt once capture starts
  private contextPredatesCapture = false;
  private audioListenersInstalled = false;
  private outputAnalyser: AnalyserNode | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sessionType: AudioSessionType = 'play-and-record';
  /** Zero-gain output for the mic processor: it must be pulled by the graph to run, but nothing it outputs may reach the speakers */
  private processorSink: GainNode | null = null;
  private vad: VoiceActivityDetector;
  private events: AudioSubsystemEvents;

  private activeSources = new Set<AudioBufferSourceNode>();
  private playbackResolvers = new Map<AudioBufferSourceNode, () => void>();
  private pendingMicStart: Promise<void> | null = null;
  private micStopRequested = false;
  private nextScheduledPlayTime = 0;
  private isCapturing = false;
  private latestInputSamples = new Float32Array(128);
  private outputTimeDomainBuffer = new Float32Array(128);
  private sessionChunks: Float32Array[] = [];
  private sessionSamplesCount = 0;
  // Interface sounds play one after another (from nextSoundAt, context time); while one rings
  // (until soundHeardUntil, performance.now() time) the mic can't start an utterance
  private nextSoundAt = 0;
  private soundHeardUntil = 0;

  constructor(events?: AudioSubsystemEvents, vadConfig?: Partial<VadConfig>) {
    this.events = events ?? {};
    this.vad = new VoiceActivityDetector(vadConfig);
  }

  /** The app's audio context if it exists yet (unlocked by the first mic tap). */
  getAudioContext(): AudioContext | null {
    return this.audioCtx;
  }

  /**
   * iOS/WebKit audio session: 'play-and-record' when the mic may be used (speech on). Speech off:
   * 'auto' while nothing plays ('playback' then would put a player on the lock screen), and
   * 'playback' while a program makes sound (speaker output, not muted by the silent switch).
   */
  setAudioSessionType(type: AudioSessionType): void {
    this.sessionType = type;
    this.configureAudioSession();
  }

  /** Applies the session type (before mic or context). Only a real change is written: each one reconfigures the session. */
  private configureAudioSession(): void {
    if (typeof navigator !== 'undefined' && 'audioSession' in navigator) {
      const session = (navigator as any).audioSession;
      if (session.type === this.sessionType) return;
      try {
        session.type = this.sessionType;
      } catch (err) {
        console.debug(`[AudioSubsystem] audioSession.type ${this.sessionType} not supported or failed:`, err);
      }
    }
  }

  /** The host tells whether anything outside this class needs the audio now; the idle clock runs while nothing does. */
  setAudioInUse(inUse: boolean): void {
    if (this.audioInUse === inUse) return;
    this.audioInUse = inUse;
    this.updateIdleSuspend();
  }

  /**
   * Keeps the context awake at least `ms` from now. For sound scheduled ahead on the audio clock
   * that nothing reports on (the play_music tool and playNotes): a long tune must not be paused
   * mid-song.
   */
  holdAudio(ms: number): void {
    this.holdUntil = Math.max(this.holdUntil, Date.now() + ms);
    this.updateIdleSuspend();
  }

  private audioBusy(): boolean {
    return (
      this.audioInUse ||
      this.isCapturing ||
      this.pendingMicStart !== null ||
      this.activeSources.size > 0
    );
  }

  /** Restarts the idle clock (or stops it while the audio is busy); when it runs out the context is suspended. */
  private updateIdleSuspend(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const ctx = this.audioCtx;
    if (!ctx || ctx.state !== 'running' || this.audioBusy()) return;
    const wait = Math.max(AUDIO_IDLE_SUSPEND_MS, this.holdUntil - Date.now());
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.audioCtx !== ctx || ctx.state !== 'running') return;
      // Every start of activity cancels this timer, so this only guards a missed one
      if (this.audioBusy()) return;
      console.debug('[AudioSubsystem] Audio idle: suspending the AudioContext');
      this.suspendedForIdle = true;
      const suspending = ctx
        .suspend()
        .catch(() => {
          this.suspendedForIdle = false;
        })
        .finally(() => {
          if (this.suspendInFlight === suspending) this.suspendInFlight = null;
        });
      this.suspendInFlight = suspending;
    }, wait);
  }

  /** Closes the shared context so the next ensureAudioContext() makes a fresh one. */
  private async replaceAudioContext(): Promise<void> {
    const old = this.audioCtx;
    if (!old) return;
    this.stopAllPlaybackImmediately();
    this.audioCtx = null;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.suspendedForIdle = false;
    this.outputAnalyser = null;
    this.nextScheduledPlayTime = 0;
    await old.close().catch(() => {});
  }

  private gestureSoundPlayed = false;

  /**
   * Called inside a tap, click or key press: creates or resumes the AudioContext there, and the
   * first time starts a silent one-frame sound in the gesture too, which Safari (iPhone above all)
   * needs before it lets later sound out of a running context
   */
  unlockInGesture(): void {
    // A suspend on its way counts as not running: resume in this gesture once it lands
    const running = this.audioCtx?.state === 'running' && !this.suspendInFlight;
    if (!running) void this.ensureAudioContext().catch(() => {});
    const context = this.audioCtx;
    if (!context || this.gestureSoundPlayed) return;
    try {
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, context.sampleRate);
      source.connect(context.destination);
      source.start(0);
      this.gestureSoundPlayed = true;
    } catch {
      // A later gesture tries again
    }
  }

  async ensureAudioContext(): Promise<AudioContext> {
    // 1. Configure iOS/WebKit AudioSession category for simultaneous full-duplex mic & speaker
    this.configureAudioSession();

    if (!this.audioCtx) {
      const AudioContextCtor =
        (typeof window !== 'undefined' &&
          (window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)) ||
        (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
      if (!AudioContextCtor) {
        return null as unknown as AudioContext;
      }
      // 2. "balanced": a larger output buffer than the default "interactive", steadier on a busy
      // phone (Piper and the LLM share the CPU/GPU); mic response is set by the processor's block size
      this.audioCtx = new AudioContextCtor({
        latencyHint: 'balanced',
      });
      this.contextPredatesCapture = !this.mediaStream;

      // 3. Monitor audio hardware state transitions and mobile interruptions
      this.audioCtx.onstatechange = () => {
        const state = this.audioCtx?.state as string;
        console.debug('[AudioSubsystem] AudioContext state changed:', state);
        if (state === 'interrupted') {
          this.events.onAudioInterrupted?.();
        } else if (state === 'running') {
          this.suspendedForIdle = false;
          this.events.onAudioResumed?.();
          // Woken by something (a tap, a program): asleep again after the idle time
          this.updateIdleSuspend();
        }
      };

      // 4. Handle mobile device route changes (e.g. connecting / disconnecting AirPods/Bluetooth headsets)
      // (listeners use whichever context is current, so they're installed once)
      const installListeners = !this.audioListenersInstalled;
      this.audioListenersInstalled = true;
      if (installListeners && typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', async () => {
          console.debug('[AudioSubsystem] Audio devices changed (Bluetooth / headset route switch)');
          if (
            this.audioCtx &&
            !(this.suspendedForIdle && this.audioCtx.state === 'suspended') &&
            (this.audioCtx.state === 'suspended' || (this.audioCtx.state as string) === 'interrupted')
          ) {
            await this.audioCtx.resume().catch(() => {});
          }
        });
      }

      // 5. Handle app foregrounding on mobile (Safari/Chrome suspend AudioContext on screen lock/background)
      if (installListeners && typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', async () => {
          if (!document.hidden && this.audioCtx) {
            if (
              !(this.suspendedForIdle && this.audioCtx.state === 'suspended') &&
              (this.audioCtx.state === 'suspended' || (this.audioCtx.state as string) === 'interrupted')
            ) {
              await this.audioCtx.resume().catch(() => {});
            }
          }
        });
      }
    }

    // An idle suspend still landing finishes first, so this resume is the last word
    if (this.suspendInFlight) await this.suspendInFlight;
    if (this.audioCtx.state === 'suspended' || (this.audioCtx.state as string) === 'interrupted') {
      await this.audioCtx.resume();
    }
    this.suspendedForIdle = false;
    this.updateIdleSuspend();
    if (!this.outputAnalyser && typeof this.audioCtx.createAnalyser === 'function') {
      this.outputAnalyser = this.audioCtx.createAnalyser();
      this.outputAnalyser.fftSize = 256;
      this.outputAnalyser.smoothingTimeConstant = 0.75;
      this.outputAnalyser.connect(this.audioCtx.destination);
      this.outputTimeDomainBuffer = new Float32Array(this.outputAnalyser.fftSize);
    }
    return this.audioCtx;
  }

  /**
   * Copies the latest normalized microphone waveform samples into `target` and returns the current RMS.
   */
  getInputWaveformData(target: Float32Array): number {
    if (!this.isCapturing) {
      target.fill(0);
      return 0;
    }
    const len = target.length;
    const src = this.latestInputSamples;
    for (let i = 0; i < len; i++) {
      const idx = Math.min(src.length - 1, Math.floor((i * src.length) / len));
      target[i] = src[idx] ?? 0;
    }
    return computeRmsLevel(target);
  }

  /**
   * Copies the live speaker playback waveform samples from the Web Audio AnalyserNode into `target`
   * and returns the instantaneous output RMS.
   */
  getOutputWaveformData(target: Float32Array): number {
    if (this.activeSources.size === 0 || !this.outputAnalyser) {
      target.fill(0);
      return 0;
    }
    this.outputAnalyser.getFloatTimeDomainData(this.outputTimeDomainBuffer);
    const len = target.length;
    const src = this.outputTimeDomainBuffer;
    for (let i = 0; i < len; i++) {
      const idx = Math.min(src.length - 1, Math.floor((i * src.length) / len));
      target[i] = src[idx] ?? 0;
    }
    const rms = computeRmsLevel(target);
    this.events.onOutputLevel?.(rms);
    return rms;
  }

  async startMicrophoneCapture(): Promise<void> {
    if (this.isCapturing) return;
    if (this.pendingMicStart) return this.pendingMicStart;
    this.micStopRequested = false;
    this.pendingMicStart = this.doStartMicrophoneCapture().finally(() => {
      this.pendingMicStart = null;
    });
    return this.pendingMicStart;
  }

  private async doStartMicrophoneCapture(): Promise<void> {
    // Mic first, then the shared audio context, on every device. On iOS, opening the mic switches
    // the audio session to voice processing (echo cancellation, often a new sample rate), and a
    // context created before that can play silently. The mic, Whistle, Piper and programs all
    // reuse one context.
    this.configureAudioSession();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    if (this.micStopRequested) {
      // Stop was requested while the permission prompt / device open was pending.
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.mediaStream = stream;
    // Same on every device: a context from before the mic opened is rebuilt once, then reused
    if (this.audioCtx && this.contextPredatesCapture) await this.replaceAudioContext();
    const ctx = await this.ensureAudioContext();

    // Track mute/unmute/ended handlers for mobile phone calls and OS interruptions
    const audioTrack = this.mediaStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.onmute = () => {
        console.warn('[AudioSubsystem] Microphone track muted by system (phone call or Siri)');
        this.events.onInputLevel?.(0, false);
      };
      audioTrack.onunmute = () => {
        console.info('[AudioSubsystem] Microphone track unmuted');
      };
      audioTrack.onended = () => {
        console.warn('[AudioSubsystem] Microphone track ended (permission revoked or device unplugged)');
        this.stopMicrophoneCapture();
      };
    }

    this.sourceNode = ctx.createMediaStreamSource(this.mediaStream);
    // Use 4096 buffer size (~85ms at 48kHz) for responsive VAD & resampling
    this.processorNode = ctx.createScriptProcessor(4096, 1, 1);
    this.vad.reset();
    this.sessionChunks = [];
    this.sessionSamplesCount = 0;

    this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this.isCapturing) return;
      const inputData = event.inputBuffer.getChannelData(0);
      const step = Math.max(1, Math.floor(inputData.length / this.latestInputSamples.length));
      for (let i = 0; i < this.latestInputSamples.length; i++) {
        this.latestInputSamples[i] = inputData[Math.min(inputData.length - 1, i * step)] ?? 0;
      }

      const resampled16k = resampleTo16kHzMono(inputData, ctx.sampleRate);
      // Keep up to 28s of session audio in case user clicks Stop manually before VAD hangover
      if (this.sessionSamplesCount + resampled16k.length <= 16000 * 28) {
        this.sessionChunks.push(new Float32Array(resampled16k));
        this.sessionSamplesCount += resampled16k.length;
      }

      const vadOutcome = this.vad.processFrame16k(this.heardByDetector(resampled16k), performance.now());

      this.events.onInputLevel?.(vadOutcome.rms, this.vad.speaking);
      this.events.onAudioChunk16k?.(resampled16k, vadOutcome.rms, this.vad.speaking);

      if (vadOutcome.event === 'speech_started') {
        this.events.onSpeechStarted?.();
      } else if (vadOutcome.event === 'speech_ended' && vadOutcome.completedUtterance) {
        this.sessionChunks = [];
        this.sessionSamplesCount = 0;
        this.events.onSpeechEnded?.(vadOutcome.completedUtterance, vadOutcome.durationMs ?? 0);
      }
    };

    this.sourceNode.connect(this.processorNode);
    this.processorSink = ctx.createGain();
    this.processorSink.gain.value = 0;
    this.processorNode.connect(this.processorSink).connect(ctx.destination);
    this.isCapturing = true;
    this.updateIdleSuspend();
  }

  /** What the browser actually applied to the mic (iOS can quietly ignore a requested setting). */
  getMicrophoneSettings(): { echoCancellation?: boolean; noiseSuppression?: boolean; sampleRate?: number; contextRate?: number } | null {
    const track = this.mediaStream?.getAudioTracks()[0];
    if (!track) return null;
    const settings = track.getSettings?.() ?? {};
    return {
      // Newer browsers may report "all" or "remote-only" instead of true
      echoCancellation: settings.echoCancellation === undefined ? undefined : settings.echoCancellation !== false,
      noiseSuppression: settings.noiseSuppression,
      sampleRate: settings.sampleRate,
      contextRate: this.audioCtx?.sampleRate,
    };
  }

  stopMicrophoneCapture(): Float32Array | null {
    if (!this.isCapturing) {
      if (this.pendingMicStart) this.micStopRequested = true;
      return null;
    }
    this.isCapturing = false;
    this.latestInputSamples.fill(0);

    let remainingUtterance: Float32Array | null = null;
    if (this.vad.speaking) {
      remainingUtterance = this.vad.flushUtterance();
    } else if (this.sessionSamplesCount > 1600) {
      remainingUtterance = new Float32Array(this.sessionSamplesCount);
      let offset = 0;
      for (const chunk of this.sessionChunks) {
        remainingUtterance.set(chunk, offset);
        offset += chunk.length;
      }
      this.vad.reset();
    } else {
      this.vad.reset();
    }
    this.sessionChunks = [];
    this.sessionSamplesCount = 0;

    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
    }
    this.processorSink?.disconnect();
    this.processorSink = null;
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    this.events.onInputLevel?.(0, false);
    this.updateIdleSuspend();
    return remainingUtterance;
  }

  /**
   * Schedules PCM Float32 samples for gapless playback on the shared AudioContext.
   * Returns a Promise that resolves when the chunk finishes playing or is interrupted.
   */
  async schedulePcmPlayback(samples: Float32Array, sampleRate = 22050): Promise<void> {
    if (samples.length === 0) return;

    const ctx = await this.ensureAudioContext();
    const audioBuffer = ctx.createBuffer(1, samples.length, sampleRate);
    audioBuffer.getChannelData(0).set(samples);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    if (this.outputAnalyser) {
      source.connect(this.outputAnalyser);
    } else {
      source.connect(ctx.destination);
    }

    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.01, this.nextScheduledPlayTime);
    this.nextScheduledPlayTime = startAt + audioBuffer.duration;

    this.activeSources.add(source);
    this.updateIdleSuspend();
    const rms = computeRmsLevel(samples);
    this.events.onOutputLevel?.(rms);

    return new Promise<void>((resolveRaw) => {
      let settled = false;
      const resolve = () => {
        if (settled) return;
        settled = true;
        this.playbackResolvers.delete(source);
        resolveRaw();
      };
      this.playbackResolvers.set(source, resolve);
      source.onended = () => {
        this.activeSources.delete(source);
        if (this.activeSources.size === 0) {
          this.outputTimeDomainBuffer.fill(0);
          this.events.onOutputLevel?.(0);
          this.events.onPlaybackEnded?.();
          this.updateIdleSuspend();
        }
        resolve();
      };
      try {
        source.start(startAt);
      } catch {
        this.activeSources.delete(source);
        resolve();
      }
    });
  }

  /**
   * What the speech detector hears of a mic frame. An interface sound can't start an utterance
   * (Whistle would write the chime down as words): while one rings it hears silence. Speech
   * already under way is heard as it is.
   */
  private heardByDetector(frame16k: Float32Array): Float32Array {
    if (this.vad.speaking || performance.now() >= this.soundHeardUntil) return frame16k;
    return new Float32Array(frame16k.length);
  }

  /**
   * A short, quiet interface sound (interface-sounds.ts), after any still playing. Only on a
   * context a tap has made: none is made for it. One asleep is woken, and a sound that would come
   * late is dropped. Playing it restarts the idle clock.
   */
  playInterfaceSound(sound: InterfaceSound): void {
    const ctx = this.audioCtx;
    if (!ctx) return;
    const asked = performance.now();
    const play = (context: AudioContext) => {
      if (context !== this.audioCtx || context.state !== 'running' || performance.now() - asked > 400) return;
      // At once (the next block the context renders), unless one is still sounding: no delay of its
      // own on top of the context's 'balanced' output latency
      const at = Math.max(context.currentTime, this.nextSoundAt);
      // Sounds piling up (a burst of events): drop this one rather than play it long after
      if (at - context.currentTime > 1) return;
      try {
        const { next, end } = playInterfaceSound(context, context.destination, sound, at);
        this.nextSoundAt = next;
        // A little after it fades, for the room's echo
        this.soundHeardUntil = Math.max(this.soundHeardUntil, performance.now() + (end - context.currentTime) * 1000 + 150);
        this.updateIdleSuspend();
      } catch {
        // No sound this time
      }
    };
    if (ctx.state === 'running' && !this.suspendInFlight) play(ctx);
    else void this.ensureAudioContext().then(play, () => {});
  }

  /**
   * Immediately stops all active and scheduled audio playback (barge-in interruption).
   */
  stopAllPlaybackImmediately(): void {
    for (const source of this.activeSources) {
      try {
        source.onended = null;
        source.stop(0);
        source.disconnect();
      } catch {
        // Ignore if already stopped
      }
    }
    this.activeSources.clear();
    for (const resolve of Array.from(this.playbackResolvers.values())) resolve();
    this.playbackResolvers.clear();
    this.outputTimeDomainBuffer.fill(0);
    if (this.audioCtx) {
      this.nextScheduledPlayTime = this.audioCtx.currentTime;
    } else {
      this.nextScheduledPlayTime = 0;
    }
    this.events.onOutputLevel?.(0);
    this.updateIdleSuspend();
  }
}
