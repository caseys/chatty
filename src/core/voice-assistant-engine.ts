// ============================================================================
// Core Voice Assistant Engine: Unified Reusable Module
// Encapsulates ModelManager, StateMachineCoordinator, ConversationMemoryStore,
// Whistle STT, Worker LLMs (LiteRT-LM Gemma 4 or WebLLM, on WebGPU), Worker TTS (Piper ONNX),
// and SharedAudioSubsystem (VAD, 16kHz resampling, gapless playback).
// ============================================================================

import { SharedAudioSubsystem } from '../audio/audio-subsystem.ts';
import type { InterfaceSound } from '../audio/interface-sounds.ts';
import { ConversationMemoryStore } from './memory-store.ts';
import { ModelManager } from './model-manager.ts';
import { classifyTranscript, ConversationOrchestrator, WELCOME_BACK_MESSAGE, WELCOME_MESSAGE, type RunStatus } from './orchestrator.ts';
import { StateMachineCoordinator, type CoordinatedStateSnapshot } from './state-machine.ts';
import { WhistleSttProvider } from '../runtimes/stt-provider.ts';
import { NativeSpeechRecognizer } from '../runtimes/native-stt.ts';
import { WorkerLlmProvider, WorkerTtsProvider } from '../runtimes/worker-bridge.ts';
import {
  JavascriptRuntime,
  createCoderAgentTool,
  createJavascriptRuntimeTool,
  type JavascriptExecutionMode,
  type JavascriptExecutionResult,
} from '../tools/javascript-runtime.ts';
import { createPlayMusicTool } from '../tools/music-tool.ts';
import { createDrawGraphicsTool } from '../tools/draw-tool.ts';
import { createWikipediaTool, createInstantAnswersTool } from '../tools/web-tools.ts';
import { NEEDLE_LABEL } from '../runtimes/needle-router.ts';
import { MODEL_REGISTRY } from './model-manager.ts';
import { WebLlmProvider } from '../runtimes/webllm-provider.ts';
import { OnnxLlmProvider } from '../runtimes/onnx-llm-provider.ts';
import { clearActivity, readInterruptedActivity, withActivity } from './activity-breadcrumbs.ts';
import { appendRunLog, runLogText, setRunLogChat } from './run-log.ts';
import {
  PHONE_CHAT_SYSTEM_PROMPT,
  PhoneModelSet,
  SwappingLlmProvider,
  TurnRouter,
} from './phone-pipeline.ts';
import {
  type ChattySettings,
  DEFAULT_SETTINGS,
  findLocalChatModel,
  SUPPORTED_CHAT_MODELS,
  type ModelOptionItem,
  loadSettingsFromStorage,
  saveSettingsToStorage,
  loadSpeechChoice,
  loadChatModelChoice,
  resolvePhoneChatModelId } from './settings.ts';
import type {
  BrowserCapabilities,
  ConversationMessage,
  LlmRuntimeProvider,
  StoredConversation,
  SupportedLanguage,
  SystemTelemetry,
} from '../types/index.ts';
import { clearSpeechModelCache } from './model-cache.ts';
import { AFTER_HEAVY_MS, AFTER_LOAD_MS, settle, settleAfterLoad, settleOnIos } from './settle.ts';

/** Returning users get the short greeting (set after the first full welcome) */
const WELCOMED_KEY = 'chatty_welcomed';
/** Events in which browsers let a page start sound */
const AUDIO_GESTURES = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
/** The play_music tool and playNotes schedule a whole tune on the audio clock and report nothing: the context stays awake this long after one starts */
const TOOL_AUDIO_HOLD_MS = 120_000;

/** A turn is under way: input being taken in, context built, or a reply (or a fix) being written */
function turnWorking(snap: CoordinatedStateSnapshot): boolean {
  return (
    snap.interaction === 'finalizing_input' ||
    snap.interaction === 'building_context' ||
    snap.interaction === 'compacting' ||
    snap.interaction === 'generating' ||
    snap.turn === 'processing_input' ||
    snap.turn === 'generating'
  );
}
/** Chats kept: a new chat beyond this deletes the one used least recently */
const MAX_CHATS = 10;

/** The full introduction the first time, a short greeting after that. */
function takeWelcomeMessage(): string {
  try {
    if (localStorage.getItem(WELCOMED_KEY)) return WELCOME_BACK_MESSAGE;
    localStorage.setItem(WELCOMED_KEY, '1');
  } catch {
    // No storage (private browsing): always introduce
  }
  return WELCOME_MESSAGE;
}

// Set while the LLM is loading; still present on the next start means the tab was killed mid-load.
const LLM_LOAD_MARKER_KEY = 'chatty_llm_loading';
function writeLlmLoadMarker(modelId: string): void {
  try {
    localStorage.setItem(LLM_LOAD_MARKER_KEY, modelId);
  } catch {
    // Storage unavailable (private mode)
  }
}
// Which model was loading when the tab last died (any startup model, for diagnostics)
const LOAD_STAGE_KEY = 'chatty_load_stage';
/** The tiny first run right after a model loads (see warmUpChat); off for now */
const WARM_UP_AFTER_LOAD = false;
/** A model load that failed (and wasn't retried): shown in Settings on the next visit */
const LAST_LOAD_FAILED_KEY = 'chatty_last_load_failed';
function recordLoadFailure(text: string): void {
  try {
    localStorage.setItem(LAST_LOAD_FAILED_KEY, text);
  } catch {
    // Storage unavailable
  }
}
function clearLoadFailure(): void {
  try {
    localStorage.removeItem(LAST_LOAD_FAILED_KEY);
  } catch {
    // Storage unavailable
  }
}
function writeLoadStage(label: string): void {
  try {
    localStorage.setItem(LOAD_STAGE_KEY, label);
  } catch {
    // Storage unavailable
  }
}
/**
 * The step of a WebLLM load its progress report is at, briefly, for the breadcrumb a crash leaves
 * ("building shaders 40/80"), or null for a report that names no step. The last weight piece
 * read means the weights are on the GPU and the model's working memory is being set aside next
 * (WebLLM reports nothing between that and the shaders).
 */
export function loadStepText(report: string): string | null {
  const count = (re: RegExp) => report.match(re)?.slice(1, 3).map(Number) ?? null;
  const fetched = count(/Fetching param cache\[(\d+)\/(\d+)\]/);
  if (fetched) return `downloading weights ${fetched[0]}/${fetched[1]}`;
  const loaded = count(/Loading model from cache\[(\d+)\/(\d+)\]/);
  if (loaded) return loaded[0] >= loaded[1] ? 'setting up working memory, after the weights' : `loading weights ${loaded[0]}/${loaded[1]}`;
  const shaders = count(/Loading GPU shader modules\[(\d+)\/(\d+)\]/);
  if (shaders) return `building shaders ${shaders[0]}/${shaders[1]}`;
  if (/^Start to fetch params/i.test(report)) return 'starting on the weights';
  if (/^Finish loading/i.test(report)) return 'finishing the load';
  return null;
}

function takeLoadStage(): string | null {
  try {
    const stage = localStorage.getItem(LOAD_STAGE_KEY);
    localStorage.removeItem(LOAD_STAGE_KEY);
    return stage;
  } catch {
    return null;
  }
}
function clearLoadStage(): void {
  try {
    localStorage.removeItem(LOAD_STAGE_KEY);
  } catch {
    // Ignore
  }
}

function clearLlmLoadMarker(): void {
  try {
    localStorage.removeItem(LLM_LOAD_MARKER_KEY);
  } catch {
    // Ignore
  }
}

export interface VoiceAssistantEngineEvents {
  onStatusChange?: (statusText: string | null) => void;
  onStateChange?: (snapshot: CoordinatedStateSnapshot) => void;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onTokenStream?: (turnId: string, chunk: string, fullText: string) => void;
  onRawOutput?: (turnId: string, rawSoFar: string) => void;
  onRunStatus?: (turnId: string | null, status: RunStatus) => void;
  /** A program started or stopped making sound (quiet for 3 seconds) */
  onProgramSound?: (sounding: boolean) => void;
  /** A program has timers or async code pending, or its last one ended */
  onProgramActivity?: (active: boolean) => void;
  /** The program in the card can be downloaded as an HTML file (it ran 2.5 s without an error), or no longer can */
  onProgramDownloadable?: (ready: boolean) => void;
  onMessageCreated?: (message: ConversationMessage) => void;
  onMessageUpdated?: (message: ConversationMessage) => void;
  onTelemetryUpdated?: (telemetry: SystemTelemetry) => void;
  onError?: (error: Error, context: string) => void;
  /** Yes/no question for the user (the app shows a browser confirm dialog); no answer means no */
  onConfirm?: (message: string) => boolean;
  /** Resolves when model downloads may start (the UI holds them while Settings is open) */
  beforeModelDownload?: () => Promise<void>;
  onCapabilitiesDetected?: (caps: BrowserCapabilities) => void;
  onLlmProgress?: (
    loaded: number,
    total: number,
    pct: number,
    mb: string,
    totalMb: string,
    /** Phones load two models in this stage: which one is loading, and its own bytes */
    current?: { label: string; loaded: number; total: number }
  ) => void;
  onTtsProgress?: (loaded: number, total: number, pct: number, mb?: string, totalMb?: string) => void;
  onSttProgress?: (loaded: number, total: number) => void;
  /** Fired once the startup Whistle STT load settles (success or failure). */
  onSttLoadSettled?: () => void;
  onTitleGenerated?: (title: string) => void;
  onJavascriptExecution?: (result: JavascriptExecutionResult) => void;
  onJavascriptVisualChange?: (hasVisual: boolean, iframe: HTMLIFrameElement | null) => void;
  onConversationsChanged?: (conversations: StoredConversation[]) => void;
  onActiveConversationSwitched?: (conversation: StoredConversation) => void;
}

export class VoiceAssistantEngine {
  readonly stateCoordinator = new StateMachineCoordinator();
  readonly memoryStore = new ConversationMemoryStore({ maxVerbatimTurns: 8 });
  readonly modelManager = new ModelManager();

  readonly sttProvider = new WhistleSttProvider();
  readonly llmProvider: WorkerLlmProvider;
  readonly ttsProvider: WorkerTtsProvider;
  readonly orchestrator: ConversationOrchestrator;
  readonly audioSubsystem: SharedAudioSubsystem;
  readonly jsRuntime: JavascriptRuntime;

  private isListening = false;
  /** Set once dispose() has run, so a page restored from the back/forward cache knows to reload */
  private pageDisposed = false;
  private selectedLanguage: SupportedLanguage = 'en';
  private currentInputRms = 0;
  private currentOutputRms = 0;
  private speechTurnCounter = 0;
  private events: VoiceAssistantEngineEvents;

  private chatModelId: string = DEFAULT_SETTINGS.chatModelId;
  private codingModelId: string = DEFAULT_SETTINGS.codingModelId;
  private voiceId: string = DEFAULT_SETTINGS.voiceId;
  private speechEnabled: boolean = DEFAULT_SETTINGS.speechEnabled;
  // Deleting the speech models' downloads (speech off); loading them again waits for it
  private speechEviction: Promise<void> = Promise.resolve();
  private sidebarOpen: boolean = DEFAULT_SETTINGS.sidebarOpen;
  private codingLlmProvider: WorkerLlmProvider | null = null;
  private phoneModels: PhoneModelSet | null = null;
  // Chat model when a WebLLM model is picked (always on phones); else Gemma 4 via llmProvider
  private localChat: WebLlmProvider | OnnxLlmProvider | null = null;
  private isPhone = false;
  // Every model load takes the next ticket; only the newest may mark the model ready or report
  // an error (a model switch in Settings supersedes a load that is still running)
  private llmLoadTicket = 0;
  // Echo guard: when Chatty's audio last played, and when the current utterance began
  private playbackActive = false;
  private playbackLastActiveAt = 0;
  private utteranceStartedAt = 0;
  // Set once initialize() runs; settings saved before then only take effect when it does
  private started = false;
  // Browser speech recognition instead of Whistle (only with ?stt=native)
  private nativeStt: NativeSpeechRecognizer | null = null;
  /** Model that was loading when the previous page load died (likely out of memory), if any */
  previousLoadFailure: string | null = null;

  private activeConversationId = 'chat_default';
  private compactionAbort: AbortController | null = null;
  private conversations = new Map<string, StoredConversation>();

  constructor(events?: VoiceAssistantEngineEvents) {
    this.events = events ?? {};

    const initialSettings = loadSettingsFromStorage();
    this.chatModelId = initialSettings.chatModelId;
    this.codingModelId = initialSettings.codingModelId;
    this.voiceId = initialSettings.voiceId;
    this.speechEnabled = initialSettings.speechEnabled;
    this.sidebarOpen = initialSettings.sidebarOpen;

    // The run log is kept per chat
    setRunLogChat(() => this.activeConversationId);
    // A welcome asked for during loading is written and spoken once loading is done
    this.stateCoordinator.subscribe(() => {
      if (this.greetWhenLoaded && this.modelsLoaded()) queueMicrotask(() => this.greetWhenLoaded && this.greet());
    });
    // The audio session follows the mic and what plays (see updateAudioSession)
    this.stateCoordinator.subscribe((snap) => {
      const working = turnWorking(snap);
      if (snap.microphone === this.lastSessionMic && snap.playback === this.lastSessionPlayback && working === this.lastSessionWorking) return;
      this.lastSessionMic = snap.microphone;
      this.lastSessionPlayback = snap.playback;
      this.lastSessionWorking = working;
      this.updateAudioSession();
    });
    // Browsers start audio only in a tap or key press: every one, anywhere in Chatty (the
    // program's card included, see the sandbox), creates or resumes the one shared AudioContext
    if (typeof document !== 'undefined') {
      // Safari grants sound only in click, touchend and keydown; Chrome also in pointerdown
      const unlockAudio = () => this.audioSubsystem?.unlockInGesture();
      for (const type of AUDIO_GESTURES) document.addEventListener(type, unlockAudio, true);
      (window as unknown as { __chattyUnlockAudio?: () => void }).__chattyUnlockAudio = unlockAudio;
    }
    this.jsRuntime = new JavascriptRuntime({
      mode: 'iframe',
      // A program that asks for audio before the first tap gets the one shared context too (made
      // now, paused until a tap), never one of its own
      getSharedAudioContext: () => {
        // Also wakes a context the idle timer put to sleep (and restarts its idle clock)
        if (this.audioSubsystem.getAudioContext()?.state !== 'running') void this.audioSubsystem.ensureAudioContext().catch(() => {});
        return this.audioSubsystem.getAudioContext();
      },
      onProgramError: (message, line) => this.orchestrator.reportProgramError(message, line),
      onProgramAudio: (sounding) => {
        this.programSounding = sounding;
        this.updateAudioSession();
        this.events.onProgramSound?.(sounding);
      },
      onProgramActivity: (active, cleared) => {
        this.programRunning = active;
        this.updateAudioSession();
        this.events.onProgramActivity?.(active);
        if (active) this.programKeptRunning = true;
        // Cleared for a new run or by Stop: it didn't end by itself (the button has its own sound)
        if (!active && cleared) this.programEnded(false);
        else if (!active && this.programReturned) this.programEnded();
      },
      onDownloadableChange: (ready) => this.events.onProgramDownloadable?.(ready),
      onRunLog: (kind, text) => {
        appendRunLog(kind, text);
        // Every run of a program starts with its code in the log
        if (kind === 'program') this.programStarted();
      },
      onResult: (res) => {
        this.events.onJavascriptExecution?.(res);
        this.programFinishedTopLevel();
      },
      onVisualChange: (hasVisual, iframe) => {
        this.events.onJavascriptVisualChange?.(hasVisual, iframe);
      },
    });

    this.llmProvider = new WorkerLlmProvider(this.chatModelId, {
      onCrashRecovered: (recoveryMs) => {
        this.orchestrator.recordRecoveryTiming(recoveryMs);
      },
    });

    if (this.codingModelId === this.chatModelId) {
      this.jsRuntime.setLlmProvider(this.llmProvider);
    } else {
      this.codingLlmProvider = new WorkerLlmProvider(this.codingModelId);
      this.jsRuntime.setLlmProvider(this.codingLlmProvider);
    }

    this.ttsProvider = new WorkerTtsProvider(this.voiceId);

    this.audioSubsystem = new SharedAudioSubsystem({
      onSpeechStarted: () => {
        this.utteranceStartedAt = performance.now();
        const turnId = `voice_turn_${Date.now()}_${++this.speechTurnCounter}`;
        this.events.onStatusChange?.('Speech detected — listening...');
        this.orchestrator.handleSttEvent({
          type: 'speech_started',
          turnId,
          sequence: 1,
          timestamp: performance.now(),
        });
      },
      onSpeechEnded: (utterance16k, durationMs) => {
        const turnId = `voice_turn_${Date.now()}_${this.speechTurnCounter}`;
        this.events.onStatusChange?.('Transcribing utterance with Whistle WASM...');
        this.orchestrator.handleSttEvent({
          type: 'speech_ended',
          turnId,
          sequence: 2,
          timestamp: performance.now(),
          durationMs,
        });
        void this.transcribeRecordedUtterance(turnId, utterance16k, this.utteranceOverlappedPlayback());
      },
      onInputLevel: (rms) => {
        this.currentInputRms = rms;
      },
      onOutputLevel: (rms) => {
        this.currentOutputRms = rms;
      },
    });

    this.orchestrator = new ConversationOrchestrator({
      stateCoordinator: this.stateCoordinator,
      memoryStore: this.memoryStore,
      llmProvider: this.llmProvider,
      ttsProvider: this.ttsProvider,
      enableSpeechOutput: this.speechEnabled,
      autoFixErrors: true,
      javascriptRuntime: this.jsRuntime,
      audioContextAccessor: this.toolAudioContext,
      tools: [],
      getConversationId: () => this.activeConversationId,
      shouldAutoTitle: (conversationId) => {
        const convo = this.conversations.get(conversationId);
        return !!convo && (convo.title === 'New Chat' || convo.title === 'Conversation');
      },
      events: {
        onMessageCreated: (msg) => {
          // (A fix turn's request is logged as a retry, with its reason)
          if (msg.role === 'user' && !msg.autoFix) appendRunLog('request', msg.canonicalContent);
          this.events.onMessageCreated?.(msg);
          void this.persistState();
        },
        onMessageUpdated: (msg) => {
          this.events.onMessageUpdated?.(msg);
          void this.persistState();
        },
        onTokenStream: (turnId, chunk, fullText) => {
          this.events.onTokenStream?.(turnId, chunk, fullText);
        },
        onRawOutput: (turnId, raw) => {
          this.events.onRawOutput?.(turnId, raw);
        },
        onRunStatus: (turnId, status) => {
          this.events.onRunStatus?.(turnId, status);
        },
        onPhraseReadyForPlayback: async (phrase) => {
          if (phrase.audioSamples && phrase.sampleRate) {
            await this.audioSubsystem.schedulePcmPlayback(phrase.audioSamples, phrase.sampleRate);
          }
        },
        onInterruption: () => {
          this.audioSubsystem.stopAllPlaybackImmediately();
          this.events.onStatusChange?.(null);
        },
        onTelemetryUpdated: (telemetry) => {
          this.events.onTelemetryUpdated?.(telemetry);
        },
        onStatusChange: (status) => {
          this.events.onStatusChange?.(status);
        },
        onError: (error, context) => {
          console.error(`[Chatty ${context}]`, error);
          this.events.onError?.(error, context);
          this.events.onStatusChange?.(`Error (${context}): ${error.message}`);
        },
        onTitleGenerated: (title, conversationId) => {
          const targetId = conversationId ?? this.activeConversationId;
          const target = this.conversations.get(targetId);
          if (target && title && title !== 'New Conversation') {
            target.title = title;
            target.updatedAt = Date.now();
            void this.modelManager.db.saveConversation(target);
            this.events.onConversationsChanged?.(this.getConversations());
          }
          if (targetId === this.activeConversationId) {
            this.events.onTitleGenerated?.(title);
          }
        },
      },
    });

    // Fallback context for runs without per-turn options (coder_agent, draw_graphics,
    // and helper calls fired by timers/handlers after their run has finished).
    this.jsRuntime.setDefaultOptions({
      onSpeak: (text) => void this.orchestrator.speakOutOfTurn(text),
      audioContextAccessor: this.toolAudioContext,
    });

    // Subscribe to state machine changes
    this.stateCoordinator.subscribe((snapshot) => {
      this.events.onStateChange?.(snapshot);
    });
  }

  async initialize(): Promise<void> {
    const startInit = performance.now();
    this.started = true;
    // Track when Chatty's audio plays, for the echo guard (utteranceOverlappedPlayback)
    this.stateCoordinator.subscribe((snap) => {
      const playing = snap.playback === 'playing' || snap.playback === 'buffering';
      if (playing) this.playbackActive = true;
      else if (this.playbackActive) {
        this.playbackActive = false;
        this.playbackLastActiveAt = performance.now();
      }
    });

    // 1. Restore persisted memories & conversations from IndexedDB
    try {
      const savedMemories = await this.modelManager.db.loadMemories();
      if (savedMemories.length > 0) {
        this.memoryStore.loadMemories(savedMemories);
      }

      const savedConvos = await this.modelManager.db.listConversations();
      this.conversations.clear();
      for (const c of savedConvos) {
        this.conversations.set(c.id, c);
      }

      if (this.conversations.size === 0) {
        // Fallback: check legacy snapshot or create default New Chat
        const legacy = await this.modelManager.db.loadConversationSnapshot();
        const initialChat: StoredConversation = {
          id: `chat_${Date.now()}`,
          title: legacy?.summary?.title || (legacy?.messages?.length ? 'Conversation' : 'New Chat'),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: legacy?.messages || [],
          summary: legacy?.summary || null,
        };
        this.activeConversationId = initialChat.id;
        this.conversations.set(initialChat.id, initialChat);
        await this.modelManager.db.saveConversation(initialChat);
      } else {
        // Every page load starts a fresh chat (earlier ones stay in the sidebar); an empty
        // chat left from a previous load is reused instead of piling up new ones
        let fresh = savedConvos.find((c) => c.messages.length === 0 && !c.summary);
        if (!fresh) {
          fresh = {
            id: `chat_${Date.now()}`,
            title: 'New Chat',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
            summary: null,
          };
          this.conversations.set(fresh.id, fresh);
          await this.modelManager.db.saveConversation(fresh);
        }
        this.activeConversationId = fresh.id;
        try {
          localStorage.setItem('chatty_active_chat_id', fresh.id);
        } catch {
          // ignore
        }
      }

      const active = this.conversations.get(this.activeConversationId);
      if (active) {
        this.memoryStore.loadConversation(active.messages, active.summary);
      }
      this.events.onConversationsChanged?.(this.getConversations());
      if (active) {
        this.events.onActiveConversationSwitched?.(active);
      }
    } catch {
      // Ignore IndexedDB errors in private browsing
    }

    // 2. Detect hardware capabilities and restore model settings
    const caps = await this.modelManager.detectCapabilities();
    const recommended = this.modelManager.recommendModelsForCapabilities(caps);
    this.events.onCapabilitiesDetected?.(caps);

    try {
      const dbSettings = await this.modelManager.db.getSetting<ChattySettings>('user_settings');
      if (dbSettings) {
        if (dbSettings.chatModelId) this.chatModelId = dbSettings.chatModelId;
        if (dbSettings.codingModelId) this.codingModelId = dbSettings.codingModelId;
        if (dbSettings.voiceId) this.voiceId = dbSettings.voiceId;
      }
    } catch {
      // Ignore storage errors in private browsing
    }

    const hasExplicitStoredSettings =
      typeof localStorage !== 'undefined' && localStorage.getItem('chatty_user_settings') !== null;

    if (!hasExplicitStoredSettings) {
      this.chatModelId = recommended.llmModelId;
    }

    const isConstrained = caps.deviceProfile === 'constrained_mobile';
    this.isPhone = isConstrained;
    if (isConstrained && loadSpeechChoice() === null) this.speechEnabled = false;
    // Phones work like desktop with a phone-sized model: a mobile tab is killed long before
    // device RAM runs out, so Gemma 4 is never loaded there. ?pipeline=split keeps the older
    // router + chat + coder phone pipeline for comparison.
    const splitPipeline =
      isConstrained && typeof location !== 'undefined' && new URLSearchParams(location.search).get('pipeline') === 'split';
    // A phone that never chose a model gets the phone default, not the desktop recommendation
    // (Gemma 4 E2B is phone-capable but only for a user who picked it); desktop keeps its own.
    if (isConstrained) this.chatModelId = resolvePhoneChatModelId(loadChatModelChoice());

    // Crash-loop guard: the marker is set while the LLM loads and cleared once it settles. If it
    // is still present, the tab died mid-load (out of memory), so retry with the smaller model
    // instead of crashing again on every visit.
    this.previousLoadFailure = takeLoadStage();
    // A load that crashed or failed last time was shown in Settings before startup (main.ts),
    // where the user chose what to load now; clear the record
    clearLlmLoadMarker();
    clearLoadFailure();
    clearActivity();
    // The coder always shares the chat model (there's no separate picker). A stale divergent
    // codingModelId from older settings would load a second multi-GB model onto the GPU
    // alongside the chat model and crash the tab mid-load.
    this.codingModelId = this.chatModelId;

    this.llmProvider.modelId = this.chatModelId;
    const chatManifest = MODEL_REGISTRY.find((m) => m.id === this.chatModelId);
    if (chatManifest) {
      this.llmProvider.contextLimit = chatManifest.contextWindowTokens;
      this.llmProvider.maxOutputTokens = chatManifest.maxOutputTokens;
    } else if (recommended.recommendedContextLimit) {
      this.llmProvider.contextLimit = recommended.recommendedContextLimit;
      this.llmProvider.maxOutputTokens = recommended.recommendedMaxOutputTokens;
    }

    if (this.codingModelId === this.chatModelId) {
      if (this.codingLlmProvider) {
        await this.codingLlmProvider.dispose();
        this.codingLlmProvider = null;
      }
      this.jsRuntime.setLlmProvider(this.llmProvider);
    } else {
      if (!this.codingLlmProvider || this.codingLlmProvider.modelId !== this.codingModelId) {
        if (this.codingLlmProvider) await this.codingLlmProvider.dispose();
        this.codingLlmProvider = new WorkerLlmProvider(this.codingModelId);
        this.jsRuntime.setLlmProvider(this.codingLlmProvider);
      }
      // Loaded lazily on first use: pre-warming a second model during startup doubles GPU memory.
    }

    this.ttsProvider.voiceId = this.voiceId;
    this.orchestrator.setSpeechOutputEnabled(this.speechEnabled);
    this.updateAudioSession();
    if (!this.speechEnabled) this.evictSpeechModels();

    this.stateCoordinator.setModelState('stt', 'ready');
    this.stateCoordinator.setModelState('llm', 'downloading');
    this.stateCoordinator.setModelState('tts', this.speechEnabled ? 'downloading' : 'unloaded');

    // Phone tuning, overridable from the URL for on-device testing:
    //   ?stt=native|whistle   ?chat=270m
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    const sttPref = params?.get('stt');
    // Whistle on every device; the browser's own recognizer only on request (?stt=native)
    if (sttPref === 'native' && NativeSpeechRecognizer.isSupported()) {
      this.setupNativeStt();
    }

    let startLlm: () => Promise<void> = async () => {};
    const hasWebGpu =
      caps.hasWebGPU || (typeof navigator !== 'undefined' && 'gpu' in navigator);

    if (!hasWebGpu) {
      this.stateCoordinator.setModelState('llm', 'failed');
      this.events.onStatusChange?.(
        'WebGPU is required for Gemma 4 local inference. Please use Chrome, Edge, or Safari with WebGPU enabled.'
      );
    } else {
      this.useLocalChat(splitPipeline ? null : this.chatModelId);
      let startupLlm: LlmRuntimeProvider = this.chatLlm;
      // ?pipeline=split: Needle router (CPU) + Gemma 3 1B chat, Qwen coder swapped in
      if (splitPipeline) {
        const phoneModels = new PhoneModelSet({
          smallChat: params?.get('chat') === '270m',
          loadGapMs: AFTER_LOAD_MS,
          onModelLoadStart: writeLoadStage,
        });
        this.phoneModels = phoneModels;
        const chat = new SwappingLlmProvider(phoneModels, phoneModels.chat, 'chat');
        const coder = new SwappingLlmProvider(phoneModels, phoneModels.coder, 'coder');
        this.orchestrator.configurePhonePipeline({
          chat,
          coder,
          router: new TurnRouter(phoneModels.needle),
          chatSystemPrompt: PHONE_CHAT_SYSTEM_PROMPT,
        });
        startupLlm = chat;
      }
      startLlm = () => {
        const ticket = ++this.llmLoadTicket;
        // The model chosen now: Settings may have changed it since the page loaded
        const provider = splitPipeline ? startupLlm : this.chatLlm;
        const modelName = this.getLlmDisplayName();
        writeLlmLoadMarker(this.chatModelId);
        if (!this.phoneModels) writeLoadStage(modelName);
        // Each step of the load is written down as it starts, so a crash on the next visit says
        // which one (see loadStepText)
        let lastStep = '';
        const noteStep = (step: string) => {
          if (this.phoneModels || step === lastStep) return;
          lastStep = step;
          writeLoadStage(`${modelName} (${step})`);
          // On a phone, also in the console, where Web Inspector shows the last step before a crash
          if (isConstrained) console.info(`[Chatty] loading ${modelName}: ${step}`);
        };
        return provider
          .initialize((loaded, total, current?: { label: string; loaded: number; total: number }) => {
            const step = loadStepText((provider as { loadStage?: string }).loadStage ?? '');
            if (step) noteStep(step);
            const pct = total > 0 ? Math.min(100, Math.round((loaded * 100) / total)) : 0;
            const mb = (loaded / (1024 * 1024)).toFixed(0);
            const totalMb = (total / (1024 * 1024)).toFixed(0);
            // The UI renders the status line from this (which model, N of M)
            this.events.onLlmProgress?.(loaded, total, pct, mb, totalMb, current);
          })
          .finally(settleAfterLoad)
          .then(() => {
            clearLlmLoadMarker();
            if (ticket !== this.llmLoadTicket) return;
            clearLoadFailure();
            return this.warmUpChat(provider).then(() => {
              noteStep('getting the sandbox ready');
              if (isConstrained) console.info(`[Chatty] loading ${modelName}: ready`);
              if (ticket !== this.llmLoadTicket) return;
              this.stateCoordinator.setModelState('llm', 'ready');
              this.greetWithoutSpeech();
              const readinessMs = Math.max(1, Math.round(performance.now() - startInit));
              this.orchestrator.recordInitializationTiming(readinessMs, readinessMs);
              this.events.onStatusChange?.(null);
              this.prepareSandboxWhenIdle();
              // The load is done: a crash from here on is named by the activity it happens in
              // (the sandbox, the offline copy, a reply), not blamed on the load
              clearLoadStage();
            });
          })
          .catch((err): Promise<void> | void => {
            clearLlmLoadMarker();
            if (ticket !== this.llmLoadTicket) return;
            console.error(`${modelName} WebGPU initialization failed:`, err);
            const reason = err instanceof Error ? err.message : String(err);
            this.stateCoordinator.setModelState('llm', 'failed');
            this.events.onStatusChange?.(`${modelName} didn't load: ${reason}`);
            // Never retried automatically (a retry can mean another multi-GB download): ask
            if (this.ask(`${modelName} didn't load:\n${reason}\n\nTry again?`)) {
              this.stateCoordinator.setModelState('llm', 'downloading');
              return startLlm();
            }
            recordLoadFailure(`${modelName} didn't load: ${reason}`);
          });
      };
    }

    // 3 & 4. The LLM, then the speech models (Piper, then Whistle), one at a time, never
    // overlapping. The LLM goes first on every device: it is the big download, and the app
    // can't answer without it. With speech off, the speech models aren't loaded at all.
    void this.downloadsAllowed()
      .then(() => startLlm())
      .catch(() => {})
      .then(() =>
        this.speechEnabled ? this.loadSpeechModels() : this.events.onSttLoadSettled?.()
      )
      .finally(clearLoadStage);

    // 5. Visibility and lifecycle handlers
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.stateCoordinator.setLifecycleState('backgrounded');
        } else {
          this.stateCoordinator.setLifecycleState('foregrounded');
        }
      });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', (event) => {
        // A normal close/reload mid-load (or mid-reply) isn't an out-of-memory crash
        clearLlmLoadMarker();
        clearLoadStage();
        clearActivity();
        // A page entering the back/forward cache keeps its models for when it's restored
        if (!event.persisted) void this.dispose();
      });
      window.addEventListener('pageshow', (event) => {
        // Restored from the back/forward cache after dispose (e.g. evicted models): start fresh
        if (event.persisted && this.pageDisposed) window.location.reload();
      });
    }
  }

  /** Waits while the UI holds model downloads (Settings is open). */
  private async downloadsAllowed(): Promise<void> {
    await this.events.beforeModelDownload?.();
  }

  /** Speech is off: its models' downloads are deleted (they download again if it's turned on). */
  private evictSpeechModels(): void {
    this.speechEviction = this.speechEviction
      .then(() => clearSpeechModelCache())
      .then(() => settle(AFTER_HEAVY_MS))
      .catch(() => {});
  }

  /** Piper, then Whistle, one at a time. Stops (and frees them) if speech is turned off meanwhile. */
  private async loadSpeechModels(): Promise<void> {
    await this.speechEviction;
    await this.downloadsAllowed();
    if (!this.speechEnabled) return;
    writeLoadStage('the voice');
    this.stateCoordinator.setModelState('tts', 'downloading');
    await this.ttsProvider
      .initialize((loaded, total) => {
        const pct = total > 0 ? Math.min(100, Math.round((loaded * 100) / total)) : 0;
        const mb = (loaded / (1024 * 1024)).toFixed(0);
        const totalMb = (total / (1024 * 1024)).toFixed(0);
        this.events.onTtsProgress?.(loaded, total, pct, mb, totalMb);
      })
      .finally(settleAfterLoad)
      .then(() => {
        if (this.speechEnabled) this.stateCoordinator.setModelState('tts', 'ready');
      })
      .catch((err) => {
        if (!this.speechEnabled) return; // disposed by turning speech off
        console.warn('Piper ONNX init warning:', err);
        this.stateCoordinator.setModelState('tts', 'failed');
      });
    if (!this.speechEnabled) {
      await this.ttsProvider.dispose();
      return;
    }

    // Whistle (skipped when the browser's recognizer is used)
    if (this.nativeStt) {
      this.events.onSttLoadSettled?.();
      return;
    }
    await this.downloadsAllowed();
    if (!this.speechEnabled) return;
    writeLoadStage('speech recognition');
    this.stateCoordinator.setModelState('stt', 'downloading');
    await this.sttProvider
      .initialize((loaded, total) => this.events.onSttProgress?.(loaded, total))
      .finally(settleAfterLoad)
      .catch((err) => {
        console.warn('Whistle STT pre-warm warning:', err);
      })
      .finally(() => {
        this.stateCoordinator.setModelState('stt', 'ready');
        this.events.onSttLoadSettled?.();
      });
    if (!this.speechEnabled) await this.sttProvider.dispose();
  }

  isSpeechEnabled(): boolean {
    return this.speechEnabled;
  }

  /**
   * Speech on: load Piper and Whistle. Off: stop the mic and any voice, and free both models'
   * memory; chat is typed.
   */
  async setSpeechEnabled(on: boolean): Promise<void> {
    if (on === this.speechEnabled) return;
    this.speechEnabled = on;
    saveSettingsToStorage({ speechEnabled: on });
    try {
      await this.modelManager.db.saveSetting('user_settings', this.getSettings());
    } catch {
      // ignore
    }
    this.orchestrator.setSpeechOutputEnabled(on);
    this.updateAudioSession();
    if (on) {
      await this.loadSpeechModels().finally(clearLoadStage);
      return;
    }
    if (this.isListening) {
      this.nativeStt?.stop();
      this.audioSubsystem.stopMicrophoneCapture();
      this.isListening = false;
      this.stateCoordinator.setMicrophoneState('stopped');
      this.events.onStatusChange?.(null);
    }
    this.audioSubsystem.stopAllPlaybackImmediately();
    await Promise.all([this.ttsProvider.dispose(), this.sttProvider.dispose()]);
    this.stateCoordinator.setModelState('tts', 'unloaded');
    this.evictSpeechModels();
    this.greetWithoutSpeech();
  }

  /** A greeting asked for while models load waits here until they're done */
  private greetWhenLoaded = false;

  /** The chat model is ready and, with speech on, the voice and speech recognition have finished loading (or failed) */
  private modelsLoaded(): boolean {
    const { llm, tts, stt } = this.stateCoordinator.getSnapshot().models;
    const loading = (state: string) => state === 'downloading' || state === 'initializing';
    return llm === 'ready' && (!this.speechEnabled || (!loading(tts) && stt !== 'downloading'));
  }

  /** Adds the welcome message to an empty chat, spoken too when speech is on, once models are loaded. */
  private greet(): void {
    if (this.hasHistory()) return;
    if (!this.modelsLoaded()) {
      this.greetWhenLoaded = true;
      return;
    }
    this.greetWhenLoaded = false;
    const turnId = `welcome_${Date.now()}`;
    const greeting = takeWelcomeMessage();
    const welcomeMsg: ConversationMessage = {
      id: `msg_assistant_${turnId}`,
      turnId,
      role: 'assistant',
      canonicalContent: greeting,
      speechReadyContent: greeting,
      timestamp: Date.now(),
    };
    this.memoryStore.addMessage(welcomeMsg);
    this.events.onMessageCreated?.(welcomeMsg);
    void this.persistState();
    if (this.speechEnabled) void this.orchestrator.speakOutOfTurn(greeting);
  }

  /** With speech off there's no Start press to greet on: greet once the model is ready. */
  private greetWithoutSpeech(): void {
    if (!this.speechEnabled && this.stateCoordinator.getSnapshot().models.llm === 'ready') this.greet();
  }

  /** Routes the browser's speech recognizer into the same STT events Whistle produces. */
  private setupNativeStt(): void {
    let turnId = '';
    this.nativeStt = new NativeSpeechRecognizer({
      onSpeechStart: () => {
        turnId = `voice_turn_${Date.now()}_${++this.speechTurnCounter}`;
        this.events.onStatusChange?.('Speech detected — listening...');
        this.orchestrator.handleSttEvent({ type: 'speech_started', turnId, sequence: 1, timestamp: performance.now() });
      },
      onFinal: (text) => {
        if (!turnId) turnId = `voice_turn_${Date.now()}_${++this.speechTurnCounter}`;
        this.events.onStatusChange?.(null);
        this.showFinalTranscript(text);
        this.orchestrator.handleSttEvent({ type: 'final_transcript', turnId, sequence: 3, timestamp: performance.now(), text });
        turnId = '';
      },
      onError: (message) => {
        this.events.onStatusChange?.(message);
        if (!this.nativeStt?.isActive) {
          this.isListening = false;
          this.stateCoordinator.setMicrophoneState('unavailable');
        }
      },
    });
    // Mute recognition while the assistant thinks or talks, so it doesn't transcribe itself
    this.stateCoordinator.subscribe((snap) => {
      if (!this.nativeStt?.isActive) return;
      const assistantBusy =
        snap.interaction === 'building_context' ||
        snap.interaction === 'generating' ||
        snap.interaction === 'speaking' ||
        snap.interaction === 'compacting' ||
        snap.playback === 'playing' ||
        snap.playback === 'buffering';
      if (assistantBusy) this.nativeStt.pause();
      else this.nativeStt.resume();
    });
  }

  /** Approximate startup LLM download size (bytes), before the download reports its own total. */
  getStartupLlmExpectedBytes(): number {
    if (this.localChat) return findLocalChatModel(this.localChat.modelId)?.sizeBytes ?? 600_000_000;
    if (this.phoneModels) return 35_300_000 + (this.phoneModels.chatSpec.dtype === 'fp16' ? 570_000_000 : 764_000_000);
    return MODEL_REGISTRY.find((m) => m.id === this.chatModelId)?.expectedSizeBytes ?? 2_008_432_640;
  }

  /** Startup models in load order, as the UI labels them ("Loading model N of M"). */
  getStartupModelOrder(): string[] {
    const speech = !this.speechEnabled
      ? []
      : this.nativeStt
        ? ['Piper voice']
        : ['Piper voice', 'Whistle speech recognition'];
    if (this.phoneModels) return [NEEDLE_LABEL, this.phoneModels.chatSpec.label, ...speech];
    return [this.getLlmDisplayName(), ...speech];
  }

  /** Name of the model(s) loading/answering, for status text. */
  /** What the chat model's runtime is doing while it loads (WebLLM only), or '' */
  getLlmLoadStage(): string {
    return (this.chatLlm as { loadStage?: string }).loadStage ?? '';
  }

  getLlmDisplayName(): string {
    if (this.phoneModels) return this.phoneModels.chatSpec.label;
    if (this.localChat) return findLocalChatModel(this.localChat.modelId)?.label ?? this.localChat.modelId;
    return this.chatModelId.includes('e4b') ? 'Gemma 4 E4B' : 'Gemma 4 E2B';
  }

  /** Start/Stop. `greet: false` starts listening without the welcome (a suggestion was tapped) */
  async toggleMicrophone(options?: { greet?: boolean }): Promise<void> {
    const snapshot = this.stateCoordinator.getSnapshot();
    const isBusy =
      snapshot.interaction === 'generating' ||
      snapshot.interaction === 'speaking' ||
      snapshot.interaction === 'compacting' ||
      snapshot.playback === 'playing' ||
      snapshot.playback === 'buffering';

    // 1. If busy generating/speaking/compacting: interrupt immediately on first press
    if (isBusy) {
      this.interrupt('User clicked Stop');
      if (this.isListening) {
        this.nativeStt?.stop();
        this.audioSubsystem.stopMicrophoneCapture();
        this.isListening = false;
        this.stateCoordinator.setMicrophoneState('stopped');
      }
      return;
    }

    // 2. If listening: stop capture cleanly
    if (this.isListening && this.nativeStt) {
      this.nativeStt.stop();
      this.isListening = false;
      this.stateCoordinator.setMicrophoneState('stopped');
      this.stateCoordinator.transitionInteraction('idle', null);
      this.events.onStatusChange?.(null);
      return;
    }
    if (this.isListening) {
      const remaining = this.audioSubsystem.stopMicrophoneCapture();
      this.isListening = false;
      this.stateCoordinator.setMicrophoneState('stopped');
      this.events.onStatusChange?.(null);

      if (remaining && remaining.length > 1600) {
        const turnId = `voice_turn_${Date.now()}_${++this.speechTurnCounter}`;
        void this.transcribeRecordedUtterance(turnId, remaining);
      } else {
        this.stateCoordinator.transitionInteraction('idle', null);
      }
      return;
    }

    // 3. Start capture (speech off: nothing to listen with; the UI hides Start)
    if (!this.speechEnabled) {
      this.greetWithoutSpeech();
      return;
    }
    try {
      this.stateCoordinator.setMicrophoneState('requesting_permission');
      if (this.nativeStt) {
        // The browser's recognizer owns the mic; we only need audio output for speech
        this.nativeStt.start();
        await this.audioSubsystem.ensureAudioContext();
      } else {
        await this.audioSubsystem.startMicrophoneCapture();
      }
      this.isListening = true;
      this.stateCoordinator.setMicrophoneState('listening');
      this.events.onStatusChange?.(this.nativeStt ? 'Listening…' : this.listeningStatus());

      // Greet on Start when the chat is empty (audio system is now set up)
      if (options?.greet !== false) this.greet();
    } catch {
      this.isListening = false;
      this.stateCoordinator.setMicrophoneState('unavailable');
      this.events.onStatusChange?.('Microphone unavailable.');
    }
  }

  private programSounding = false;
  // The program has timers, animation frames or async work pending (onProgramActivity)
  private programRunning = false;
  private lastSessionMic: string | null = null;
  private lastSessionPlayback: string | null = null;
  private lastSessionWorking = false;
  // A program's run, for its start and end sounds: it started, its top level has finished, it
  // kept running past its top level (timers, frames, a loop), and the check for an end once its
  // pending work is reported
  private programLive = false;
  private programReturned = false;
  private programKeptRunning = false;
  private programEndCheck: ReturnType<typeof setTimeout> | null = null;

  /** A short, quiet interface sound (interface-sounds.ts). Never throws: no sound when the audio isn't ready */
  playInterfaceSound(sound: InterfaceSound): void {
    try {
      this.audioSubsystem?.playInterfaceSound(sound);
    } catch {
      // No sound this time
    }
  }

  private programStarted(): void {
    if (this.programEndCheck) clearTimeout(this.programEndCheck);
    this.programEndCheck = null;
    this.programLive = true;
    this.programReturned = false;
    this.programKeptRunning = false;
    this.playInterfaceSound('start');
  }

  /**
   * The program's top level is done: it has ended unless it left work pending. The sandbox
   * reports pending work 200 ms after it starts, so this looks a little later than that.
   */
  private programFinishedTopLevel(): void {
    if (!this.programLive) return;
    this.programReturned = true;
    if (this.programEndCheck) clearTimeout(this.programEndCheck);
    this.programEndCheck = setTimeout(() => {
      this.programEndCheck = null;
      if (!this.programRunning) this.programEnded();
    }, 400);
  }

  /**
   * The program is over. Its end sound plays only when it kept running (an animation, a loop,
   * timers) and then stopped by itself: a drawing done at once has nothing to end, and one
   * cleared away (a new run, Replay, Stop) is followed by its own sounds
   */
  private programEnded(sound = true): void {
    if (this.programEndCheck) clearTimeout(this.programEndCheck);
    this.programEndCheck = null;
    if (!this.programLive) return;
    const keptRunning = this.programKeptRunning;
    this.programLive = false;
    this.programReturned = false;
    this.programKeptRunning = false;
    if (sound && keptRunning) this.playInterfaceSound('end');
  }

  /**
   * The browser's audio session follows what is happening: 'play-and-record' only while the mic
   * is on (Safari keeps the output quiet in it when nothing records, so text-mode sound was
   * silent), 'playback' while Chatty's voice or a program sounds, 'auto' otherwise (iOS would show
   * a lock-screen player for 'playback' with nothing playing)
   */
  private updateAudioSession(): void {
    const snap = this.stateCoordinator.getSnapshot();
    const micOn = snap.microphone === 'listening' || snap.microphone === 'requesting_permission';
    const sounding = this.programSounding || snap.playback === 'playing' || snap.playback === 'buffering';
    this.audioSubsystem?.setAudioSessionType(micOn ? 'play-and-record' : sounding ? 'playback' : 'auto');
    // The shared context sleeps once none of these has held it awake for a while. A turn holds it
    // from the tap that sent it: the program it writes may play sound long after that tap, and
    // Safari may not wake a sleeping context outside one
    this.audioSubsystem?.setAudioInUse(micOn || sounding || this.programRunning || turnWorking(snap));
  }

  /** The audio for tools; asking for it holds the context awake for a tune (see TOOL_AUDIO_HOLD_MS) */
  private toolAudioContext = (): Promise<AudioContext> => {
    this.audioSubsystem.holdAudio(TOOL_AUDIO_HOLD_MS);
    return this.audioSubsystem.ensureAudioContext();
  };

  /** What programs did, as text (see run-log.ts) */
  getRunLog(): string {
    return runLogText();
  }

  async submitText(text: string): Promise<ConversationMessage | null> {
    try {
      await this.audioSubsystem.ensureAudioContext();
    } catch {
      // AudioContext unavailable in test/headless environments
    }
    return this.orchestrator.submitUserInput(text, { isVoiceTranscript: false });
  }

  /** "Listening (echo cancellation on, mic 48 kHz)", from what the browser actually applied. */
  private listeningStatus(): string {
    const mic = this.audioSubsystem.getMicrophoneSettings();
    console.info('[Chatty] microphone settings', mic);
    if (!mic) return 'Listening…';
    const echo =
      mic.echoCancellation === undefined
        ? 'echo cancellation unknown'
        : `echo cancellation ${mic.echoCancellation ? 'on' : 'OFF'}`;
    const rate = mic.sampleRate ?? mic.contextRate;
    return `Listening (${echo}${rate ? `, mic ${Math.round(rate / 1000)} kHz` : ''})`;
  }

  /**
   * True when Chatty's audio played during the utterance, or ended just before it began: what
   * the mic heard may be Chatty's own voice (phone speakers defeat echo cancellation).
   */
  private utteranceOverlappedPlayback(): boolean {
    return this.playbackActive || this.playbackLastActiveAt > this.utteranceStartedAt - 800;
  }

  /** Shows a final transcript only if it will be sent (ignored ones and stop words aren't). */
  private showFinalTranscript(text: string, heardDuringPlayback = false): void {
    const action = classifyTranscript(text, this.orchestrator.isAssistantBusy(), heardDuringPlayback);
    this.events.onTranscript?.(action === 'submit' ? text : '', true);
  }

  interrupt(reason = 'User stopped response'): void {
    this.compactionAbort?.abort();
    this.audioSubsystem.stopAllPlaybackImmediately();
    this.orchestrator.interruptCurrentTurn(reason);
    this.stateCoordinator.transitionInteraction('idle', null);
    this.stateCoordinator.setPlaybackState('stopped');
    this.events.onStatusChange?.(null);
  }

  private async transcribeRecordedUtterance(
    turnId: string,
    samples16k: Float32Array,
    heardDuringPlayback = false
  ): Promise<void> {
    try {
      this.stateCoordinator.setModelState('stt', 'initializing');
      const result = await this.sttProvider.transcribe(
        samples16k,
        16000,
        this.selectedLanguage
      );
      this.stateCoordinator.setModelState('stt', 'ready');
      this.events.onStatusChange?.(null);

      const text = result.text.trim();
      if (text) {
        this.showFinalTranscript(text, heardDuringPlayback);
        this.orchestrator.handleSttEvent({
          type: 'final_transcript',
          turnId,
          sequence: 3,
          timestamp: performance.now(),
          text,
          language: result.language,
          words: result.words,
          durationMs: result.latencyMs,
          heardDuringPlayback,
        });
      } else {
        this.stateCoordinator.transitionInteraction('idle', null);
      }
    } catch (err) {
      this.stateCoordinator.setModelState('stt', 'ready');
      this.events.onStatusChange?.(null);
      this.orchestrator.handleSttEvent({
        type: 'error',
        turnId,
        sequence: 3,
        timestamp: performance.now(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getInputWaveformData(target: Float32Array): number {
    return this.audioSubsystem.getInputWaveformData(target);
  }

  getOutputWaveformData(target: Float32Array): number {
    return this.audioSubsystem.getOutputWaveformData(target);
  }

  getIsListening(): boolean {
    return this.isListening;
  }

  getSnapshot(): CoordinatedStateSnapshot {
    return this.stateCoordinator.getSnapshot();
  }

  getMessages(): ReadonlyArray<ConversationMessage> {
    return this.memoryStore.getMessages();
  }

  getSummary() {
    return this.memoryStore.getSummary();
  }

  hasHistory(): boolean {
    return this.memoryStore.getMessages().length > 0 || this.memoryStore.getSummary() !== null;
  }

  getContextUsage(): { usedTokens: number; contextLimit: number; percentage: number } {
    const limit = this.chatLlm.contextLimit || 8192;
    const used = this.memoryStore.getCurrentContextTokens();
    const percentage = Math.min(100, Math.round((used / limit) * 100));
    return { usedTokens: used, contextLimit: limit, percentage };
  }

  /**
   * Generates a concise title (3 to 6 words) for the chat based on the current
   * conversation text or the summary after compaction, using Gemma to perform the summarization.
   */
  async generateTitle(options?: {
    text?: string;
    summary?: string;
    signal?: AbortSignal;
  }): Promise<string> {
    return this.orchestrator.generateConversationTitle(options);
  }

  setSpeechOutputEnabled(enabled: boolean): void {
    this.orchestrator.setSpeechOutputEnabled(enabled);
    if (!enabled) {
      this.audioSubsystem.stopAllPlaybackImmediately();
    }
  }

  setLanguage(lang: SupportedLanguage): void {
    this.selectedLanguage = lang;
  }

  async resetConversation(clearMemories = true): Promise<void> {
    if (this.isListening) {
      this.audioSubsystem.stopMicrophoneCapture();
      this.isListening = false;
      this.stateCoordinator.setMicrophoneState('stopped');
    }
    this.interrupt('User reset conversation');
    this.cancelPendingPersist();

    this.memoryStore.clearConversation();
    if (clearMemories) {
      this.memoryStore.clearAllMemories();
    }

    const active = this.conversations.get(this.activeConversationId);
    if (active) {
      active.messages = [];
      active.summary = null;
      active.title = 'New Chat';
      active.updatedAt = Date.now();
      try {
        await this.modelManager.db.saveConversation(active);
      } catch {}
    }

    this.stateCoordinator.transitionInteraction('idle', null);
    this.stateCoordinator.setPlaybackState('stopped');

    try {
      await this.modelManager.db.clearConversationSnapshot();
      if (clearMemories) {
        await this.modelManager.db.saveMemories([]);
      }
    } catch {
      // Ignore storage errors in private browsing
    }

    this.events.onConversationsChanged?.(this.getConversations());
    this.events.onStatusChange?.(null);
  }

  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private persistEpoch = 0;

  /** Debounced: coalesces per-token message updates into at most one write per ~500ms. */
  persistState(immediate = false): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    const run = () => {
      this.persistTimer = null;
      const epoch = this.persistEpoch;
      this.persistChain = this.persistChain.then(async () => {
        if (epoch !== this.persistEpoch) return; // conversation was reset meanwhile
        try {
          const currentMessages = [...this.memoryStore.getMessages()];
          const currentSummary = this.memoryStore.getSummary();
          const active = this.conversations.get(this.activeConversationId);
          if (active) {
            active.messages = currentMessages;
            active.summary = currentSummary;
            active.updatedAt = Date.now();
            await this.modelManager.db.saveConversation(active);
            this.events.onConversationsChanged?.(this.getConversations());
          }
          await this.modelManager.db.saveConversationSnapshot(
            currentMessages,
            currentSummary
          );
          await this.modelManager.db.saveMemories(this.memoryStore.getAllMemories());
        } catch {
          // Ignore storage errors in private browsing
        }
      });
      return this.persistChain;
    };
    if (immediate) return run();
    this.persistTimer = setTimeout(run, 500);
    return Promise.resolve();
  }

  private cancelPendingPersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.persistEpoch++;
  }

  getConversations(): StoredConversation[] {
    const list = Array.from(this.conversations.values());
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
  }

  getActiveConversationId(): string {
    return this.activeConversationId;
  }

  getActiveConversation(): StoredConversation | null {
    return this.conversations.get(this.activeConversationId) ?? null;
  }

  async createConversation(title = 'New Chat'): Promise<StoredConversation> {
    if (this.isListening) {
      this.audioSubsystem.stopMicrophoneCapture();
      this.isListening = false;
      this.stateCoordinator.setMicrophoneState('stopped');
    }
    this.interrupt('Created new conversation');
    await this.persistState(true);

    const newChat: StoredConversation = {
      id: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      summary: null,
    };

    this.conversations.set(newChat.id, newChat);
    this.activeConversationId = newChat.id;
    this.memoryStore.clearConversation();
    for (const old of this.getConversations().slice(MAX_CHATS)) {
      this.conversations.delete(old.id);
      try {
        await this.modelManager.db.deleteConversation(old.id);
      } catch {}
    }

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('chatty_active_chat_id', newChat.id);
      } catch {}
    }

    try {
      await this.modelManager.db.saveConversation(newChat);
    } catch {}

    this.events.onConversationsChanged?.(this.getConversations());
    this.events.onActiveConversationSwitched?.(newChat);
    this.events.onStatusChange?.(null);
    this.greetWithoutSpeech();
    return newChat;
  }

  async switchConversation(id: string): Promise<boolean> {
    if (id === this.activeConversationId) return true;

    let target = this.conversations.get(id);
    if (!target) {
      try {
        target = (await this.modelManager.db.loadConversation(id)) ?? undefined;
        if (target) this.conversations.set(target.id, target);
      } catch {}
    }
    if (!target) return false;

    if (this.isListening) {
      this.audioSubsystem.stopMicrophoneCapture();
      this.isListening = false;
      this.stateCoordinator.setMicrophoneState('stopped');
    }
    this.interrupt('Switched conversation');
    await this.persistState(true);

    this.activeConversationId = target.id;
    this.memoryStore.loadConversation(target.messages, target.summary);

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('chatty_active_chat_id', target.id);
      } catch {}
    }

    this.events.onConversationsChanged?.(this.getConversations());
    this.events.onActiveConversationSwitched?.(target);
    this.events.onStatusChange?.(null);
    return true;
  }

  /** Deletes every chat and starts a new one */
  async clearAllConversations(): Promise<StoredConversation> {
    this.interrupt('Cleared all conversations');
    this.cancelPendingPersist();
    this.memoryStore.clearConversation();
    const ids = [...this.conversations.keys()];
    this.conversations.clear();
    for (const id of ids) {
      try {
        await this.modelManager.db.deleteConversation(id);
      } catch {}
    }
    return this.createConversation('New Chat');
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
    try {
      await this.modelManager.db.deleteConversation(id);
    } catch {}

    if (id === this.activeConversationId) {
      const remaining = this.getConversations();
      if (remaining.length > 0) {
        await this.switchConversation(remaining[0].id);
      } else {
        await this.createConversation('New Chat');
      }
    } else {
      this.events.onConversationsChanged?.(this.getConversations());
    }
  }

  async renameConversation(id: string, newTitle: string): Promise<void> {
    const convo = this.conversations.get(id);
    if (!convo) return;
    convo.title = newTitle;
    convo.updatedAt = Date.now();
    try {
      await this.modelManager.db.saveConversation(convo);
    } catch {}
    this.events.onConversationsChanged?.(this.getConversations());
  }

  async compactConversation(id?: string): Promise<void> {
    const targetId = id || this.activeConversationId;
    if (targetId !== this.activeConversationId) {
      await this.switchConversation(targetId);
    }
    this.compactionAbort?.abort();
    const compactionAbort = new AbortController();
    this.compactionAbort = compactionAbort;
    try {
      await this.orchestrator.forceCompaction(compactionAbort.signal);
    } finally {
      if (this.compactionAbort === compactionAbort) this.compactionAbort = null;
    }
    const active = this.conversations.get(this.activeConversationId);
    if (active) {
      active.messages = [...this.memoryStore.getMessages()];
      active.summary = this.memoryStore.getSummary();
      active.updatedAt = Date.now();
      try {
        await this.modelManager.db.saveConversation(active);
      } catch {}
      this.events.onConversationsChanged?.(this.getConversations());
    }
  }

  setJsRuntimeMode(mode: JavascriptExecutionMode): void {
    this.jsRuntime.setMode(mode);
  }

  getJsRuntimeMode(): JavascriptExecutionMode {
    return this.jsRuntime.getMode();
  }

  setJsRuntimeContainer(container: HTMLElement | null): void {
    this.jsRuntime.setIframeContainer(container);
  }

  getActiveIframe(): HTMLIFrameElement | null {
    return this.jsRuntime.getActiveIframe();
  }

  clearVisualScreen(): void {
    const iframe = this.jsRuntime.getActiveIframe();
    if (iframe?.contentDocument) {
      const root = iframe.contentDocument.getElementById('root');
      if (root) {
        root.innerHTML = '';
      }
    }
    this.events.onJavascriptVisualChange?.(false, iframe ?? null);
  }

  async executeJavascript(
    code: string,
    callback?: (result: JavascriptExecutionResult) => void
  ): Promise<JavascriptExecutionResult> {
    return this.jsRuntime.execute(code, callback);
  }

  /** The program in the card as a self-contained HTML file, or null when there's none to download */
  programHtml(): Promise<string | null> {
    return this.jsRuntime.standaloneHtml();
  }

  /** Whether this chat has a program Replay can run again */
  canReplay(): boolean {
    return this.orchestrator.replayableProgram() !== null;
  }

  /** Runs this chat's newest program again, without the model */
  replayLastProgram(): Promise<boolean> {
    return this.orchestrator.replayLastProgram();
  }

  getChatModelId(): string {
    return this.chatModelId;
  }

  getCodingModelId(): string {
    return this.codingModelId;
  }

  getVoiceId(): string {
    return this.voiceId;
  }

  getSettings(): ChattySettings {
    return {
      chatModelId: this.chatModelId,
      codingModelId: this.codingModelId,
      voiceId: this.voiceId,
      speechEnabled: this.speechEnabled,
      sidebarOpen: this.sidebarOpen,
    };
  }

  getSidebarOpen(): boolean {
    return this.sidebarOpen;
  }

  setSidebarOpen(open: boolean): void {
    this.sidebarOpen = open;
    saveSettingsToStorage({ sidebarOpen: open });
  }

  /** The model answering turns on desktop: Gemma 4 (LiteRT), or Qwen2.5-Coder when picked. */
  /**
   * One tiny generation right after a WebLLM model loads, so the first-generation GPU cost
   * (pipeline compiles, KV cache) is paid while nothing else is happening. Not a chat turn:
   * not streamed, logged or remembered. It runs in the WebLLM worker, which catches and logs a
   * failure. WebLLM only (LiteRT skipped). Off (WARM_UP_AFTER_LOAD) while iPhone Safari's tab
   * crashes are being narrowed down: the first reply pays the cost instead.
   */
  private async warmUpChat(provider: LlmRuntimeProvider): Promise<void> {
    if (!WARM_UP_AFTER_LOAD) return;
    if (!(provider instanceof WebLlmProvider) || provider !== this.localChat) return;
    // iPhone/iPad Safari: a full second after the load before the first run (the load's own pause
    // is AFTER_LOAD_MS), the step where its tab was being killed
    await settleOnIos(1000 - AFTER_LOAD_MS);
    try {
      await withActivity('warming up the model', () => provider.warmUp());
    } catch (err) {
      console.warn('Model warm-up failed (ignored):', err);
    }
    await settle(AFTER_HEAVY_MS);
  }

  /** Builds the sandbox iframe while idle, so the first program doesn't build it right after a reply */
  private prepareSandboxWhenIdle(): void {
    // Recorded while its page loads, so a crash then is named on the next visit (the load's own
    // breadcrumb is cleared by now)
    const run = () =>
      void withActivity('getting the sandbox ready', async () => {
        try {
          this.jsRuntime.prepare();
        } catch (err) {
          console.warn('Sandbox pre-build failed (ignored):', err);
        }
        await settle(1500);
      });
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof ric === 'function') ric(run, { timeout: 2000 });
    else setTimeout(run, AFTER_HEAVY_MS);
  }

  private get chatLlm(): LlmRuntimeProvider {
    return this.localChat ?? this.llmProvider;
  }

  /** Points the conversation and the JS runtime at a WebLLM chat model, or at Gemma 4 (null). */
  private useLocalChat(modelId: string | null): void {
    const model = modelId ? findLocalChatModel(modelId) : undefined;
    if (this.localChat && this.localChat.modelId !== model?.id) {
      void this.localChat.dispose();
      this.localChat = null;
    }
    if (model && !this.localChat) {
      // Models WebLLM has no build of run with Transformers.js (ONNX) instead
      this.localChat = model.onnx
        ? new OnnxLlmProvider(model.id, {
            repo: model.onnx.repo,
            dtype: model.onnx.dtype,
            contextLimit: model.contextLimit,
            maxOutputTokens: model.maxOutputTokens,
          })
        : new WebLlmProvider(model.id, model);
    }
    this.orchestrator.setLlmProvider(this.chatLlm);
    this.jsRuntime.setLlmProvider(this.chatLlm);
  }

  /** Every chat model, on every device, smallest download first (names mark the phone-sized ones) */
  getChatModelOptions(): ModelOptionItem[] {
    return [...SUPPORTED_CHAT_MODELS].sort((a, b) => (a.downloadBytes ?? Infinity) - (b.downloadBytes ?? Infinity));
  }

  async setChatModelId(modelId: string): Promise<void> {
    if (this.chatModelId === modelId && this.llmProvider.modelId === modelId) return;
    this.chatModelId = modelId;
    // The coder follows the chat model, so only one model is ever resident.
    this.codingModelId = modelId;
    this.llmProvider.modelId = modelId;
    const manifest = MODEL_REGISTRY.find((m) => m.id === modelId);
    if (manifest) {
      this.llmProvider.contextLimit = manifest.contextWindowTokens;
      this.llmProvider.maxOutputTokens = manifest.maxOutputTokens;
    }
    saveSettingsToStorage({ chatModelId: modelId });
    try {
      await this.modelManager.db.saveSetting('user_settings', this.getSettings());
    } catch {
      // ignore
    }

    const localModel = findLocalChatModel(modelId);
    if (localModel || this.localChat) {
      // One chat model in GPU memory: unload the current one before the next loads
      if (localModel) await this.llmProvider.dispose();
      if (this.localChat && this.localChat.modelId !== localModel?.id) await this.localChat.dispose();
      this.useLocalChat(localModel?.id ?? null);
      await settle(AFTER_HEAVY_MS);
    }

    if (this.codingModelId === modelId) {
      if (this.codingLlmProvider) {
        await this.codingLlmProvider.dispose();
        this.codingLlmProvider = null;
      }
      this.jsRuntime.setLlmProvider(this.chatLlm);
    } else if (!this.codingLlmProvider) {
      // Coder shared the chat provider and the models now diverge: pin it to its own provider
      this.codingLlmProvider = new WorkerLlmProvider(this.codingModelId);
      this.jsRuntime.setLlmProvider(this.codingLlmProvider);
      const gpu =
        typeof navigator !== 'undefined' && 'gpu' in (navigator as unknown as { gpu?: unknown });
      if (gpu) {
        void this.codingLlmProvider.initialize().catch((err) => {
          console.warn('Coding subagent provider pre-warm warning:', err);
        });
      }
    }

    void this.loadChatModel();
  }

  /** Loads (downloading if needed) the current chat model, reporting progress like startup. */
  private loadChatModel(): Promise<void> {
    const hasWebGpu =
      typeof navigator !== 'undefined' && 'gpu' in (navigator as unknown as { gpu?: unknown });

    if (!hasWebGpu) {
      this.stateCoordinator.setModelState('llm', 'failed');
      return Promise.resolve();
    }

    this.stateCoordinator.setModelState('llm', 'downloading');
    const modelName = this.getLlmDisplayName();
    const load = (): Promise<void> => {
      const ticket = ++this.llmLoadTicket;
      return this.chatLlm
        .initialize((loaded, total) => {
          const pct = total > 0 ? Math.min(100, Math.round((loaded * 100) / total)) : 0;
          const mb = (loaded / (1024 * 1024)).toFixed(0);
          const totalMb = (total / (1024 * 1024)).toFixed(0);
          // Same status line and meter as startup loading (with live MB/s)
          this.events.onLlmProgress?.(loaded, total, pct, mb, totalMb, { label: modelName, loaded, total });
        })
        .finally(settleAfterLoad)
        .then(() => {
          if (ticket !== this.llmLoadTicket) return;
          clearLoadFailure();
          return this.warmUpChat(this.chatLlm).then(() => {
            if (ticket !== this.llmLoadTicket) return;
            this.stateCoordinator.setModelState('llm', 'ready');
            this.events.onStatusChange?.(null);
            this.prepareSandboxWhenIdle();
          });
        })
        .catch((err): Promise<void> | void => {
          if (ticket !== this.llmLoadTicket) return;
          const reason = err instanceof Error ? err.message : String(err);
          this.stateCoordinator.setModelState('llm', 'failed');
          this.events.onStatusChange?.(`${modelName} didn't load: ${reason}`);
          // Never retried automatically: ask
          if (this.ask(`${modelName} didn't load:\n${reason}\n\nTry again?`)) {
            this.stateCoordinator.setModelState('llm', 'downloading');
            return load();
          }
          recordLoadFailure(`${modelName} didn't load: ${reason}`);
        });
    };
    return load();
  }

  /**
   * The downloaded models were deleted (Settings → Clear model cache): download the loaded ones
   * again now, the chat model first, then speech if it's on. Models still loading (a new pick,
   * startup) download anyway.
   */
  async refetchModels(): Promise<void> {
    if (!this.started || this.phoneModels) return;
    const models = this.stateCoordinator.getSnapshot().models;
    if (models.llm === 'ready') {
      await this.chatLlm.dispose();
      await settle(AFTER_HEAVY_MS);
      await this.loadChatModel();
    }
    if (this.speechEnabled && models.tts === 'ready') {
      await Promise.all([this.ttsProvider.dispose(), this.sttProvider.dispose()]);
      await settle(AFTER_HEAVY_MS);
      await this.loadSpeechModels().finally(clearLoadStage);
    }
  }

  /** Asks the user a yes/no question; without a UI to answer, the answer is no. */
  private ask(message: string): boolean {
    return this.events.onConfirm?.(message) ?? false;
  }

  async setCodingModelId(modelId: string): Promise<void> {
    if (this.codingModelId === modelId) return;
    this.codingModelId = modelId;
    saveSettingsToStorage({ codingModelId: modelId });
    try {
      await this.modelManager.db.saveSetting('user_settings', this.getSettings());
    } catch {
      // ignore
    }

    if (modelId === this.chatModelId) {
      if (this.codingLlmProvider) {
        await this.codingLlmProvider.dispose();
        this.codingLlmProvider = null;
      }
      this.jsRuntime.setLlmProvider(this.llmProvider);
    } else {
      if (this.codingLlmProvider) {
        await this.codingLlmProvider.dispose();
      }
      this.codingLlmProvider = new WorkerLlmProvider(modelId);
      this.jsRuntime.setLlmProvider(this.codingLlmProvider);
      const hasWebGpu =
        typeof navigator !== 'undefined' && 'gpu' in (navigator as unknown as { gpu?: unknown });
      if (hasWebGpu) {
        void this.codingLlmProvider.initialize().catch((err) => {
          console.warn('Coding subagent provider pre-warm warning:', err);
        });
      }
    }
  }

  async setVoiceId(voiceId: string): Promise<void> {
    if (this.voiceId === voiceId && this.ttsProvider.voiceId === voiceId) return;
    this.voiceId = voiceId;
    this.ttsProvider.voiceId = voiceId;
    saveSettingsToStorage({ voiceId });
    try {
      await this.modelManager.db.saveSetting('user_settings', this.getSettings());
    } catch {
      // ignore
    }
    // Speech off: remembered for when it's turned back on
    if (!this.speechEnabled) return;

    this.stateCoordinator.setModelState('tts', 'downloading');
    void this.ttsProvider
      .initialize((loaded, total) => {
        const pct = total > 0 ? Math.min(100, Math.round((loaded * 100) / total)) : 0;
        const mb = (loaded / (1024 * 1024)).toFixed(0);
        const totalMb = (total / (1024 * 1024)).toFixed(0);
        this.events.onTtsProgress?.(loaded, total, pct, mb, totalMb);
        this.events.onStatusChange?.(
          `Pulling Piper Voice: ${mb} / ${totalMb} MB (${pct}%)...`
        );
      })
      .finally(settleAfterLoad)
      .then(() => {
        this.stateCoordinator.setModelState('tts', 'ready');
        this.events.onStatusChange?.(null);
      })
      .catch((err) => {
        console.warn('Piper ONNX change warning:', err);
        this.stateCoordinator.setModelState('tts', 'failed');
      });
  }

  /**
   * Why the last visit ended badly, if it did: the page stopped mid-load or mid-reply (probably
   * out of memory), or a model load failed. Read before initialize(), which clears it.
   */
  getLastLoadProblem(): string | null {
    try {
      const stage = localStorage.getItem(LOAD_STAGE_KEY);
      if (stage || localStorage.getItem(LLM_LOAD_MARKER_KEY)) {
        return `Last time, loading ${stage ?? 'the model'} stopped the page (probably out of memory).`;
      }
      const failed = localStorage.getItem(LAST_LOAD_FAILED_KEY);
      if (failed) return `Last time, ${failed}.`;
      const activity = readInterruptedActivity();
      return activity ? `Last time, the page stopped while ${activity} (probably out of memory).` : null;
    } catch {
      return null;
    }
  }

  /** Detects the device class early (before initialize), so the settings picker lists the right models. */
  async detectDevice(): Promise<void> {
    const caps = await this.modelManager.detectCapabilities();
    this.isPhone = caps.deviceProfile === 'constrained_mobile';
    if (this.isPhone) this.chatModelId = resolvePhoneChatModelId(loadChatModelChoice());
    // Speech starts off on phones (less memory); Settings can turn it on
    if (this.isPhone && loadSpeechChoice() === null) this.speechEnabled = false;
  }

  async updateSettings(settings: Partial<ChattySettings>): Promise<void> {
    if (!this.started) {
      // Picked before startup (first-visit settings): just remember them; initialize() loads them
      if (settings.chatModelId) this.chatModelId = settings.chatModelId;
      if (settings.codingModelId) this.codingModelId = settings.codingModelId;
      if (settings.voiceId) this.voiceId = settings.voiceId;
      if (typeof settings.speechEnabled === 'boolean') this.speechEnabled = settings.speechEnabled;
      saveSettingsToStorage({
        // Only a model passed in is the user's choice; the one held in memory may be a default
        ...(settings.chatModelId ? { chatModelId: this.chatModelId } : {}),
        codingModelId: this.codingModelId,
        voiceId: this.voiceId,
        speechEnabled: this.speechEnabled,
      });
      try {
        await this.modelManager.db.saveSetting('user_settings', this.getSettings());
      } catch {
        // ignore
      }
      return;
    }
    const promises: Promise<void>[] = [];
    // First, so a voice change made with speech off doesn't load Piper
    if (typeof settings.speechEnabled === 'boolean' && settings.speechEnabled !== this.speechEnabled) {
      promises.push(this.setSpeechEnabled(settings.speechEnabled));
    }
    if (settings.chatModelId && settings.chatModelId !== this.chatModelId) {
      promises.push(this.setChatModelId(settings.chatModelId));
    }
    if (settings.codingModelId && settings.codingModelId !== this.codingModelId) {
      promises.push(this.setCodingModelId(settings.codingModelId));
    }
    if (settings.voiceId && settings.voiceId !== this.voiceId) {
      promises.push(this.setVoiceId(settings.voiceId));
    }
    await Promise.all(promises);
  }

  async dispose(): Promise<void> {
    this.pageDisposed = true;
    void this.persistState(true);
    this.audioSubsystem.stopMicrophoneCapture();
    this.audioSubsystem.stopAllPlaybackImmediately();
    this.jsRuntime.dispose();
    if (this.codingLlmProvider) {
      await this.codingLlmProvider.dispose();
    }
    await this.llmProvider.dispose();
    await this.localChat?.dispose();
    await this.phoneModels?.dispose();
    await this.ttsProvider.dispose();
  }
}

