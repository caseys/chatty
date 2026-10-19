// ============================================================================
// Standalone Minimal UI Controller
// Powered by the unified VoiceAssistantEngine
// ============================================================================

import Prism from 'prismjs';
import { VoiceAssistantEngine } from './core/voice-assistant-engine.ts';
import { MODEL_REGISTRY } from './core/model-manager.ts';
import { FluidAudioVisualizer } from './audio/visualizer.ts';
import type { ConversationMessage, StoredConversation } from './types/index.ts';
import { createToolSummaryElement, parseStreamingToolCall, stripToolCallMarkup } from './tools/tool-formatter.ts';

type LoadKind = 'llm' | 'tts' | 'stt';

/** The app's own greeting (engine creates it with a welcome_ turn id). */

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
};

const SETTINGS_SEEN_KEY = 'chatty_settings_seen';
/** Set once the user has spoken; until then the chat shows example phrases */
const HAS_SPOKEN_KEY = 'chatty_has_spoken';
/** Matches the CSS breakpoint where the chat and code panels stack */
const NARROW_LAYOUT = '(max-width: 760px)';

/** True on the very first visit (settings never saved or shown). */
function isFirstVisit(): boolean {
  try {
    return localStorage.getItem(SETTINGS_SEEN_KEY) === null && localStorage.getItem('chatty_user_settings') === null;
  } catch {
    return false;
  }
}

export class MinimalVoiceApp {
  private engine: VoiceAssistantEngine;
  private micBtn = document.getElementById('btn-mic-toggle') as HTMLButtonElement | null;
  private micLabel = document.getElementById('mic-btn-label');
  private newBtn = document.getElementById('btn-new-chat') as HTMLButtonElement | null;
  private statusEl = document.getElementById('minimal-status');
  private chatLogEl = document.getElementById('chat-log');
  private chatExamplesEl = document.getElementById('chat-examples');
  private rawOutputEl = document.getElementById('raw-output');
  // Chat bubbles by message id and by turn (streamed text arrives before the reply is saved)
  private bubbles = new Map<string, HTMLElement>();
  private turnBubbles = new Map<string, HTMLElement>();
  private interimUserBubble: HTMLElement | null = null;
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
  private clearScreenBtn = document.getElementById('btn-clear-screen') as HTMLButtonElement | null;

  private jsIframeContainer = document.getElementById('js-runtime-iframe-container');

  // Settings Dialog Elements
  private settingsBtn = document.getElementById('btn-settings') as HTMLButtonElement | null;
  private settingsDialog = document.getElementById('settings-dialog') as HTMLDialogElement | null;
  private settingsForm = document.getElementById('settings-form') as HTMLFormElement | null;
  private closeSettingsXBtn = document.getElementById('btn-close-settings-x') as HTMLButtonElement | null;
  private cancelSettingsBtn = document.getElementById('btn-cancel-settings') as HTMLButtonElement | null;
  private selectChatModel = document.getElementById('select-chat-model') as HTMLSelectElement | null;
  private selectPiperVoice = document.getElementById('select-piper-voice') as HTMLSelectElement | null;

  // Sidebar Elements
  private sidebarEl = document.getElementById('chat-sidebar') as HTMLElement | null;
  private sidebarBackdrop = document.getElementById('sidebar-backdrop') as HTMLElement | null;
  private toggleSidebarBtn = document.getElementById('btn-toggle-sidebar') as HTMLButtonElement | null;
  private closeSidebarBtn = document.getElementById('btn-close-sidebar') as HTMLButtonElement | null;
  private sidebarNewChatBtn = document.getElementById('btn-sidebar-new-chat') as HTMLButtonElement | null;
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
      onRawOutput: (_turnId, raw) => {
        this.setRawOutput(raw);
      },
      onMessageCreated: (msg) => {
        if (msg.role === 'user' && msg.canonicalContent) {
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
    this.startWaveforms();
    // Install click pass-through before the (potentially long) model download/initialization.
    this.initPointerPassthrough();
    this.updateBusyIndicator();
    this.updateDownloadProgress('Loading models…', 0, '0%');
    try {
      // First visit: choose the model and voice before anything downloads
      if (isFirstVisit()) {
        await this.engine.detectDevice();
        await this.showSettingsAndWait();
      }
      await this.engine.initialize();
      // The page died mid-load last time: say which model, so on-device testing can pinpoint it
      const failedStage = this.engine.previousLoadFailure;
      const note = document.getElementById('load-failure-note');
      if (failedStage && note) {
        note.textContent = `Last visit stopped while loading ${failedStage} (likely out of memory).`;
        note.hidden = false;
      }
    } finally {
      this.appInitializing = false;
      this.updateBusyIndicator();
    }

    // Expose engine globally for programmatic access / testing
    if (typeof window !== 'undefined') {
      (window as unknown as { chattyEngine?: VoiceAssistantEngine }).chattyEngine = this.engine;
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

    // Restore sidebar state from saved preferences
    if (this.engine.getSidebarOpen()) {
      this.toggleSidebar(true);
    }
    this.renderChatList(this.engine.getConversations());

    this.updateUiState();
  }

  /** Waveforms sit between the status box and the button on desktop, under the chat on phones. */
  private placeWaveforms(): void {
    const waves = document.querySelector('.chat-waveforms');
    const narrow = window.matchMedia(NARROW_LAYOUT).matches;
    const target = document.querySelector(narrow ? '.chat-panel' : '.bottom-right');
    if (!waves || !target) return;
    if (narrow) target.appendChild(waves);
    else target.insertBefore(waves, target.firstChild);
  }

  private bindEvents(): void {
    this.updateChatExamples(false);
    this.placeWaveforms();
    window.matchMedia(NARROW_LAYOUT).addEventListener('change', () => this.placeWaveforms());
    // Stay on the newest text when the layout changes (rotation, desktop/mobile switch)
    if (typeof ResizeObserver !== 'undefined') {
      const keepAtBottom = new ResizeObserver(() => {
        this.scrollChatToBottom();
        if (this.rawOutputEl) this.rawOutputEl.scrollTop = this.rawOutputEl.scrollHeight;
      });
      if (this.chatLogEl) keepAtBottom.observe(this.chatLogEl);
      if (this.rawOutputEl) keepAtBottom.observe(this.rawOutputEl);
    }
    this.micBtn?.addEventListener('click', async () => {
      try {
        navigator.vibrate?.(15);
      } catch {
        // ignore haptic errors
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

    this.clearScreenBtn?.addEventListener('click', () => {
      this.resetVisualScreen();
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
      if (this.selectPiperVoice) this.selectPiperVoice.value = current.voiceId;
      this.settingsDialog?.showModal();
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

      this.settingsDialog?.close();

      const hasChanges =
        newChatModelId !== current.chatModelId ||
        newCodingModelId !== current.codingModelId ||
        newVoiceId !== current.voiceId;

      if (hasChanges) {
        if (this.statusEl) {
          this.statusEl.textContent = 'Applying updated settings...';
        }
        await this.engine.updateSettings({
          chatModelId: newChatModelId,
          codingModelId: newCodingModelId,
          voiceId: newVoiceId,
        });
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
    isStreaming = false
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
      displayText = speakMatches.map((m) => m[2]).join(' ');
    } else if (
      stripped.includes('```') ||
      stripped.includes('MODE:') ||
      /^(?:const|let|var|function|class|import|root\.|document\.|window\.)\b/m.test(stripped.trim())
    ) {
      displayText = '';
    }

    if (displayText) {
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
    note.className = 'system-note';
    note.setAttribute('role', 'note');
    note.textContent = text;
    return note;
  }

  private showSummaryNote(summaryText: string): void {
    this.chatLogEl?.appendChild(this.createSystemNote(`Earlier in this chat: ${summaryText}`));
  }

  /** Empties the chat log and the raw output panel. */
  private clearChatLog(): void {
    if (this.chatLogEl) this.chatLogEl.innerHTML = '';
    this.bubbles.clear();
    this.turnBubbles.clear();
    this.interimUserBubble = null;
    this.setRawOutput('');
  }

  /** Renders a whole conversation (on load and when switching chats). */
  private renderConversation(
    messages: readonly ConversationMessage[],
    summary: { summaryText: string } | null | undefined
  ): void {
    this.clearChatLog();
    if (summary?.summaryText) this.showSummaryNote(summary.summaryText);
    for (const m of messages) {
      if (m.role === 'user' && m.canonicalContent) this.addUserBubble(m);
      else if (m.role === 'assistant' && (m.canonicalContent || m.toolCall)) this.renderAssistantMessage(m);
    }
    const lastReply = [...messages].reverse().find((m) => m.role === 'assistant');
    this.setRawOutput(lastReply?.rawLlmOutput || lastReply?.rawCode || '');
    this.scrollChatToBottom();
  }

  private createBubble(role: 'user' | 'assistant'): HTMLElement {
    const row = document.createElement('div');
    row.className = `chat-row ${role}`;
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

  /** Example phrases stay up until the user has spoken for the first time. */
  private updateChatExamples(userHasSpoken: boolean): void {
    let spoken = userHasSpoken;
    try {
      if (spoken) localStorage.setItem(HAS_SPOKEN_KEY, '1');
      else spoken = localStorage.getItem(HAS_SPOKEN_KEY) !== null;
    } catch {
      // no storage: show examples until they speak in this visit
    }
    if (this.chatExamplesEl) this.chatExamplesEl.hidden = spoken;
  }

  private addUserBubble(msg: ConversationMessage): void {
    this.updateChatExamples(true);
    if (this.bubbles.has(msg.id)) return;
    const bubble = this.interimUserBubble ?? this.createBubble('user');
    this.interimUserBubble = null;
    bubble.classList.remove('interim');
    bubble.textContent = msg.canonicalContent;
    this.bubbles.set(msg.id, bubble);
    this.scrollChatToBottom();
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
    this.renderAssistantOutput(bubble, msg.canonicalContent, msg.toolCall);
  }

  /**
   * Shows the model's raw output as highlighted code, kept scrolled to the newest text.
   * speak() lines are left out: what was said is in the chat.
   */
  private setRawOutput(text: string): void {
    if (!this.rawOutputEl) return;
    const code = text
      .split('\n')
      .filter((line) => !/^\s*(?:await\s+)?speak\(.*\);?\s*$/.test(line))
      .join('\n')
      .trim();
    this.rawOutputEl.innerHTML = Prism.highlight(code, Prism.languages.javascript, 'javascript');
    this.rawOutputEl.scrollTop = this.rawOutputEl.scrollHeight;
  }

  /** Keeps the chat log scrolled to the newest message. */
  private scrollChatToBottom(): void {
    if (this.chatLogEl) this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
  }

  private updateUiState(): void {
    const snap = this.engine.getSnapshot();
    const isModelLoading =
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

    if (this.micBtn) {
      this.micBtn.disabled = isModelLoading;
      this.micBtn.classList.toggle('listening', isActive);
    }

    if (this.micLabel) {
      this.micLabel.textContent = isActive ? 'Stop' : (hasHistory ? 'Continue' : 'Start');
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
  private showSettingsAndWait(): Promise<void> {
    const dialog = this.settingsDialog;
    if (!dialog) return Promise.resolve();
    const current = this.engine.getSettings();
    this.fillChatModelOptions(current.chatModelId);
    if (this.selectPiperVoice) this.selectPiperVoice.value = current.voiceId;
    return new Promise((resolve) => {
      dialog.addEventListener(
        'close',
        () => {
          try {
            localStorage.setItem(SETTINGS_SEEN_KEY, '1');
          } catch {
            // ignore
          }
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
    const finished: Record<LoadKind, boolean> = {
      llm: m.llm === 'ready' || m.llm === 'failed',
      tts: m.tts === 'ready' || m.tts === 'failed',
      stt: this.sttLoadSettled,
    };
    let sumLoaded = 0;
    let sumTotal = 0;
    for (const k of ['llm', 'tts', 'stt'] as LoadKind[]) {
      const t = this.loadBytes[k].total || defaults[k];
      sumTotal += t;
      sumLoaded += finished[k] ? t : Math.min(this.loadBytes[k].loaded, t);
    }
    const overallPct = sumTotal > 0 ? Math.min(100, Math.round((sumLoaded * 100) / sumTotal)) : 0;
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(0);
    const own = current ?? this.loadBytes[kind];
    const ownPct = own.total > 0 ? Math.min(100, Math.round((own.loaded * 100) / own.total)) : 0;
    const order = this.engine.getStartupModelOrder();
    const index = order.indexOf(label);
    const step = index >= 0 ? `model ${index + 1} of ${order.length}: ` : '';
    this.updateDownloadProgress(
      `Loading ${step}${label} — ${mb(own.loaded)} / ${mb(own.total)} MB (${ownPct}%)`,
      overallPct,
      `${overallPct}% · ${mb(sumLoaded)} / ${mb(sumTotal)} MB`
    );
  }

  private updateDownloadProgress(statusText: string, pct: number, meterText: string): void {
    if (this.statusEl) {
      this.statusEl.textContent = statusText;
    }
    const meterFill = document.getElementById('context-meter-fill');
    const meterVal = document.getElementById('context-meter-text');
    const meterTitle = document.getElementById('meter-title');
    const thresholdEl = document.getElementById('context-meter-threshold');

    if (meterTitle) {
      meterTitle.textContent = 'Loading models';
    }
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
    const meterTitle = document.getElementById('meter-title');
    const thresholdEl = document.getElementById('context-meter-threshold');

    if (meterTitle) {
      meterTitle.textContent = 'Context Window';
    }
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
      meterText.textContent = `${percentage}% (${usedTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens)`;
    }
  }

  private updateStatusFromSnapshot(): void {
    if (!this.statusEl) return;
    const snap = this.engine.getSnapshot();

    const isModelLoading = this.isStartupLoading();

    if (snap.models.llm === 'failed') {
      this.statusEl.textContent =
        typeof navigator !== 'undefined' && 'gpu' in navigator
          ? 'WebGPU / Model Error'
          : 'WebGPU not supported in this browser';
    } else if (isModelLoading) {
      // Keep existing progress string if already showing percentages
      if (!this.statusEl.textContent || this.statusEl.textContent === 'Ready') {
        this.statusEl.textContent = 'Pulling models…';
      }
    } else if (snap.interaction === 'compacting') {
      this.statusEl.textContent = 'Compacting…';
    } else if (snap.interaction === 'finalizing_input') {
      this.statusEl.textContent = 'Transcribing…';
    } else if (snap.interaction === 'building_context' || snap.interaction === 'generating') {
      this.statusEl.textContent = 'Thinking…';
    } else if (snap.interaction === 'speaking' || snap.playback === 'playing') {
      this.statusEl.textContent = 'Speaking…';
    } else if (this.engine.getIsListening() || snap.interaction === 'listening') {
      this.statusEl.textContent = 'Listening…';
    } else if (snap.interaction === 'error') {
      this.statusEl.textContent = snap.lastError ?? 'Error';
    } else {
      this.statusEl.textContent = 'Ready';
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
  /** Shows the drawing layer, and the Clear button only while something is drawn on it. */
  private showScreenContent(hasContent: boolean): void {
    if (hasContent && this.screenVisualLayer) this.screenVisualLayer.hidden = false;
    if (this.clearScreenBtn) this.clearScreenBtn.hidden = !hasContent;
  }

  private resetVisualScreen(): void {
    this.showScreenContent(false);
    const iframe = this.engine.getActiveIframe();
    if (iframe) iframe.style.pointerEvents = 'none';
    void this.engine.jsRuntime.resetVisual();
    this.engine.clearVisualScreen();
  }

  private initPointerPassthrough(): void {
    const layer = this.screenVisualLayer;
    if (!layer) return;

    type Gesture = {
      origin: 'host' | 'iframe';
      target: Element;
      pointerId: number;
      pointerType: string;
      x: number;
      y: number;
    };
    let gesture: Gesture | null = null;
    let suppressHostClickUntil = 0;

    const getIframe = (): HTMLIFrameElement | null =>
      this.engine.getActiveIframe() || layer.querySelector('iframe');

    const setCapture = (iframe: HTMLIFrameElement, on: boolean) => {
      iframe.style.pointerEvents = on ? 'auto' : 'none';
    };

    // True when a Chatty host control (corner buttons, mic/start button, sidebar, settings)
    // sits under the point. elementsFromPoint is used so the iframe/layer is skipped even while
    // the iframe is 'auto' and would otherwise be the topmost element.
    const hostControlAt = (x: number, y: number): boolean => {
      const stack = document.elementsFromPoint(x, y);
      const top = stack.find((el) => !layer.contains(el));
      return Boolean(
        top &&
          (top.closest('.minimal-corner-btn') ||
            top.closest('.minimal-start-btn') ||
            top.closest('.chat-sidebar') ||
            top.closest('.settings-dialog'))
      );
    };

    /** Returns the agent-drawn element under the point, or null if the area is transparent. */
    const agentHitAt = (iframe: HTMLIFrameElement, x: number, y: number): Element | null => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return null;
        const hit = doc.elementFromPoint(x, y);
        // Over root, body, html, or nothing: transparent, pass through to the page underneath.
        if (!hit || hit === doc.documentElement || hit === doc.body || hit.id === 'root') return null;

        // Canvas: test the alpha of the pixel under the cursor (tagName: the canvas is cross-realm).
        if (hit.tagName === 'CANVAS') {
          try {
            const canvas = hit as HTMLCanvasElement;
            const rect = canvas.getBoundingClientRect();
            const cx = Math.round((x - rect.left) * (canvas.width / rect.width));
            const cy = Math.round((y - rect.top) * (canvas.height / rect.height));
            const ctx = canvas.getContext('2d');
            if (ctx && cx >= 0 && cx < canvas.width && cy >= 0 && cy < canvas.height) {
              if (ctx.getImageData(cx, cy, 1, 1).data[3] === 0) return null;
            }
          } catch {
            // Tainted canvas / non-2d context: treat as opaque
          }
        }

        if (hostControlAt(x, y)) return null;
        return hit;
      } catch {
        return null;
      }
    };

    const makeEvents = (
      win: Window,
      el: Element,
      type: 'down' | 'up' | 'move',
      g: Pick<Gesture, 'pointerId' | 'pointerType' | 'x' | 'y'>,
      buttons: number
    ) => {
      const w = win as unknown as Record<string, any>;
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: win,
        clientX: g.x,
        clientY: g.y,
        screenX: g.x,
        screenY: g.y,
        button: 0,
        buttons,
      };
      const pointerInit = { ...init, pointerId: g.pointerId, pointerType: g.pointerType, isPrimary: true };
      const PointerCtor = w.PointerEvent || w.MouseEvent;
      el.dispatchEvent(new PointerCtor(`pointer${type}`, pointerInit));
      el.dispatchEvent(new w.MouseEvent(`mouse${type}`, init));
    };

    const focusIfFocusable = (el: Element) => {
      const f = el.closest('input, textarea, select, button, a[href], [tabindex], [contenteditable]');
      if (f && typeof (f as HTMLElement).focus === 'function') (f as HTMLElement).focus();
    };

    const dispatchClick = (win: Window, el: Element, g: Gesture) => {
      const w = win as unknown as Record<string, any>;
      el.dispatchEvent(
        new w.MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: win,
          clientX: g.x,
          clientY: g.y,
          button: 0,
        })
      );
    };

    const winOf = (el: Element): Window => el.ownerDocument.defaultView || window;

    const beginGesture = (origin: Gesture['origin'], target: Element, e: PointerEvent) => {
      gesture = {
        origin,
        target,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        x: e.clientX,
        y: e.clientY,
      };
      makeEvents(winOf(target), target, 'down', gesture, 1);
      focusIfFocusable(target);
    };

    const finishGesture = (e: PointerEvent, source: Gesture['origin']) => {
      const g = gesture;
      if (!g || e.pointerId !== g.pointerId) return;
      gesture = null;
      g.x = e.clientX;
      g.y = e.clientY;
      const win = winOf(g.target);
      // The native 'up' only reaches the target's document when it came from that document.
      if (source === g.origin) makeEvents(win, g.target, 'up', g, 0);
      if (g.target.isConnected) {
        dispatchClick(win, g.target, g);
        focusIfFocusable(g.target);
      }
      if (g.origin === 'host' && g.pointerType !== 'mouse') {
        // The browser will still fire a native click at the host element the touch started on.
        suppressHostClickUntil = performance.now() + 800;
      }
    };

    // ---- Host window handlers (iframe currently 'none', or touch with no hover) ----
    const onHostMove = (e: PointerEvent) => {
      const iframe = getIframe();
      if (!iframe) return;
      attach(iframe);
      if (gesture && gesture.origin === 'host' && e.pointerId === gesture.pointerId) {
        // Touch drag that started on an agent element: keep feeding the iframe element.
        gesture.x = e.clientX;
        gesture.y = e.clientY;
        makeEvents(winOf(gesture.target), gesture.target, 'move', gesture, 1);
        return;
      }
      setCapture(iframe, agentHitAt(iframe, e.clientX, e.clientY) !== null);
    };

    const onHostDown = (e: PointerEvent) => {
      const iframe = getIframe();
      if (!iframe) return;
      attach(iframe);
      suppressHostClickUntil = 0;
      const hit = agentHitAt(iframe, e.clientX, e.clientY);
      if (!hit) {
        setCapture(iframe, false);
        return;
      }
      // No hover (touch) or pointer jumped: the event already targeted the host element.
      // Capture the iframe from now on and replay the gesture into the agent element.
      setCapture(iframe, true);
      beginGesture('host', hit, e);
    };

    const onHostUp = (e: PointerEvent) => finishGesture(e, 'host');

    const onHostClick = (e: MouseEvent) => {
      if (suppressHostClickUntil && performance.now() < suppressHostClickUntil) {
        suppressHostClickUntil = 0;
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };

    // ---- Iframe window handlers (iframe currently 'auto') ----
    const onFrameMove = (e: PointerEvent) => {
      const iframe = getIframe();
      if (!iframe || (gesture && gesture.origin === 'iframe')) return;
      if (agentHitAt(iframe, e.clientX, e.clientY) === null) setCapture(iframe, false);
    };

    const onFrameDown = (e: PointerEvent) => {
      const iframe = getIframe();
      if (!iframe) return;
      if (agentHitAt(iframe, e.clientX, e.clientY) !== null) return; // genuine agent click
      // Transparent area (or a host control): hand the gesture to the host page.
      setCapture(iframe, false);
      const hostEl = document.elementFromPoint(e.clientX, e.clientY);
      if (!hostEl || hostEl === document.documentElement) return;
      beginGesture('iframe', hostEl, e);
    };

    const onFrameUp = (e: PointerEvent) => finishGesture(e, 'iframe');

    const onCancel = (e: PointerEvent) => {
      if (gesture && e.pointerId === gesture.pointerId) gesture = null;
    };

    // Stable handler references make repeated attach() calls idempotent (no duplicate listeners).
    const attach = (iframe: HTMLIFrameElement) => {
      const win = iframe.contentWindow;
      if (!win) return;
      try {
        win.addEventListener('pointermove', onFrameMove as EventListener, { passive: true });
        win.addEventListener('pointerdown', onFrameDown as EventListener, { capture: true, passive: true });
        win.addEventListener('pointerup', onFrameUp as EventListener, { capture: true, passive: true });
        win.addEventListener('pointercancel', onCancel as EventListener, { capture: true, passive: true });
      } catch {
        // iframe window unavailable
      }
    };

    window.addEventListener('pointermove', onHostMove, { passive: true });
    window.addEventListener('pointerdown', onHostDown, { capture: true, passive: true });
    window.addEventListener('pointerup', onHostUp, { capture: true, passive: true });
    window.addEventListener('pointercancel', onCancel, { capture: true, passive: true });
    window.addEventListener('click', onHostClick, { capture: true });

    // Re-attach whenever the iframe document (re)loads.
    this.engine.jsRuntime.setIframeLoadListener(attach);
    const existing = getIframe();
    if (existing) attach(existing);
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
      const registerSw = () => {
        navigator.serviceWorker
          .register('/sw.js', { scope: '/' })
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

  // Handle PWA installation prompt
  let deferredInstallPrompt: any = null;
  const installBtn = document.getElementById('btn-install-app') as HTMLButtonElement | null;
  const iosDialog = document.getElementById('dialog-ios-install') as HTMLDialogElement | null;
  const closeIosDialogBtn = document.getElementById('btn-close-ios-dialog') as HTMLButtonElement | null;

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as any).standalone === true;

  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
  const isMacSafari =
    /^((?!chrome|android).)*safari/i.test(navigator.userAgent) &&
    !/chrome|chromium|edg/i.test(navigator.userAgent);

  if (!isStandalone) {
    if (installBtn) {
      installBtn.hidden = false;
    }
    // 1. Chrome / Edge / Android native prompt
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (installBtn) {
        installBtn.hidden = false;
      }
    });
  } else {
    if (installBtn) {
      installBtn.hidden = true;
    }
  }

  installBtn?.addEventListener('click', async () => {
    const settingsDialog = document.getElementById('settings-dialog') as HTMLDialogElement | null;
    if (settingsDialog && settingsDialog.open) {
      settingsDialog.close();
    }
    if (deferredInstallPrompt) {
      await deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        deferredInstallPrompt = null;
        if (installBtn) installBtn.hidden = true;
      }
    } else {
      iosDialog?.showModal();
    }
  });

  closeIosDialogBtn?.addEventListener('click', () => {
    iosDialog?.close();
  });

  iosDialog?.addEventListener('click', (e) => {
    if (e.target === iosDialog) {
      iosDialog.close();
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if (installBtn) installBtn.hidden = true;
  });
}
