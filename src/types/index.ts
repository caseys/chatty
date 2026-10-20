// ============================================================================
// Core Types & State Machine Definitions for Client-Side Voice Assistant
// ============================================================================

export type InteractionState =
  | 'idle'
  | 'listening'
  | 'finalizing_input'
  | 'building_context'
  | 'compacting'
  | 'generating'
  | 'speaking'
  | 'interrupted'
  | 'recovering'
  | 'error';

export type TurnState =
  | 'idle'
  | 'processing_input'
  | 'generating'
  | 'completed'
  | 'canceled'
  | 'failed';

export type MicrophoneState =
  | 'unavailable'
  | 'requesting_permission'
  | 'listening'
  | 'stopped';

export type PlaybackState =
  | 'stopped'
  | 'buffering'
  | 'playing'
  | 'interrupted';

export type ModelRuntimeState =
  | 'unloaded'
  | 'downloading'
  | 'initializing'
  | 'ready'
  | 'failed';

export type AppLifecycleState =
  | 'foregrounded'
  | 'backgrounded'
  | 'recovering';

export type ResponseMode = 'direct' | 'clarification' | 'verification';

export type DeviceProfile =
  | 'constrained_mobile'
  | 'typical_laptop_mobile'
  | 'high_memory_desktop'
  | 'unsupported_webgpu';

export type SupportedLanguage = 'en' | 'de' | 'fr' | 'es' | 'it' | 'nl' | 'pl';

// ============================================================================
// Model Manifest & Capability Types
// ============================================================================

export interface ModelManifest {
  id: string;
  name: string;
  version: string;
  task: 'stt' | 'llm' | 'tts';
  url: string;
  expectedSizeBytes: number;
  sha256: string;
  runtime: 'litert-lm' | 'whistle-wasm' | 'piper-onnx';
  requiredCapabilities: ('webgpu' | 'wasm' | 'audio' | 'opfs')[];
  quantization: string;
  estimatedMemoryMB: number;
  contextWindowTokens: number;
  maxOutputTokens: number;
  supportedLanguages: string[];
  license: string;
  attribution: string;
}

export interface BrowserCapabilities {
  hasWebGPU: boolean;
  gpuAdapterName?: string;
  maxBufferSize: number;
  maxStorageBufferBindingSize: number;
  hasWasm: boolean;
  hasAudioContext: boolean;
  hasGetUserMedia: boolean;
  hasOPFS: boolean;
  hasIndexedDB: boolean;
  hasCacheStorage: boolean;
  hasSpeechSynthesis: boolean;
  hasWebSpeechRecognition: boolean;
  storageQuotaBytes: number;
  storageUsageBytes: number;
  persistentStorageGranted: boolean;
  deviceProfile: DeviceProfile;
}

export interface DownloadState {
  modelId: string;
  version: string;
  status: 'not_downloaded' | 'downloading' | 'verifying' | 'cached' | 'failed';
  downloadedBytes: number;
  totalBytes: number;
  completedChunks: number[];
  verifiedSha256?: string;
  storageBackend: 'opfs' | 'indexeddb' | 'cache' | 'memory';
  updatedAt: number;
  error?: string;
}

// ============================================================================
// STT Events & Transcript Types
// ============================================================================

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  probability: number;
}

export type SttEventType =
  | 'speech_started'
  | 'partial_transcript'
  | 'final_transcript'
  | 'speech_ended'
  | 'error';

export interface SttEvent {
  type: SttEventType;
  turnId: string;
  sequence: number;
  timestamp: number;
  text?: string;
  pending?: string;
  language?: SupportedLanguage | '';
  words?: TranscriptWord[];
  durationMs?: number;
  rmsLevel?: number;
  error?: string;
  /** Speech overlapped Chatty's own audio, so it may be its voice coming back through the mic */
  heardDuringPlayback?: boolean;
}

// ============================================================================
// Conversation, Memory, and Speech-Aware Representations
// ============================================================================

export interface PhraseSegment {
  id: string;
  turnId: string;
  sequence: number;
  canonicalText: string;
  speechNormalizedText: string;
  status: 'queued' | 'synthesizing' | 'ready' | 'playing' | 'played' | 'canceled' | 'failed';
  audioSamples?: Float32Array;
  sampleRate?: number;
  synthesisTimeMs?: number;
  audioDurationMs?: number;
}

export interface ConversationMessage {
  id: string;
  turnId: string;
  role: 'system' | 'user' | 'assistant';
  canonicalContent: string;
  rawTranscript?: string;
  /** User turn Chatty sent itself to report a failed program back to the model (not shown as a bubble) */
  autoFix?: boolean;
  rawCode?: string;
  rawLlmOutput?: string;
  speechReadyContent?: string;
  phrases?: PhraseSegment[];
  timestamp: number;
  interrupted?: boolean;
  spokenTextBeforeInterrupt?: string;
  responseMode?: ResponseMode;
  verified?: boolean;
  toolCall?: {
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    error?: string;
    status?: 'running' | 'completed' | 'failed';
  };
  metrics?: TurnMetrics;
}

export interface ConversationSummary {
  id: string;
  updatedAt: number;
  coveredTurnCount: number;
  lastCoveredTurnId: string;
  summaryText: string;
  decisions: string[];
  unresolvedQuestions: string[];
  namedEntities: Record<string, string>;
  constraints: string[];
  title?: string;
}

export interface StoredConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
  summary: ConversationSummary | null;
}

export interface LongTermMemoryItem {
  id: string;
  key: string;
  value: string;
  category: 'preference' | 'fact' | 'constraint';
  approvedByUser: boolean;
  sourceTurnId?: string;
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// Provider-Neutral Runtime Interfaces (Addendum Section 8)
// ============================================================================

export interface LlmGenerationOptions {
  turnId: string;
  systemPrompt: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /**
   * Near-greedy decoding for an exact answer (a fix turn's corrected line): runtimes that can,
   * use a low temperature and no repetition penalty
   */
  exact?: boolean;
  signal?: AbortSignal;
  onToken?: (chunk: string, sequence: number) => void;
}

export interface LlmGenerationResult {
  turnId: string;
  text: string;
  aborted: boolean;
  timeToFirstTokenMs: number;
  totalTimeMs: number;
  tokensGenerated: number;
  tokensPerSecond: number;
  toolCall?: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface LlmRuntimeProvider {
  readonly id: string;
  readonly modelId: string;
  readonly contextLimit: number;
  readonly maxOutputTokens: number;
  readonly supportsStreaming: boolean;
  readonly supportsCancellation: boolean;
  readonly supportsTools: boolean;

  initialize(onProgress?: (loaded: number, total: number) => void): Promise<void>;
  generate(options: LlmGenerationOptions): Promise<LlmGenerationResult>;
  cancel(turnId?: string): void;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SttRuntimeProvider {
  readonly id: string;
  readonly modelId: string;
  initialize(onProgress?: (loaded: number, total: number) => void): Promise<void>;
  transcribe(samples: Float32Array, sampleRate: number, language?: SupportedLanguage, signal?: AbortSignal): Promise<{
    text: string;
    language: SupportedLanguage | '';
    words?: TranscriptWord[];
    latencyMs: number;
  }>;
  dispose(): Promise<void>;
}

export interface TtsRuntimeProvider {
  readonly id: string;
  readonly voiceId: string;
  initialize(onProgress?: (loaded: number, total: number) => void): Promise<void>;
  synthesize(text: string, turnId: string, sequence: number, signal?: AbortSignal): Promise<{
    samples: Float32Array;
    sampleRate: number;
    synthesisTimeMs: number;
    audioDurationMs: number;
  }>;
  cancel(turnId?: string): void;
  dispose(): Promise<void>;
}

// ============================================================================
// Performance & Observability Metrics (Spec Section 10)
// ============================================================================

export interface TurnMetrics {
  turnId: string;
  sttFinalizationLatencyMs?: number;
  llmTimeToFirstTokenMs?: number;
  firstAudioLatencyMs?: number;
  generationThroughputTps?: number;
  ttsRealTimeFactor?: number;
  interruptionLatencyMs?: number;
  totalTurnDurationMs?: number;
}

export interface SystemTelemetry {
  firstUseReadinessMs?: number;
  warmInitializationMs?: number;
  peakMemoryEstimateMB: number;
  lastRecoveryTimeMs?: number;
  completedTurns: number;
  interruptedTurns: number;
  averageTtftMs: number;
  averageFirstAudioMs: number;
  averageTps: number;
  averageTtsRtf: number;
  recentTurnMetrics: TurnMetrics[];
}

// ============================================================================
// Worker Message Protocol
// ============================================================================

export interface WorkerRequestMessage<T = unknown> {
  requestId: string;
  turnId: string;
  sequence: number;
  type: string;
  payload: T;
  timestamp: number;
}

export interface WorkerResponseMessage<T = unknown> {
  requestId: string;
  turnId: string;
  sequence: number;
  type: string;
  payload: T;
  error?: string;
  timestamp: number;
}
