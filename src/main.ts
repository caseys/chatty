// ============================================================================
// Standalone Minimal UI Controller
// Powered by the unified VoiceAssistantEngine
// ============================================================================

import { formatRepairTally, repairTally, runLogVersion } from './core/run-log.ts';
import Prism from 'prismjs';
import { VoiceAssistantEngine } from './core/voice-assistant-engine.ts';
import { MODEL_REGISTRY } from './core/model-manager.ts';
import { FluidAudioVisualizer } from './audio/visualizer.ts';
import { clearModelCache, getModelCacheBytes } from './core/model-cache.ts';
import { isAppleMobile, SUPPORTED_CHAT_MODELS } from './core/settings.ts';
import { AFTER_LOAD_MS, settle } from './core/settle.ts';
import { withActivity } from './core/activity-breadcrumbs.ts';
import { decodeProgramHash, encodeProgramHash } from './share-link.ts';
import { createFrameCoalescer } from './frame-coalescer.ts';
import type { ConversationMessage, StoredConversation } from './types/index.ts';
import { GAVE_UP_STATUS, GENERATING_NOTE, type RunStatus } from './core/orchestrator.ts';
import type { InterfaceSound } from './audio/interface-sounds.ts';
import { createToolSummaryElement, parseStreamingToolCall, stripToolCallMarkup } from './tools/tool-formatter.ts';

type LoadKind = 'llm' | 'tts' | 'stt';

/** The app's own greeting (engine creates it with a welcome_ turn id). */

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
};

const SETTINGS_SEEN_KEY = 'chatty_settings_seen';
const PRELOAD_RELOAD_KEY = 'chatty_preload_reload_at';

// A tab opened before a deploy can lazily import a chunk the deploy deleted: reload once to pick up
// the new build (at most once a minute, so a genuinely missing chunk can't loop).
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY) ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

/** Matches the CSS breakpoint where the chat and code panels stack */
const NARROW_LAYOUT = '(max-width: 760px)';

const RUN_STATUS_ICONS: Record<RunStatus['kind'], string> = { ok: '▶', running: '▶', error: '✕', none: '–' };

/** True on the very first visit (settings never saved or shown). */
/** First visit, or the first load of new code: Settings opens before anything downloads. */
function settingsNotSeenForThisVersion(): boolean {
  try {
    return localStorage.getItem(SETTINGS_SEEN_KEY) !== __APP_VERSION__;
  } catch {
    return false;
  }
}

/** The short part of a WebLLM progress message: "Loading GPU shader modules[12/80]: 15% ..." → "Loading GPU shader modules [12/80]" */
function loadStageText(text: string): string {
  return text.split(/[:.]/)[0].replace(/\[/, ' [').trim().slice(0, 60);
}

export class MinimalVoiceApp {
  private engine: VoiceAssistantEngine;
  private micBtn = document.getElementById('btn-mic-toggle') as HTMLButtonElement | null;
  private micLabel = document.getElementById('mic-btn-label');
  private newBtn = document.getElementById('btn-new-chat') as HTMLButtonElement | null;
  private statusEl = document.getElementById('minimal-status');
  private chatLogEl = document.getElementById('chat-log');
  private chatExamplesEl = document.getElementById('chat-examples');
  private chatInputForm = document.getElementById('chat-input-form') as HTMLFormElement | null;
  private chatInput = document.getElementById('chat-input') as HTMLInputElement | null;
  private chatSendBtn = document.getElementById('chat-send-btn') as HTMLButtonElement | null;
  private modelCacheSizeEl = document.getElementById('model-cache-size');
  private clearModelCacheBtn = document.getElementById('btn-clear-model-cache') as HTMLButtonElement | null;
  private rawOutputEl = document.getElementById('raw-output');
  private runStatusEl = document.getElementById('run-status');
  // The last Settings save being applied (model downloads wait for it)
  private settingsApplying: Promise<void> = Promise.resolve();
  // Set by Clear model cache; Settings' close then downloads the models in use again
  private modelCacheCleared = false;
  private rawOutputTurnId: string | null = null;
  /** The raw panel shows the run log (tap the run status) instead of the newest code */
  private showingRunLog = false;
  /** The tally line over the run log: read from every chat's stored log only when an entry was added since (not on every repaint) */
  private tallyLine = '';
  private tallyVersion = -1;
  private lastRawOutput = '';
  /** The newest program, speak() lines included (what Share links to) */
  private panelCode = '';
  // Streamed tokens repaint the panel at most once a frame (see setRawOutput)
  private rawOutputFrame = createFrameCoalescer<string>((code) => this.paintRawOutput(code));
  private sharedProgram: string | null = null;
  // Chat bubbles by message id and by turn (streamed text arrives before the reply is saved)
  private bubbles = new Map<string, HTMLElement>();
  private turnBubbles = new Map<string, HTMLElement>();
  private interimUserBubble: HTMLElement | null = null;
  /** True while a saved chat is redrawn, so its messages appear without the entering animation */
  private restoringChat = false;
  // The interface sounds each chat bubble has played: one of each kind, when its text first shows
  private bubbleSounds = new WeakMap<HTMLElement, Set<InterfaceSound>>();
  private userSoundPlayed = false;
  private downloadRate = { label: '', bytes: 0, time: 0, rate: 0 };
  private inputCanvas = document.getElementById('input-waveform') as HTMLCanvasElement | null;
  private outputCanvas = document.getElementById('output-waveform') as HTMLCanvasElement | null;

  private inputVisualizer: FluidAudioVisualizer | null = null;
  private outputVisualizer: FluidAudioVisualizer | null = null;

  private inputPcmBuffer = new Float32Array(64);
  private outputPcmBuffer = new Float32Array(64);

  // Rootless Full-Window Visual Screen
  private appInitializing = true;
  // Startup download progress per model, combined into one progress bar
  private loadBytes: Record<LoadKind, { loaded: number; total: number }> = {
    llm: { loaded: 0, total: 0 },
    tts: { loaded: 0, total: 0 },
    stt: { loaded: 0, total: 0 },
  };
  private sttLoadSettled = false;
  private keepAwakeWanted = false;
  private keepAwakeListenerAdded = false;
  private wakeLockPending = false;
  private wakeLockSentinel: WakeLockSentinelLike | null = null;
  private keepAwakeRetryTimer = 0;
  private screenVisualLayer = document.getElementById('screen-visual-layer') as HTMLElement | null;
  // A program still making sound or with timers pending (a loop, a countdown): the bottom button shows as Stop
  private programSounding = false;
  private programRunning = false;
  // Set by updateUiState: the bottom button stops the program (nothing else to stop)
  private stopButtonStopsProgram = false;
  /** Something is drawn in the card (the combined button offers Clear when nothing else applies) */
  private screenHasContent = false;
  /** What the combined bottom button does now: Stop has priority, Clear is the last resort */
  /** The main button runs this chat's newest program again (voice off, nothing running) */
  private mainButtonReplays = false;
  private modelsReadyAnnounced = false;
  private clearScreenBtn = document.getElementById('btn-clear-screen') as HTMLButtonElement | null;
  private downloadProgramBtn = document.getElementById('btn-download-program') as HTMLButtonElement | null;

  private jsIframeContainer = document.getElementById('js-runtime-iframe-container');

  // Settings Dialog Elements
  private settingsBtn = document.getElementById('btn-settings') as HTMLButtonElement | null;
  private settingsDialog = document.getElementById('settings-dialog') as HTMLDialogElement | null;
  private settingsForm = document.getElementById('settings-form') as HTMLFormElement | null;
  private closeSettingsXBtn = document.getElementById('btn-close-settings-x') as HTMLButtonElement | null;
  private cancelSettingsBtn = document.getElementById('btn-cancel-settings') as HTMLButtonElement | null;
  private selectChatModel = document.getElementById('select-chat-model') as HTMLSelectElement | null;
  private selectPiperVoice = document.getElementById('select-piper-voice') as HTMLSelectElement | null;
  private toggleSpeech = document.getElementById('toggle-speech') as HTMLInputElement | null;
  private voiceField = document.getElementById('settings-voice-field');

  // Sidebar Elements
  private sidebarEl = document.getElementById('chat-sidebar') as HTMLElement | null;
  private sidebarBackdrop = document.getElementById('sidebar-backdrop') as HTMLElement | null;
  private toggleSidebarBtn = document.getElementById('btn-toggle-sidebar') as HTMLButtonElement | null;
  private closeSidebarBtn = document.getElementById('btn-close-sidebar') as HTMLButtonElement | null;
  private sidebarNewChatBtn = document.getElementById('btn-sidebar-new-chat') as HTMLButtonElement | null;
  private clearAllChatsBtn = document.getElementById('btn-clear-all-chats') as HTMLButtonElement | null;
  private sidebarChatList = document.getElementById('sidebar-chat-list') as HTMLUListElement | null;

  constructor() {
    if (this.inputCanvas) {
      this.inputVisualizer = new FluidAudioVisualizer(this.inputCanvas, {
        barCount: 18,
        barWidth: 2.5,
        gap: 3,
        gradientColors: ['#38bdf8', '#3b82f6', '#6366f1'],
        glowColor: 'rgba(56, 189, 248, 0.45)',
      });
    }

    if (this.outputCanvas) {
      this.outputVisualizer = new FluidAudioVisualizer(this.outputCanvas, {
        barCount: 18,
        barWidth: 2.5,
        gap: 3,
        // Voice output reads quieter than the mic: show it 1.25x
        gain: 1.25,
        gradientColors: ['#34d399', '#10b981', '#06b6d4'],
        glowColor: 'rgba(52, 211, 153, 0.45)',
      });
    }
    this.engine = new VoiceAssistantEngine({
      onJavascriptExecution: (res) => {
        if (res.hasVisualOutput) this.showScreenContent(true);
      },
      onJavascriptVisualChange: (hasVisual) => {
        this.showScreenContent(hasVisual);
      },
      onStatusChange: (statusText) => {
        if (!this.statusEl) return;
        if (statusText) {
          this.statusEl.textContent = statusText;
        } else {
          this.updateStatusFromSnapshot();
        }
      },
      onStateChange: () => {
        this.updateUiState();
      },
      onTranscript: (text) => {
        this.showInterimTranscript(text);
      },
      onTokenStream: (turnId, _chunk, fullText) => {
        this.renderAssistantOutput(this.bubbleForTurn(turnId), fullText, undefined, true);
      },
      onRawOutput: (turnId, raw) => {
        // A new reply: its run status comes once its code has run
        if (turnId !== this.rawOutputTurnId) {
          this.rawOutputTurnId = turnId;
          this.setRunStatus(null);
        }
        this.setRawOutput(raw, true);
      },
      onRunStatus: (_turnId, status) => {
        // Every fix failed: the run log shows what happened, without a tap
        if (status.kind === 'error' && status.text.endsWith(GAVE_UP_STATUS)) this.showingRunLog = true;
        this.setRunStatus(status);
        this.showProgramState(status);
      },
      onProgramSound: (sounding) => {
        this.programSounding = sounding;
        this.updateUiState();
      },
      onProgramActivity: (active) => {
        this.programRunning = active;
        this.updateUiState();
      },
      onProgramDownloadable: (ready) => {
        if (this.downloadProgramBtn) this.downloadProgramBtn.hidden = !ready;
      },
      onMessageCreated: (msg) => {
        // Chatty's own "fix this error" turns aren't the user's words
        if (msg.autoFix && msg.fixNotice) this.addFixNotice(msg);
        if (msg.role === 'user' && msg.canonicalContent && !msg.autoFix) {
          this.addUserBubble(msg);
          try {
            navigator.vibrate?.([8, 20, 8]);
          } catch {
            // ignore haptic errors
          }
        }
        if (msg.role === 'assistant' && (msg.canonicalContent || msg.toolCall)) {
          this.renderAssistantMessage(msg);
        }
        this.updateUiState();
      },
      onMessageUpdated: (msg) => {
        if (msg.role === 'assistant' && (msg.canonicalContent || msg.toolCall)) {
          this.renderAssistantMessage(msg);
        }
        this.updateUiState();
      },
      onLlmProgress: (loaded, total, _pct, _mb, _totalMb, current) => {
        this.reportLoadProgress('llm', loaded, total, current?.label ?? this.engine.getLlmDisplayName(), current);
      },
      onTtsProgress: (loaded, total) => {
        this.reportLoadProgress('tts', loaded, total, 'Piper voice');
      },
      onSttProgress: (loaded, total) => {
        this.reportLoadProgress('stt', loaded, total, 'Whistle speech recognition');
      },
      onSttLoadSettled: () => {
        this.sttLoadSettled = true;
        this.updateUiState();
      },
      onConfirm: (message) => window.confirm(message),
      // Downloads wait while Settings is open, so the model picked there is the one downloaded
      beforeModelDownload: () => this.settingsClosed(),
      onError: (err, context) => {
        if (this.statusEl) {
          this.statusEl.textContent = `Error (${context}): ${err.message}`;
        }
      },
      onTitleGenerated: (title) => {
        if (typeof document !== 'undefined') {
          document.title = `${title} — Chatty`;
        }
        this.renderChatList(this.engine.getConversations());
      },
      onConversationsChanged: (convos) => {
        this.renderChatList(convos);
      },
      onActiveConversationSwitched: (convo) => {
        this.onActiveChatSwitched(convo);
      },
    });
  }

  async init(): Promise<void> {
    this.bindEvents();
    this.openSharedProgram();
    window.addEventListener('hashchange', () => this.openSharedProgram());
    this.startWaveforms();
    // Install click pass-through before the (potentially long) model download/initialization.
    this.updateBusyIndicator();
    this.updateDownloadProgress('Loading models…', 0, '0%');
    try {
      // First visit, new code, or the last model load crashed or failed: choose before anything downloads
      const loadProblem = this.engine.getLastLoadProblem();
      if (settingsNotSeenForThisVersion() || loadProblem) {
        await this.engine.detectDevice();
        await this.showSettingsAndWait(loadProblem);
      }
      await this.engine.initialize();
    } finally {
      this.appInitializing = false;
      this.updateBusyIndicator();
    }

    // Expose engine globally for programmatic access / testing
    if (typeof window !== 'undefined') {
      (window as unknown as { chattyEngine?: VoiceAssistantEngine }).chattyEngine = this.engine;
      // The rule filter's calibration (rule-filter.ts): scores RULE_CASES with the loaded model and fits the cutoffs
      if (import.meta.env.DEV) {
        const engine = this.engine;
        (window as unknown as { chattyRuleFilter?: unknown }).chattyRuleFilter = {
          calibrate: () => engine.orchestrator.calibrateRuleFilter(),
        };
      }
    }

    // Connect JavaScript Runtime iframe container
    if (this.jsIframeContainer) {
      this.engine.setJsRuntimeContainer(this.jsIframeContainer);
    }

    // Restore previous conversation text if available
    const messages = this.engine.getMessages();
    const summary = this.engine.getSummary();
    if (summary?.title && typeof document !== 'undefined') {
      document.title = `${summary.title} — Chatty`;
    }
    this.renderConversation(messages, summary);

    // Populate settings dropdowns initially from engine
    const initialSettings = this.engine.getSettings();
    this.fillChatModelOptions(initialSettings.chatModelId);
    if (this.selectPiperVoice) this.selectPiperVoice.value = initialSettings.voiceId;
    this.fillSpeechSetting(initialSettings.speechEnabled);

    // Restore sidebar state from saved preferences
    if (this.engine.getSidebarOpen()) {
      this.toggleSidebar(true);
    }
    this.renderChatList(this.engine.getConversations());

    this.updateUiState();
  }

  /** Waveforms sit between the status box and the button on desktop, under the chat on phones. */
  /**
   * Phones: waveforms under the chat, text input at the very bottom of the screen.
   * Desktop: waveforms in the bottom row beside Start, text input under the chat.
   */
  private placeForLayout(): void {
    const narrow = window.matchMedia(NARROW_LAYOUT).matches;
    const chatPanel = document.querySelector('.chat-panel');
    const waves = document.querySelector('.chat-waveforms');
    const bottomRight = document.querySelector('.bottom-right');
    if (waves && chatPanel && bottomRight) {
      if (narrow) chatPanel.appendChild(waves);
      else bottomRight.insertBefore(waves, bottomRight.firstChild);
    }
    const stage = document.querySelector('.minimal-stage');
    if (this.chatInputForm && chatPanel && stage) {
      (narrow ? stage : chatPanel).appendChild(this.chatInputForm);
    }
  }

  /** Shows how much the downloaded models take up, in the settings dialog. */
  private async refreshModelCacheSize(): Promise<void> {
    if (!this.modelCacheSizeEl) return;
    const bytes = await getModelCacheBytes().catch(() => 0);
    const size = bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
    this.modelCacheSizeEl.textContent = `Downloaded models: ${size}`;
    if (this.clearModelCacheBtn) this.clearModelCacheBtn.disabled = bytes === 0;
  }

  private bindEvents(): void {
    this.watchCardTaps();
    // Tapping the run status switches the raw panel between the code and the run log
    this.runStatusEl?.addEventListener('click', (event) => {
      const share = (event.target as HTMLElement).closest('.run-share');
      if (share) {
        void this.shareProgram(share as HTMLElement);
        return;
      }
      const copy = (event.target as HTMLElement).closest('.run-copy');
      if (copy) {
        void this.copyRawPanel(copy as HTMLElement);
        return;
      }
      this.showingRunLog = !this.showingRunLog;
      this.setRawOutput(this.lastRawOutput);
      const hint = this.runStatusEl?.querySelector('.run-log-toggle:not(.run-copy):not(.run-share)');
      if (hint) hint.textContent = this.showingRunLog ? 'code' : 'log';
    });
    // Tapping an example sends it as if typed (the tap also unlocks audio for the reply)
    // With speech on, it also starts voice mode (listening, no welcome) so the conversation goes on by voice
    this.chatExamplesEl?.addEventListener('click', async (e) => {
      const example = (e.target as HTMLElement).closest('.chat-example');
      if (!example || !this.chatInput || this.chatInput.disabled) return;
      const text = (example.textContent ?? '').replace(/[“”]/g, '').trim();
      if (this.engine.isSpeechEnabled() && !this.engine.getIsListening()) {
        await this.engine.toggleMicrophone({ greet: false });
        this.updateUiState();
      }
      this.chatInput.value = text;
      this.chatInputForm?.requestSubmit();
    });

    // A tick for Chatty's own buttons: settings, Start / Stop / Continue, clear the screen. (After
    // the engine's own listener, which wakes the audio in the same tap)
    document.addEventListener(
      'click',
      (e) => {
        const button = (e.target as Element | null)?.closest?.('#btn-settings, #settings-dialog button, #btn-mic-toggle, #btn-clear-screen');
        if (button && !(button as HTMLButtonElement).disabled) this.engine.playInterfaceSound('tap');
      },
      true
    );

    this.chatInputForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.chatInput?.value.trim();
      if (!text || this.chatSendBtn?.disabled) return;
      if (this.chatInput) this.chatInput.value = '';
      // Sent: the field lets go (the card stays stepped back until the turn is done)
      this.chatInput?.blur();
      // Its sound now, in the tap: the message can take a while to show (a long chat is compacted first)
      this.engine.playInterfaceSound('user');
      this.userSoundPlayed = true;
      void this.engine.submitText(text);
    });
    this.chatInput?.addEventListener('focus', () => {
      this.inputFocused = true;
      this.cardSize = 'auto';
      this.updateCardState();
    });
    this.chatInput?.addEventListener('blur', () => {
      this.inputFocused = false;
      this.updateCardState();
    });

    this.clearModelCacheBtn?.addEventListener('click', async () => {
      const shown = this.modelCacheSizeEl?.textContent?.replace('Downloaded models: ', '') ?? 'the downloaded models';
      if (!confirm(`Delete ${shown} of downloaded models? They download again the next time Chatty loads.`)) return;
      this.clearModelCacheBtn!.disabled = true;
      await clearModelCache();
      await this.refreshModelCacheSize();
      this.modelCacheCleared = true;
    });
    // After clearing the cache, the models in use download again once Settings closes
    this.settingsDialog?.addEventListener('close', () => {
      if (!this.modelCacheCleared) return;
      this.modelCacheCleared = false;
      void this.settingsApplying.catch(() => {}).then(() => this.engine.refetchModels());
    });
    this.showChatExamples(true);
    this.placeForLayout();
    window.matchMedia(NARROW_LAYOUT).addEventListener('change', () => this.placeForLayout());
    // Stay on the newest text when the layout changes (rotation, desktop/mobile switch)
    if (typeof ResizeObserver !== 'undefined') {
      const keepAtBottom = new ResizeObserver(() => {
        this.scrollChatToBottom();
        if (this.rawOutputEl) this.rawOutputEl.scrollTop = this.rawOutputEl.scrollHeight;
      });
      if (this.chatLogEl) keepAtBottom.observe(this.chatLogEl);
      if (this.rawOutputEl) keepAtBottom.observe(this.rawOutputEl);
    }
    // The program in the card, saved as one HTML file that runs on its own
    this.downloadProgramBtn?.addEventListener('click', async () => {
      const html = await this.engine.programHtml().catch((err) => {
        console.warn('Download failed:', err);
        return null;
      });
      if (!html) return;
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'chatty-program.html';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });
    this.clearScreenBtn?.addEventListener('click', () => {
      this.resetVisualScreen();
      this.updateUiState();
    });

    this.micBtn?.addEventListener('click', async () => {
      try {
        navigator.vibrate?.(15);
      } catch {
        // ignore haptic errors
      }
      // Replay: the newest program again, when nothing runs and voice is off
      if (this.mainButtonReplays) {
        await this.engine.replayLastProgram();
        this.updateUiState();
        return;
      }
      // Stop with only a program running (a music loop): stops the program
      if (this.stopButtonStopsProgram) {
        this.resetVisualScreen();
        this.updateUiState();
        return;
      }
      await this.engine.toggleMicrophone();
      this.updateUiState();
    });

    this.newBtn?.addEventListener('click', async () => {
      try {
        navigator.vibrate?.(15);
      } catch {
        // ignore haptic errors
      }
      this.resetVisualScreen();
      await this.engine.createConversation('New Chat');
      this.clearChatLog();
      if (typeof document !== 'undefined') document.title = 'New Chat — Chatty';
      this.updateUiState();
    });

    this.sidebarNewChatBtn?.addEventListener('click', async () => {
      try {
        navigator.vibrate?.(15);
      } catch {}
      this.resetVisualScreen();
      await this.engine.createConversation('New Chat');
      this.clearChatLog();
      if (typeof document !== 'undefined') document.title = 'New Chat — Chatty';
      this.updateUiState();
      if (window.innerWidth <= 640) {
        this.toggleSidebar(false);
      }
    });

    this.clearAllChatsBtn?.addEventListener('click', async () => {
      if (!window.confirm("Delete all chats? This can't be undone.")) return;
      this.resetVisualScreen();
      await this.engine.clearAllConversations();
      this.clearChatLog();
      if (typeof document !== 'undefined') document.title = 'New Chat — Chatty';
      this.updateUiState();
    });

    this.toggleSidebarBtn?.addEventListener('click', () => {
      try {
        navigator.vibrate?.(10);
      } catch {}
      this.toggleSidebar();
    });

    this.closeSidebarBtn?.addEventListener('click', () => {
      this.toggleSidebar(false);
    });

    this.sidebarBackdrop?.addEventListener('click', () => {
      this.toggleSidebar(false);
    });

    // Close any open chat-item-menus when clicking outside
    document.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.chat-item-menu-wrapper')) {
        document.querySelectorAll('.chat-item-menu:not([hidden])').forEach((m) => {
          (m as HTMLElement).hidden = true;
        });
      }
    });

    // Settings Modal Dialog Controls
    this.settingsBtn?.addEventListener('click', () => {
      try {
        navigator.vibrate?.(10);
      } catch {
        // ignore
      }
      const current = this.engine.getSettings();
      // Rebuilt on open: phones only list phone-sized models once the device is detected
      this.fillChatModelOptions(current.chatModelId);
      void this.refreshModelCacheSize();
      if (this.selectPiperVoice) this.selectPiperVoice.value = current.voiceId;
      this.fillSpeechSetting(current.speechEnabled);
      this.settingsDialog?.showModal();
    });

    // The voice picker only matters with speech on
    this.toggleSpeech?.addEventListener('change', () => {
      if (this.voiceField) this.voiceField.hidden = !this.toggleSpeech?.checked;
    });

    this.closeSettingsXBtn?.addEventListener('click', () => {
      this.settingsDialog?.close();
    });

    this.cancelSettingsBtn?.addEventListener('click', () => {
      this.settingsDialog?.close();
    });

    this.settingsDialog?.addEventListener('click', (e) => {
      if (e.target === this.settingsDialog) {
        this.settingsDialog?.close();
      }
    });

    this.settingsForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        navigator.vibrate?.(15);
      } catch {
        // ignore
      }

      const current = this.engine.getSettings();
      const newChatModelId = this.selectChatModel?.value || current.chatModelId;
      const newCodingModelId = newChatModelId; // coder follows the chat model
      const newVoiceId = this.selectPiperVoice?.value || current.voiceId;
      const newSpeechEnabled = this.toggleSpeech?.checked ?? current.speechEnabled;

      this.settingsDialog?.close();

      // Saving settings before anything was asked is also Start (voice on): the same tap that
      // starts the audio starts listening
      const noInputYet = !(this.engine.getActiveConversation()?.messages ?? []).some((m) => m.role === 'user');
      const micOff = this.engine.stateCoordinator.getSnapshot().microphone !== 'listening';
      const startListening = newSpeechEnabled && noInputYet && micOff;

      const hasChanges =
        newChatModelId !== current.chatModelId ||
        newCodingModelId !== current.codingModelId ||
        newVoiceId !== current.voiceId ||
        newSpeechEnabled !== current.speechEnabled;

      if (hasChanges) {
        if (this.statusEl) {
          this.statusEl.textContent = 'Applying updated settings...';
        }
        this.settingsApplying = this.engine.updateSettings({
          chatModelId: newChatModelId,
          codingModelId: newCodingModelId,
          voiceId: newVoiceId,
          speechEnabled: newSpeechEnabled,
        });
        await this.settingsApplying;
        this.updateUiState();
      }
      if (startListening && this.engine.stateCoordinator.getSnapshot().microphone !== 'listening') {
        await this.engine.toggleMicrophone();
        this.updateUiState();
      }
    });
  }

  private toggleSidebar(force?: boolean): void {
    const isCurrentlyOpen = this.sidebarEl ? !this.sidebarEl.hidden : false;
    const nextOpen = force !== undefined ? force : !isCurrentlyOpen;

    if (this.sidebarEl) {
      this.sidebarEl.hidden = !nextOpen;
    }
    if (this.sidebarBackdrop) {
      this.sidebarBackdrop.hidden = !nextOpen;
    }
    this.engine.setSidebarOpen(nextOpen);
  }

  private onActiveChatSwitched(convo: StoredConversation): void {
    this.resetVisualScreen();
    this.renderConversation(convo.messages ?? [], convo.summary);

    if (typeof document !== 'undefined') {
      document.title = `${convo.title || 'New Chat'} — Chatty`;
    }

    this.renderChatList(this.engine.getConversations());
    this.updateUiState();
  }

  private renderChatList(convos: StoredConversation[]): void {
    if (!this.sidebarChatList) return;
    this.sidebarChatList.innerHTML = '';

    const activeId = this.engine.getActiveConversationId();

    for (const convo of convos) {
      const isActive = convo.id === activeId;
      const li = document.createElement('li');
      li.className = `chat-item ${isActive ? 'active' : ''}`;
      li.dataset.chatId = convo.id;

      // Formatting timestamp
      const date = new Date(convo.updatedAt || convo.createdAt);
      const isToday = new Date().toDateString() === date.toDateString();
      const timeStr = isToday
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString([], { month: 'short', day: 'numeric' });

      // Select button
      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'chat-item-select-btn';
      selectBtn.title = `Switch to ${convo.title || 'New Chat'}`;

      const iconSpan = document.createElement('span');
      iconSpan.className = 'chat-item-icon';
      iconSpan.setAttribute('aria-hidden', 'true');
      iconSpan.textContent = '💬';

      const infoDiv = document.createElement('div');
      infoDiv.className = 'chat-item-info';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'chat-item-title';
      titleSpan.textContent = convo.title || 'New Chat';

      const dateSpan = document.createElement('span');
      dateSpan.className = 'chat-item-date';
      dateSpan.textContent = timeStr;

      infoDiv.appendChild(titleSpan);
      infoDiv.appendChild(dateSpan);
      selectBtn.appendChild(iconSpan);
      selectBtn.appendChild(infoDiv);

      selectBtn.addEventListener('click', async () => {
        try {
          navigator.vibrate?.(10);
        } catch {}
        await this.engine.switchConversation(convo.id);
        if (window.innerWidth <= 640) {
          this.toggleSidebar(false);
        }
      });

      // Menu button & Ellipse dropdown
      const menuWrapper = document.createElement('div');
      menuWrapper.className = 'chat-item-menu-wrapper';

      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'chat-item-menu-btn';
      menuBtn.setAttribute('aria-label', `Options for ${convo.title || 'chat'}`);
      menuBtn.title = 'Options';
      menuBtn.textContent = '⋮';

      const menu = document.createElement('div');
      menu.className = 'chat-item-menu dropdown-menu';
      menu.hidden = true;

      // Compact button
      const compactBtn = document.createElement('button');
      compactBtn.type = 'button';
      compactBtn.className = 'chat-menu-action btn-compact-chat';
      compactBtn.innerHTML = '<span class="action-icon">🗜️</span><span>Compact</span>';
      compactBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        menu.hidden = true;
        if (this.statusEl) {
          this.statusEl.textContent = 'Compacting context…';
        }
        await this.engine.compactConversation(convo.id);
        this.updateUiState();
      });

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'chat-menu-action btn-delete-chat';
      deleteBtn.innerHTML = '<span class="action-icon">🗑️</span><span>Delete</span>';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        menu.hidden = true;
        await this.engine.deleteConversation(convo.id);
        this.updateUiState();
      });

      menu.appendChild(compactBtn);
      menu.appendChild(deleteBtn);

      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = menu.hidden;
        document.querySelectorAll('.chat-item-menu:not([hidden])').forEach((m) => {
          (m as HTMLElement).hidden = true;
        });
        menu.hidden = !willOpen;
      });

      menuWrapper.appendChild(menuBtn);
      menuWrapper.appendChild(menu);

      li.appendChild(selectBtn);
      li.appendChild(menuWrapper);
      this.sidebarChatList.appendChild(li);
    }
  }

  private renderAssistantOutput(
    target: HTMLElement,
    content: string,
    toolCall?: ConversationMessage['toolCall'],
    isStreaming = false,
    fromProgram = false
  ): void {
    target.innerHTML = '';

    let activeToolCall = toolCall;
    // "[Interrupted]" is bookkeeping for the model's history; show it as a note, not reply text
    const wasInterrupted = /\[(?:Response )?interrupted\]\s*$/i.test(content);
    let cleanText = content.replace(/\s*\[(?:Response )?interrupted\]\s*$/i, '');

    // If streaming and tool call not yet finalized in msg, detect if stream has tool call block
    if (isStreaming && !activeToolCall) {
      const parsedStream = parseStreamingToolCall(content);
      if (parsedStream) {
        activeToolCall = {
          name: parsedStream.toolName,
          arguments: parsedStream.args,
          status: 'running',
        };
        cleanText = parsedStream.cleanText;
      }
    }

    // Generated code is shown in the model output panel, so only other tools get a card here
    if (activeToolCall && activeToolCall.name !== 'javascript_runtime') {
      target.appendChild(createToolSummaryElement(activeToolCall));
    }

    // Clean conversational text (strip raw tool blocks and special tags completely)
    const stripped = stripToolCallMarkup(cleanText);
    const speakMatches = Array.from(stripped.matchAll(/speak\(\s*(["'`])([\s\S]*?)\1\s*\)/g));
    let displayText = stripped;
    if (speakMatches.length > 0) {
      // Text with ${...} still to fill in shows once the program has run and said it
      displayText = speakMatches
        .map((m) => m[2])
        .filter((t) => !t.includes('${'))
        .join(' ');
    } else if (
      stripped.includes('```') ||
      stripped.includes('MODE:') ||
      /^(?:const|let|var|function|class|import|root\.|document\.|window\.)\b/m.test(stripped.trim())
    ) {
      displayText = '';
    }

    if (displayText) {
      this.soundForBubble(target, fromProgram ? 'output' : 'chat');
      // What a running program said (not the chat model) is marked as its Output
      if (fromProgram) {
        const source = document.createElement('div');
        source.className = 'bubble-source';
        source.textContent = 'Output';
        target.appendChild(source);
      }
      const textDiv = document.createElement('div');
      textDiv.className = 'assistant-text-content';
      textDiv.textContent = displayText;
      target.appendChild(textDiv);
    }
    if (wasInterrupted) {
      target.appendChild(this.createSystemNote('Interrupted'));
    }

    this.scrollChatToBottom();
  }

  /** App/status text inside the conversation panels, styled apart from what was said. */
  private createSystemNote(text: string): HTMLElement {
    const note = document.createElement('div');
    note.className = this.restoringChat ? 'system-note' : 'system-note entering';
    note.setAttribute('role', 'note');
    note.textContent = text;
    return note;
  }

  private showSummaryNote(summaryText: string): void {
    this.chatLogEl?.appendChild(this.createSystemNote(`Earlier in this chat: ${summaryText}`));
  }

  /** Empties the chat log, the raw output panel and its run status. */
  private clearChatLog(): void {
    if (this.chatLogEl) this.chatLogEl.innerHTML = '';
    this.bubbles.clear();
    this.turnBubbles.clear();
    this.interimUserBubble = null;
    // A new or other chat starts on its code, not on the run log a give-up (or a tap) left showing
    this.showingRunLog = false;
    this.setRawOutput('');
    this.setRunStatus(null);
    this.showChatExamples(true);
  }

  /** Renders a whole conversation (on load and when switching chats). */
  private renderConversation(
    messages: readonly ConversationMessage[],
    summary: { summaryText: string } | null | undefined
  ): void {
    this.clearChatLog();
    this.restoringChat = true;
    if (summary?.summaryText) this.showSummaryNote(summary.summaryText);
    for (const m of messages) {
      if (m.autoFix && m.fixNotice) this.addFixNotice(m);
      else if (m.role === 'user' && m.canonicalContent && !m.autoFix) this.addUserBubble(m);
      else if (m.role === 'assistant' && (m.canonicalContent || m.toolCall)) this.renderAssistantMessage(m);
    }
    this.restoringChat = false;
    const lastReply = [...messages].reverse().find((m) => m.role === 'assistant');
    this.setRawOutput(lastReply?.rawLlmOutput || lastReply?.rawCode || '');
    this.scrollChatToBottom();
  }

  private createBubble(role: 'user' | 'assistant'): HTMLElement {
    const row = document.createElement('div');
    row.className = this.restoringChat ? `chat-row ${role}` : `chat-row ${role} entering`;
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    row.appendChild(bubble);
    this.chatLogEl?.appendChild(row);
    return bubble;
  }

  /** What the user is saying, shown as it is recognized; becomes their message once sent. */
  private showInterimTranscript(text: string): void {
    if (!text) {
      this.interimUserBubble?.parentElement?.remove();
      this.interimUserBubble = null;
      return;
    }
    this.interimUserBubble ??= this.createBubble('user');
    this.interimUserBubble.classList.add('interim');
    this.interimUserBubble.textContent = text;
    this.scrollChatToBottom();
  }

  /** Example phrases show in a chat until the user sends something in it. */
  private showChatExamples(show: boolean): void {
    if (this.chatExamplesEl) this.chatExamplesEl.hidden = !show;
  }

  /** A fix turn's note in the chat: the error the model is asked to fix */
  private addFixNotice(msg: ConversationMessage): void {
    if (this.bubbles.has(msg.id) || !msg.fixNotice) return;
    const note = this.createSystemNote(msg.fixNotice);
    // Run notes (Generating…, Fixing …) are Output too
    const source = document.createElement('div');
    source.className = 'bubble-source';
    source.textContent = 'Output';
    note.prepend(source);
    this.chatLogEl?.appendChild(note);
    this.bubbles.set(msg.id, note);
    this.soundForBubble(note, msg.fixNotice === GENERATING_NOTE ? 'output' : 'fix');
    this.scrollChatToBottom();
  }

  private addUserBubble(msg: ConversationMessage): void {
    this.showChatExamples(false);
    if (this.bubbles.has(msg.id)) return;
    const bubble = this.interimUserBubble ?? this.createBubble('user');
    this.interimUserBubble = null;
    bubble.classList.remove('interim');
    bubble.textContent = msg.canonicalContent;
    this.bubbles.set(msg.id, bubble);
    // A typed message sounded when it was sent; a spoken one sounds as it shows
    if (this.userSoundPlayed) this.userSoundPlayed = false;
    else this.soundForBubble(bubble, 'user');
    this.scrollChatToBottom();
  }

  /** A bubble's interface sound, the first time its text of that kind shows (not for a chat being restored) */
  private soundForBubble(bubble: HTMLElement, sound: InterfaceSound): void {
    if (this.restoringChat) return;
    const played = this.bubbleSounds.get(bubble) ?? new Set<InterfaceSound>();
    if (played.has(sound)) return;
    played.add(sound);
    this.bubbleSounds.set(bubble, played);
    this.engine.playInterfaceSound(sound);
  }

  private bubbleForTurn(turnId: string): HTMLElement {
    let bubble = this.turnBubbles.get(turnId);
    if (!bubble) {
      bubble = this.createBubble('assistant');
      this.turnBubbles.set(turnId, bubble);
    }
    return bubble;
  }

  private renderAssistantMessage(msg: ConversationMessage): void {
    const bubble = this.bubbles.get(msg.id) ?? this.bubbleForTurn(msg.turnId);
    this.bubbles.set(msg.id, bubble);
    // Anything a run produced (its words, or Chatty's note on it) is Output; the model's own chat isn't tagged
    this.renderAssistantOutput(bubble, msg.canonicalContent, msg.toolCall, false, msg.fromProgram !== undefined);
  }

  /**
   * Shows the model's raw output as highlighted code, kept scrolled to the newest text.
   * speak() lines are left out: what was said is in the chat.
   * Streamed tokens only update the text here; the painting (highlighting the whole program is
   * slow) waits for the next frame, and every other call paints at once.
   */
  private setRawOutput(text: string, streaming = false): void {
    if (!this.rawOutputEl) return;
    this.lastRawOutput = text;
    let code = '';
    if (!this.showingRunLog) {
      // Without speak() lines (they're in the chat) and without code fences: an unmatched ``` reads
      // as an open template string and would turn everything after it into one green string
      const unfenced = text
        .split('\n')
        .filter((line) => !/^\s*(?:(?:javascript|js|html|css)[ \t:]*)?(?:```|~~~|"""|''')[\w-]*\s*$/i.test(line));
      // Set now, not in the frame: Share reads it between frames
      this.panelCode = unfenced.join('\n').trim();
      code = unfenced
        .filter((line) => !/^\s*(?:await\s+)?speak\(.*\);?\s*$/.test(line))
        .join('\n')
        .trim();
    }
    this.rawOutputFrame.push(code);
    if (!streaming) this.rawOutputFrame.flush();
  }

  /** Draws the run log or the highlighted code, scrolled to the end */
  private paintRawOutput(code: string): void {
    const el = this.rawOutputEl;
    if (!el) return;
    if (this.showingRunLog) {
      if (this.tallyVersion !== runLogVersion()) {
        this.tallyVersion = runLogVersion();
        this.tallyLine = formatRepairTally(repairTally());
      }
      el.textContent = `${this.tallyLine}\n\n${this.engine.getRunLog() || 'Nothing has run yet.'}`;
    } else {
      el.innerHTML = Prism.highlight(code, Prism.languages.javascript, 'javascript');
    }
    el.scrollTop = el.scrollHeight;
  }

  /** Shows a program from a #program= link in the code panel. It runs only when the user clicks. */
  private openSharedProgram(): void {
    const code = decodeProgramHash(location.hash);
    if (code === null) return;
    history.replaceState(null, '', location.pathname + location.search);
    this.sharedProgram = code;
    this.showingRunLog = false;
    this.setRunStatus(null);
    this.setRawOutput(code);
    const bar = document.getElementById('shared-program');
    if (bar) bar.hidden = false;
    const run = document.getElementById('btn-run-shared');
    if (!run) return;
    run.onclick = () => {
      const program = this.sharedProgram;
      if (program === null) return;
      this.sharedProgram = null;
      if (bar) bar.hidden = true;
      this.resetVisualScreen();
      void this.engine.executeJavascript(program).then(
        (res) => this.setRunStatus(res.success ? { kind: 'ok', text: 'Ran the shared program' } : { kind: 'error', text: res.error ?? 'The shared program failed' }),
        (e) => this.setRunStatus({ kind: 'error', text: String(e) })
      );
    };
  }

  /** Copies a link to the program in the code panel, through the share sheet where there is one */
  private async shareProgram(button: HTMLElement): Promise<void> {
    const hash = encodeProgramHash(this.panelCode);
    const say = (text: string): void => {
      const old = button.title;
      button.title = text;
      button.dataset.feedback = text;
      setTimeout(() => {
        if (!button.isConnected) return;
        button.title = old;
        delete button.dataset.feedback;
      }, 1500);
    };
    if (hash === null) {
      say(this.panelCode ? 'too long to share' : 'nothing to share');
      return;
    }
    const url = location.origin + import.meta.env.BASE_URL + hash;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'A Chatty program', url });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      say('link copied');
    } catch {
      say('copy failed');
    }
  }

  /** Copies what the code panel shows (the run log, or the code) and says so on the link */
  private async copyRawPanel(link: HTMLElement): Promise<void> {
    // It copies the panel's text: paint any streamed text still waiting for its frame
    this.rawOutputFrame.flush();
    const text = this.showingRunLog ? this.engine.getRunLog() : (this.rawOutputEl?.textContent ?? '');
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // No clipboard access (older Safari): copy through a hidden text area
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;opacity:0;';
      document.body.append(area);
      area.select();
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
      area.remove();
    }
    link.textContent = copied ? 'copied' : 'copy failed';
    setTimeout(() => {
      if (link.isConnected) link.textContent = 'copy';
    }, 1500);
  }

  private setRunStatus(status: RunStatus | null): void {
    const el = this.runStatusEl;
    if (!el) return;
    el.hidden = !status;
    el.textContent = status ? `${RUN_STATUS_ICONS[status.kind]} ${status.text}` : '';
    if (status) {
      const hint = document.createElement('span');
      hint.className = 'run-log-toggle';
      hint.textContent = this.showingRunLog ? 'code' : 'log';
      // Copies what the panel shows: the run log, or the code
      const copy = document.createElement('span');
      copy.className = 'run-log-toggle run-copy';
      copy.textContent = 'copy';
      const share = document.createElement('span');
      share.className = 'run-log-toggle run-share';
      share.title = 'Share this program as a link';
      share.setAttribute('role', 'button');
      share.setAttribute('aria-label', 'Share this program as a link');
      share.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
      el.append(hint, copy, share);
    }
    // The run log grows with each run: keep it current while it's shown
    if (this.showingRunLog) this.setRawOutput(this.lastRawOutput);
    el.dataset.kind = status?.kind ?? '';
  }

  /** Keeps the chat log scrolled to the newest message. */
  private scrollChatToBottom(): void {
    if (this.chatLogEl) this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
  }

  /** Resolves once Settings is closed and any changes saved there are applied. */
  private async settingsClosed(): Promise<void> {
    const dialog = this.settingsDialog;
    if (dialog?.open) await new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
    await this.settingsApplying.catch(() => {});
  }

  private fillSpeechSetting(on: boolean): void {
    if (this.toggleSpeech) this.toggleSpeech.checked = on;
    if (this.voiceField) this.voiceField.hidden = !on;
  }

  private updateUiState(): void {
    const snap = this.engine.getSnapshot();
    // 'unloaded' counts as loading too: it is the state before startup begins
    const isModelLoading =
      snap.models.llm === 'unloaded' ||
      snap.models.llm === 'downloading' ||
      snap.models.llm === 'initializing' ||
      snap.models.tts === 'downloading' ||
      snap.models.tts === 'initializing';

    const canInterrupt =
      snap.interaction === 'generating' ||
      snap.interaction === 'speaking' ||
      snap.interaction === 'compacting' ||
      snap.playback === 'playing' ||
      snap.playback === 'buffering';

    const isListening = this.engine.getIsListening();
    const isActive = isListening || canInterrupt;
    const hasHistory = this.engine.hasHistory();

    // A program still running or making sound can be stopped with the same button
    const programActive = this.programSounding || this.programRunning;
    this.stopButtonStopsProgram = programActive && !isActive;

    // One button, by priority: Stop (busy, listening, a program running) > Start/Continue (voice
    // on) > Clear (something on screen, nothing else to do) > hidden
    const speechOn = this.engine.isSpeechEnabled();
    const stopping = isActive || programActive;
    // The first time loading is done, the page hears of it (the service worker waits for it on iPhone)
    if (!isModelLoading && !this.modelsReadyAnnounced && this.engine.getSnapshot().models.llm === 'ready') {
      this.modelsReadyAnnounced = true;
      (window as unknown as { __chattyModelsReady?: boolean }).__chattyModelsReady = true;
      window.dispatchEvent(new Event('chatty:models-ready'));
    }
    this.mainButtonReplays = !isModelLoading && !stopping && !speechOn && this.engine.canReplay();
    if (this.micBtn) {
      this.micBtn.disabled = isModelLoading;
      this.micBtn.classList.toggle('listening', stopping);
      this.micBtn.classList.toggle('replaying', this.mainButtonReplays);
      // Start, Continue and Replay show the play triangle; Loading and Stop keep the dot
      this.micBtn.classList.toggle('plays', !isModelLoading && !stopping);
      this.micBtn.hidden = !speechOn && !stopping && !this.mainButtonReplays;
      this.micBtn.setAttribute('aria-label', this.mainButtonReplays ? 'Run the program again' : 'Start or stop voice');
      this.micBtn.title = this.mainButtonReplays ? 'Run the program again' : '';
    }
    // Clear: whenever something is on screen and nothing is running (Stop clears a running one)
    if (this.clearScreenBtn) this.clearScreenBtn.hidden = isModelLoading || stopping || !this.screenHasContent;
    const waves = document.querySelector<HTMLElement>('.chat-waveforms');
    if (waves) waves.hidden = !speechOn;
    const examplesTitle = this.chatExamplesEl?.querySelector('.chat-examples-title');
    if (examplesTitle) examplesTitle.textContent = speechOn ? 'Try saying' : 'Try typing';

    if (this.micLabel) {
      this.micLabel.textContent = isModelLoading
        ? 'Loading…'
        : stopping
          ? 'Stop'
          : this.mainButtonReplays
            ? 'Replay'
            : hasHistory
              ? 'Continue'
              : 'Start';
    }
    // Until the models are ready, everything but Settings is grayed out and can't be used
    if (this.chatSendBtn) this.chatSendBtn.disabled = isModelLoading;
    if (this.chatInput) this.chatInput.disabled = isModelLoading;
    if (this.toggleSidebarBtn) this.toggleSidebarBtn.disabled = isModelLoading;
    const chips = this.chatExamplesEl?.querySelectorAll<HTMLButtonElement>('.chat-example') ?? [];
    chips.forEach((chip) => {
      chip.disabled = isModelLoading;
    });
    for (const el of [this.chatInput, this.chatSendBtn, this.toggleSidebarBtn, this.newBtn, ...chips]) {
      el?.classList.toggle('loading-blocked', isModelLoading);
    }

    if (this.newBtn) {
      this.newBtn.hidden = false;
      this.newBtn.disabled = isModelLoading;
      this.newBtn.style.opacity = hasHistory ? '1' : '0.65';
      this.newBtn.title = hasHistory
        ? 'Start new chat and reset history'
        : 'Start a new conversation';
    }

    const isSpeaking = snap.interaction === 'speaking' || snap.playback === 'playing';
    const mascotContainer = document.getElementById('minimal-mascot-container');
    if (mascotContainer) {
      mascotContainer.classList.toggle('listening', isListening);
      mascotContainer.classList.toggle('speaking', isSpeaking);
    }

    this.updateStatusFromSnapshot();
    this.updateContextMeter();
    this.updateBusyIndicator();
  }

  /**
   * Turns the context meter into an animated barber pole while the app is initializing or
   * the LLM is working (transcribing, building context, generating, compacting, running tools).
   */
  /** Opens Settings and waits for it to close; `loadProblem` explains why (last load crashed or failed). */
  private showSettingsAndWait(loadProblem: string | null = null): Promise<void> {
    const dialog = this.settingsDialog;
    if (!dialog) return Promise.resolve();
    const warning = document.getElementById('model-load-warning');
    if (warning) {
      // iPhone Safari: quitting it frees the memory a crashed tab left behind
      const advice = isAppleMobile() ? 'Force quitting Safari may help.' : 'Choose a smaller model, then save.';
      warning.textContent = loadProblem ? `⚠️ ${loadProblem} ${advice}` : '';
      warning.hidden = !loadProblem;
    }
    const current = this.engine.getSettings();
    this.fillChatModelOptions(current.chatModelId);
    if (this.selectPiperVoice) this.selectPiperVoice.value = current.voiceId;
    this.fillSpeechSetting(current.speechEnabled);
    void this.refreshModelCacheSize();
    return new Promise((resolve) => {
      dialog.addEventListener(
        'close',
        () => {
          try {
            localStorage.setItem(SETTINGS_SEEN_KEY, __APP_VERSION__);
          } catch {
            // ignore
          }
          if (warning) warning.hidden = true;
          resolve();
        },
        { once: true }
      );
      dialog.showModal();
    });
  }

  private fillChatModelOptions(selected: string): void {
    if (!this.selectChatModel) return;
    this.selectChatModel.replaceChildren(
      ...this.engine.getChatModelOptions().map((m) => new Option(m.name, m.id))
    );
    this.selectChatModel.value = selected;
  }

  private updateBusyIndicator(): void {
    const bar = document.querySelector<HTMLElement>('.context-meter-bar');
    if (!bar) return;
    const snap = this.engine.getSnapshot();
    const busy =
      this.appInitializing ||
      this.isStartupLoading() ||
      snap.interaction === 'finalizing_input' ||
      snap.interaction === 'building_context' ||
      snap.interaction === 'compacting' ||
      snap.interaction === 'generating' ||
      snap.turn === 'processing_input' ||
      snap.turn === 'generating';
    bar.classList.toggle('busy', busy);
    bar.setAttribute('aria-busy', String(busy));
    this.noteTurnWorking(
      snap.interaction === 'finalizing_input' ||
        snap.interaction === 'building_context' ||
        snap.interaction === 'generating' ||
        snap.turn === 'processing_input' ||
        snap.turn === 'generating'
    );
    // Also stay awake while the mic is on, so a hands-free conversation isn't cut off by sleep.
    this.setKeepAwake(busy || snap.microphone === 'listening');
  }

  /**
   * Holds a Screen Wake Lock while busy so mobile browsers don't sleep: iOS suspends a sleeping
   * page and kills tabs holding a large model, so dimming mid-load crashes the app.
   * The lock is fragile on mobile (dropped when hidden, revoked by Low Power Mode, denied in
   * iOS < 18.4 Home Screen apps), so while it is wanted it is re-requested on release, on
   * visibility, on the next tap, and every few seconds.
   */
  private setKeepAwake(on: boolean): void {
    this.keepAwakeWanted = on;
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } })
      .wakeLock;

    if (!this.keepAwakeListenerAdded) {
      this.keepAwakeListenerAdded = true;
      const retry = () => {
        if (this.keepAwakeWanted && !this.isWakeLockHeld()) this.setKeepAwake(true);
      };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') retry();
      });
      // A user gesture can succeed where an unprompted request was refused
      window.addEventListener('pointerdown', retry, { capture: true, passive: true });
      window.addEventListener('keydown', retry, { capture: true });
    }

    if (on) {
      if (!this.keepAwakeRetryTimer) {
        this.keepAwakeRetryTimer = window.setInterval(() => {
          if (this.keepAwakeWanted && !this.isWakeLockHeld()) this.setKeepAwake(true);
        }, 5000);
      }
      if (!wakeLock || this.isWakeLockHeld()) return;
      if (this.wakeLockPending || document.visibilityState !== 'visible') return;
      this.wakeLockPending = true;
      wakeLock
        .request('screen')
        .then((sentinel) => {
          this.wakeLockSentinel = sentinel;
          // Re-acquire if the system revokes it while still busy
          sentinel.addEventListener?.('release', () => {
            if (this.wakeLockSentinel === sentinel) this.wakeLockSentinel = null;
            if (this.keepAwakeWanted && document.visibilityState === 'visible') this.setKeepAwake(true);
          });
          // Became idle while the request was in flight
          if (!this.keepAwakeWanted) void sentinel.release().catch(() => {});
        })
        .catch(() => {
          // Denied (Low Power Mode, iOS Home Screen app < 18.4, no gesture yet); retried later
        })
        .finally(() => {
          this.wakeLockPending = false;
        });
    } else {
      if (this.keepAwakeRetryTimer) {
        window.clearInterval(this.keepAwakeRetryTimer);
        this.keepAwakeRetryTimer = 0;
      }
      if (this.wakeLockSentinel) {
        const sentinel = this.wakeLockSentinel;
        this.wakeLockSentinel = null;
        void sentinel.release().catch(() => {});
      }
    }
  }

  private isWakeLockHeld(): boolean {
    return !!this.wakeLockSentinel && !this.wakeLockSentinel.released;
  }

  /** True while any startup model (Gemma, Piper, Whistle) is still downloading/initializing. */
  private isStartupLoading(): boolean {
    const m = this.engine.getSnapshot().models;
    return (
      m.llm === 'downloading' ||
      m.llm === 'initializing' ||
      m.tts === 'downloading' ||
      m.tts === 'initializing' ||
      !this.sttLoadSettled
    );
  }

  /**
   * One progress bar for all startup models (loaded one at a time): the status line names the
   * model currently loading, the bar shows bytes across all three.
   */
  private reportLoadProgress(
    kind: LoadKind,
    loaded: number,
    total: number,
    label: string,
    /** The single model loading within a multi-model stage, with its own bytes */
    current?: { loaded: number; total: number }
  ): void {
    const settings = this.engine.getSettings();
    const expected = (id: string, fallback: number) =>
      MODEL_REGISTRY.find((m) => m.id === id)?.expectedSizeBytes ?? fallback;
    const defaults: Record<LoadKind, number> = {
      llm: this.engine.getStartupLlmExpectedBytes(),
      tts: expected(settings.voiceId, 63_201_294),
      stt: expected('whistle-stt-base', 16_919_407),
    };
    this.loadBytes[kind] = { loaded, total: total > 0 ? total : defaults[kind] };

    const m = this.engine.getSnapshot().models;
    // Speech off: only the chat model loads
    const kinds: LoadKind[] = this.engine.isSpeechEnabled() ? ['llm', 'tts', 'stt'] : ['llm'];
    const finished: Record<LoadKind, boolean> = {
      llm: m.llm === 'ready' || m.llm === 'failed',
      tts: m.tts === 'ready' || m.tts === 'failed',
      stt: this.sttLoadSettled,
    };
    let sumLoaded = 0;
    let sumTotal = 0;
    for (const k of kinds) {
      const t = this.loadBytes[k].total || defaults[k];
      sumTotal += t;
      sumLoaded += finished[k] ? t : Math.min(this.loadBytes[k].loaded, t);
    }
    const overallPct = sumTotal > 0 ? Math.min(100, Math.round((sumLoaded * 100) / sumTotal)) : 0;
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(0);
    const own = current ?? this.loadBytes[kind];
    const order = this.engine.getStartupModelOrder();
    const index = order.indexOf(label);
    const step = index >= 0 && order.length > 1 ? ` (${index + 1} of ${order.length})` : '';
    const rate = this.measureDownloadRate(label, own.loaded);
    const rateText = rate && own.loaded < own.total ? ` · ${rate.toFixed(1)} MB/s` : '';
    // Nothing downloaded yet, or past the download (the weights going onto the GPU, the
    // shaders): say what the runtime is doing ("Loading GPU shader modules [12/80]"), so a load
    // that stalls shows where, and no download speed shows for work that isn't a download
    const llmStage = kind === 'llm' ? this.engine.getLlmLoadStage() : '';
    const stage = kind === 'llm' && (own.loaded === 0 || /^Loading (?:model from cache|GPU shader)/i.test(llmStage)) ? loadStageText(llmStage) : '';
    // The left says what is loading (and how fast); the right and the bar, how far along it all is
    this.updateDownloadProgress(
      stage ? `Loading ${label}${step} — ${stage}` : `Loading ${label}${step}${rateText}`,
      overallPct,
      `${overallPct}% · ${mb(sumLoaded)} / ${mb(sumTotal)} MB`
    );
  }

  /** Smoothed download speed (MB/s) of the model loading now, or null until there's enough to measure. */
  private measureDownloadRate(label: string, loaded: number): number | null {
    const now = performance.now();
    const last = this.downloadRate;
    if (last.label !== label || loaded < last.bytes) {
      this.downloadRate = { label, bytes: loaded, time: now, rate: 0 };
      return null;
    }
    const elapsed = now - last.time;
    if (elapsed >= 500) {
      const instant = (loaded - last.bytes) / (1024 * 1024) / (elapsed / 1000);
      last.rate = last.rate ? last.rate * 0.6 + instant * 0.4 : instant;
      last.bytes = loaded;
      last.time = now;
    }
    return last.rate || null;
  }

  private updateDownloadProgress(statusText: string, pct: number, meterText: string): void {
    if (this.statusEl) {
      this.statusEl.textContent = statusText;
    }
    const meterFill = document.getElementById('context-meter-fill');
    const meterVal = document.getElementById('context-meter-text');
    const thresholdEl = document.getElementById('context-meter-threshold');

    if (meterFill) {
      meterFill.style.width = `${Math.max(1, pct)}%`;
      meterFill.classList.remove('warning', 'danger');
    }
    if (meterVal) {
      meterVal.textContent = meterText;
    }
    if (thresholdEl) {
      thresholdEl.style.display = 'none';
    }
  }

  private updateContextMeter(): void {
    if (this.isStartupLoading()) return; // Retain download progress bar while models are loading

    const meterFill = document.getElementById('context-meter-fill');
    const meterText = document.getElementById('context-meter-text');
    const thresholdEl = document.getElementById('context-meter-threshold');

    if (thresholdEl) {
      thresholdEl.style.display = '';
    }

    if (!meterFill && !meterText) return;

    const { usedTokens, contextLimit, percentage } = this.engine.getContextUsage();
    if (meterFill) {
      meterFill.style.width = `${percentage}%`;
      meterFill.classList.toggle('warning', percentage >= 70 && percentage < 85);
      meterFill.classList.toggle('danger', percentage >= 85);
    }
    if (meterText) {
      meterText.textContent = `${percentage}% · ${usedTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens`;
    }
  }

  /** The chat model's name ("Qwen3 0.6B"), without the size and notes in brackets */
  private chatModelName(): string {
    const model = SUPPORTED_CHAT_MODELS.find((m) => m.id === this.engine.getChatModelId());
    return model ? model.name.replace(/\s*\(.*$/, '') : 'Ready';
  }

  private updateStatusFromSnapshot(): void {
    if (!this.statusEl) return;
    const snap = this.engine.getSnapshot();
    const busy = (what: string) => `${this.chatModelName()} · ${what}`;

    const isModelLoading = this.isStartupLoading();

    if (snap.models.llm === 'failed') {
      this.statusEl.textContent =
        typeof navigator !== 'undefined' && 'gpu' in navigator
          ? 'WebGPU / Model Error'
          : 'WebGPU not supported in this browser';
    } else if (isModelLoading) {
      // Keep existing progress string if already showing percentages
      if (!this.statusEl.textContent?.startsWith('Loading')) {
        this.statusEl.textContent = 'Pulling models…';
      }
    } else if (snap.interaction === 'compacting') {
      this.statusEl.textContent = busy('Compacting…');
    } else if (snap.interaction === 'finalizing_input') {
      this.statusEl.textContent = busy('Transcribing…');
    } else if (snap.interaction === 'building_context' || snap.interaction === 'generating') {
      this.statusEl.textContent = busy('Thinking…');
    } else if (snap.interaction === 'speaking' || snap.playback === 'playing') {
      this.statusEl.textContent = busy('Speaking…');
    } else if (this.engine.getIsListening() || snap.interaction === 'listening') {
      this.statusEl.textContent = busy('Listening…');
    } else if (snap.interaction === 'error') {
      this.statusEl.textContent = snap.lastError ?? 'Error';
    } else {
      // Ready: the model's name says it is loaded and which one it is
      this.statusEl.textContent = this.chatModelName();
    }
  }

  private startWaveforms(): void {
    const handleContextLost = (e: Event) => {
      e.preventDefault();
      console.warn('[Canvas Waveform] Canvas context lost on mobile');
    };

    this.inputCanvas?.addEventListener('contextlost', handleContextLost);
    this.outputCanvas?.addEventListener('contextlost', handleContextLost);

    let isVisible = !document.hidden;
    let animFrameId: number | null = null;

    const draw = () => {
      if (!isVisible) {
        animFrameId = null;
        return;
      }

      const inRms = this.engine.getInputWaveformData(this.inputPcmBuffer);
      const outRms = this.engine.getOutputWaveformData(this.outputPcmBuffer);
      const snap = this.engine.getSnapshot();
      const isListening = this.engine.getIsListening();
      const isSpeaking = snap.interaction === 'speaking' || snap.playback === 'playing';

      if (this.inputVisualizer) {
        this.inputVisualizer.render(this.inputPcmBuffer, inRms, isListening);
      }
      if (this.outputVisualizer) {
        this.outputVisualizer.render(this.outputPcmBuffer, outRms, isSpeaking);
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

  /** Fully resets the agent's visual screen (iframe document, timers, audio) and click capture. */
  /** Shows the drawing layer; the combined button offers Clear while something is drawn on it. */
  private showScreenContent(hasContent: boolean): void {
    if (hasContent && this.screenVisualLayer) this.screenVisualLayer.hidden = false;
    if (this.screenHasContent !== hasContent) {
      this.screenHasContent = hasContent;
      this.updateUiState();
    }
  }

  /**
   * The card while a program has failed: hidden when it showed nothing (there is nothing to see),
   * otherwise faded and pulsing while a fix is coming, and cleared once every fix has failed. New
   * results bring it back.
   */
  private showProgramState(status: RunStatus | null): void {
    const layer = this.screenVisualLayer;
    if (!layer) return;
    // Every fix failed: the card is cleared and hidden, for a fresh start
    if (status?.kind === 'error' && status.text.endsWith(GAVE_UP_STATUS)) {
      this.resetVisualScreen();
      return;
    }
    const failed = status?.kind === 'error';
    const fixing = failed && /\((?:asking the model to fix it|trying fixes for )/.test(status.text);
    layer.classList.toggle('program-hidden', failed && status.text.includes('showed nothing'));
    layer.classList.toggle('program-failed', failed && !fixing);
    this.fixingNow = fixing;
    this.updateCardState();
  }

  /** While typing, and while a reply or a fix is on its way: the card steps back (card-shrunk) */
  private inputFocused = false;
  private cardWorking = false;
  private fixingNow = false;
  private cardRelaxTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * What the user chose by tapping: 'big' (they tapped the small card), 'small' (they tapped
   * somewhere else while it was big), or 'auto' (it follows typing and turns). A new turn, typing
   * and a cleared screen go back to 'auto'.
   */
  private cardSize: 'auto' | 'small' | 'big' = 'auto';
  /** A tap that grew the card: its click doesn't reach what's under the card */
  private swallowClickUntil = 0;

  private updateCardState(): void {
    const stepsBack = this.inputFocused || this.cardWorking || this.fixingNow;
    this.screenVisualLayer?.classList.toggle('card-shrunk', this.cardSize === 'small' || (this.cardSize === 'auto' && stepsBack));
  }

  /** A tap on the small card makes it big; a tap anywhere else while it's big makes it small */
  private watchCardTaps(): void {
    document.addEventListener(
      'pointerdown',
      (event) => {
        const layer = this.screenVisualLayer;
        const card = layer?.querySelector<HTMLElement>('.js-iframe-container > div:not([hidden])');
        if (!layer || layer.hidden || layer.classList.contains('program-hidden') || !card) return;
        const r = card.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        // (taps inside the big card go to the program's own page and never reach this one)
        const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
        const small = layer.classList.contains('card-shrunk');
        if (small && inside) {
          this.cardSize = 'big';
          this.updateCardState();
          event.preventDefault();
          event.stopPropagation();
          this.swallowClickUntil = performance.now() + 600;
        } else if (!small && !inside) {
          this.cardSize = 'small';
          this.updateCardState();
        }
      },
      true
    );
    document.addEventListener(
      'click',
      (event) => {
        if (performance.now() > this.swallowClickUntil) return;
        this.swallowClickUntil = 0;
        event.preventDefault();
        event.stopPropagation();
      },
      true
    );
  }

  /** A turn is working (or not): the card comes back a moment after the last one ends, so it stays back between a turn and the fix that follows */
  private noteTurnWorking(working: boolean): void {
    if (working) {
      if (this.cardRelaxTimer !== null) clearTimeout(this.cardRelaxTimer);
      this.cardRelaxTimer = null;
      if (!this.cardWorking) {
        // A new turn: the card follows it again, whatever was tapped before
        this.cardSize = 'auto';
        this.cardWorking = true;
        this.updateCardState();
      }
      return;
    }
    if (!this.cardWorking || this.cardRelaxTimer !== null) return;
    this.cardRelaxTimer = setTimeout(() => {
      this.cardRelaxTimer = null;
      this.cardWorking = false;
      this.updateCardState();
    }, 800);
  }

  private resetVisualScreen(): void {
    this.screenVisualLayer?.classList.remove('program-hidden', 'program-failed');
    this.fixingNow = false;
    this.cardSize = 'auto';
    this.updateCardState();
    this.programSounding = false;
    this.programRunning = false;
    this.showScreenContent(false);
    const iframe = this.engine.getActiveIframe();
    if (iframe) iframe.style.pointerEvents = 'none';
    void this.engine.jsRuntime.resetVisual();
    this.engine.clearVisualScreen();
  }

}

// Auto-initialize when loaded
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const start = () => {
    const app = new MinimalVoiceApp();
    void app.init();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Register Service Worker for offline PWA functionality in production,
  // while unregistering in development mode to prevent reload stalls with Vite HMR
  if ('serviceWorker' in navigator) {
    if (import.meta.env.DEV) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const reg of registrations) {
          void reg.unregister().then(() => {
            console.debug('[Chatty PWA] Unregistered development service worker:', reg.scope);
          });
        }
      });
    } else {
      /** Registers the worker; resolves once a new one has finished installing (a minute at most) */
      const registerSw = (query = ''): Promise<void> =>
        navigator.serviceWorker
          // The app lives under Vite's base ('/chatty/'), so the worker and its scope do too
          .register(`${import.meta.env.BASE_URL}sw.js${query}`, { scope: import.meta.env.BASE_URL })
          .then((reg) => {
            console.debug('[Chatty PWA] Service Worker registered:', reg.scope);
            const worker = reg.installing;
            if (!worker) return;
            return new Promise<void>((resolve) => {
              worker.addEventListener('statechange', () => {
                if (worker.state !== 'installing') resolve();
              });
              setTimeout(resolve, 60_000);
            });
          })
          .catch((err) => {
            console.warn('[Chatty PWA] Service Worker registration warning:', err);
          });

      if (isAppleMobile()) {
        // iPhone Safari: the worker installs once the models have loaded and settled, so the two
        // don't run at the same time, and stores only the app shell (sw.js?lite=1). Recorded until
        // it has installed, so a crash then is named on the next visit.
        const afterModels = () =>
          void settle(AFTER_LOAD_MS).then(() => withActivity('installing the offline copy', () => registerSw('?lite=1')));
        if ((window as unknown as { __chattyModelsReady?: boolean }).__chattyModelsReady) afterModels();
        else window.addEventListener('chatty:models-ready', afterModels, { once: true });
      } else if (document.readyState === 'complete') {
        void registerSw();
      } else {
        window.addEventListener('load', () => void registerSw());
      }
    }
  }

  // Install: only where the browser offers its own install prompt (Chrome, Edge, Android)
  let deferredInstallPrompt: any = null;
  const installBtn = document.getElementById('btn-install-app') as HTMLButtonElement | null;
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as any).standalone === true;

  // iPhone: a quality warning in place of installing (the models that fit Safari are the smallest)
  // The memory the browser reports (Chrome's navigator.deviceMemory), which picks the phone model
  const memoryEl = document.getElementById('settings-device-memory');
  if (memoryEl) {
    const gb = (navigator as { deviceMemory?: number }).deviceMemory;
    memoryEl.textContent = typeof gb === 'number' ? `Memory ${gb} GB` : 'Memory not reported';
    memoryEl.title = typeof gb === 'number' ? 'Reported by the browser, rounded' : "This browser doesn't report memory";
  }

  const installField = document.getElementById('settings-install-field');
  // Only in Safari itself: a Home Screen app (standalone) isn't Safari, and needs no workaround
  if (isAppleMobile() && !isStandalone && installField) {
    installField.innerHTML =
      '<p class="settings-safari-warning" role="note">⚠️ Quality degraded on iPhone Safari' +
      '<span class="settings-safari-hint">Save to Home Screen as a workaround. Website Menu » Share » Scroll Down » Add to Home Screen</span></p>';
    installField.hidden = false;
  }

  if (!isStandalone) {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (installBtn) installBtn.hidden = false;
    });
  }

  installBtn?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    (document.getElementById('settings-dialog') as HTMLDialogElement | null)?.close();
    await deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      deferredInstallPrompt = null;
      installBtn.hidden = true;
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if (installBtn) installBtn.hidden = true;
  });

  // Share: the system share sheet, where the browser has one
  const shareBtn = document.getElementById('btn-share-app') as HTMLButtonElement | null;
  const shareData = { title: 'Chatty', url: location.origin + location.pathname };
  if (shareBtn && typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare(shareData))) {
    shareBtn.hidden = false;
    shareBtn.addEventListener('click', () => {
      navigator.share(shareData).catch(() => {
        // Dismissed, or not allowed here
      });
    });
  }
}
