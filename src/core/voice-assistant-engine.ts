// ============================================================================
// Core Voice Assistant Engine: Unified Reusable Module
// Encapsulates ModelManager, StateMachineCoordinator, ConversationMemoryStore,
// Whistle STT, Worker LLM (LiteRT-LM Gemma 4 WebGPU), Worker TTS (Piper ONNX),
// and SharedAudioSubsystem (VAD, 16kHz resampling, gapless playback).
// ============================================================================

import { SharedAudioSubsystem } from '../audio/audio-subsystem.ts';
import { ConversationMemoryStore } from './memory-store.ts';
import { ModelManager } from './model-manager.ts';
import { ConversationOrchestrator } from './orchestrator.ts';
import { StateMachineCoordinator, type CoordinatedStateSnapshot } from './state-machine.ts';
import { WhistleSttProvider } from '../runtimes/stt-provider.ts';
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
import { MODEL_REGISTRY } from './model-manager.ts';
import {
  type ChattySettings,
  DEFAULT_SETTINGS,
  loadSettingsFromStorage,
  saveSettingsToStorage,
} from './settings.ts';
import type {
  BrowserCapabilities,
  ConversationMessage,
  StoredConversation,
  SupportedLanguage,
  SystemTelemetry,
} from '../types/index.ts';

const WELCOME_MESSAGE =
  'Welcome to Chatty, I can do anything your browser can do. For example: ask me to make MIDI music, ' +
  'use oscillators and other Web Audio tools, draw 3D scenes, animate motion, ' +
  'look up things in Wikipedia or DuckDuckGo and more!';

// Set while the LLM is loading; still present on the next start means the tab was killed mid-load.
const LLM_LOAD_MARKER_KEY = 'chatty_llm_loading';
function writeLlmLoadMarker(modelId: string): void {
  try {
    localStorage.setItem(LLM_LOAD_MARKER_KEY, modelId);
  } catch {
    // Storage unavailable (private mode)
  }
}
function readLlmLoadMarker(): string | null {
  try {
    return localStorage.getItem(LLM_LOAD_MARKER_KEY);
  } catch {
    return null;
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
  onMessageCreated?: (message: ConversationMessage) => void;
  onMessageUpdated?: (message: ConversationMessage) => void;
  onTelemetryUpdated?: (telemetry: SystemTelemetry) => void;
  onError?: (error: Error, context: string) => void;
  onCapabilitiesDetected?: (caps: BrowserCapabilities) => void;
  onLlmProgress?: (loaded: number, total: number, pct: number, mb: string, totalMb: string) => void;
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
  private selectedLanguage: SupportedLanguage = 'en';
  private currentInputRms = 0;
  private currentOutputRms = 0;
  private speechTurnCounter = 0;
  private events: VoiceAssistantEngineEvents;

  private chatModelId: string = DEFAULT_SETTINGS.chatModelId;
  private codingModelId: string = DEFAULT_SETTINGS.codingModelId;
  private voiceId: string = DEFAULT_SETTINGS.voiceId;
  private sidebarOpen: boolean = DEFAULT_SETTINGS.sidebarOpen;
  private codingLlmProvider: WorkerLlmProvider | null = null;

  private activeConversationId = 'chat_default';
  private compactionAbort: AbortController | null = null;
  private conversations = new Map<string, StoredConversation>();

  constructor(events?: VoiceAssistantEngineEvents) {
    this.events = events ?? {};

    const initialSettings = loadSettingsFromStorage();
    this.chatModelId = initialSettings.chatModelId;
    this.codingModelId = initialSettings.codingModelId;
    this.voiceId = initialSettings.voiceId;
    this.sidebarOpen = initialSettings.sidebarOpen;

    this.jsRuntime = new JavascriptRuntime({
      mode: 'iframe',
      onResult: (res) => {
        this.events.onJavascriptExecution?.(res);
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
        void this.transcribeRecordedUtterance(turnId, utterance16k);
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
      javascriptRuntime: this.jsRuntime,
      audioContextAccessor: () => this.audioSubsystem.ensureAudioContext(),
      tools: [],
      getConversationId: () => this.activeConversationId,
      shouldAutoTitle: (conversationId) => {
        const convo = this.conversations.get(conversationId);
        return !!convo && (convo.title === 'New Chat' || convo.title === 'Conversation');
      },
      events: {
        onMessageCreated: (msg) => {
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
      audioContextAccessor: () => this.audioSubsystem.ensureAudioContext(),
    });

    // Subscribe to state machine changes
    this.stateCoordinator.subscribe((snapshot) => {
      this.events.onStateChange?.(snapshot);
    });
  }

  async initialize(): Promise<void> {
    const startInit = performance.now();

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
        const storedActiveId =
          typeof localStorage !== 'undefined'
            ? localStorage.getItem('chatty_active_chat_id')
            : null;
        if (storedActiveId && this.conversations.has(storedActiveId)) {
          this.activeConversationId = storedActiveId;
        } else {
          this.activeConversationId = savedConvos[0].id;
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
    // Phones can't hold E4B: a mobile tab is killed long before device RAM runs out.
    if (isConstrained && this.chatModelId !== recommended.llmModelId) {
      this.chatModelId = recommended.llmModelId;
    }

    // Crash-loop guard: the marker is set while the LLM loads and cleared once it settles. If it
    // is still present, the tab died mid-load (out of memory), so retry with the smaller model
    // instead of crashing again on every visit.
    const crashedLoad = readLlmLoadMarker();
    if (crashedLoad) {
      if (this.chatModelId !== recommended.fallbackLlmModelId) {
        this.chatModelId = recommended.fallbackLlmModelId;
      }
      this.events.onStatusChange?.(
        'The last model load ran out of memory; retrying with the smaller model.'
      );
    }
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

    this.stateCoordinator.setModelState('stt', 'ready');
    this.stateCoordinator.setModelState('llm', 'downloading');
    this.stateCoordinator.setModelState('tts', 'downloading');

    let llmInitDone: Promise<void> | null = null;
    const hasWebGpu =
      caps.hasWebGPU || (typeof navigator !== 'undefined' && 'gpu' in navigator);

    if (!hasWebGpu) {
      this.stateCoordinator.setModelState('llm', 'failed');
      this.events.onStatusChange?.(
        'WebGPU is required for Gemma 4 local inference. Please use Chrome, Edge, or Safari with WebGPU enabled.'
      );
    } else {
      const modelName = this.chatModelId.includes('e4b') ? 'Gemma 4 E4B' : 'Gemma 4 E2B';
      writeLlmLoadMarker(this.chatModelId);
      llmInitDone = this.llmProvider
        .initialize((loaded, total) => {
          const pct = total > 0 ? Math.min(100, Math.round((loaded * 100) / total)) : 0;
          const mb = (loaded / (1024 * 1024)).toFixed(0);
          const totalMb = (total / (1024 * 1024)).toFixed(0);
          this.events.onLlmProgress?.(loaded, total, pct, mb, totalMb);
          this.events.onStatusChange?.(
            `Pulling ${modelName} WebGPU to OPFS: ${mb} / ${totalMb} MB (${pct}%)...`
          );
        })
        .then(() => {
          clearLlmLoadMarker();
          this.stateCoordinator.setModelState('llm', 'ready');
          const readinessMs = Math.max(1, Math.round(performance.now() - startInit));
          this.orchestrator.recordInitializationTiming(readinessMs, readinessMs);
          this.events.onStatusChange?.(null);
        })
        .catch((err) => {
          clearLlmLoadMarker();
          console.error('Gemma 4 WebGPU initialization failed:', err);
          this.stateCoordinator.setModelState('llm', 'failed');
          this.events.onStatusChange?.(
            `Gemma 4 initialization error: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    }

    // 3 & 4. Speech models load one at a time after the LLM settles. The WebGPU LLM load is the
    // memory peak, so it runs alone; the small WASM models follow (WASM heaps never shrink, so
    // keeping them out of the LLM load window lowers the peak).
    const startSpeechModels = async () => {
      await this.ttsProvider
        .initialize((loaded, total) => {
          const pct = total > 0 ? Math.min(100, Math.round((loaded * 100) / total)) : 0;
          const mb = (loaded / (1024 * 1024)).toFixed(0);
          const totalMb = (total / (1024 * 1024)).toFixed(0);
          this.events.onTtsProgress?.(loaded, total, pct, mb, totalMb);
          this.events.onStatusChange?.(
            `Pulling Piper Voice: ${mb} / ${totalMb} MB (${pct}%)...`
          );
        })
        .then(() => {
          this.stateCoordinator.setModelState('tts', 'ready');
        })
        .catch((err) => {
          console.warn('Piper ONNX init warning:', err);
          this.stateCoordinator.setModelState('tts', 'failed');
        });

      // 4. Pre-warm Whistle STT WASM provider
      await this.sttProvider
        .initialize((loaded, total) => this.events.onSttProgress?.(loaded, total))
        .catch((err) => {
          console.warn('Whistle STT pre-warm warning:', err);
        })
        .finally(() => this.events.onSttLoadSettled?.());
    };
    void (llmInitDone ?? Promise.resolve()).finally(() => startSpeechModels());

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
      window.addEventListener('pagehide', () => {
        // A normal close/reload mid-load isn't an out-of-memory crash
        clearLlmLoadMarker();
        void this.dispose();
      });
    }
  }

  async toggleMicrophone(): Promise<void> {
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
        this.audioSubsystem.stopMicrophoneCapture();
        this.isListening = false;
        this.stateCoordinator.setMicrophoneState('stopped');
      }
      return;
    }

    // 2. If listening: stop capture cleanly
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

    // 3. Start capture
    try {
      this.stateCoordinator.setMicrophoneState('requesting_permission');
      await this.audioSubsystem.startMicrophoneCapture();
      this.isListening = true;
      this.stateCoordinator.setMicrophoneState('listening');
      this.events.onStatusChange?.('Listening for speech (VAD active)...');

      // Greet on Start when the chat is empty (audio system is now set up)
      if (!this.hasHistory()) {
        const turnId = `welcome_${Date.now()}`;
        const welcomeMsg: ConversationMessage = {
          id: `msg_assistant_${turnId}`,
          turnId,
          role: 'assistant',
          canonicalContent: WELCOME_MESSAGE,
          speechReadyContent: WELCOME_MESSAGE,
          timestamp: Date.now(),
        };
        this.memoryStore.addMessage(welcomeMsg);
        this.events.onMessageCreated?.(welcomeMsg);
        void this.persistState();
        void this.orchestrator.speakOutOfTurn(WELCOME_MESSAGE);
      }
    } catch {
      this.isListening = false;
      this.stateCoordinator.setMicrophoneState('unavailable');
      this.events.onStatusChange?.('Microphone unavailable.');
    }
  }

  async submitText(text: string): Promise<ConversationMessage | null> {
    try {
      await this.audioSubsystem.ensureAudioContext();
    } catch {
      // AudioContext unavailable in test/headless environments
    }
    return this.orchestrator.submitUserInput(text, { isVoiceTranscript: false });
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
    samples16k: Float32Array
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
        this.events.onTranscript?.(text, true);
        this.orchestrator.handleSttEvent({
          type: 'final_transcript',
          turnId,
          sequence: 3,
          timestamp: performance.now(),
          text,
          language: result.language,
          words: result.words,
          durationMs: result.latencyMs,
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
    const limit = this.llmProvider.contextLimit || 8192;
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

    if (this.codingModelId === modelId) {
      if (this.codingLlmProvider) {
        await this.codingLlmProvider.dispose();
        this.codingLlmProvider = null;
      }
      this.jsRuntime.setLlmProvider(this.llmProvider);
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

    const hasWebGpu =
      typeof navigator !== 'undefined' && 'gpu' in (navigator as unknown as { gpu?: unknown });

    if (!hasWebGpu) {
      this.stateCoordinator.setModelState('llm', 'failed');
      return;
    }

    this.stateCoordinator.setModelState('llm', 'downloading');
    const modelName = modelId.includes('e4b') ? 'Gemma 4 E4B' : 'Gemma 4 E2B';
    void this.llmProvider
      .initialize((loaded, total) => {
        const pct = total > 0 ? Math.min(100, Math.round((loaded * 100) / total)) : 0;
        const mb = (loaded / (1024 * 1024)).toFixed(0);
        const totalMb = (total / (1024 * 1024)).toFixed(0);
        this.events.onLlmProgress?.(loaded, total, pct, mb, totalMb);
        this.events.onStatusChange?.(
          `Pulling ${modelName} WebGPU to OPFS: ${mb} / ${totalMb} MB (${pct}%)...`
        );
      })
      .then(() => {
        this.stateCoordinator.setModelState('llm', 'ready');
        this.events.onStatusChange?.(null);
      })
      .catch((err) => {
        this.stateCoordinator.setModelState('llm', 'failed');
        this.events.onStatusChange?.(
          `Gemma 4 initialization error: ${err instanceof Error ? err.message : String(err)}`
        );
      });
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
      .then(() => {
        this.stateCoordinator.setModelState('tts', 'ready');
        this.events.onStatusChange?.(null);
      })
      .catch((err) => {
        console.warn('Piper ONNX change warning:', err);
        this.stateCoordinator.setModelState('tts', 'failed');
      });
  }

  async updateSettings(settings: Partial<ChattySettings>): Promise<void> {
    const promises: Promise<void>[] = [];
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
    void this.persistState(true);
    this.audioSubsystem.stopMicrophoneCapture();
    this.audioSubsystem.stopAllPlaybackImmediately();
    this.jsRuntime.dispose();
    if (this.codingLlmProvider) {
      await this.codingLlmProvider.dispose();
    }
    await this.llmProvider.dispose();
    await this.ttsProvider.dispose();
  }
}

