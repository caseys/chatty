// ============================================================================
// Built-in browser speech recognition (Web Speech API: webkitSpeechRecognition).
// Used on phones instead of the Whistle WASM model, so no STT model is downloaded or
// held in memory. The browser owns the microphone while it listens.
// ============================================================================

type RecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onspeechstart: (() => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type RecognitionCtor = new () => RecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface NativeSttHandlers {
  onSpeechStart: () => void;
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  onError: (message: string) => void;
}

export class NativeSpeechRecognizer {
  static isSupported(): boolean {
    return getRecognitionCtor() !== null;
  }

  private recognition: RecognitionLike | null = null;
  // Listening requested by the user (mic on)
  private active = false;
  // Temporarily muted while the assistant is thinking/speaking, so it doesn't hear itself
  private paused = false;
  private running = false;

  constructor(private readonly handlers: NativeSttHandlers, private lang = 'en-US') {}

  setLanguage(lang: string): void {
    this.lang = lang;
  }

  /** Starts listening. Call from a user gesture (iOS requires it for the first start). */
  start(): void {
    this.active = true;
    this.paused = false;
    this.ensureRunning();
  }

  stop(): void {
    this.active = false;
    this.halt();
  }

  /** Mutes recognition (e.g. while the assistant talks); resume() picks up again. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.halt();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.ensureRunning();
  }

  get isActive(): boolean {
    return this.active;
  }

  private halt(): void {
    if (this.recognition && this.running) {
      try {
        this.recognition.abort();
      } catch {
        // Already stopped
      }
    }
  }

  private ensureRunning(): void {
    if (!this.active || this.paused || this.running) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      this.handlers.onError('Speech recognition is not supported in this browser.');
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.onspeechstart = () => this.handlers.onSpeechStart();
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        const text = result[0]?.transcript?.trim() ?? '';
        if (!text) continue;
        if (result.isFinal) this.handlers.onFinal(text);
        else this.handlers.onInterim?.(text);
      }
    };
    rec.onerror = (ev) => {
      // 'no-speech' / 'aborted' are routine; restart via onend
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        this.active = false;
        this.handlers.onError('Microphone or speech recognition permission was denied.');
      } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
        console.warn('[Chatty STT] Speech recognition error:', ev.error);
      }
    };
    rec.onend = () => {
      this.running = false;
      if (this.recognition === rec) this.recognition = null;
      // Mobile browsers end continuous recognition after silence; keep listening while wanted
      if (this.active && !this.paused) setTimeout(() => this.ensureRunning(), 250);
    };
    this.recognition = rec;
    try {
      rec.start();
      this.running = true;
    } catch (err) {
      this.running = false;
      this.recognition = null;
      this.handlers.onError(err instanceof Error ? err.message : String(err));
    }
  }
}
