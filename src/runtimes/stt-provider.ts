// ============================================================================
// STT Runtime Provider: Cactus-Needle Whistle WASM + Web Speech Fallback
// (Spec Section 3.1)
// ============================================================================

import type {
  SttRuntimeProvider,
  SupportedLanguage,
  TranscriptWord,
} from '../types/index.ts';
import { withActivity } from '../core/activity-breadcrumbs.ts';

const WHISTLE_MODEL_URL =
  'https://huggingface.co/Cactus-Compute/whistle/resolve/b358ddadd89b7a713b5aa131f23032d3cca1b251/whistle.cact';
const WHISTLE_EXPECTED_BYTES = 16_919_407;
const WHISTLE_OPFS_FILENAME = 'whistle-stt-base.cact';

async function loadOrFetchWhistleModelBytes(
  onProgress?: (loaded: number, total: number) => void
): Promise<Uint8Array> {
  // 1. Check OPFS cache first
  if (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.getDirectory === 'function'
  ) {
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(WHISTLE_OPFS_FILENAME);
      const file = await fileHandle.getFile();
      if (file.size === WHISTLE_EXPECTED_BYTES) {
        onProgress?.(file.size, file.size);
        return new Uint8Array(await file.arrayBuffer());
      }
      await root.removeEntry(WHISTLE_OPFS_FILENAME).catch(() => {});
    } catch {
      // Not in OPFS yet
    }
  }

  // 2. Fetch with explicit CORS + credentials: 'omit' so Hugging Face CDN redirects succeed
  onProgress?.(0, WHISTLE_EXPECTED_BYTES);
  const response = await fetch(WHISTLE_MODEL_URL, {
    mode: 'cors',
    credentials: 'omit',
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Whistle STT model (${response.status})`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, WHISTLE_EXPECTED_BYTES);
    }
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // 3. Persist in OPFS for instant warm startups
  if (
    bytes.byteLength === WHISTLE_EXPECTED_BYTES &&
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.getDirectory === 'function'
  ) {
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(WHISTLE_OPFS_FILENAME, { create: true });
      if (typeof (fileHandle as any).createWritable === 'function') {
        const writable = await (fileHandle as any).createWritable();
        await writable.write(bytes);
        await writable.close();
      }
    } catch {
      // Ignore OPFS write errors
    }
  }

  return bytes;
}

export class WhistleSttProvider implements SttRuntimeProvider {
  readonly id = 'whistle-wasm';
  readonly modelId: string;
  private whistleSession: any = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(modelId = 'whistle-stt-base') {
    this.modelId = modelId;
  }

  async initialize(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.initialized && this.whistleSession) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      const [{ createWhistle }, modelBytes] = await Promise.all([
        import('cactus-needle/browser'),
        loadOrFetchWhistleModelBytes(onProgress),
      ]);
      this.whistleSession = await createWhistle({
        model: modelBytes,
        cache: true,
        onDownloadProgress: (prog) => {
          onProgress?.(prog.loaded, prog.total ?? WHISTLE_EXPECTED_BYTES);
        },
      });
      this.initialized = true;
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  transcribe(
    samples: Float32Array,
    sampleRate = 16000,
    language?: SupportedLanguage,
    signal?: AbortSignal
  ): Promise<{
    text: string;
    language: SupportedLanguage | '';
    words?: TranscriptWord[];
    latencyMs: number;
  }> {
    return withActivity('transcribing speech (Whistle)', () => this.transcribeNow(samples, sampleRate, language, signal));
  }

  private async transcribeNow(
    samples: Float32Array,
    sampleRate: number,
    language?: SupportedLanguage,
    signal?: AbortSignal
  ): Promise<{
    text: string;
    language: SupportedLanguage | '';
    words?: TranscriptWord[];
    latencyMs: number;
  }> {
    if (!this.initialized || !this.whistleSession) {
      await this.initialize();
    }

    // Clamp samples to [-1, 1] as required by cactus-needle's strict sample validator
    const clamped = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      clamped[i] = Number.isFinite(s) ? Math.max(-1, Math.min(1, s)) : 0;
    }

    const start = performance.now();
    const result = await this.whistleSession.transcribe(
      { samples: clamped, sampleRate },
      {
        language,
        wordTimestamps: true,
        abortSignal: signal,
      }
    );

    const latencyMs = Math.max(1, Math.round(performance.now() - start));
    return {
      text: result.text ?? '',
      language: (result.language as SupportedLanguage | '') ?? 'en',
      words: result.words,
      latencyMs,
    };
  }

  async dispose(): Promise<void> {
    this.initPromise = null;
    if (this.whistleSession) {
      try {
        await this.whistleSession.close();
      } catch {
        // Ignore close error
      }
      this.whistleSession = null;
    }
    this.initialized = false;
  }
}
