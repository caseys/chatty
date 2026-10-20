// ============================================================================
// First-Class Conversation Orchestrator (Addendum Sections 1-8)
// ============================================================================

import type {
  ConversationMessage,
  ConversationSummary,
  InteractionState,
  LlmRuntimeProvider,
  PhraseSegment,
  ResponseMode,
  SttEvent,
  SystemTelemetry,
  ToolDefinition,
  TtsRuntimeProvider,
  TurnMetrics,
} from '../types/index.ts';
import { BoundedQueue, TurnResourceScheduler } from './bounded-queue.ts';
import { ConversationMemoryStore } from './memory-store.ts';
import {
  IncrementalPhraseSegmenter,
  normalizeTextForSpeech,
  normalizeUserTranscript,
} from './speech-normalizer.ts';
import { StateMachineCoordinator } from './state-machine.ts';
import { describePastProgram, isTalkOnly, programDraws } from './history-format.ts';
import {
  isFollowUpEdit,
  runReadyTool,
  type LastAction,
  type ReadyToolOutcome,
  type TurnRouter,
} from './phone-pipeline.ts';
import {
  JavascriptRuntime,
  inspectExecutableCode,
  syntaxErrorLine,
} from '../tools/javascript-runtime.ts';
import { appendRunLog } from './run-log.ts';
import { applyFixReply, FIX_SYSTEM_PROMPT, fixRequest } from './line-fix.ts';
import { AFTER_HEAVY_MS, settle } from './settle.ts';
import { withActivity } from './activity-breadcrumbs.ts';

/** "Error at line 7: x is not defined" (the line when the browser reported it) */
function errorText(message: string, line?: number): string {
  return line ? `Error at line ${line}: ${message}` : `Error: ${message}`;
}

/** The text of a `speak("…");` program that inspectExecutableCode made from a prose reply, or null */
function proseOfSpeakCode(code: string): string | null {
  const match = code.match(/^speak\(("(?:[^"\\]|\\.)*")\);$/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return null;
  }
}

/** How a reply's code went: ran, failed, still running (a song, a timer), or there was none */
export interface RunStatus {
  kind: 'ok' | 'running' | 'error' | 'none';
  text: string;
}

export interface OrchestratorEvents {
  onMessageCreated?: (message: ConversationMessage) => void;
  onMessageUpdated?: (message: ConversationMessage) => void;
  onTokenStream?: (turnId: string, token: string, canonicalSoFar: string) => void;
  /** The model's raw output so far for this turn, exactly as generated */
  onRawOutput?: (turnId: string, rawSoFar: string) => void;
  /** Whether this reply's code ran, and how it went */
  onRunStatus?: (turnId: string | null, status: RunStatus) => void;
  onPhraseReadyForPlayback?: (phrase: PhraseSegment) => Promise<void> | void;
  onInterruption?: (canceledTurnId: string, preservedCanonicalText: string) => void;
  onTelemetryUpdated?: (telemetry: SystemTelemetry) => void;
  onError?: (error: Error, context: string) => void;
  onStatusChange?: (status: string | null) => void;
  onTitleGenerated?: (title: string, conversationId?: string) => void;
}

export interface ConversationOrchestratorOptions {
  stateCoordinator: StateMachineCoordinator;
  memoryStore?: ConversationMemoryStore;
  llmProvider: LlmRuntimeProvider;
  ttsProvider?: TtsRuntimeProvider;
  /** Ignored: the legacy tool-call path is gone (still accepted so the debug console and benchmark suite compile) */
  tools?: ToolDefinition[];
  javascriptRuntime?: JavascriptRuntime;
  audioContextAccessor?: () => Promise<AudioContext | null> | AudioContext | null;
  events?: OrchestratorEvents;
  enableSpeechOutput?: boolean;
  /** Send a failed program's error back to the model for one automatic fix (see maybeAutoFix) */
  autoFixErrors?: boolean;
  maxTtsQueueSize?: number;
  contextCompactionThreshold?: number;
  /** Id of the conversation currently loaded in memory (used to attribute auto-titles). */
  getConversationId?: () => string;
  /** Whether the given conversation still needs an auto-generated title. */
  shouldAutoTitle?: (conversationId: string) => boolean;
}

export const TITLE_GENERATION_SYSTEM_PROMPT = [
  'You are an expert conversation title generator.',
  'Generate a concise, descriptive title (3 to 6 words) summarizing the primary topic or goal of the conversation.',
  'Output ONLY the plain text title with no quotes, no markdown, no punctuation, and no introductory words.',
].join(' ');

export const COMPACTION_SYSTEM_PROMPT = [
  'You are a conversation memory compaction expert for a voice assistant.',
  'Condense the entire conversation history into a structured, dense, highly informative working summary.',
  'Preserve all of the following dimensions:',
  '1. User Profile & Preferences: explicit preferences, habits, instructions, constraints.',
  '2. Decisions & Agreed Outcomes: choices made, tools/options chosen, plans finalized.',
  '3. Crucial Facts & Entities: specific names, numbers, technical terms, or details discussed.',
  '4. Current Conversation Context: the active topic or what the user was working on.',
  'Format as a dense, structured summary under 200 words. Do not include conversational filler, greetings, or commentary.',
].join(' ');

export { programDraws } from './history-format.ts';

/**
 * Where a degenerate repeat loop starts in streamed output (keeping the first copy), or -1:
 * the same line four times in a row, or the same phrase four times back to back.
 */
export function repetitionCutIndex(text: string): number {
  const start = Math.max(0, text.length - 600);
  const tail = text.slice(start);
  const byLine = tail.match(/(^|\n)([^\n]*[A-Za-z][^\n]*)(?:\n+\2){3,}\n?[^\n]*$/);
  if (byLine && byLine.index !== undefined && byLine[2].trim().length >= 6) {
    return start + byLine.index + byLine[1].length + byLine[2].length;
  }
  const inline = tail.match(/([^\n]{8,120}?)\1{3,}[^\n]*$/);
  if (inline && inline.index !== undefined && /[A-Za-z]/.test(inline[1])) {
    return start + inline.index + inline[1].length;
  }
  // A block of 2–12 lines written three times in a row (the same few lines of code, a paragraph)
  const blockStart = Math.max(0, text.length - 2400);
  const done = text.slice(blockStart).split('\n').slice(0, -1); // the last line may still be arriving
  for (let k = 2; k <= 12 && done.length >= k * 3; k++) {
    // Where the lines start repeating every k lines
    let p = done.length - k;
    while (p > 0 && done[p - 1] === done[p - 1 + k]) p--;
    if (done.length - p < k * 3) continue;
    const block = done.slice(p, p + k).join('\n');
    if (block.replace(/\s/g, '').length < 20 || !/[A-Za-z]/.test(block)) continue;
    // Keep the first copy
    return blockStart + done.slice(0, p + k).join('\n').length;
  }
  return -1;
}

/** Speech recognizers often "hear" this in silence or noise; never treated as a request. */
const IGNORED_TRANSCRIPT = /^\s*thank you[\s.!]*$/i;
const STOP_PHRASE = /^(?:stop|wait|cancel|pause|quiet|enough)(?: please)?$/;

/**
 * What to do with a final transcript: drop it, stop the assistant, or send it as a request.
 * While the assistant is busy, a stray word (or a noise the recognizer turned into one) doesn't
 * interrupt it: that takes a stop word, or a request of two or more words. Speech heard while
 * Chatty's own audio was playing may be its voice coming back through the mic (phone speakers
 * defeat echo cancellation), so then only a stop word counts.
 */
export function classifyTranscript(
  text: string,
  assistantBusy: boolean,
  heardDuringPlayback = false
): 'ignore' | 'stop' | 'submit' {
  if (IGNORED_TRANSCRIPT.test(text)) return 'ignore';
  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  if (words.length === 0) return 'ignore';
  const isStop = STOP_PHRASE.test(words.join(' '));
  if (heardDuringPlayback) return isStop ? 'stop' : 'ignore';
  if (!assistantBusy) return 'submit';
  if (isStop) return 'stop';
  return words.length >= 2 ? 'submit' : 'ignore';
}

/** Requests (or the program being changed) that the optional rules are for */
const SOUND_REQUEST =
  /\b(?:play|music|song|sing|sound|beat|groove|drum|piano|bass|guitar|organ|violin|strings|trumpet|sax|flute|chord|melod|tune|notes?\b|midi|rhythm|jam|music loop|loop(?:ed)? (?:the )?(?:song|beat|music|melody)|tempo|bpm|beep|\btone\b.*\bplay|\bplay\b.*\btone\b|audio|instrument|\b[a-g][#b]? (?:major|minor|pentatonic)|(?:major|minor|pentatonic) scale|scale (?:in|of) [a-g]|requestMIDIAccess|AudioContext)/i;
const DRAWING_REQUEST =
  /\b(?:draw|paint|sketch|picture|image|art\b|animat|game|simulat|bounc|canvas|scene|shape|circle|square|triangle|stars?\b|sky|rainbow|landscape|pattern|fractal|particle|mov(?:e|ing)|getContext)/i;
const THREE_D_REQUEST = /(?:\b3d\b|\bthree[- ]?d\b|\bcube|\bsphere|\bwebgl|\brotat|\bspin|\borbit|\bplanet|THREE\.)/i;
const DIAGRAM_REQUEST = /\b(?:svg|diagram|icon|chart|graph|logo|vector|flowchart|map)/i;
const FACTS_REQUEST =
  /\b(?:who (?:was|is)|what (?:is|was|are) (?:a|an|the)|when|where|why|which|how (?:many|much|old|tall|far|big|long)|tell me about|look up|search|find out|history|define|meaning|capital|population|weather|news|facts?|wiki|fetch)\b/i;

/**
 * The rules, as bullets (small models copy numbering into their replies). A rule with `when` is
 * for some requests only: models with a small context (the smallest ones, on any device) get it
 * only when the request, or the program it changes, matches. Bigger models get every rule, the
 * same prompt each turn.
 */
const PROMPT_RULES: ReadonlyArray<{ text: string; when?: RegExp }> = [
  { text: '- ONLY return executable JavaScript: the shortest program that fully does the request, comment-free, using the helpers described here.' },
  { text: '- Act first: do what was asked (draw, build, play, compute, look up) as a live, working browser app, then tell the user what you did with speak("...").' },
  { text: '- ALL messages to the user go through speak(text): plain conversation is just speak(). speak() accepts computed values in template strings.' },
  { text: '- What you add to document.body appears in a card in the middle of the screen. Use HTML and CSS for interfaces: buttons, forms, cards, notes, tables, gauges, dashboards and widgets. The screen is wiped with clear(): to completely update the screen, call clear() first.' },
  { text: '- Use <canvas> for visuals: drawings, art, animations, games and simulations.', when: DRAWING_REQUEST },
  { text: '- For 3D, use WebGL on a <canvas>.', when: THREE_D_REQUEST },
  { text: '- <svg> works for diagrams and icons.', when: DIAGRAM_REQUEST },
  { text: '- Sound: music and instruments use Web MIDI, one line per note: out = (await navigator.requestMIDIAccess()).outputs.values().next().value; then call out.send([instrument, notes, velocity, durationMs], time) once per note, chord or drum hit, at its own time. Other sounds (beeps, effects) use Web Audio: create an AudioContext and await ctx.resume() first. Instruments: piano, bass, organ, guitar, strings, violin, trumpet, sax, flute, drums. Notes: one note (\'G3\'), a chord by name (\'G major\', \'Am7\'), a scale (\'G pentatonic down\' plays its notes in order), drum hits (\'kick\', \'snare\', \'hihat\'), or an array (up to 4 notes sound together; 5 or more play one after another). Timing: declare const bpm, beat = 60000 / bpm and start = performance.now() at the top; beat n plays at start + n * beat, and a 4/4 measure is 4 beats. To loop: put the bars in a function that ends with start += their length, call it, then setInterval it with that same length. A beat or groove means drums. Boom-chuck: kick on beats 1 and 3, snare on 2 and 4. Walking bass: one bass note per beat, stepping through the chord\'s notes. Shuffle: hi-hats on each beat and two-thirds of the way through it.', when: SOUND_REQUEST },
  { text: '- Answer what you know directly. To look up facts you don\'t know, fetch a public API that allows cross-origin requests, such as Wikipedia (https://en.wikipedia.org/api/rest_v1/page/summary/<title>), and speak a sentence or two of it, not the whole text.', when: FACTS_REQUEST },
  { text: '- Calculate all results using JavaScript logic.' },
  { text: '- If you define a function, call it.' },
];

/** The rules for a request: all of them, or (filter) only those it needs */
export function promptRules(request = '', filter = false): string {
  const rules = PROMPT_RULES.filter((rule) => !filter || !rule.when || rule.when.test(request));
  return [
    "You are Chatty, a voice assistant that acts by writing JavaScript. Your reply runs as a program in the user's browser, immediately and exactly as written.",
    'Rules:',
    ...rules.map((rule) => rule.text),
  ].join('\n');
}


/**
 * One real chat exchange before the conversation, there only to show the reply format (a
 * JavaScript program, no prose): without it small models answer like a chat assistant offering
 * code ("you can use the following code: …"). It holds nothing worth copying.
 */
export const FORMAT_TURNS: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: 'Hi Chatty!' },
  // Only speech: small models copied a drawn "Hi!" heading into every program
  { role: 'assistant', content: 'speak("Hi! What would you like me to make?");' },
];

export const CONCISE_VOICE_SYSTEM_PROMPT = promptRules();

/** A line of a streaming reply that starts code: the reply isn't prose (shown and spoken as it comes) */
const STREAM_CODE_LINE = /^(?:const|let|var|function|class|import|MODE:|```|\/\/|\/\*|root\.|document\.|window\.)\b/m;
/** What the code panel shows of a streaming reply: the inside of its code fences, when it has any */
function codeView(text: string): string {
  if (!text.includes('```')) return text;
  return [...text.matchAll(/```[\w-]*[^\n]*\n([\s\S]*?)(?:```|$)/g)].map((m) => m[1]).join('\n');
}

/** Markup in a streaming reply */
const STREAM_MARKUP = /<(?:script|canvas|html|!doctype)\b/i;

export class ConversationOrchestrator {
  readonly stateCoordinator: StateMachineCoordinator;
  readonly memoryStore: ConversationMemoryStore;
  readonly scheduler: TurnResourceScheduler;

  private llmProvider: LlmRuntimeProvider;
  private ttsProvider?: TtsRuntimeProvider;
  private javascriptRuntime: JavascriptRuntime;
  private audioContextAccessor?: () => Promise<AudioContext | null> | AudioContext | null;
  private events: OrchestratorEvents;
  private enableSpeechOutput: boolean;
  private autoFixErrors: boolean;
  private compactionThreshold: number;
  private getConversationId?: () => string;
  private shouldAutoTitle?: (conversationId: string) => boolean;
  // Last tool or program in each conversation: lets follow-ups ("make it bigger", "what about
  // Paris?") continue the previous action, and gives the coder the program it is editing
  private lastAction: LastAction | null = null;
  // The newest program run, so an error it hits (during or soon after the run) goes back to the model once
  private lastRun: {
    turnId: string;
    code: string;
    /** What the user asked for, so a fix request can lead with it (see fixRequest) */
    task: string;
    isAutoFix: boolean;
    fixRequested: boolean;
    error: string | null;
    errorLine?: number;
  } | null = null;
  // User messages that went out with notes added (see buildModelPrompt), by message id
  private sentRequests = new Map<string, string>();
  // Phone pipeline (small models): router picks a tool / code / chat each turn
  private phonePipeline: {
    router: TurnRouter;
    coder: LlmRuntimeProvider;
    chatSystemPrompt: string;
  } | null = null;

  private ttsSynthesisQueue: BoundedQueue<PhraseSegment>;
  private activeAssistantMessage: ConversationMessage | null = null;
  private activeTurnStartTime = 0;
  private activeTurnSpeechEndedTime = 0;

  private speechDisabledWaiters = new Set<() => void>();
  private completedTurnsCount = 0;
  private interruptedTurnsCount = 0;
  private recentTurnMetrics: TurnMetrics[] = [];
  private firstUseReadinessMs?: number;
  private warmInitializationMs?: number;
  private lastRecoveryTimeMs?: number;

  constructor(options: ConversationOrchestratorOptions) {
    this.stateCoordinator = options.stateCoordinator;
    this.memoryStore = options.memoryStore ?? new ConversationMemoryStore();
    this.scheduler = new TurnResourceScheduler();
    this.llmProvider = options.llmProvider;
    this.ttsProvider = options.ttsProvider;
    this.events = options.events ?? {};
    this.enableSpeechOutput = options.enableSpeechOutput ?? true;
    this.autoFixErrors = options.autoFixErrors ?? false;
    this.compactionThreshold = options.contextCompactionThreshold ?? 0.85;
    this.getConversationId = options.getConversationId;
    this.shouldAutoTitle = options.shouldAutoTitle;

    this.javascriptRuntime =
      options.javascriptRuntime ??
      new JavascriptRuntime({ mode: 'eval', llmProvider: this.llmProvider });
    this.audioContextAccessor = options.audioContextAccessor;

    // So the context meter and the budgets count the system prompt from the start
    this.syncPromptReserve();

    const maxTtsQueueSize = options.maxTtsQueueSize ?? 256;
    this.ttsSynthesisQueue = new BoundedQueue<PhraseSegment>({
      maxSize: maxTtsQueueSize,
      highWaterMark: Math.max(6, Math.floor(maxTtsQueueSize * 0.75)),
      lowWaterMark: Math.max(2, Math.floor(maxTtsQueueSize * 0.25)),
    });
  }

  /**
   * Switches to the phone pipeline: `chat` writes prose replies, `router` (Needle) picks
   * a ready-made tool, coder_agent (JavaScript written by `coder`) or plain chat for each turn.
   */
  configurePhonePipeline(config: {
    chat: LlmRuntimeProvider;
    coder: LlmRuntimeProvider;
    router: TurnRouter;
    chatSystemPrompt: string;
  }): void {
    this.llmProvider = config.chat;
    this.phonePipeline = { router: config.router, coder: config.coder, chatSystemPrompt: config.chatSystemPrompt };
  }

  setLlmProvider(provider: LlmRuntimeProvider): void {
    this.llmProvider = provider;
  }

  setTtsProvider(provider: TtsRuntimeProvider | undefined): void {
    this.ttsProvider = provider;
  }

  setSpeechOutputEnabled(enabled: boolean): void {
    this.enableSpeechOutput = enabled;
    if (!enabled) {
      // Release turns waiting on playback that is being silenced
      const waiters = Array.from(this.speechDisabledWaiters);
      this.speechDisabledWaiters.clear();
      for (const wake of waiters) wake();
    }
  }

  /**
   * Resolves when `promise` settles, the signal aborts, or speech output is disabled
   * (whichever comes first), so awaits on audio playback can never outlive a stop.
   */
  private waitUnlessStopped(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        signal.removeEventListener('abort', done);
        this.speechDisabledWaiters.delete(done);
        resolve();
      };
      signal.addEventListener('abort', done, { once: true });
      this.speechDisabledWaiters.add(done);
      promise.then(done, done);
    });
  }

  // --------------------------------------------------------------------------
  // STT Event Handling & Barge-In Interruption
  // --------------------------------------------------------------------------

  /** True while the assistant is generating or talking. */
  isAssistantBusy(): boolean {
    const snapshot = this.stateCoordinator.getSnapshot();
    return (
      snapshot.interaction === 'generating' ||
      snapshot.interaction === 'speaking' ||
      snapshot.playback === 'playing' ||
      snapshot.playback === 'buffering'
    );
  }

  handleSttEvent(event: SttEvent): void {
    const snapshot = this.stateCoordinator.getSnapshot();
    const busy = this.isAssistantBusy();

    switch (event.type) {
      case 'speech_started': {
        // While the assistant is busy, sound alone doesn't interrupt it: the transcript decides
        // (see classifyTranscript), so a cough or background noise can't cut it off
        if (!busy) this.stateCoordinator.transitionInteraction('listening', event.turnId);
        break;
      }

      case 'partial_transcript': {
        // Partial transcripts update UI only and NEVER trigger duplicate LLM responses
        if (snapshot.interaction === 'idle') {
          this.stateCoordinator.transitionInteraction('listening', event.turnId);
        }
        break;
      }

      case 'speech_ended': {
        this.activeTurnSpeechEndedTime = event.timestamp || performance.now();
        if (!busy) this.stateCoordinator.transitionInteraction('finalizing_input', event.turnId);
        break;
      }

      case 'final_transcript': {
        const action = classifyTranscript(event.text ?? '', busy, !!event.heardDuringPlayback);
        if (action === 'stop') {
          this.interruptCurrentTurn('User said stop');
        } else if (action === 'submit') {
          const sttLatencyMs =
            this.activeTurnSpeechEndedTime > 0
              ? Math.max(1, (event.timestamp || performance.now()) - this.activeTurnSpeechEndedTime)
              : event.durationMs ?? 0;
          void this.submitUserInput(event.text ?? '', {
            isVoiceTranscript: true,
            sttFinalizationLatencyMs: sttLatencyMs,
          });
        } else if (!busy) {
          this.stateCoordinator.transitionInteraction('idle', null);
        }
        break;
      }

      case 'error': {
        // STT failure must not corrupt conversation history or block typed interaction
        this.events.onError?.(new Error(event.error ?? 'STT Error'), 'stt');
        if (snapshot.interaction === 'listening' || snapshot.interaction === 'finalizing_input') {
          this.stateCoordinator.transitionInteraction('idle', null);
        }
        break;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Interruption Handling (Spec Section 5 & Addendum Section 4)
  // --------------------------------------------------------------------------

  interruptCurrentTurn(reason = 'User interrupted'): string | null {
    const canceledTurnId = this.scheduler.getActiveTurnId();
    const interruptStart = performance.now();

    if (canceledTurnId) {
      this.scheduler.cancelTurn(canceledTurnId, reason);
      this.llmProvider.cancel(canceledTurnId);
      this.ttsProvider?.cancel(canceledTurnId);
      this.ttsSynthesisQueue.cancelTurn(canceledTurnId);
    }

    let preservedText = '';
    if (this.activeAssistantMessage && this.activeAssistantMessage.turnId === canceledTurnId) {
      preservedText = this.activeAssistantMessage.canonicalContent;
      const interruptedContent = preservedText
        ? `${preservedText} [Interrupted]`
        : '[Response interrupted]';

      this.activeAssistantMessage.interrupted = true;
      this.activeAssistantMessage.spokenTextBeforeInterrupt = preservedText;
      this.activeAssistantMessage.canonicalContent = interruptedContent;
      if (this.activeAssistantMessage.metrics) {
        this.activeAssistantMessage.metrics.interruptionLatencyMs = Math.max(
          1,
          performance.now() - interruptStart
        );
      }

      this.memoryStore.updateMessage(this.activeAssistantMessage.id, {
        interrupted: true,
        spokenTextBeforeInterrupt: preservedText,
        canonicalContent: interruptedContent,
        metrics: this.activeAssistantMessage.metrics,
      });

      this.events.onMessageUpdated?.({ ...this.activeAssistantMessage });
      this.activeAssistantMessage = null;
    }

    this.interruptedTurnsCount++;
    this.stateCoordinator.setPlaybackState('interrupted');
    this.stateCoordinator.transitionInteraction('interrupted', canceledTurnId);
    if (canceledTurnId) {
      this.events.onInterruption?.(canceledTurnId, preservedText);
    }

    this.emitTelemetry();
    return canceledTurnId;
  }

  // --------------------------------------------------------------------------
  // 7-Stage Turn Processing Pipeline (Addendum Section 3)
  // --------------------------------------------------------------------------

  async submitUserInput(
    rawInput: string,
    options?: {
      isVoiceTranscript?: boolean;
      sttFinalizationLatencyMs?: number;
      /** The program that failed: this turn asks the model to fix it (see maybeAutoFix) */
      autoFix?: string;
    }
  ): Promise<ConversationMessage | null> {
    // Stage 1: Capture and normalize input
    const { rawTranscript, normalized } = options?.isVoiceTranscript
      ? normalizeUserTranscript(rawInput)
      : { rawTranscript: rawInput, normalized: rawInput.trim() };

    // Empty input (e.g. "[BLANK_AUDIO]") must not cancel an in-progress turn
    if (!normalized) {
      if (!this.scheduler.getActiveTurnId()) {
        this.stateCoordinator.transitionInteraction('idle', null);
      }
      return null;
    }

    // If an earlier turn is still active, interrupt it cleanly first
    if (this.scheduler.getActiveTurnId()) {
      this.interruptCurrentTurn('Superseded by new user turn');
    }

    const { turnId, signal } = this.scheduler.startTurn();
    const conversationId = this.getConversationId?.();
    this.activeTurnStartTime = performance.now();

    // Context Compaction Check: When context exceeds threshold (>= 85% of what the prompt may
    // use: the window less the room for the reply), compact before continuing
    // (A fix turn doesn't use the history, so its request, program and all, must not wipe it)
    this.syncPromptReserve();
    if (
      !options?.autoFix &&
      this.memoryStore.isContextCompactionNeeded(
        this.llmProvider.contextLimit,
        normalized,
        this.compactionThreshold
      )
    ) {
      await this.performContextCompaction(signal, turnId);
      if (!this.scheduler.isTurnValid(turnId) || signal.aborted) {
        // Only reset state if a newer turn has not taken over
        if (this.ownsState(turnId)) {
          this.stateCoordinator.transitionInteraction('idle', null);
        }
        return null;
      }
    }

    this.stateCoordinator.transitionInteraction('building_context', turnId);

    const userMsg: ConversationMessage = {
      id: `msg_user_${turnId}`,
      turnId,
      role: 'user',
      canonicalContent: normalized,
      rawTranscript: options?.isVoiceTranscript ? rawTranscript : undefined,
      ...(options?.autoFix ? { autoFix: true } : {}),
      timestamp: Date.now(),
    };

    // Stage 2: Resolve context BEFORE adding current message so history is clean
    // (A fix turn sends no history, memories or references: nothing to resolve)
    const resolvedContext: ReturnType<ConversationMemoryStore['resolveContextForQuery']> = options?.autoFix
      ? { workingMessages: [], conversationSummary: null, relevantMemories: [], resolvedReferencesNote: null, estimatedTokens: 0 }
      : this.memoryStore.resolveContextForQuery(
          normalized,
          Math.floor(this.memoryStore.usablePromptTokens(this.llmProvider.contextLimit) * this.compactionThreshold)
        );

    // Commit user message to working memory
    this.memoryStore.addMessage(userMsg);
    this.events.onMessageCreated?.(userMsg);

    // Stage 4: Choose a response mode (direct, clarification, verification)
    // Phone pipeline routes with Needle instead
    // (A fix request quotes the user's words, which must not pick a clarifying question)
    const responseMode =
      this.phonePipeline || options?.autoFix
        ? 'direct'
        : this.selectResponseMode(normalized, resolvedContext.workingMessages);

    // Stage 3: Build the prompt respecting model context budget
    // Editing the last program ("make it bigger")? Then the model needs that program's code;
    // otherwise past programs appear only as one-line summaries.
    const lastAction = this.getLastAction(conversationId);
    const programBeingEdited =
      options?.autoFix ??
      (lastAction?.kind === 'code' && isFollowUpEdit(normalized) ? lastAction.code : null);
    let { systemPrompt, promptMessages } = this.buildModelPrompt(
      normalized,
      resolvedContext,
      responseMode,
      programBeingEdited
    );
    // A fix turn is its own job: a short prompt about fixing and only the fix request (the
    // rules, examples and history are for writing programs, and small models rewrote the
    // program they saw there, bug and all). The turn whose program it fixes:
    const fixedTurnId = options?.autoFix ? this.lastRun?.turnId : undefined;
    // The line the fix request marked, where the corrected line goes back
    const fixLine = options?.autoFix ? this.lastRun?.errorLine : undefined;
    if (options?.autoFix) {
      systemPrompt = FIX_SYSTEM_PROMPT;
      // One message, the user's: the failed program is handed over to fix, not shown as the
      // model's own reply (which it copied back)
      promptMessages = [{ role: 'user', content: normalized }];
    }
    // Notes added to the request go out with it again in every later prompt (see buildModelPrompt)
    const sentRequest = promptMessages[promptMessages.length - 1]?.content;
    if (!this.phonePipeline && sentRequest && sentRequest !== normalized) {
      this.rememberSentRequest(userMsg.id, sentRequest);
    }

    // Prepare assistant message placeholder
    const turnMetrics: TurnMetrics = {
      turnId,
      sttFinalizationLatencyMs: options?.sttFinalizationLatencyMs,
    };

    const assistantMsg: ConversationMessage = {
      id: `msg_assistant_${turnId}`,
      turnId,
      role: 'assistant',
      canonicalContent: '',
      speechReadyContent: '',
      phrases: [],
      timestamp: Date.now(),
      responseMode,
      metrics: turnMetrics,
    };

    this.activeAssistantMessage = assistantMsg;
    this.memoryStore.addMessage(assistantMsg);
    this.events.onMessageCreated?.({ ...assistantMsg });

    // Transition to generating
    this.stateCoordinator.transitionInteraction('generating', turnId);

    const segmenter = new IncrementalPhraseSegmenter();
    const spokenPhrasesSeen = new Set<string>();
    // Code-mode speak() texts already routed to TTS (streamed or runtime-delivered), by normalized key
    const spokenSpeakCounts = new Map<string, number>();
    // Streamed speak() texts not yet matched against a runtime onSpeak delivery
    const streamedSpeakPending = new Map<string, number>();
    const speakKey = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    const consume = (m: Map<string, number>, k: string): boolean => {
      const n = m.get(k) ?? 0;
      if (n <= 0) return false;
      m.set(k, n - 1);
      return true;
    };
    let processedSpeakMatches = 0;
    let ttsDrainPromise: Promise<void> = Promise.resolve();
    const pendingPlaybacks: Promise<void>[] = [];
    let firstAudioRecorded = false;

    const enqueuePhraseForSpeech = (canonicalPhrase: string) => {
      if (!this.scheduler.isTurnValid(turnId)) return;
      // Do not synthesize markdown code syntax as speech
      if (canonicalPhrase.startsWith('```')) return;
      const speechNormalized = normalizeTextForSpeech(canonicalPhrase);
      if (!speechNormalized) return;

      spokenPhrasesSeen.add(canonicalPhrase.trim());
      spokenPhrasesSeen.add(speechNormalized.trim());

      const seq = this.scheduler.nextSequence(turnId);
      const phraseSeg: PhraseSegment = {
        id: `phrase_${turnId}_${seq}`,
        turnId,
        sequence: seq,
        canonicalText: canonicalPhrase,
        speechNormalizedText: speechNormalized,
        status: 'queued',
      };

      assistantMsg.phrases?.push(phraseSeg);
      assistantMsg.speechReadyContent = assistantMsg.phrases
        ?.map((p) => p.speechNormalizedText)
        .join(' ');

      if (!this.enableSpeechOutput || !this.ttsProvider) {
        phraseSeg.status = 'played';
        return;
      }

      const enqueued = this.ttsSynthesisQueue.enqueue({
        id: phraseSeg.id,
        turnId,
        sequence: seq,
        priority: 10,
        payload: phraseSeg,
        enqueuedAt: performance.now(),
      });

      if (enqueued) {
        ttsDrainPromise = ttsDrainPromise.then(() =>
          this.processNextTtsPhrase(
            turnId,
            signal,
            () => {
              if (!firstAudioRecorded) {
                firstAudioRecorded = true;
                const refTime =
                  this.activeTurnSpeechEndedTime > 0
                    ? this.activeTurnSpeechEndedTime
                    : this.activeTurnStartTime;
                turnMetrics.firstAudioLatencyMs = Math.max(1, performance.now() - refTime);
              }
            },
            (playbackPromise) => {
              pendingPlaybacks.push(playbackPromise);
            }
          )
        );
      }
    };

    try {
      // Stage 5: Generate incrementally (the phone pipeline may already have answered with a ready-made tool)
      let finalCanonicalText = '';
      let generationProvider = this.llmProvider;
      // What the program being written is for (remembered for follow-up edits)
      let codeTask = normalized;

      if (this.phonePipeline) {
        const route = await this.phonePipeline.router.route(normalized, signal, this.getLastAction(conversationId));
        if (!this.scheduler.isTurnValid(turnId) || signal.aborted) return assistantMsg;

        if (route.kind === 'tool') {
          this.lastAction = { conversationId, kind: 'tool', name: route.name, args: route.args };
          assistantMsg.toolCall = { name: route.name, arguments: route.args };
          this.events.onMessageUpdated?.({ ...assistantMsg });
          const outcome = await runReadyTool(route.name, route.args, {
            speakLater: (text) => void this.speakOutOfTurn(text),
          }).catch((err): ReadyToolOutcome => ({
            context: `The ${route.name} tool failed (${err instanceof Error ? err.message : String(err)}). Apologize briefly.`,
          }));
          if (!this.scheduler.isTurnValid(turnId) || signal.aborted) return assistantMsg;
          assistantMsg.toolCall = {
            name: route.name,
            arguments: route.args,
            result: outcome.say ?? outcome.context?.slice(0, 160),
            status: 'completed',
          };
          this.events.onMessageUpdated?.({ ...assistantMsg });
          if (outcome.say) {
            finalCanonicalText = outcome.say;
            assistantMsg.canonicalContent = finalCanonicalText;
            this.events.onTokenStream?.(turnId, finalCanonicalText, finalCanonicalText);
            this.events.onMessageUpdated?.({ ...assistantMsg });
            for (const phrase of segmenter.push(finalCanonicalText + ' ')) {
              enqueuePhraseForSpeech(phrase);
            }
            for (const phrase of segmenter.flush()) {
              enqueuePhraseForSpeech(phrase);
            }
          } else if (outcome.context) {
            systemPrompt = `${systemPrompt}\nAnswer the user using this information:\n${outcome.context}`;
          }
        } else if (route.kind === 'code') {
          // Qwen2.5-Coder writes the program; the existing code path streams speak() and runs it
          codeTask = route.task;
          assistantMsg.toolCall = { name: 'coder_agent', arguments: { task: route.task } };
          this.events.onMessageUpdated?.({ ...assistantMsg });
          generationProvider = this.phonePipeline.coder;
          systemPrompt = CONCISE_VOICE_SYSTEM_PROMPT;
          const previous = this.getLastAction(conversationId);
          promptMessages =
            route.edit && previous?.kind === 'code'
              ? [
                  // The coder sees the program it is changing (the screen is wiped before it runs)
                  { role: 'user', content: previous.task },
                  { role: 'assistant', content: previous.code },
                  { role: 'user', content: route.task },
                ]
              : [{ role: 'user', content: route.task }];
          this.events.onStatusChange?.('Writing code…');
        }
      }

      if (!finalCanonicalText) {
        let rawAccumulatedTokens = '';
        let lastSpokenTextEmitted = '';
        // Phone chat model replies in prose only; only the coder's output is run as code
        const forceProse = !!this.phonePipeline && generationProvider !== this.phonePipeline.coder;
        let streamMode: 'unknown' | 'code' | 'prose' = forceProse ? 'prose' : 'unknown';
        // Prose shows in the chat as it streams but is voiced once the reply is complete and known
        // not to be a program ("Here's the code: …" is read aloud otherwise, before the code
        // arrives). The phone chat model only ever writes prose, so there is nothing to wait for.
        const voiceProseWhileStreaming = forceProse;
        // A fix's reply stays out of the chat and the speakers until it has run: when it comes
        // back as chat instead of the program, it is dropped (see lostProgram)
        const quietReply = !!options?.autoFix;
        // Small models can fall into repeating one line forever: stop generating when they do
        let generationAbort = new AbortController();
        const abortGeneration = () => generationAbort.abort();
        signal.addEventListener('abort', abortGeneration, { once: true });
        let stoppedRepeating = false;
        let repeatCheckedAt = 0;

        const generateReply = (messages: typeof promptMessages) => withActivity('generating a reply', () => generationProvider.generate({
          turnId,
          systemPrompt,
          messages,
          temperature: 0.1,
          maxOutputTokens: generationProvider.maxOutputTokens,
          // A fix wants the one most likely line, not a varied one
          ...(options?.autoFix ? { exact: true } : {}),
          signal: generationAbort.signal,
          onToken: (chunk) => {
            if (!this.scheduler.isTurnValid(turnId) || stoppedRepeating) return;

            rawAccumulatedTokens += chunk;
            if (rawAccumulatedTokens.length - repeatCheckedAt >= 40) {
              repeatCheckedAt = rawAccumulatedTokens.length;
              const cut = repetitionCutIndex(rawAccumulatedTokens);
              if (cut >= 0) {
                stoppedRepeating = true;
                appendRunLog('retry', 'the reply started repeating itself: generation stopped there (no retry)');
                rawAccumulatedTokens = rawAccumulatedTokens.slice(0, cut);
                if (streamMode === 'prose' && !quietReply) {
                  assistantMsg.canonicalContent = rawAccumulatedTokens;
                  this.events.onMessageUpdated?.({ ...assistantMsg });
                }
                generationAbort.abort();
                return;
              }
            }
            const currentFull = rawAccumulatedTokens;
            // The code panel shows only code: the fenced part once a fence starts
            this.events.onRawOutput?.(turnId, codeView(currentFull));

            if (streamMode === 'unknown') {
              // Markup counts as code too: an HTML reply
              const hasCodeSignature =
                currentFull.includes('speak(') || STREAM_CODE_LINE.test(currentFull) || /^\s*</.test(currentFull);
              if (hasCodeSignature) {
                streamMode = 'code';
              } else if (
                /\s/.test(currentFull) ||
                (currentFull.length >= 10 && !/^\s*(?:speak|const|let|var|func|root|doc|win|import|\/\/|\/\*|`|<)/i.test(currentFull))
              ) {
                streamMode = 'prose';
                // Shown as it streams only for the phone chat model, whose replies are all prose:
                // otherwise prose may still turn out to wrap code, and talk outside speak() is
                // dropped (see the isProse branch for a reply that is only prose)
                if (!quietReply && voiceProseWhileStreaming) {
                  // Flush buffered prefix to canonicalContent
                  assistantMsg.canonicalContent = currentFull;
                  this.events.onTokenStream?.(turnId, currentFull, assistantMsg.canonicalContent);
                  this.events.onMessageUpdated?.({ ...assistantMsg });
                  if (voiceProseWhileStreaming) {
                    for (const phrase of segmenter.push(currentFull)) {
                      enqueuePhraseForSpeech(phrase);
                    }
                  }
                }
                return;
              }
            }

            if (
              streamMode === 'prose' &&
              (currentFull.includes('```') || STREAM_CODE_LINE.test(currentFull) || STREAM_MARKUP.test(currentFull))
            ) {
              // Explanation followed by code (fenced or not, or markup): the code runs once the
              // reply is complete; stop showing here (the explanation was never voiced)
              streamMode = 'code';
            }
            if (streamMode === 'prose') {
              if (!quietReply && voiceProseWhileStreaming) {
                assistantMsg.canonicalContent += chunk;
                this.events.onTokenStream?.(turnId, chunk, assistantMsg.canonicalContent);
                this.events.onMessageUpdated?.({ ...assistantMsg });
                if (voiceProseWhileStreaming) {
                  for (const phrase of segmenter.push(chunk)) {
                    enqueuePhraseForSpeech(phrase);
                  }
                }
              }
            }
            // In code mode nothing is shown or voiced while it streams: a reply can still be cut
            // or come back unusable, and the chat only adds messages. What the program
            // says when it runs fills the bubble and the voice.
          },
        }));

        const genResult = await generateReply(promptMessages);

        if (generationProvider !== this.llmProvider) this.events.onStatusChange?.(null);

        signal.removeEventListener('abort', abortGeneration);
        // Discard stale results if turn was canceled during generation
        if (!this.scheduler.isTurnValid(turnId) || (genResult.aborted && !stoppedRepeating)) {
          return assistantMsg;
        }

        turnMetrics.llmTimeToFirstTokenMs = genResult.timeToFirstTokenMs;
        turnMetrics.generationThroughputTps = genResult.tokensPerSecond;

        const rawContent = rawAccumulatedTokens || assistantMsg.canonicalContent || genResult.text;
        // The model's whole reply, before the program is taken out of it
        appendRunLog('reply', rawContent);

        if (this.scheduler.isTurnValid(turnId)) {
          // A fix reply is search/replace edits to the failed program: they're applied, and the
          // code panel shows the whole program that runs
          const fixedProgram = options?.autoFix ? applyFixReply(options.autoFix, rawContent, fixLine) : rawContent;
          if (fixedProgram !== rawContent) this.events.onRawOutput?.(turnId, fixedProgram);
          const inspected = inspectExecutableCode(fixedProgram);
          const executableCode = inspected.code;
          const isProse = inspected.isProse || forceProse;
          assistantMsg.rawCode = executableCode;
          assistantMsg.rawLlmOutput = rawContent;

          // A fix that came back as chat or a bare speak(), or that no longer draws what the program
          // drew, has lost the program. Nothing runs and nothing is said or shown; the original
          // stays the current program (lastRun, lastAction) and the status says why.
          const originalCode = options?.autoFix;
          const lostProgram =
            !!originalCode && (isTalkOnly(executableCode) || (programDraws(originalCode) && !programDraws(executableCode)));
          // Edits that matched nothing leave the same failing program: running it again would
          // only repeat the error (and its sounds and words)
          const unchangedProgram = !!originalCode && fixedProgram.replace(/\s+/g, '') === originalCode.replace(/\s+/g, '');
          // A fix that came back cut off: it doesn't parse, so running it would only fail
          const incompleteProgram =
            !!originalCode && !lostProgram && !unchangedProgram && (await syntaxErrorLine(executableCode)) !== undefined;

          if (lostProgram || unchangedProgram || incompleteProgram) {
            if (options?.autoFix) this.finishFixLog(lostProgram ? 'lost' : unchangedProgram ? 'unchanged' : 'incomplete');
            const failed = this.lastRun;
            const why = lostProgram
              ? 'The fix lost the program'
              : unchangedProgram
                ? "The fix didn't change the program"
                : 'The fix came back incomplete';
            appendRunLog('discarded', `// ${why}, so it was not run. The model replied:\n${rawContent}`);
            // The code panel keeps the program that is still current; the reply is in the run log
            this.events.onRawOutput?.(turnId, `// ${why} (its reply is in the log)\n${originalCode}`);
            this.events.onRunStatus?.(turnId, {
              kind: 'error',
              text: `${why}, so it was not run. ${failed?.error ? errorText(failed.error, failed.errorLine) : 'The program failed.'}`,
            });
          } else if (isProse) {
            if (options?.autoFix) {
              this.finishFixLog('lost');
              appendRunLog('discarded', `// The fix came back as chat, so nothing was run:\n${rawContent}`);
            }
            this.events.onRunStatus?.(turnId, { kind: 'none', text: 'No code to run in this reply' });
            // The reply is known not to be a program, so voice it now (not while it streamed, when
            // it might still have turned into code). Nothing was voiced yet unless it is the phone
            // chat model's, which is voiced as it streams.
            const proseText = (assistantMsg.canonicalContent || proseOfSpeakCode(executableCode) || rawContent).trim();
            if (rawContent.trim() && proseText && (assistantMsg.phrases?.length ?? 0) === 0) {
              if (!assistantMsg.canonicalContent) {
                // A short reply never left 'unknown' mode, so the chat has not shown it yet
                assistantMsg.canonicalContent = proseText;
                this.events.onTokenStream?.(turnId, proseText, proseText);
                this.events.onMessageUpdated?.({ ...assistantMsg });
              }
              for (const phrase of segmenter.push(proseText + ' ')) {
                enqueuePhraseForSpeech(phrase);
              }
            }
          } else {
            // Execute the generated output through the Universal Programmatic Agent Harness
            // Set once the run returns: later speak() calls come from timers/handlers the code left
            // running, and are voiced outside the (finished) turn instead of being dropped.
            let runFinished = false;
            // A new program starts on a clean slate: old drawings, animation loops, timers and
            // sounds go away, whether or not the new one draws ("play it slower" must not layer a
            // second loop over the first). Programs that only talk (desktop replies are speak()
            // code) leave a running program alone, and nothing happens when nothing is running.
            if (!isTalkOnly(executableCode) && this.javascriptRuntime.hasRunningProgram?.()) {
              await this.javascriptRuntime.resetVisual();
              // The old program's canvases and sounds are freed before the new one allocates
              await settle(AFTER_HEAVY_MS);
            }
            // What the failed program already said: a fix doesn't say it again
            const fixSaid = fixedTurnId
              ? (this.memoryStore.getMessages().find((m) => m.id === `msg_assistant_${fixedTurnId}`)?.canonicalContent ?? '')
              : '';
            const saidBefore = (phrase: string) => !!fixSaid && !!phrase.trim() && fixSaid.includes(phrase.trim());
            const execResult = await this.javascriptRuntime.execute(executableCode, undefined, {
              onSpeak: (phrase) => {
                if (saidBefore(phrase)) return;
                if (runFinished) {
                  void this.speakOutOfTurn(phrase);
                } else if (this.scheduler.isTurnValid(turnId)) {
                  const key = speakKey(phrase);
                  // Already pre-spoken while streaming
                  if (consume(streamedSpeakPending, key)) return;
                  bump(spokenSpeakCounts, key);
                  spokenPhrasesSeen.add(phrase);
                  for (const p of segmenter.push(phrase + ' ')) {
                    enqueuePhraseForSpeech(p);
                  }
                }
              },
              audioContextAccessor: this.audioContextAccessor,
            });
            runFinished = true;
            if (options?.autoFix) this.finishFixLog(execResult.error ? 'error' : 'ran');
            // A syntax error comes without a line: a parser finds it, so the fix can point at it
            if (execResult.error && execResult.errorLine === undefined) {
              execResult.errorLine = await syntaxErrorLine(executableCode);
            }
            this.lastRun = {
              turnId,
              code: executableCode,
              task: codeTask,
              isAutoFix: !!options?.autoFix,
              fixRequested: false,
              error: execResult.error ?? null,
              errorLine: execResult.errorLine,
            };
            this.events.onRunStatus?.(
              turnId,
              execResult.error
                ? { kind: 'error', text: errorText(execResult.error, execResult.errorLine) }
                : execResult.stillRunning
                  ? { kind: 'running', text: 'Ran; still running' }
                  : { kind: 'ok', text: `Ran in ${Math.max(1, Math.round(execResult.executionTimeMs))} ms` }
            );
            // The program follow-ups may edit; remembered even when it failed ("fix it" edits it
            // too). Talk-only replies (desktop chat is speak() code) don't replace it.
            if (!isTalkOnly(executableCode)) {
              this.lastAction = { conversationId, kind: 'code', task: codeTask, code: executableCode };
            }
            // A fix that works stands for the broken program in later prompts, as if the model had
            // written it right the first time (see buildModelPrompt). The broken program's message
            // isn't edited: messages are only ever added.
            if (fixedTurnId && !execResult.error) {
              assistantMsg.fixesTurnId = fixedTurnId;
            }

            if (this.scheduler.isTurnValid(turnId)) {
              let spokenText = '';
              let spokenTextsHandled = false;
              const spokenTexts = (execResult.spokenTexts ?? []).filter((t) => !saidBefore(t));
              if (spokenTexts.length > 0) {
                spokenText = spokenTexts.join(' ');
                spokenTextsHandled = true;
                // Only speak phrases that were not already streamed / delivered via onSpeak
                const remaining = new Map(spokenSpeakCounts);
                for (const t of spokenTexts) {
                  if (consume(remaining, speakKey(t))) continue;
                  spokenPhrasesSeen.add(t);
                  for (const phrase of segmenter.push(t + ' ')) {
                    enqueuePhraseForSpeech(phrase);
                  }
                }
              } else if (options?.autoFix && !execResult.error && (execResult.spokenTexts?.length ?? 0) > 0) {
                // A working fix that only repeats what was already said adds no bubble
              } else if (
                execResult.output !== undefined &&
                execResult.output !== null &&
                execResult.output !== 'undefined' &&
                execResult.output !== 'use strict' &&
                // A program's last line is often `document.body.innerHTML = "<div>…"`: that value is markup, not a reply
                !/<[a-z][^>]*>/i.test(String(execResult.output)) &&
                // …or an element it made ("[object HTMLDivElement]")
                !/^\[object [A-Za-z]+\]$/.test(String(execResult.output))
              ) {
                spokenText =
                  typeof execResult.output === 'object'
                    ? JSON.stringify(execResult.output)
                    : String(execResult.output);
              } else if (execResult.error && !(this.autoFixErrors && !options?.autoFix)) {
                // (When a fix follows, its reply is the answer)
                spokenText = 'Something went wrong while running that.';
              } else if (execResult.hasVisualOutput) {
                spokenText = "I've rendered that on your screen.";
              }

              if (spokenText) {
                const shown = assistantMsg.canonicalContent;
                assistantMsg.canonicalContent = spokenText;
                const added = assistantMsg.canonicalContent.startsWith(shown)
                  ? assistantMsg.canonicalContent.slice(shown.length)
                  : assistantMsg.canonicalContent;
                this.events.onTokenStream?.(turnId, added, assistantMsg.canonicalContent);
                this.events.onMessageUpdated?.({ ...assistantMsg });

                if (!spokenTextsHandled && !spokenPhrasesSeen.has(spokenText)) {
                  spokenPhrasesSeen.add(spokenText);
                  for (const phrase of segmenter.push(spokenText)) {
                    enqueuePhraseForSpeech(phrase);
                  }
                }
              }

              if (execResult.hasVisualOutput || execResult.code) {
                assistantMsg.toolCall = {
                  name: 'javascript_runtime',
                  arguments: { code: executableCode },
                  result: execResult,
                  error: execResult.error,
                  status: execResult.success ? 'completed' : 'failed',
                };
                this.events.onMessageUpdated?.({ ...assistantMsg });
              }
            }
          }
        }

        // Selective lightweight verification pass for high-impact factual claims
        if (responseMode === 'verification' && this.scheduler.isTurnValid(turnId)) {
          assistantMsg.verified = true;
        }
      }

      // Flush remaining buffered phrase to TTS
      for (const trailingPhrase of segmenter.flush()) {
        enqueuePhraseForSpeech(trailingPhrase);
      }

      // Wait for queued phrase syntheses and scheduled playback to finish unless interrupted
      // Waits are raced against abort / speech being disabled so a stopped playback can never hang the turn.
      if (this.scheduler.isTurnValid(turnId)) {
        await this.waitUnlessStopped(ttsDrainPromise, signal);
        if (pendingPlaybacks.length > 0 && this.scheduler.isTurnValid(turnId)) {
          await this.waitUnlessStopped(Promise.allSettled(pendingPlaybacks), signal);
        }
      }

      if (!this.scheduler.isTurnValid(turnId)) {
        return assistantMsg;
      }

      // Stage 7: Finalize the turn
      turnMetrics.totalTurnDurationMs = Math.max(1, performance.now() - this.activeTurnStartTime);
      assistantMsg.metrics = turnMetrics;
      this.memoryStore.updateMessage(assistantMsg.id, {
        canonicalContent: assistantMsg.canonicalContent,
        speechReadyContent: assistantMsg.speechReadyContent,
        phrases: assistantMsg.phrases,
        verified: assistantMsg.verified,
        toolCall: assistantMsg.toolCall,
        fixesTurnId: assistantMsg.fixesTurnId,
        metrics: turnMetrics,
      });

      this.scheduler.completeTurn(turnId);
      this.activeAssistantMessage = null;
      this.completedTurnsCount++;
      this.recentTurnMetrics.push(turnMetrics);
      if (this.recentTurnMetrics.length > 25) {
        this.recentTurnMetrics.shift();
      }

      this.stateCoordinator.setPlaybackState('stopped');
      this.stateCoordinator.transitionInteraction('idle', null);
      this.events.onMessageUpdated?.({ ...assistantMsg });
      this.emitTelemetry();
      this.maybeAutoFix(turnId);

      // If this was the first completed turn in this session, generate a concise title
      // (or, when the host tracks titles, the first turn of a conversation still untitled)
      const needsTitle =
        conversationId !== undefined && this.shouldAutoTitle
          ? this.shouldAutoTitle(conversationId)
          : this.completedTurnsCount === 1;
      if (needsTitle) {
        // Snapshot the text now so a conversation switch cannot change what gets titled
        const titleText = this.formatConversationForCompaction(this.memoryStore.getMessages(), null).trim();
        void this.generateConversationTitle({
          text: titleText || undefined,
          conversationId,
        }).catch(() => {});
      }

      return assistantMsg;
    } catch (err) {
      if (!this.scheduler.isTurnValid(turnId) || signal.aborted) {
        return assistantMsg;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      if (options?.autoFix) this.finishFixLog('error');
      if (!assistantMsg.canonicalContent) {
        assistantMsg.canonicalContent = `[Error: ${error.message}]`;
        this.memoryStore.updateMessage(assistantMsg.id, {
          canonicalContent: assistantMsg.canonicalContent,
        });
        this.events.onMessageUpdated?.({ ...assistantMsg });
      }
      this.events.onError?.(error, 'llm_turn');
      this.stateCoordinator.transitionInteraction('error', turnId, error.message);
      this.scheduler.completeTurn(turnId);
      this.activeAssistantMessage = null;
      return assistantMsg;
    }
  }

  // --------------------------------------------------------------------------
  // Dynamic Context Compaction & Summarization (Prompt & History Reset)
  // --------------------------------------------------------------------------

  private formatConversationForCompaction(
    messages: ReadonlyArray<ConversationMessage>,
    existingSummary: ConversationSummary | null
  ): string {
    const lines: string[] = [];
    if (existingSummary?.summaryText) {
      lines.push(`[Prior Summary]: ${existingSummary.summaryText}`);
    }
    // Chatty's own fix requests, and the replies to them, aren't part of the conversation
    const fixTurnIds = new Set(messages.filter((m) => m.role === 'user' && m.autoFix).map((m) => m.turnId));
    for (const msg of messages) {
      if (fixTurnIds.has(msg.turnId)) continue;
      const text = msg.canonicalContent.replace(/\s*\[Interrupted\]\s*$/, '').trim();
      if (!text || text.startsWith('[Error') || text === '[Response interrupted]') continue;
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      lines.push(`${role}: ${text}`);
    }
    return lines.join('\n');
  }

  private speakCompactingAnnouncement(turnId: string, signal?: AbortSignal): Promise<void> {
    return this.speakStandalonePhrase('Hold on a sec.', turnId, signal);
  }

  /**
   * Speaks text outside the normal turn pipeline, e.g. speak() calls fired by
   * runtime timers or event handlers after the code-mode turn has finished.
   */
  /**
   * An error a program threw after it started (a timer, an async function, or a handler the user
   * triggered, maybe minutes later). Shown, and sent back to the model to fix, once per program.
   */
  reportProgramError(message: string, line?: number): void {
    this.events.onRunStatus?.(null, { kind: 'error', text: `${errorText(message, line)} (while running)` });
    const run = this.lastRun;
    // A program that only talks can't have thrown it: it's from an app still on screen from before
    if (!run || run.error || isTalkOnly(run.code)) return;
    run.error = message;
    run.errorLine = line;
    // Still finishing its turn (speaking): the turn's end sends it
    if (!this.scheduler.getActiveTurnId()) this.maybeAutoFix(run.turnId);
  }

  /**
   * One automatic fix per request: the error goes back to the model, shown the lines around it,
   * and it rewrites the program (see line-fix.ts).
   */
  private maybeAutoFix(turnId: string): void {
    const run = this.lastRun;
    if (!this.autoFixErrors) return;
    if (!run || run.turnId !== turnId || !run.error || run.isAutoFix || run.fixRequested) return;
    if (this.scheduler.getActiveTurnId()) return; // the user has already moved on
    run.fixRequested = true;
    this.events.onRunStatus?.(turnId, {
      kind: 'error',
      text: `${errorText(run.error, run.errorLine)} (asking the model to fix it)`,
    });
    const request = fixRequest(run.task, run.code, run.errorLine, run.error);
    this.startFixLog(run);
    appendRunLog('retry', `the program failed (${errorText(run.error, run.errorLine)}): asking the model to fix the marked line`);
    // A short pause before the model runs again, unless the user moves on meanwhile
    void settle(AFTER_HEAVY_MS).then(() => {
      if (this.scheduler.getActiveTurnId()) return;
      return this.submitUserInput(request, { autoFix: run.code });
    });
  }

  /**
   * A record of each fix turn in localStorage (chatty_fix_log, the last 50), to see how often
   * fixes work: the error and line, and how the fix ended (finishFixLog).
   */
  private fixLogTime: number | null = null;

  private updateFixLog(change: (log: Array<Record<string, unknown>>) => void): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const parsed = JSON.parse(localStorage.getItem('chatty_fix_log') ?? '[]');
      const log: Array<Record<string, unknown>> = Array.isArray(parsed) ? parsed : [];
      change(log);
      localStorage.setItem('chatty_fix_log', JSON.stringify(log.slice(-50)));
    } catch {
      // The log is only a measurement: never in the way
    }
  }

  private startFixLog(run: { code: string; errorLine?: number; error: string | null }): void {
    const time = Date.now();
    this.fixLogTime = time;
    const markedLine = run.errorLine ? (run.code.split('\n')[run.errorLine - 1] ?? '').trim() : '';
    this.updateFixLog((log) => {
      log.push({ time, modelId: this.llmProvider.modelId, error: run.error, line: run.errorLine ?? null, markedLine });
    });
  }

  private finishFixLog(outcome: 'ran' | 'lost' | 'unchanged' | 'incomplete' | 'error'): void {
    const time = this.fixLogTime;
    if (time === null) return;
    this.fixLogTime = null;
    this.updateFixLog((log) => {
      const entry = log.find((e) => e.time === time);
      if (entry) entry.outcome = outcome;
    });
  }

  speakOutOfTurn(text: string): Promise<void> {
    const phraseText = text.trim();
    if (!phraseText) return Promise.resolve();
    return this.speakStandalonePhrase(phraseText, `oot_${Date.now()}`);
  }

  private async speakStandalonePhrase(phraseText: string, turnId: string, signal?: AbortSignal): Promise<void> {
    if (!this.ttsProvider || !this.enableSpeechOutput) return;
    try {
      const res = await this.ttsProvider.synthesize(phraseText, turnId, 0, signal);
      if (res.samples && res.samples.length > 0) {
        await this.events.onPhraseReadyForPlayback?.({
          id: `phrase_${turnId}_0`,
          turnId,
          sequence: 0,
          canonicalText: phraseText,
          speechNormalizedText: phraseText,
          status: 'ready',
          audioSamples: res.samples,
          sampleRate: res.sampleRate,
        });
      }
    } catch {
      // Non-fatal if standalone speech fails or speech output disabled
    }
  }

  /** The last tool/program used in this conversation, if any. */
  private getLastAction(conversationId: string | undefined): LastAction | null {
    return this.lastAction && this.lastAction.conversationId === conversationId ? this.lastAction : null;
  }

  /** True when the coordinated state still belongs to the given turn/compaction id. */
  private ownsState(ownerId: string): boolean {
    return this.stateCoordinator.getSnapshot().activeTurnId === ownerId;
  }

  /**
   * Summarizes history. `ownerTurnId` is the turn that triggered compaction (omitted for a
   * standalone/manual compaction, which then owns the state itself and returns to idle).
   */
  private async performContextCompaction(signal?: AbortSignal, ownerTurnId?: string): Promise<void> {
    const compactTurnId = `compact_${Date.now()}`;
    const stateOwnerId = ownerTurnId ?? compactTurnId;
    this.stateCoordinator.transitionInteraction('compacting', stateOwnerId);
    this.events.onStatusChange?.('Compacting…');

    // 1. Speak announcement "Hold on a sec."
    const announcementPromise = this.speakCompactingAnnouncement(compactTurnId, signal);

    // 2. Format conversation history for Gemma to summarize
    const previousMessages = this.memoryStore.getMessages();
    const existingSummary = this.memoryStore.getSummary();
    const formattedTranscript = this.formatConversationForCompaction(
      previousMessages,
      existingSummary
    );

    const compactionPrompt = `Please summarize our entire conversation so far into a concise, structured memory summary:\n\n${formattedTranscript}`;

    try {
      // 3. Request structured compaction from Gemma
      const summaryResult = await this.llmProvider.generate({
        turnId: compactTurnId,
        messages: [{ role: 'user', content: compactionPrompt }],
        systemPrompt: COMPACTION_SYSTEM_PROMPT,
        temperature: 0.2,
        maxOutputTokens: 400,
        signal,
      });

      await announcementPromise;

      // Cancelled compaction must not trim history
      if (signal?.aborted || summaryResult.aborted) return;

      const summaryText = summaryResult.text.trim();
      if (summaryText) {
        const newSummary: ConversationSummary = {
          id: `sum_${Date.now()}`,
          updatedAt: Date.now(),
          coveredTurnCount: (existingSummary?.coveredTurnCount ?? 0) + previousMessages.length,
          lastCoveredTurnId: previousMessages[previousMessages.length - 1]?.turnId ?? '',
          summaryText,
          decisions: [],
          unresolvedQuestions: [],
          namedEntities: {},
          constraints: [],
        };
        // Restart LLM chat with no history except the summary
        this.memoryStore.compactWithSummary(newSummary);
      } else {
        this.memoryStore.compactIfNecessary(2);
      }
    } catch (err) {
      await announcementPromise;
      if (signal?.aborted) return;
      console.error('[Chatty Compaction] LLM compaction error, using fallback:', err);
      this.memoryStore.compactIfNecessary(2);
    } finally {
      // Only touch shared status/state if a newer turn has not superseded us
      if (this.ownsState(stateOwnerId)) {
        this.events.onStatusChange?.(null);
        if (!ownerTurnId) {
          this.stateCoordinator.transitionInteraction('idle', null);
        }
      }
    }
  }

  async forceCompaction(signal?: AbortSignal): Promise<void> {
    const messages = this.memoryStore.getMessages();
    if (messages.length === 0 && !this.memoryStore.getSummary()) {
      return;
    }
    await this.performContextCompaction(signal);
  }

  // --------------------------------------------------------------------------
  // Dynamic Title Generation (Current Messages or Compacted Summary)
  // --------------------------------------------------------------------------

  /**
   * Generates a concise title (3 to 6 words) for the conversation based on the current
   * conversation text or the compacted summary, using Gemma to perform the summarization.
   */
  async generateConversationTitle(options?: {
    text?: string;
    summary?: string;
    signal?: AbortSignal;
    conversationId?: string;
  }): Promise<string> {
    const existingSummary = options?.summary ?? this.memoryStore.getSummary()?.summaryText ?? null;
    const messages = this.memoryStore.getMessages();

    let contentToSummarize = '';
    if (options?.text) {
      contentToSummarize = options.text.trim();
    } else if (existingSummary) {
      const activeText = this.formatConversationForCompaction(messages, null).trim();
      contentToSummarize = activeText
        ? `Summary of earlier conversation:\n${existingSummary}\n\nRecent conversation:\n${activeText}`
        : `Summary of conversation:\n${existingSummary}`;
    } else {
      contentToSummarize = this.formatConversationForCompaction(messages, null).trim();
    }

    if (!contentToSummarize) {
      return 'New Conversation';
    }

    const titleTurnId = `title_${Date.now()}`;
    const userPrompt = `Generate a concise 3 to 6 word title summarizing this conversation:\n\n${contentToSummarize}`;

    try {
      const result = await this.llmProvider.generate({
        turnId: titleTurnId,
        messages: [{ role: 'user', content: userPrompt }],
        systemPrompt: TITLE_GENERATION_SYSTEM_PROMPT,
        temperature: 0.2,
        maxOutputTokens: 25,
        signal: options?.signal,
      });

      let title = result.text.trim();
      // Remove any markdown headers or asterisks
      title = title.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
      // Remove surrounding quotes
      title = title.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
      // Remove trailing punctuation (.!?)
      title = title.replace(/[.!?]+$/, '').trim();
      // Remove common prefix if Gemma emitted it
      title = title.replace(/^(title|conversation title|chat title):\s*/i, '').trim();
      // If multiple lines, pick first non-empty line
      if (title.includes('\n')) {
        title = title.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
      }

      const finalTitle = title || 'New Conversation';
      const stillCurrent =
        options?.conversationId === undefined ||
        !this.getConversationId ||
        this.getConversationId() === options.conversationId;
      if (stillCurrent && this.memoryStore.getSummary()) {
        this.memoryStore.updateSummaryTitle(finalTitle);
      }
      this.events.onTitleGenerated?.(finalTitle, options?.conversationId);
      return finalTitle;
    } catch (err) {
      console.error('[Chatty Title] Failed to generate conversation title with LLM, using fallback title:', err);
      return 'New Conversation';
    }
  }

  // --------------------------------------------------------------------------
  // Response Mode & Prompt Construction (Addendum Sections 3 & 6)
  // --------------------------------------------------------------------------

  selectResponseMode(
    normalizedQuery: string,
    workingMessages: ReadonlyArray<ConversationMessage>
  ): ResponseMode {
    const lower = normalizedQuery.toLowerCase();

    // 1. Check for genuinely ambiguous short input with no prior context
    const words = normalizedQuery.split(/\s+/);
    const isAmbiguousPronounOnly =
      words.length <= 4 &&
      /\b(do it|change it|move it|fix that|the other one)\b/i.test(lower) &&
      workingMessages.length === 0;
    if (isAmbiguousPronounOnly) {
      return 'clarification';
    }

    // 2. Check if high-impact factual verification is warranted
    if (
      /\b(verify|fact check|exact year|chemical formula|medical dosage|is it true that|speed of light|capital of)\b/i.test(
        lower
      )
    ) {
      return 'verification';
    }

    return 'direct';
  }

  /**
   * The system prompt's parts that stay the same from turn to turn. The desktop model keeps its
   * processed prompt (the KV cache) between turns only while the system prompt and the earlier
   * messages are sent again exactly as before, so anything that varies with a request
   * (memories, notes) goes into that request's message instead (see buildModelPrompt).
   */
  /** The smallest models (a 4,096-token context), on any device: they get a trimmed prompt */
  private get isSmallModel(): boolean {
    return this.llmProvider.contextLimit <= 4096;
  }

  private staticPromptParts(request?: string): { head: string[]; tail: string[] } {
    // The smallest models get only the rules this request needs
    const filter = request !== undefined && this.isSmallModel;
    const rules = filter ? promptRules(request, true) : CONCISE_VOICE_SYSTEM_PROMPT;
    const head = this.phonePipeline
      ? [`${this.phonePipeline.chatSystemPrompt} Current date and time: ${new Date().toLocaleString()}.`]
      : [rules];

    // The format, restated after everything else
    const tail = this.phonePipeline
      ? []
      : ['Reply with one JavaScript program: first the code that does the request, then one speak() sentence about it. ALL messages to the user go through speak().'];
    return { head, tail };
  }

  /** Estimated tokens of what every prompt carries: the system prompt and the format turns */
  private fixedPromptTokens(): number {
    // Small models get a prompt with only the rules a request needs, so count the core rules
    // (the format turns are always there)
    const { head, tail } = this.staticPromptParts(this.isSmallModel ? '' : undefined);
    // …and every example, which they get only when the request matches (the music one is long)
    let tokens = this.memoryStore.estimateTokens([...head, ...tail].join('\n'));
    if (!this.phonePipeline) {
      // A few tokens per message for the chat template's role markers
      for (const turn of FORMAT_TURNS) tokens += this.memoryStore.estimateTokens(turn.content) + 4;
    }
    return tokens;
  }

  /**
   * Tells the memory store what each prompt carries besides the conversation, and the room the
   * reply needs (WebLLM keeps maxOutputTokens free inside the window), so compaction and
   * trimming start before the window overflows.
   */
  private syncPromptReserve(): void {
    this.memoryStore.setPromptReserve({
      fixedTokens: this.fixedPromptTokens(),
      outputTokens: this.llmProvider.maxOutputTokens ?? 0,
    });
  }

  /** Remember what a user message looked like when it was sent, so later prompts repeat it exactly */
  private rememberSentRequest(messageId: string, content: string): void {
    this.sentRequests.delete(messageId);
    this.sentRequests.set(messageId, content);
    // Only messages still in the history matter, and that is a handful
    for (const oldest of this.sentRequests.keys()) {
      if (this.sentRequests.size <= 32) break;
      this.sentRequests.delete(oldest);
    }
  }

  private buildModelPrompt(
    userMessage: string,
    context: ReturnType<ConversationMemoryStore['resolveContextForQuery']>,
    mode: ResponseMode,
    programBeingEdited: string | null = null
  ): {
    systemPrompt: string;
    promptMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  } {
    // Rules are picked by the request and, for an edit or a fix, the program it changes
    const { head, tail } = this.staticPromptParts(`${userMessage}\n${programBeingEdited ?? ''}`);
    const systemParts: string[] = [...head];

    // What applies to this request only: memories picked for it, a reference it makes, how to
    // answer it. In the system prompt these would change it on most turns, and the model would
    // have to process the whole prompt again; with the request they stay with it.
    const notes: string[] = [];
    if (context.relevantMemories.length > 0) {
      const memStr = context.relevantMemories.map((m) => `${m.key}: ${m.value}`).join('; ');
      notes.push(`User approved memory: ${memStr}.`);
    }
    if (context.resolvedReferencesNote) {
      notes.push(context.resolvedReferencesNote);
    }
    if (mode === 'clarification') {
      notes.push('The user request is ambiguous and lacks prior context. Ask a brief, polite clarifying question.');
    } else if (mode === 'verification') {
      notes.push('Double-check factual accuracy and state exact verified figures concisely.');
    }
    // The phone chat model's prompt keeps them in the system prompt (it has no prompt cache to protect)
    if (this.phonePipeline) systemParts.push(...notes);

    // The summary changes only when older messages leave the history, which changes the start
    // of the messages too
    if (context.conversationSummary) {
      systemParts.push(`Earlier conversation summary: ${context.conversationSummary.summaryText}`);
    }

    const promptMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> =
      this.phonePipeline ? [] : FORMAT_TURNS.map((t) => ({ ...t }));
    const pastPrograms: string[] = [];
    // Assistant messages before the user's first one are the app's own (the welcome greeting).
    // Sent, they'd merge into the format turn's reply (consecutive turns are joined): left out.
    let userHasSpoken = false;
    // Chatty's own "fix this error" turns and the replies to them stay out of later prompts: the
    // chat hides them, and a model that sees them answers the next request the same way
    const fixTurnIds = new Set(
      context.workingMessages.filter((m) => m.role === 'user' && m.autoFix).map((m) => m.turnId)
    );
    // The request text of the last user message kept, as the user wrote it (for describePastProgram)
    let lastAsk = '';

    // A working fix's program stands for the broken one it fixed (the broken message isn't edited)
    const fixedCode = new Map<string, string>();
    for (const m of context.workingMessages) {
      if (m.role === 'assistant' && m.fixesTurnId && m.rawCode) fixedCode.set(m.fixesTurnId, m.rawCode);
    }

    for (const stored of context.workingMessages) {
      if (fixTurnIds.has(stored.turnId)) continue;
      const fixed = stored.role === 'assistant' ? fixedCode.get(stored.turnId) : undefined;
      const msg = fixed ? { ...stored, rawCode: fixed, rawLlmOutput: fixed } : stored;
      if (msg.role === 'user') userHasSpoken = true;
      else if (msg.role === 'assistant' && !userHasSpoken) continue;
      if (msg.role === 'assistant') {
        // Past programs leave the message history (with the request that asked for them) and are
        // described in the system prompt, except the one being edited, which is shown in full.
        // Phone chat model (split pipeline) sees only what was said.
        if (!this.phonePipeline && !(programBeingEdited && msg.rawCode === programBeingEdited)) {
          const prev = promptMessages[promptMessages.length - 1];
          const described = describePastProgram(msg, prev?.role === 'user' ? lastAsk : '');
          if (described) {
            if (prev?.role === 'user') promptMessages.pop();
            pastPrograms.push(described);
            continue;
          }
        }
        const content = (
          this.phonePipeline
            ? msg.canonicalContent || ''
            : programBeingEdited && msg.rawCode === programBeingEdited
              ? msg.rawCode
              : msg.rawCode || msg.canonicalContent || ''
        )
          .replace(/\s*\[Interrupted\]\s*$/, '')
          .trim();
        if (!content || content === '[Response interrupted]' || content.startsWith('[Error')) {
          continue;
        }
        promptMessages.push({
          role: 'assistant',
          content,
        });
      } else {
        const cleaned = msg.canonicalContent
          .replace(/\s*\[Interrupted\]\s*$/, '')
          .trim();
        if (!cleaned || cleaned === '[Response interrupted]' || cleaned.startsWith('[Error')) {
          continue;
        }
        lastAsk = cleaned;
        promptMessages.push({
          role: msg.role,
          // As it was sent: with the notes it carried, so the earlier prompt is repeated exactly
          content: this.sentRequests.get(msg.id) ?? cleaned,
        });
      }
    }

    // The program being edited or fixed is always shown in full right before the request, even
    // when its turn is no longer in the history (compacted away)
    if (programBeingEdited && !promptMessages.some((m) => m.role === 'assistant' && m.content === programBeingEdited)) {
      promptMessages.push({ role: 'assistant', content: programBeingEdited });
    }

    promptMessages.push({
      role: 'user',
      content:
        notes.length > 0 && !this.phonePipeline
          ? `Notes (not part of the request):\n${notes.map((n) => `- ${n}`).join('\n')}\n\nRequest: ${userMessage}`
          : userMessage,
    });

    // Changes only when a program leaves the messages (which changes their start as well)
    if (pastPrograms.length > 0) {
      systemParts.push(
        `Programs you ran earlier in this conversation (write a complete new program for each request):\n${pastPrograms.slice(-8).join('\n')}`
      );
    }
    systemParts.push(...tail);
    const systemPrompt = systemParts.join('\n');
    return { systemPrompt, promptMessages };
  }

  // --------------------------------------------------------------------------
  // TTS Phrase Queue Processing with Graceful Degradation (Addendum Section 7)
  // --------------------------------------------------------------------------

  private async processNextTtsPhrase(
    turnId: string,
    signal: AbortSignal,
    onFirstAudio: () => void,
    onPlaybackScheduled?: (playbackPromise: Promise<void>) => void
  ): Promise<void> {
    if (!this.ttsProvider || !this.scheduler.isTurnValid(turnId)) return;

    const item = this.ttsSynthesisQueue.dequeue();
    if (!item) return;

    // Speech was turned off after this phrase was queued: skip synthesis
    if (!this.enableSpeechOutput) {
      item.payload.status = 'played';
      return;
    }

    const phrase = item.payload;
    if (phrase.turnId !== turnId || !this.scheduler.isTurnValid(turnId)) {
      phrase.status = 'canceled';
      return;
    }

    try {
      phrase.status = 'synthesizing';
      this.stateCoordinator.setPlaybackState('buffering');

      const result = await this.ttsProvider.synthesize(
        phrase.speechNormalizedText,
        turnId,
        phrase.sequence,
        signal
      );

      if (!this.scheduler.isTurnValid(turnId) || signal.aborted) {
        phrase.status = 'canceled';
        return;
      }

      phrase.audioSamples = result.samples;
      phrase.sampleRate = result.sampleRate;
      phrase.synthesisTimeMs = result.synthesisTimeMs;
      phrase.audioDurationMs = result.audioDurationMs;
      phrase.status = 'ready';

      if (this.activeAssistantMessage?.metrics && result.audioDurationMs > 0) {
        this.activeAssistantMessage.metrics.ttsRealTimeFactor = Number(
          (result.synthesisTimeMs / result.audioDurationMs).toFixed(3)
        );
      }

      onFirstAudio();
      this.stateCoordinator.transitionInteraction('speaking', turnId);
      this.stateCoordinator.setPlaybackState('playing');

      phrase.status = 'playing';
      const playbackPromise = Promise.resolve(this.events.onPhraseReadyForPlayback?.(phrase))
        .then(() => {
          if (this.scheduler.isTurnValid(turnId)) {
            phrase.status = 'played';
          }
        })
        .catch((err) => {
          phrase.status = 'failed';
          const error = err instanceof Error ? err : new Error(String(err));
          this.events.onError?.(error, 'tts_playback');
        });
      onPlaybackScheduled?.(playbackPromise);
    } catch (err) {
      // Spec Section 9: When TTS fails, continue displaying generated text without failing the turn
      phrase.status = 'failed';
      const error = err instanceof Error ? err : new Error(String(err));
      this.events.onError?.(error, 'tts_synthesis');
    }
  }

  // --------------------------------------------------------------------------
  // Telemetry & Observability (Spec Section 10)
  // --------------------------------------------------------------------------

  recordInitializationTiming(coldMs?: number, warmMs?: number): void {
    if (coldMs !== undefined) this.firstUseReadinessMs = coldMs;
    if (warmMs !== undefined) this.warmInitializationMs = warmMs;
    this.emitTelemetry();
  }

  recordRecoveryTiming(recoveryMs: number): void {
    this.lastRecoveryTimeMs = recoveryMs;
    this.emitTelemetry();
  }

  getTelemetry(): SystemTelemetry {
    const ttfts = this.recentTurnMetrics
      .map((m) => m.llmTimeToFirstTokenMs)
      .filter((v): v is number => v !== undefined && v > 0);
    const firstAudios = this.recentTurnMetrics
      .map((m) => m.firstAudioLatencyMs)
      .filter((v): v is number => v !== undefined && v > 0);
    const tpsList = this.recentTurnMetrics
      .map((m) => m.generationThroughputTps)
      .filter((v): v is number => v !== undefined && v > 0);
    const rtfs = this.recentTurnMetrics
      .map((m) => m.ttsRealTimeFactor)
      .filter((v): v is number => v !== undefined && v > 0);

    const avg = (arr: number[]) =>
      arr.length > 0 ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : 0;

    return {
      firstUseReadinessMs: this.firstUseReadinessMs,
      warmInitializationMs: this.warmInitializationMs,
      peakMemoryEstimateMB: 420,
      lastRecoveryTimeMs: this.lastRecoveryTimeMs,
      completedTurns: this.completedTurnsCount,
      interruptedTurns: this.interruptedTurnsCount,
      averageTtftMs: avg(ttfts),
      averageFirstAudioMs: avg(firstAudios),
      averageTps: avg(tpsList),
      averageTtsRtf: avg(rtfs),
      recentTurnMetrics: [...this.recentTurnMetrics],
    };
  }

  getInteractionState(): InteractionState {
    return this.stateCoordinator.getSnapshot().interaction;
  }

  private emitTelemetry(): void {
    this.events.onTelemetryUpdated?.(this.getTelemetry());
  }
}
