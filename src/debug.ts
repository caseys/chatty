// ============================================================================
// Main Application Controller & UI Integration
// Coordinates StateMachineCoordinator, ConversationOrchestrator, SharedAudioSubsystem,
// Whistle STT, Worker LLM (LiteRT-LM Gemma 4 WebGPU), Worker TTS (Piper ONNX),
// and IndexedDB / OPFS Model Manager.
// ============================================================================

import { SharedAudioSubsystem } from './audio/audio-subsystem.ts';
import { ConversationMemoryStore } from './core/memory-store.ts';
import { ModelManager } from './core/model-manager.ts';
import { ConversationOrchestrator } from './core/orchestrator.ts';
import { StateMachineCoordinator } from './core/state-machine.ts';
import { runConversationEvaluationSuite } from './evaluation/benchmark-suite.ts';
import { WhistleSttProvider } from './runtimes/stt-provider.ts';
import { WorkerLlmProvider, WorkerTtsProvider } from './runtimes/worker-bridge.ts';
import type {
  ConversationMessage,
  SupportedLanguage,
  SystemTelemetry,
} from './types/index.ts';
import { createToolSummaryElement, stripToolCallMarkup } from './tools/tool-formatter.ts';
import { createWikipediaTool, createInstantAnswersTool } from './tools/web-tools.ts';
import {
  JavascriptRuntime,
  createJavascriptRuntimeTool,
} from './tools/javascript-runtime.ts';

export class ChattyAppController {
  readonly stateCoordinator = new StateMachineCoordinator();
  readonly memoryStore = new ConversationMemoryStore({ maxVerbatimTurns: 8 });
  readonly modelManager = new ModelManager();

  private sttProvider = new WhistleSttProvider();
  private llmProvider: WorkerLlmProvider;
  private ttsProvider: WorkerTtsProvider;
  private orchestrator: ConversationOrchestrator;
  private audioSubsystem: SharedAudioSubsystem;
  private jsRuntime: JavascriptRuntime;

  private isListening = false;
  private selectedLanguage: SupportedLanguage = 'en';
  private currentInputRms = 0;
  private currentOutputRms = 0;
  private speechTurnCounter = 0;

  constructor() {
    this.llmProvider = new WorkerLlmProvider('gemma-4-e2b-it-web', {
      onCrashRecovered: (recoveryMs) => {
        this.orchestrator.recordRecoveryTiming(recoveryMs);
      },
    });
    this.jsRuntime = new JavascriptRuntime({ mode: 'iframe', llmProvider: this.llmProvider });
    this.ttsProvider = new WorkerTtsProvider('en_US-hfc_female-medium');

    this.audioSubsystem = new SharedAudioSubsystem({
      onSpeechStarted: () => {
        const turnId = `voice_turn_${Date.now()}_${++this.speechTurnCounter}`;
        this.setPartialBanner('Speech detected — listening...');
        this.orchestrator.handleSttEvent({
          type: 'speech_started',
          turnId,
          sequence: 1,
          timestamp: performance.now(),
        });
      },
      onSpeechEnded: (utterance16k, durationMs) => {
        const turnId = `voice_turn_${Date.now()}_${this.speechTurnCounter}`;
        this.setPartialBanner('Transcribing utterance with Whistle WASM...');
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
      tools: [
        {
          name: 'calculator',
          description: 'Evaluates arithmetic expressions',
          parameters: {},
          execute: ({ a, operator, b }) => {
            const x = Number(a);
            const y = Number(b);
            if (operator === '+') return x + y;
            if (operator === '-') return x - y;
            if (operator === '*') return x * y;
            if (operator === '/') return y !== 0 ? Number((x / y).toFixed(4)) : NaN;
            return 0;
          },
        },
        {
          name: 'get_local_time',
          description: 'Returns the user current local time',
          parameters: {},
          execute: () => new Date().toLocaleTimeString(),
        },
        createWikipediaTool(),
        createInstantAnswersTool(),
        createJavascriptRuntimeTool(this.jsRuntime),
      ],
      events: {
        onMessageCreated: () => {
          this.renderMessages();
          this.renderMemoryInspector();
          void this.persistState();
        },
        onMessageUpdated: () => {
          this.renderMessages();
          this.renderMemoryInspector();
          void this.persistState();
        },
        onPhraseReadyForPlayback: async (phrase) => {
          if (phrase.audioSamples && phrase.sampleRate) {
            await this.audioSubsystem.schedulePcmPlayback(phrase.audioSamples, phrase.sampleRate);
          }
        },
        onInterruption: () => {
          this.audioSubsystem.stopAllPlaybackImmediately();
          this.renderMessages();
        },
        onTelemetryUpdated: (telemetry) => {
          this.renderTelemetry(telemetry);
        },
        onError: (error, context) => {
          console.error(`[Chatty ${context}]`, error);
          this.setPartialBanner(`Error (${context}): ${error.message}`);
        },
      },
    });
  }

  async init(): Promise<void> {
    const startInit = performance.now();

    this.bindDomEvents();
    this.startWaveformVisualizer();

    // Subscribe to state machine updates
    this.stateCoordinator.subscribe((snapshot) => {
      this.renderStateBadges(snapshot);
    });

    // Restore persisted memories & conversation history from IndexedDB
    try {
      const savedMemories = await this.modelManager.db.loadMemories();
      if (savedMemories.length > 0) {
        this.memoryStore.loadMemories(savedMemories);
      }

      const savedConvo = await this.modelManager.db.loadConversationSnapshot();
      if (savedConvo && savedConvo.messages.length > 0) {
        for (const msg of savedConvo.messages) {
          this.memoryStore.addMessage(msg);
        }
        if (savedConvo.summary) {
          this.memoryStore.setSummary(savedConvo.summary);
        }
      }
    } catch {
      // Ignore IndexedDB errors in restricted contexts
    }

    // Detect hardware capabilities and select adaptive runtime (Spec Section 4)
    const caps = await this.modelManager.detectCapabilities();
    const recommended = this.modelManager.recommendModelsForCapabilities(caps);
    this.renderCapabilities(caps);

    const elLlm = document.getElementById('cap-llm');
    const elTts = document.getElementById('cap-tts');

    this.stateCoordinator.setModelState('stt', 'ready');
    this.stateCoordinator.setModelState('llm', 'downloading');
    this.stateCoordinator.setModelState('tts', 'downloading');

    const targetManifest = this.modelManager.getManifest(recommended.llmModelId);
    this.llmProvider.modelId = recommended.llmModelId;

    const hasWebGpu = caps.hasWebGPU || (typeof navigator !== 'undefined' && 'gpu' in navigator);
    if (!hasWebGpu) {
      this.stateCoordinator.setModelState('llm', 'failed');
      if (elLlm) elLlm.textContent = 'WebGPU Unavailable';
      this.setPartialBanner(
        'WebGPU is required for Gemma 4 local inference. Please use Chrome, Edge, or Safari with WebGPU enabled.'
      );
    } else {
      if (elLlm) elLlm.textContent = `Loading ${targetManifest?.name ?? recommended.llmModelId} (0%)...`;
      this.llmProvider
        .initialize((loaded, total) => {
          const pct = total > 0 ? Math.min(100, Math.round((loaded * 100) / total)) : 0;
          const mb = (loaded / (1024 * 1024)).toFixed(0);
          const totalMb = (total / (1024 * 1024)).toFixed(0);
          if (elLlm) elLlm.textContent = `Gemma 4 E2B (${mb}/${totalMb} MB · ${pct}%)`;
          this.setPartialBanner(
            `Downloading & caching Gemma 4 E2B WebGPU to OPFS: ${mb} / ${totalMb} MB (${pct}%)...`
          );
        })
        .then(() => {
          this.stateCoordinator.setModelState('llm', 'ready');
          if (elLlm) elLlm.textContent = targetManifest?.name ?? recommended.llmModelId;
          const readinessMs = Math.max(1, Math.round(performance.now() - startInit));
          this.orchestrator.recordInitializationTiming(readinessMs, readinessMs);
          this.setPartialBanner(null);
        })
        .catch((err) => {
          console.error('Gemma 4 WebGPU initialization failed:', err);
          this.stateCoordinator.setModelState('llm', 'failed');
          if (elLlm) elLlm.textContent = 'Initialization Failed';
          this.setPartialBanner(
            `Gemma 4 initialization error: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    }

    // Initialize Piper ONNX TTS worker
    if (elTts) elTts.textContent = 'Downloading Piper Voice (0%)...';
    this.ttsProvider
      .initialize((loaded, total) => {
        const pct = total > 0 ? Math.min(100, Math.round((loaded * 100) / total)) : 0;
        if (elTts) elTts.textContent = `Piper ONNX (${pct}%)`;
      })
      .then(() => {
        this.stateCoordinator.setModelState('tts', 'ready');
        if (elTts) elTts.textContent = `Piper (${this.ttsProvider.voiceId})`;
      })
      .catch((err) => {
        console.warn('Piper ONNX init warning:', err);
        this.stateCoordinator.setModelState('tts', 'failed');
        if (elTts) elTts.textContent = 'Piper (Download error)';
      });

    // Pre-warm Whistle STT WASM provider in background alongside LLM and TTS
    this.sttProvider.initialize().catch((err) => {
      console.warn('Whistle STT pre-warm warning:', err);
    });

    this.renderMessages();
    this.renderMemoryInspector();
    await this.renderModelRegistryModal();

    // Handle page visibility changes (Spec Section 7 & 9)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stateCoordinator.setLifecycleState('backgrounded');
      } else {
        this.stateCoordinator.setLifecycleState('foregrounded');
      }
    });

    // Release WebGPU devices and terminate workers on page reload/unload to avoid GPU adapter exhaustion
    window.addEventListener('pagehide', () => {
      void this.llmProvider.dispose();
      void this.ttsProvider.dispose();
    });
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
      this.setPartialBanner(null);

      const text = result.text.trim();
      if (text) {
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
      this.setPartialBanner(null);
      this.orchestrator.handleSttEvent({
        type: 'error',
        turnId,
        sequence: 3,
        timestamp: performance.now(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --------------------------------------------------------------------------
  // DOM Event Bindings
  // --------------------------------------------------------------------------

  private bindDomEvents(): void {
    const form = document.getElementById('chat-form') as HTMLFormElement | null;
    const input = document.getElementById('chat-input') as HTMLInputElement | null;

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!input) return;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      // Pre-warm and unlock hardware AudioContext inside the user gesture while LLM generates
      void this.audioSubsystem.ensureAudioContext();
      void this.orchestrator.submitUserInput(text, { isVoiceTranscript: false });
    });

    // Quick prompt chips
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const chip = target?.closest('.chip-prompt') as HTMLElement | null;
      if (chip && chip.dataset.prompt) {
        void this.audioSubsystem.ensureAudioContext();
        void this.orchestrator.submitUserInput(chip.dataset.prompt, { isVoiceTranscript: false });
      }
    });

    // Microphone toggle
    const micBtn = document.getElementById('btn-mic-toggle');
    micBtn?.addEventListener('click', () => {
      void this.toggleMicrophone();
    });

    // Barge-In / Interrupt button
    const interruptBtn = document.getElementById('btn-interrupt');
    interruptBtn?.addEventListener('click', () => {
      this.audioSubsystem.stopAllPlaybackImmediately();
      this.orchestrator.interruptCurrentTurn('User clicked Stop / Barge-In');
    });

    // TTS toggle
    const ttsChk = document.getElementById('chk-tts-enabled') as HTMLInputElement | null;
    ttsChk?.addEventListener('change', () => {
      this.orchestrator.setSpeechOutputEnabled(ttsChk.checked);
      if (!ttsChk.checked) {
        this.audioSubsystem.stopAllPlaybackImmediately();
      }
    });

    // Language select
    const langSelect = document.getElementById('select-language') as HTMLSelectElement | null;
    langSelect?.addEventListener('change', () => {
      this.selectedLanguage = langSelect.value as SupportedLanguage;
    });

    // Reset conversation button
    const clearBtn = document.getElementById('btn-clear-chat');
    clearBtn?.addEventListener('click', async () => {
      this.audioSubsystem.stopAllPlaybackImmediately();
      this.orchestrator.interruptCurrentTurn('Reset conversation');
      this.memoryStore.clearConversation();
      await this.llmProvider.reset();
      this.stateCoordinator.transitionInteraction('idle', null);
      this.renderMessages();
      this.renderMemoryInspector();
      await this.persistState();
    });

    // Clear all long-term memories button
    const clearMemoriesBtn = document.getElementById('btn-clear-memories');
    clearMemoriesBtn?.addEventListener('click', async () => {
      this.memoryStore.loadMemories([]);
      this.renderMemoryInspector();
      await this.persistState();
    });

    // Long-term memory add form
    const memForm = document.getElementById('memory-add-form') as HTMLFormElement | null;
    const memKey = document.getElementById('mem-key-input') as HTMLInputElement | null;
    const memVal = document.getElementById('mem-val-input') as HTMLInputElement | null;
    memForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!memKey || !memVal) return;
      const k = memKey.value.trim();
      const v = memVal.value.trim();
      if (!k || !v) return;
      this.memoryStore.upsertApprovedMemory(k, v, 'preference');
      memKey.value = '';
      memVal.value = '';
      this.renderMemoryInspector();
      await this.persistState();
    });

    // Run Evaluation Suite button
    const evalBtn = document.getElementById('btn-run-eval') as HTMLButtonElement | null;
    evalBtn?.addEventListener('click', async () => {
      if (evalBtn) {
        evalBtn.disabled = true;
        evalBtn.textContent = 'Running Suite...';
      }
      try {
        const report = await runConversationEvaluationSuite({
          createLlmProvider: () => this.llmProvider,
          createTtsProvider: () => this.ttsProvider,
        });
        this.renderEvaluationReport(report);
      } finally {
        if (evalBtn) {
          evalBtn.disabled = false;
          evalBtn.textContent = 'Run Quality Suite';
        }
      }
    });

    // Model Registry Dialog
    const dialogModels = document.getElementById('dialog-models') as HTMLDialogElement | null;
    const openModelsBtn = document.getElementById('btn-open-models');
    const closeModelsBtn = document.getElementById('btn-close-models');

    openModelsBtn?.addEventListener('click', async () => {
      await this.renderModelRegistryModal();
      dialogModels?.showModal();
    });

    closeModelsBtn?.addEventListener('click', () => {
      dialogModels?.close();
    });
  }

  private async toggleMicrophone(): Promise<void> {
    const micBtn = document.getElementById('btn-mic-toggle');
    const micLabel = document.getElementById('mic-btn-label');

    if (this.isListening) {
      const remaining = this.audioSubsystem.stopMicrophoneCapture();
      this.isListening = false;
      this.stateCoordinator.setMicrophoneState('stopped');
      micBtn?.classList.remove('listening');
      if (micLabel) micLabel.textContent = 'Start Voice Input';
      this.setPartialBanner(null);

      if (remaining && remaining.length > 1600) {
        const turnId = `voice_turn_${Date.now()}_${++this.speechTurnCounter}`;
        void this.transcribeRecordedUtterance(turnId, remaining);
      } else {
        this.stateCoordinator.transitionInteraction('idle', null);
      }
      return;
    }

    try {
      this.stateCoordinator.setMicrophoneState('requesting_permission');
      await this.audioSubsystem.startMicrophoneCapture();
      this.isListening = true;
      this.stateCoordinator.setMicrophoneState('listening');
      micBtn?.classList.add('listening');
      if (micLabel) micLabel.textContent = 'Stop Listening';
      this.setPartialBanner('Listening for speech (VAD active)...');
    } catch {
      this.isListening = false;
      this.stateCoordinator.setMicrophoneState('unavailable');
      this.setPartialBanner('Microphone unavailable — typed chat remains active.');
    }
  }

  // --------------------------------------------------------------------------
  // Rendering Functions
  // --------------------------------------------------------------------------

  private setPartialBanner(text: string | null): void {
    const banner = document.getElementById('live-partial-banner');
    const span = document.getElementById('partial-transcript-text');
    if (!banner || !span) return;
    if (!text) {
      banner.hidden = true;
    } else {
      banner.hidden = false;
      span.textContent = text;
    }
  }

  private renderStateBadges(snapshot: ReturnType<StateMachineCoordinator['getSnapshot']>): void {
    const elInteraction = document.getElementById('badge-interaction');
    const elMic = document.getElementById('badge-mic');
    const elPlayback = document.getElementById('badge-playback');
    const elRuntime = document.getElementById('badge-runtime');
    const btnInterrupt = document.getElementById('btn-interrupt') as HTMLButtonElement | null;

    if (elInteraction) {
      elInteraction.textContent = snapshot.interaction;
      elInteraction.className = `chip-value ${
        snapshot.interaction === 'error'
          ? 'state-err'
          : snapshot.interaction === 'interrupted'
          ? 'state-warn'
          : snapshot.interaction === 'idle'
          ? ''
          : 'state-active'
      }`;
    }
    if (elMic) elMic.textContent = snapshot.microphone;
    if (elPlayback) elPlayback.textContent = snapshot.playback;
    if (elRuntime) {
      elRuntime.textContent = snapshot.models.llm;
      elRuntime.className = `chip-value ${
        snapshot.models.llm === 'ready'
          ? 'state-ready'
          : snapshot.models.llm === 'failed'
          ? 'state-err'
          : 'state-warn'
      }`;
    }

    if (btnInterrupt) {
      const canInterrupt =
        snapshot.interaction === 'generating' ||
        snapshot.interaction === 'speaking' ||
        snapshot.playback === 'playing' ||
        snapshot.playback === 'buffering';
      btnInterrupt.disabled = !canInterrupt;
    }
  }

  private renderMessages(): void {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    const messages = this.memoryStore.getMessages();
    if (messages.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <h2>Private, Local Voice Assistant</h2>
          <p>
            Speak using the microphone or type below. Audio capture, Whistle WASM speech recognition,
            LLM context orchestration, and phrase-level speech synthesis run locally in your browser.
          </p>
          <div class="quick-prompts">
            <button type="button" class="chip-prompt" data-prompt="What are three options for browser inference?">
              "Three options for browser inference?"
            </button>
            <button type="button" class="chip-prompt" data-prompt="Tell me more about the second option.">
              "Tell me about the second option"
            </button>
            <button type="button" class="chip-prompt" data-prompt="What is the capital of France?">
              "Capital of France?"
            </button>
            <button type="button" class="chip-prompt" data-prompt="Calculate 42 * 19">
              "Calculate 42 * 19"
            </button>
          </div>
        </div>
      `;
      container.querySelectorAll<HTMLButtonElement>('.chip-prompt').forEach((btn) => {
        btn.addEventListener('click', () => {
          const prompt = btn.dataset.prompt;
          if (prompt) {
            void this.orchestrator.submitUserInput(prompt);
          }
        });
      });
      return;
    }

    container.innerHTML = '';
    for (const msg of messages) {
      container.appendChild(this.createMessageElement(msg));
    }
    container.scrollTop = container.scrollHeight;
  }

  private createMessageElement(msg: ConversationMessage): HTMLElement {
    const card = document.createElement('article');
    card.className = `msg-card ${msg.role === 'user' ? 'msg-user' : 'msg-assistant'}`;

    const header = document.createElement('div');
    header.className = 'msg-header';

    const roleSpan = document.createElement('span');
    roleSpan.className = 'msg-role';
    if (msg.role === 'assistant') {
      const avatarImg = document.createElement('img');
      avatarImg.src = `${import.meta.env.BASE_URL}mascott.png`;
      avatarImg.alt = 'Chatty';
      avatarImg.className = 'msg-avatar-mascot';
      roleSpan.appendChild(avatarImg);
    }
    const roleText = document.createTextNode(msg.role === 'user' ? 'You' : 'Chatty (Gemma 4)');
    roleSpan.appendChild(roleText);
    header.appendChild(roleSpan);

    const badges = document.createElement('div');
    badges.className = 'msg-badges';

    if (msg.responseMode && msg.responseMode !== 'direct') {
      const modeBadge = document.createElement('span');
      modeBadge.className = 'msg-badge';
      modeBadge.textContent = msg.responseMode;
      badges.appendChild(modeBadge);
    }

    if (msg.verified) {
      const verBadge = document.createElement('span');
      verBadge.className = 'msg-badge verified';
      verBadge.textContent = 'verified';
      badges.appendChild(verBadge);
    }

    if (msg.interrupted) {
      const intBadge = document.createElement('span');
      intBadge.className = 'msg-badge interrupted';
      intBadge.textContent = 'interrupted';
      badges.appendChild(intBadge);
    }

    if (msg.metrics?.llmTimeToFirstTokenMs) {
      const ttftBadge = document.createElement('span');
      ttftBadge.className = 'msg-badge';
      ttftBadge.textContent = `TTFT ${msg.metrics.llmTimeToFirstTokenMs}ms`;
      badges.appendChild(ttftBadge);
    }

    header.appendChild(badges);
    card.appendChild(header);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';

    if (msg.toolCall) {
      contentDiv.appendChild(createToolSummaryElement(msg.toolCall));
    }

    const cleanContent = stripToolCallMarkup(msg.canonicalContent || '…');

    if (cleanContent) {
      const textDiv = document.createElement('div');
      textDiv.textContent = cleanContent;
      contentDiv.appendChild(textDiv);
    }

    card.appendChild(contentDiv);

    if (msg.phrases && msg.phrases.length > 0) {
      const sub = document.createElement('div');
      sub.className = 'msg-sub';
      sub.textContent = `TTS Phrases (${msg.phrases.length}): "${(msg.speechReadyContent ?? '').slice(0, 95)}${
        (msg.speechReadyContent?.length ?? 0) > 95 ? '…' : ''
      }"`;
      card.appendChild(sub);
    }

    return card;
  }

  private renderMemoryInspector(): void {
    const turnBadge = document.getElementById('memory-turn-count');
    if (turnBadge) {
      turnBadge.textContent = `${this.memoryStore.getMessages().length} verbatim`;
    }

    const summaryEl = document.getElementById('summary-display');
    const summary = this.memoryStore.getSummary();
    if (summaryEl) {
      summaryEl.textContent = summary
        ? `${summary.summaryText} (${summary.coveredTurnCount} earlier turns compacted)`
        : 'No compacted summary yet (created automatically when conversation exceeds working context budget).';
    }

    // Pending memory proposals banner
    const proposalBanner = document.getElementById('memory-proposal-banner');
    const proposals = this.memoryStore.getPendingProposals();
    if (proposalBanner) {
      if (proposals.length === 0) {
        proposalBanner.hidden = true;
        proposalBanner.innerHTML = '';
      } else {
        const prop = proposals[0];
        proposalBanner.hidden = false;
        proposalBanner.innerHTML = '';
        const label = document.createElement('span');
        label.textContent = `Save preference to long-term memory? "${prop.key}: ${prop.value}"`;
        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '6px';

        const approveBtn = document.createElement('button');
        approveBtn.className = 'btn btn-primary btn-sm';
        approveBtn.textContent = 'Approve';
        approveBtn.onclick = () => {
          this.memoryStore.approveProposal(prop.id);
          this.renderMemoryInspector();
          void this.persistState();
        };

        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'btn btn-secondary btn-sm';
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.onclick = () => {
          this.memoryStore.dismissProposal(prop.id);
          this.renderMemoryInspector();
        };

        actions.append(approveBtn, dismissBtn);
        proposalBanner.append(label, actions);
      }
    }

    // Long-term memory list
    const listEl = document.getElementById('memory-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    for (const item of this.memoryStore.getAllMemories()) {
      const li = document.createElement('li');
      li.className = 'memory-item';

      const textSpan = document.createElement('span');
      textSpan.textContent = `${item.key}: ${item.value}`;

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-ghost btn-sm';
      delBtn.textContent = 'Delete';
      delBtn.onclick = () => {
        this.memoryStore.deleteMemory(item.id);
        this.renderMemoryInspector();
        void this.persistState();
      };

      li.append(textSpan, delBtn);
      listEl.appendChild(li);
    }
  }

  private renderTelemetry(telemetry: SystemTelemetry): void {
    const set = (id: string, val: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    set('metric-ttft', telemetry.averageTtftMs > 0 ? `${telemetry.averageTtftMs} ms` : '— ms');
    set(
      'metric-first-audio',
      telemetry.averageFirstAudioMs > 0 ? `${telemetry.averageFirstAudioMs} ms` : '— ms'
    );
    set('metric-tps', telemetry.averageTps > 0 ? `${telemetry.averageTps} tok/s` : '— tok/s');
    set('metric-rtf', telemetry.averageTtsRtf > 0 ? `${telemetry.averageTtsRtf}x` : '—');
    set('metric-completed', String(telemetry.completedTurns));
    set('metric-interrupted', String(telemetry.interruptedTurns));
  }

  private renderCapabilities(caps: Awaited<ReturnType<ModelManager['detectCapabilities']>>): void {
    const set = (id: string, val: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set('cap-profile', caps.deviceProfile);
    set('cap-webgpu', caps.hasWebGPU ? `Available (${caps.gpuAdapterName ?? 'GPU'})` : 'Unavailable');
  }

  private renderEvaluationReport(
    report: Awaited<ReturnType<typeof runConversationEvaluationSuite>>
  ): void {
    const badge = document.getElementById('eval-score-badge');
    if (badge) {
      badge.textContent = `${report.passedCases}/${report.totalCases} Passed (${report.passRatePercent}%)`;
    }

    const list = document.getElementById('eval-results-list');
    if (!list) return;
    list.innerHTML = '';

    for (const r of report.results) {
      const div = document.createElement('div');
      div.className = 'eval-item';

      const top = document.createElement('div');
      top.className = 'eval-item-top';

      const title = document.createElement('span');
      title.textContent = r.category;

      const status = document.createElement('span');
      status.className = r.passed ? 'eval-pass' : 'eval-fail';
      status.textContent = `${r.passed ? 'PASS' : 'FAIL'} (${r.durationMs}ms)`;

      top.append(title, status);

      const desc = document.createElement('span');
      desc.style.color = 'var(--text-secondary)';
      desc.textContent = `${r.name} — ${r.details}`;

      div.append(top, desc);
      list.appendChild(div);
    }
  }

  private async renderModelRegistryModal(): Promise<void> {
    const caps = await this.modelManager.detectCapabilities();
    const quotaEl = document.getElementById('storage-quota-text');
    if (quotaEl) {
      const usedMB = (caps.storageUsageBytes / (1024 * 1024)).toFixed(1);
      const quotaMB =
        caps.storageQuotaBytes > 0
          ? `${(caps.storageQuotaBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
          : 'Available (OPFS + IndexedDB)';
      quotaEl.textContent = `${usedMB} MB used / ${quotaMB}`;
    }

    const listEl = document.getElementById('model-registry-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    for (const manifest of this.modelManager.getRegistry()) {
      const row = document.createElement('div');
      row.className = 'model-row';

      const meta = document.createElement('div');
      meta.className = 'model-meta';

      const h4 = document.createElement('h4');
      h4.textContent = `${manifest.name} [${manifest.task.toUpperCase()}]`;

      const p = document.createElement('p');
      const sizeMB = `${(manifest.expectedSizeBytes / (1024 * 1024)).toFixed(1)} MB`;
      p.textContent = `Runtime: ${manifest.runtime} · Size: ${sizeMB} · Quant: ${manifest.quantization} · License: ${manifest.license}`;

      meta.append(h4, p);

      const actionBtn = document.createElement('button');
      actionBtn.className = 'btn btn-secondary btn-sm';
      actionBtn.textContent =
        manifest.id === this.llmProvider.modelId ||
        manifest.id === this.ttsProvider.voiceId ||
        manifest.id === 'whistle-stt-base'
          ? 'Active'
          : 'Select & Download';

      actionBtn.onclick = async () => {
        if (manifest.task === 'llm') {
          actionBtn.textContent = 'Downloading...';
          this.llmProvider.modelId = manifest.id;
          await this.llmProvider.initialize((loaded, total) => {
            const pct = total > 0 ? Math.round((loaded * 100) / total) : 0;
            actionBtn.textContent = `Loading ${pct}%`;
          });
          const elLlm = document.getElementById('cap-llm');
          if (elLlm) elLlm.textContent = manifest.name;
          await this.renderModelRegistryModal();
        } else if (manifest.task === 'tts') {
          actionBtn.textContent = 'Downloading...';
          this.ttsProvider.voiceId = manifest.id;
          await this.ttsProvider.initialize((loaded, total) => {
            const pct = total > 0 ? Math.round((loaded * 100) / total) : 0;
            actionBtn.textContent = `Downloading ${pct}%`;
          });
          const elTts = document.getElementById('cap-tts');
          if (elTts) elTts.textContent = manifest.name;
          await this.renderModelRegistryModal();
        }
      };

      row.append(meta, actionBtn);
      listEl.appendChild(row);
    }
  }

  private startWaveformVisualizer(): void {
    const canvas = document.getElementById('audio-visualizer') as HTMLCanvasElement | null;
    if (!canvas) return;
    canvas.addEventListener('contextlost', (e) => {
      e.preventDefault();
      console.warn('[Visualizer] Canvas context lost on mobile');
    });
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let phase = 0;
    let isVisible = !document.hidden;
    let animFrameId: number | null = null;

    const draw = () => {
      if (!isVisible) {
        animFrameId = null;
        return;
      }

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const activeLevel = Math.max(this.currentInputRms * 5, this.currentOutputRms * 4, 0.04);
      const bars = 28;
      const barWidth = 5;
      const gap = (w - bars * barWidth) / (bars + 1);

      phase += 0.12;
      ctx.fillStyle = this.isListening ? '#ef4444' : '#3b82f6';

      for (let i = 0; i < bars; i++) {
        const wave = Math.sin(phase + i * 0.35) * 0.5 + 0.5;
        const barHeight = Math.max(6, Math.min(h - 12, wave * activeLevel * h * 1.6 + 6));
        const x = gap + i * (barWidth + gap);
        const y = (h - barHeight) / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, 3);
        ctx.fill();
      }

      animFrameId = requestAnimationFrame(draw);
    };

    document.addEventListener('visibilitychange', () => {
      isVisible = !document.hidden;
      if (isVisible && animFrameId === null) {
        animFrameId = requestAnimationFrame(draw);
      }
    });

    animFrameId = requestAnimationFrame(draw);
  }

  private async persistState(): Promise<void> {
    try {
      await this.modelManager.db.saveConversationSnapshot(
        this.memoryStore.getMessages(),
        this.memoryStore.getSummary()
      );
      await this.modelManager.db.saveMemories(this.memoryStore.getAllMemories());
    } catch {
      // Ignore storage persistence errors in private browsing
    }
  }
}

// Auto-initialize when running in the browser document
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const start = () => {
    const app = new ChattyAppController();
    void app.init();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Register Service Worker for offline PWA functionality
  if ('serviceWorker' in navigator) {
    const registerSw = () => {
      navigator.serviceWorker
        .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
        .then((reg) => {
          console.debug('[Chatty PWA] Service Worker registered:', reg.scope);
        })
        .catch((err) => {
          console.warn('[Chatty PWA] Service Worker registration warning:', err);
        });
    };

    if (document.readyState === 'complete') {
      registerSw();
    } else {
      window.addEventListener('load', registerSw);
    }
  }
}
