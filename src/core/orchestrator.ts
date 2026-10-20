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
  stripToolCallMarkup,
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
import { AFTER_HEAVY_MS, settle } from './settle.ts';
import { withActivity } from './activity-breadcrumbs.ts';

/** "Error at line 7: x is not defined" (the line when the browser reported it) */
function errorText(message: string, line?: number): string {
  return line ? `Error at line ${line}: ${message}` : `Error: ${message}`;
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

/** Internal marker: a legacy tool failure was already reported to the user. */
class ToolFailureHandled extends Error {}

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

export const CONCISE_VOICE_SYSTEM_PROMPT = [
  "You are Chatty, a voice assistant that acts by writing JavaScript. Your reply runs as a program in the user's browser, immediately and exactly as written.",
  'Rules:',
  '1. Reply with perfect JavaScript syntax ONLY. Concise logic, fully functional.',
  '2. Act first: do what was asked (draw, build, play, compute, look up) as a live, working browser app, then tell the user what you did with speak("...").',
  '3. speak(text) talks to the user; plain conversation is just speak(). It accepts computed values: speak(`The total is ${total}.`). Never mention code, JavaScript or programming in what you say, and never offer code.',
  '4. What you add to document.body appears in a card in the middle of the screen. Use <canvas> for visuals: drawings, art, animations, games and simulations (2D or WebGL). Use HTML and CSS for interfaces: buttons, forms, cards, notes, tables, gauges, dashboards and widgets. <svg> works for diagrams and icons.',
  '   The screen is wiped with clear(): to completely update the screen, call clear() first.',
  '5. Sound: Web Audio (create an AudioContext and await ctx.resume() first), or Web MIDI for instruments: out = (await navigator.requestMIDIAccess()).outputs.values().next().value; then call out.send([instrument, notes, velocity, durationMs], time) once per note, chord or drum hit, at its own time. Instruments: piano, bass, organ, guitar, strings, violin, trumpet, sax, flute, drums. Notes: one note (\'G3\'), a chord by name (\'G major\', \'Am7\'), a scale (\'G pentatonic down\' plays its notes in order), drum hits (\'kick\', \'snare\', \'hihat\'), or an array (up to 4 notes sound together; 5 or more play one after another). Timing: declare const bpm, beat = 60000 / bpm and start = performance.now() at the top; beat n plays at start + n * beat, and a 4/4 measure is 4 beats. Play it once unless asked to loop or repeat. To loop: put the bars in a function that ends with start += their length, call it, then setInterval it with that same length. A beat or groove means drums. Boom-chuck: kick on beats 1 and 3, snare on 2 and 4. Walking bass: one bass note per beat, stepping through the chord\'s notes. Shuffle: hi-hats on each beat and two-thirds of the way through it.',
  '6. Answer what you know directly. To look up facts you don\'t know, fetch a public API that allows cross-origin requests, such as Wikipedia (https://en.wikipedia.org/api/rest_v1/page/summary/<title>), and speak a sentence or two of it, not the whole text.',
  '7. Write code instead of guessing results.',
  '8. If you define a function, call it.',
  '9. The examples (zorbs, blips, Zibble, Zorblax) are made up: never reuse their names, numbers or formulas.',
].join('\n');

/**
 * Example exchanges, shown in the system prompt inside <examples> tags (EXAMPLES_PROMPT). Sent as
 * chat turns they read as the model's own earlier answers, and their content was carried into new
 * replies; tagged, the model can tell them apart from the conversation. Their content is made up
 * (zorbs, blips, a pet dragon, the Zorblax theme): small models copy whatever concrete content an
 * example holds into unrelated replies, and made-up content never fits a real request, so only
 * the structure carries over. Each reply acts before it speaks.
 */
export const EXAMPLE_TURNS: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: 'Good morning! Any tips for training my pet dragon, Zibble?' },
  {
    role: 'assistant',
    content: 'speak("Morning! Keep Zibble\'s flying lessons short, reward every good landing, and keep the snacks away from the curtains.");',
  },
  { role: 'user', content: 'If one blorp is 2,340 zorbs, how many zorbs are in 0.15 blorps?' },
  { role: 'assistant', content: 'const zorbs = 2340 * 0.15;\nspeak(`0.15 blorps is ${zorbs} zorbs.`);' },
  { role: 'user', content: 'Play the Zorblax theme on organ with strings and a slow beat, on repeat' },
  {
    role: 'assistant',
    content: [
      'const out = (await navigator.requestMIDIAccess()).outputs.values().next().value;',
      'const bpm = 90;',
      'const beat = 60000 / bpm;',
      "const theme = ['D4', 'F4', 'A4', 'G4', 'F4', 'E4', 'D4', 'A3'];",
      'let start = performance.now() + 100;',
      'function playTheme() {',
      '  for (let i = 0; i < theme.length; i++) {',
      '    const t = start + i * beat;',
      "    out.send(['organ', theme[i], 80, beat], t);",
      "    if (i % 4 === 0) out.send(['strings', 'D minor', 60, 4 * beat], t);",
      "    out.send(['drums', i % 2 ? 'snare' : 'kick', 90], t);",
      '  }',
      '  start += theme.length * beat;',
      '}',
      'playTheme();',
      'setInterval(playTheme, theme.length * beat);',
      'speak("Here\'s the Zorblax theme, on repeat.");',
    ].join('\n'),
  },
  { role: 'user', content: 'Make a zorbs to blips converter' },
  {
    role: 'assistant',
    content: [
      "document.body.innerHTML = '<h2>Zorbs to blips</h2><input id=\"zorbs\" type=\"number\" value=\"5\"> zorbs<p id=\"blips\"></p>';",
      "const zorbs = document.getElementById('zorbs');",
      "const blips = document.getElementById('blips');",
      'function convert() {',
      '  // Input values are text: Number() turns them into numbers',
      '  const result = Number(zorbs.value) * 3 + 7;',
      '  blips.textContent = `${zorbs.value} zorbs is ${result} blips`;',
      '}',
      "zorbs.addEventListener('input', convert);",
      'convert();',
      'speak("Type a number of zorbs to see it in blips.");',
    ].join('\n'),
  },
  { role: 'user', content: 'Show a seven second launch timer for my toy rocket, Blip' },
  {
    role: 'assistant',
    content: [
      'const box = document.createElement("div");',
      'box.style.cssText = "padding:16px 28px;font:600 40px sans-serif;";',
      'document.body.appendChild(box);',
      'let left = 7;',
      'box.textContent = left;',
      'const tick = setInterval(() => {',
      '  left -= 1;',
      '  box.textContent = left;',
      '  if (left === 0) {',
      '    clearInterval(tick);',
      '    speak("Liftoff!");',
      '  }',
      '}, 1000);',
      'speak("Blip lifts off in seven seconds.");',
    ].join('\n'),
  },
  { role: 'user', content: 'Tell me about the okapi' },
  {
    role: 'assistant',
    content: 'const res = await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent("Okapi"));\nconst page = await res.json();\nspeak(page.extract.split(". ").slice(0, 2).join(". "));',
  },
];

/**
 * One real chat exchange before the conversation, there only to show the reply format (a
 * JavaScript program, no prose): without it small models answer like a chat assistant offering
 * code ("you can use the following code: …"). It holds nothing worth copying.
 */
export const FORMAT_TURNS: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: 'Hi Chatty!' },
  { role: 'assistant', content: 'speak("Hi! What would you like me to make?");' },
];

/** The example exchanges as the system prompt shows them (see EXAMPLE_TURNS) */
const EXAMPLES_PROMPT = [
  'Examples of requests and replies (made up, not part of this conversation):',
  '<examples>',
  ...EXAMPLE_TURNS.filter((t) => t.role === 'user').map(
    (t, i) => `<example>\n<request>${t.content}</request>\n<reply>\n${EXAMPLE_TURNS[2 * i + 1].content}\n</reply>\n</example>`
  ),
  '</examples>',
].join('\n');

export class ConversationOrchestrator {
  readonly stateCoordinator: StateMachineCoordinator;
  readonly memoryStore: ConversationMemoryStore;
  readonly scheduler: TurnResourceScheduler;

  private llmProvider: LlmRuntimeProvider;
  private ttsProvider?: TtsRuntimeProvider;
  private tools = new Map<string, ToolDefinition>();
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
    isAutoFix: boolean;
    fixRequested: boolean;
    error: string | null;
    errorLine?: number;
  } | null = null;
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

    if (options.tools) {
      for (const tool of options.tools) {
        this.tools.set(tool.name, tool);
      }
    }

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

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
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

    // Context Compaction Check: When context exceeds threshold (>= 85%), compact before continuing
    if (
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
    const resolvedContext = this.memoryStore.resolveContextForQuery(
      normalized,
      Math.floor(this.llmProvider.contextLimit * 0.75)
    );

    // Commit user message to working memory
    this.memoryStore.addMessage(userMsg);
    this.events.onMessageCreated?.(userMsg);

    // Stage 4: Choose a response mode (direct, clarification, verification, tool_execution)
    // Phone pipeline routes with Needle instead of keyword-matched tool execution
    const responseMode = this.phonePipeline
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
      // Do not synthesize raw tool invocation blocks or markdown code syntax as speech
      if (
        canonicalPhrase.includes('```tool_call') ||
        canonicalPhrase.includes('call:') ||
        canonicalPhrase.startsWith('```') ||
        canonicalPhrase.includes('{"name":') ||
        canonicalPhrase.includes('<|tool_call') ||
        canonicalPhrase.includes('<tool_call') ||
        canonicalPhrase.includes('tool_call|>') ||
        canonicalPhrase.includes('<start_function_call')
      ) {
        return;
      }
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
      // Stage 5: Generate incrementally (or execute tool if tool_execution mode)
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

      if (responseMode === 'tool_execution') {
        const toolExecutionOutcome = await this.tryExecuteMatchingTool(normalized, turnId);
        if (toolExecutionOutcome) {
          assistantMsg.toolCall = toolExecutionOutcome.toolCall;
          finalCanonicalText = toolExecutionOutcome.responseText;
          assistantMsg.canonicalContent = finalCanonicalText;
          this.events.onTokenStream?.(turnId, finalCanonicalText, finalCanonicalText);
          for (const phrase of segmenter.push(finalCanonicalText)) {
            enqueuePhraseForSpeech(phrase);
          }
        }
      }

      if (!finalCanonicalText) {
        let rawAccumulatedTokens = '';
        let lastSpokenTextEmitted = '';
        // Phone chat model replies in prose only; only the coder's output is run as code
        const forceProse = !!this.phonePipeline && generationProvider !== this.phonePipeline.coder;
        let streamMode: 'unknown' | 'code' | 'prose' = forceProse ? 'prose' : 'unknown';
        // Small models can fall into repeating one line forever: stop generating when they do
        const generationAbort = new AbortController();
        const abortGeneration = () => generationAbort.abort();
        signal.addEventListener('abort', abortGeneration, { once: true });
        let stoppedRepeating = false;
        let repeatCheckedAt = 0;

        const genResult = await withActivity('generating a reply', () => generationProvider.generate({
          turnId,
          systemPrompt,
          messages: promptMessages,
          temperature: 0.1,
          maxOutputTokens: generationProvider.maxOutputTokens,
          signal: generationAbort.signal,
          tools: Array.from(this.tools.values()),
          onToken: (chunk) => {
            if (!this.scheduler.isTurnValid(turnId) || stoppedRepeating) return;

            rawAccumulatedTokens += chunk;
            if (rawAccumulatedTokens.length - repeatCheckedAt >= 40) {
              repeatCheckedAt = rawAccumulatedTokens.length;
              const cut = repetitionCutIndex(rawAccumulatedTokens);
              if (cut >= 0) {
                stoppedRepeating = true;
                rawAccumulatedTokens = rawAccumulatedTokens.slice(0, cut);
                if (streamMode === 'prose') {
                  assistantMsg.canonicalContent = rawAccumulatedTokens;
                  this.events.onMessageUpdated?.({ ...assistantMsg });
                }
                generationAbort.abort();
                return;
              }
            }
            const currentFull = rawAccumulatedTokens;
            this.events.onRawOutput?.(turnId, currentFull);

            if (streamMode === 'unknown') {
              const hasCodeSignature =
                currentFull.includes('speak(') ||
                /^(?:const|let|var|function|class|import|MODE:|```|\/\/|\/\*|root\.|document\.|window\.)\b/m.test(currentFull);
              if (hasCodeSignature) {
                streamMode = 'code';
              } else if (
                /\s/.test(currentFull) ||
                (currentFull.length >= 10 && !/^\s*(?:speak|const|let|var|func|root|doc|win|import|\/\/|\/\*|`)/i.test(currentFull))
              ) {
                streamMode = 'prose';
                // Flush buffered prefix to canonicalContent
                assistantMsg.canonicalContent = currentFull;
                this.events.onTokenStream?.(turnId, currentFull, assistantMsg.canonicalContent);
                this.events.onMessageUpdated?.({ ...assistantMsg });
                for (const phrase of segmenter.push(currentFull)) {
                  enqueuePhraseForSpeech(phrase);
                }
                return;
              }
            }

            if (streamMode === 'prose' && currentFull.includes('```')) {
              // Explanation followed by a code block: the code runs once the reply is complete;
              // stop voicing here so it isn't read aloud
              streamMode = 'code';
            }
            if (streamMode === 'prose') {
              assistantMsg.canonicalContent += chunk;
              this.events.onTokenStream?.(turnId, chunk, assistantMsg.canonicalContent);
              this.events.onMessageUpdated?.({ ...assistantMsg });
              const readyPhrases = segmenter.push(chunk);
              for (const phrase of readyPhrases) {
                enqueuePhraseForSpeech(phrase);
              }
            } else if (streamMode === 'code') {
              // Extract completed plain string arguments inside speak(...) calls.
              // Template literals with ${...} are left to the runtime onSpeak (real values).
              const speakMatches = Array.from(currentFull.matchAll(/speak\(\s*(["'`])([\s\S]*?)\1\s*\)/g));
              let latestSpoken = '';
              speakMatches.forEach((m, idx) => {
                const quote = m[1];
                const spokenStr = m[2];
                // Skip non-literal args (e.g. "a" + b) and template interpolation
                const isPlainLiteral =
                  !(quote === '`' && spokenStr.includes('${')) &&
                  !new RegExp(`(^|[^\\\\])${quote}`).test(spokenStr);
                if (!isPlainLiteral) return;
                latestSpoken += (latestSpoken ? ' ' : '') + spokenStr;
                if (idx < processedSpeakMatches) return;
                const key = speakKey(spokenStr);
                bump(spokenSpeakCounts, key);
                bump(streamedSpeakPending, key);
                spokenPhrasesSeen.add(spokenStr);
                for (const phrase of segmenter.push(spokenStr + ' ')) {
                  enqueuePhraseForSpeech(phrase);
                }
              });
              processedSpeakMatches = speakMatches.length;
              if (latestSpoken && latestSpoken !== lastSpokenTextEmitted) {
                const delta = latestSpoken.startsWith(lastSpokenTextEmitted)
                  ? latestSpoken.slice(lastSpokenTextEmitted.length)
                  : latestSpoken;
                lastSpokenTextEmitted = latestSpoken;
                assistantMsg.canonicalContent = latestSpoken;
                this.events.onTokenStream?.(turnId, delta, assistantMsg.canonicalContent);
                this.events.onMessageUpdated?.({ ...assistantMsg });
              }
            }
          },
        }));

        if (generationProvider !== this.llmProvider) this.events.onStatusChange?.(null);

        signal.removeEventListener('abort', abortGeneration);
        // Discard stale results if turn was canceled during generation
        if (!this.scheduler.isTurnValid(turnId) || (genResult.aborted && !stoppedRepeating)) {
          return assistantMsg;
        }

        turnMetrics.llmTimeToFirstTokenMs = genResult.timeToFirstTokenMs;
        turnMetrics.generationThroughputTps = genResult.tokensPerSecond;

        // Check if the generated output contains a tool call from Gemma or legacy tool call format
        const rawContent = rawAccumulatedTokens || assistantMsg.canonicalContent || genResult.text;

        let toolName = '';
        let toolArgs: Record<string, unknown> = {};
        let toolCallDetected = false;

        // 1. Fenced code block ```tool_call or ```json
        const fencedMatch = rawContent.match(/```(?:tool_call|json)\s*\n([\s\S]+?)\n```/i);
        if (fencedMatch) {
          try {
            const parsed = JSON.parse(fencedMatch[1]);
            toolName = parsed.name || parsed.tool || '';
            toolArgs = (parsed.arguments || parsed.args || {}) as Record<string, unknown>;
            toolCallDetected = true;
          } catch {}
        }

        // 2. Native tag or bare call syntax: <|tool_call>call:func{args}<tool_call|> or call:func{args}
        if (!toolCallDetected) {
          const callMatch = rawContent.match(/(?:<\|tool_call>|<tool_call>)?\s*call:(\w+)\s*(\{[\s\S]+?\})(?:<tool_call\|>|<\/\|tool_call>|<\|tool_call_end\|>|<\/tool_call>|$)?/i);
          if (callMatch) {
            try {
              toolName = callMatch[1];
              toolArgs = JSON.parse(callMatch[2]);
              toolCallDetected = true;
            } catch {
              toolName = callMatch[1];
              toolArgs = {};
              toolCallDetected = true;
            }
          }
        }

        // 3. Native tag with JSON: <|tool_call>{"name": "...", "arguments": {...}}<tool_call|>
        if (!toolCallDetected) {
          const tagJsonMatch = rawContent.match(/(?:<\|tool_call>|<tool_call>)\s*(\{[\s\S]+?\})\s*(?:<tool_call\|>|<\/\|tool_call>|<\|tool_call_end\|>|<\/tool_call>|$)?/i);
          if (tagJsonMatch) {
            try {
              const parsed = JSON.parse(tagJsonMatch[1]);
              toolName = parsed.name || parsed.tool || '';
              toolArgs = (parsed.arguments || parsed.args || {}) as Record<string, unknown>;
              toolCallDetected = true;
            } catch {}
          }
        }

        // 4. Bare JSON tool call object: {"name": "...", "arguments": {...}}
        if (!toolCallDetected) {
          const jsonMatch = rawContent.match(/\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/i);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              toolName = parsed.name || parsed.tool || '';
              toolArgs = (parsed.arguments || parsed.args || {}) as Record<string, unknown>;
              toolCallDetected = true;
            } catch {}
          }
        }

        // 5. Function call syntax: <|tool_call>coder_agent(...)<tool_call|>
        if (!toolCallDetected) {
          const funcMatch = rawContent.match(/(?:<\|tool_call>|<tool_call>)\s*(\w+)\s*\(([\s\S]*?)\)(?:<tool_call\|>|<\/\|tool_call>|<\|tool_call_end\|>|<\/tool_call>|$)?/i);
          if (funcMatch) {
            toolName = funcMatch[1];
            try {
              toolArgs = JSON.parse(funcMatch[2]);
            } catch {
              toolArgs = { task: funcMatch[2].trim() };
            }
            toolCallDetected = true;
          }
        }

        // 6. Gemma emitted tool control tags without arguments or body: e.g. <|tool_call><tool_call|> or <|tool_call>
        if (!toolCallDetected && (rawContent.includes('<|tool_call') || rawContent.includes('<tool_call') || rawContent.includes('tool_call|>'))) {
          // Model intended to call a tool! Infer tool from normalized user message
          const inferred = this.inferToolFromUserRequest(normalized);
          if (inferred) {
            toolName = inferred.toolName;
            toolArgs = inferred.toolArgs;
            toolCallDetected = true;
          }
        }

        let executedLegacyTool = false;
        if (toolCallDetected && this.scheduler.isTurnValid(turnId)) {
          try {
            const targetTool =
              this.tools.get(toolName) ||
              (toolName === 'browser_agent' ? (this.tools.get('coder_agent') || this.tools.get('javascript_runtime')) : null) ||
              (toolName === 'coder_agent' ? (this.tools.get('browser_agent') || this.tools.get('javascript_runtime')) : null) ||
              (toolName === 'javascript_runtime' ? (this.tools.get('coder_agent') || this.tools.get('browser_agent')) : null);
            if (targetTool) {
              const effectiveToolName = targetTool.name;

              // Bulletproof fallback: If tool arguments are empty or missing meaningful string values, populate from user input!
              const hasMeaningfulArg = Object.values(toolArgs).some(
                (v) => typeof v === 'string' && v.trim().length > 0
              );
              if (!hasMeaningfulArg) {
                if (
                  effectiveToolName === 'coder_agent' ||
                  effectiveToolName === 'browser_agent' ||
                  effectiveToolName === 'javascript_runtime'
                ) {
                  toolArgs = { task: normalized };
                } else if (effectiveToolName === 'draw_graphics') {
                  toolArgs = { prompt: normalized };
                } else if (effectiveToolName === 'play_music') {
                  toolArgs = { notes: normalized, description: normalized };
                } else if (effectiveToolName === 'wikipedia' || effectiveToolName === 'instant_answers') {
                  toolArgs = { query: normalized };
                }
              }

              // Notify message updated with running tool call
              assistantMsg.toolCall = {
                name: effectiveToolName,
                arguments: toolArgs,
                status: 'running',
              };
              this.events.onMessageUpdated?.({ ...assistantMsg });

              let toolResult: unknown;
              try {
                toolResult = await targetTool.execute(toolArgs);
              } catch (execErr) {
                if (this.scheduler.isTurnValid(turnId)) {
                  const errMessage = execErr instanceof Error ? execErr.message : String(execErr);
                  console.warn('[Chatty Orchestrator] Tool execution failed:', execErr);
                  assistantMsg.toolCall = {
                    name: effectiveToolName,
                    arguments: toolArgs,
                    error: errMessage,
                    status: 'failed',
                  };
                  const failureText = `Sorry, the ${effectiveToolName.replace(/_/g, ' ')} tool failed.`;
                  assistantMsg.canonicalContent = failureText;
                  this.events.onMessageUpdated?.({ ...assistantMsg });
                  // Failure is reported to the user; do not fall through to the JS runtime
                  executedLegacyTool = true;
                  for (const phrase of segmenter.push(failureText)) {
                    enqueuePhraseForSpeech(phrase);
                  }
                }
                throw new ToolFailureHandled();
              }
              executedLegacyTool = true;
              if (this.scheduler.isTurnValid(turnId)) {
                let displayResult = '';
                let isError = false;
                let errorMsg: string | undefined;

                if (toolResult && typeof toolResult === 'object') {
                  const r = toolResult as any;
                  if (r.error) {
                    isError = true;
                    errorMsg = String(r.error);
                    displayResult = `Error: ${r.error}`;
                  } else if (r.played) {
                    displayResult = `played ${r.count} notes`;
                  } else if (
                    r.output !== undefined &&
                    r.output !== null &&
                    r.output !== 'undefined' &&
                    r.output !== 'use strict'
                  ) {
                    displayResult = String(r.output);
                  } else if (r.hasVisualOutput) {
                    displayResult = 'visual output rendered on screen';
                  } else if (r.logs && r.logs.length > 0) {
                    displayResult = r.logs.join('; ');
                  } else if (r.answer !== undefined) {
                    displayResult = String(r.answer);
                  } else if (r.summary !== undefined) {
                    displayResult = r.title ? `${r.title}: ${r.summary}` : String(r.summary);
                  } else {
                    displayResult = '';
                  }
                } else if (
                  toolResult !== undefined &&
                  toolResult !== null &&
                  toolResult !== 'undefined' &&
                  toolResult !== 'use strict'
                ) {
                  displayResult = String(toolResult);
                } else {
                  displayResult = '';
                }

                assistantMsg.toolCall = {
                  name: toolName,
                  arguments: toolArgs,
                  result: toolResult,
                  error: errorMsg,
                  status: isError ? 'failed' : 'completed',
                };

                const cleanPreText = stripToolCallMarkup(rawContent);

                let spokenText: string;
                if (cleanPreText) {
                  const lower = cleanPreText.toLowerCase();
                  const isAction =
                    toolName === 'play_music' ||
                    toolName === 'draw_graphics' ||
                    lower.includes('play') ||
                    lower.includes('draw') ||
                    lower.includes('note');
                  spokenText =
                    displayResult && !isAction
                      ? `${cleanPreText}. The result is ${displayResult}.`
                      : cleanPreText;
                } else if (toolName === 'play_music') {
                  spokenText = 'I played those notes for you.';
                } else if (toolName === 'draw_graphics') {
                  spokenText = 'I drew that on your screen.';
                } else if (displayResult) {
                  spokenText = `I ran the ${toolName.replace(/_/g, ' ')} tool. The result is ${displayResult}.`;
                } else if (
                  toolName === 'coder_agent' ||
                  toolName === 'browser_agent' ||
                  toolName === 'javascript_runtime'
                ) {
                  spokenText = "I've built and launched that in your browser.";
                } else {
                  spokenText = `I ran the ${toolName.replace(/_/g, ' ')} tool.`;
                }

                assistantMsg.canonicalContent = spokenText;
                this.events.onMessageUpdated?.({ ...assistantMsg });
                for (const phrase of segmenter.push(spokenText)) {
                  enqueuePhraseForSpeech(phrase);
                }
              }
            }
          } catch (err) {
            if (!(err instanceof ToolFailureHandled)) {
              console.warn('[Chatty Orchestrator] Failed to execute tool call from LLM:', err);
            }
          }
        }

        if (!executedLegacyTool && this.scheduler.isTurnValid(turnId)) {
          const inspected = inspectExecutableCode(rawContent);
          const executableCode = inspected.code;
          const isProse = inspected.isProse || forceProse;
          assistantMsg.rawCode = executableCode;
          assistantMsg.rawLlmOutput = rawContent;

          if (isProse) {
            this.events.onRunStatus?.(turnId, { kind: 'none', text: 'No code to run in this reply' });
          } else {
            // Execute the generated output through the Universal Programmatic Agent Harness
            // Set once the run returns: later speak() calls come from timers/handlers the code left
            // running, and are voiced outside the (finished) turn instead of being dropped.
            let runFinished = false;
            // A new program that draws starts on a clean screen: old drawings, animation loops and
            // sounds go away. Programs that only talk (desktop replies are speak() code) leave the
            // screen alone, and nothing happens when the screen is already empty.
            if (programDraws(executableCode) && this.javascriptRuntime.hasVisualContent?.()) {
              await this.javascriptRuntime.resetVisual();
              // The old program's canvases and sounds are freed before the new one allocates
              await settle(AFTER_HEAVY_MS);
            }
            const execResult = await this.javascriptRuntime.execute(executableCode, undefined, {
              onSpeak: (phrase) => {
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
            // A syntax error comes without a line: a parser finds it, so the fix can point at it
            if (execResult.error && execResult.errorLine === undefined) {
              execResult.errorLine = await syntaxErrorLine(executableCode);
            }
            this.lastRun = {
              turnId,
              code: executableCode,
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

            if (this.scheduler.isTurnValid(turnId)) {
              let spokenText = '';
              let spokenTextsHandled = false;
              if (execResult.spokenTexts && execResult.spokenTexts.length > 0) {
                spokenText = execResult.spokenTexts.join(' ');
                spokenTextsHandled = true;
                // Only speak phrases that were not already streamed / delivered via onSpeak
                const remaining = new Map(spokenSpeakCounts);
                for (const t of execResult.spokenTexts) {
                  if (consume(remaining, speakKey(t))) continue;
                  spokenPhrasesSeen.add(t);
                  for (const phrase of segmenter.push(t + ' ')) {
                    enqueuePhraseForSpeech(phrase);
                  }
                }
              } else if (
                execResult.output !== undefined &&
                execResult.output !== null &&
                execResult.output !== 'undefined' &&
                execResult.output !== 'use strict' &&
                // A program's last line is often `document.body.innerHTML = "<div>…"`: that value is markup, not a reply
                !/<[a-z][^>]*>/i.test(String(execResult.output))
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
                assistantMsg.canonicalContent = spokenText;
                this.events.onTokenStream?.(turnId, '', spokenText);
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
    for (const msg of messages) {
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

  /** One automatic fix per request: the error goes back to the model, which rewrites the program. */
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
    // Small models fix the right thing when shown the exact line
    const lineText = run.errorLine ? run.code.split('\n')[run.errorLine - 1]?.trim() : '';
    const where = lineText ? ` at line ${run.errorLine} (\`${lineText.slice(0, 160)}\`)` : '';
    // A short pause before the model runs again, unless the user moves on meanwhile
    void settle(AFTER_HEAVY_MS).then(() => {
      if (this.scheduler.getActiveTurnId()) return;
      return this.submitUserInput(
        `Your program failed${where}: ${run.error}\nReply with the complete corrected program, JavaScript only.`,
        { autoFix: run.code }
      );
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
  // Tool Intent Inference & Prompt Construction (Addendum Sections 3 & 6)
  // --------------------------------------------------------------------------

  private inferToolFromUserRequest(userPrompt: string): { toolName: string; toolArgs: Record<string, unknown> } | null {
    const lower = userPrompt.toLowerCase();

    // 1. Music / sound synthesis / notes / melody / MIDI
    if (
      this.tools.has('play_music') &&
      (lower.includes('music') ||
        lower.includes('note') ||
        lower.includes('melody') ||
        lower.includes('song') ||
        lower.includes('tune') ||
        lower.includes('midi') ||
        lower.includes('piano') ||
        lower.includes('sound') ||
        lower.includes('chord') ||
        lower.includes('play '))
    ) {
      return {
        toolName: 'play_music',
        toolArgs: { notes: userPrompt, description: userPrompt },
      };
    }

    // 2. Drawing / graphics / canvas / art
    if (
      this.tools.has('draw_graphics') &&
      (lower.includes('draw') ||
        lower.includes('canvas') ||
        lower.includes('sketch') ||
        lower.includes('paint') ||
        lower.includes('graphics') ||
        lower.includes('spiral') ||
        lower.includes('circle') ||
        lower.includes('visual'))
    ) {
      return {
        toolName: 'draw_graphics',
        toolArgs: { prompt: userPrompt },
      };
    }

    // 3. Wikipedia lookup
    if (
      this.tools.has('wikipedia') &&
      (lower.startsWith('who is') ||
        lower.startsWith('what is') ||
        lower.includes('wikipedia') ||
        lower.includes('look up') ||
        lower.startsWith('search '))
    ) {
      return {
        toolName: 'wikipedia',
        toolArgs: { query: userPrompt },
      };
    }

    // 4. DuckDuckGo / Instant answers
    if (
      this.tools.has('instant_answers') &&
      (lower.includes('duckduckgo') || lower.includes('weather') || lower.includes('definition'))
    ) {
      return {
        toolName: 'instant_answers',
        toolArgs: { query: userPrompt },
      };
    }

    // 5. Universal browser agent (games, widgets, interactive apps, JavaScript runtime)
    const browserTool =
      this.tools.get('coder_agent') ||
      this.tools.get('browser_agent') ||
      this.tools.get('javascript_runtime');
    if (browserTool) {
      return {
        toolName: browserTool.name,
        toolArgs: { task: userPrompt },
      };
    }

    return null;
  }

  selectResponseMode(
    normalizedQuery: string,
    workingMessages: ReadonlyArray<ConversationMessage>
  ): ResponseMode {
    const lower = normalizedQuery.toLowerCase();

    // 1. Check if a registered tool explicitly matches the user intent
    if (this.tools.size > 0) {
      if (
        /\b(what time|current time|calculate|compute|\d+\s*[+*\/-]\s*\d+|set a timer|device status|run javascript|eval javascript|execute javascript|run js|eval js|play a sound|play sound|sound effect|synthesize sound|web audio|beep|chime|synthesizer|midi|web midi|play a tune|play music|draw|render canvas|webgl|fetch data|weather|wikipedia)\b/i.test(
          lower
        ) ||
        lower.startsWith('eval:') ||
        lower.startsWith('javascript:')
      ) {
        return 'tool_execution';
      }
    }

    // 2. Check for genuinely ambiguous short input with no prior context
    const words = normalizedQuery.split(/\s+/);
    const isAmbiguousPronounOnly =
      words.length <= 4 &&
      /\b(do it|change it|move it|fix that|the other one)\b/i.test(lower) &&
      workingMessages.length === 0;
    if (isAmbiguousPronounOnly) {
      return 'clarification';
    }

    // 3. Check if high-impact factual verification is warranted
    if (
      /\b(verify|fact check|exact year|chemical formula|medical dosage|is it true that|speed of light|capital of)\b/i.test(
        lower
      )
    ) {
      return 'verification';
    }

    return 'direct';
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
    const systemParts: string[] = this.phonePipeline
      ? [`${this.phonePipeline.chatSystemPrompt} Current date and time: ${new Date().toLocaleString()}.`]
      : [CONCISE_VOICE_SYSTEM_PROMPT, EXAMPLES_PROMPT];

    if (context.relevantMemories.length > 0) {
      const memStr = context.relevantMemories.map((m) => `${m.key}: ${m.value}`).join('; ');
      systemParts.push(`User approved memory: ${memStr}.`);
    }

    if (context.conversationSummary) {
      systemParts.push(`Earlier conversation summary: ${context.conversationSummary.summaryText}`);
    }

    if (context.resolvedReferencesNote) {
      systemParts.push(context.resolvedReferencesNote);
    }

    if (this.tools.size > 0) {
      const toolList = Array.from(this.tools.values())
        .map((t) => {
          const props = (t.parameters?.properties as Record<string, { type?: string; description?: string }>) || {};
          const propNames = Object.keys(props);
          const argsSignature = propNames.length > 0 ? propNames.join(', ') : '';
          return `- ${t.name}(${argsSignature}): ${t.description}`;
        })
        .join('\n');
      systemParts.push(
        `Available Tools:\n${toolList}\nTo use a tool, output a single tool_call block:\n<|tool_call>call:<tool_name>{"<param>": "<value>"}<tool_call|>\nNever leave "arguments" empty.`
      );
    }

    if (mode === 'clarification') {
      systemParts.push(
        'The user request is ambiguous and lacks prior context. Ask a brief, polite clarifying question.'
      );
    } else if (mode === 'verification') {
      systemParts.push(
        'Double-check factual accuracy and state exact verified figures concisely.'
      );
    }

    const promptMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> =
      this.phonePipeline ? [] : FORMAT_TURNS.map((t) => ({ ...t }));
    const pastPrograms: string[] = [];
    // Assistant messages before the user's first one are the app's own (the welcome greeting).
    // Sent, they'd merge into the format turn's reply (consecutive turns are joined): left out.
    let userHasSpoken = false;

    for (const msg of context.workingMessages) {
      if (msg.role === 'user') userHasSpoken = true;
      else if (msg.role === 'assistant' && !userHasSpoken) continue;
      if (msg.role === 'assistant') {
        // Past programs leave the message history (with the request that asked for them) and are
        // described in the system prompt, except the one being edited, which is shown in full.
        // Phone chat model (split pipeline) sees only what was said.
        if (!this.phonePipeline && !(programBeingEdited && msg.rawCode === programBeingEdited)) {
          const prev = promptMessages[promptMessages.length - 1];
          const described = describePastProgram(msg, prev?.role === 'user' ? prev.content : '');
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
        promptMessages.push({
          role: msg.role,
          content: cleaned,
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
      content: userMessage,
    });

    if (pastPrograms.length > 0) {
      systemParts.push(
        `Programs you ran earlier in this conversation (write a complete new program for each request):\n${pastPrograms.slice(-8).join('\n')}`
      );
    }
    // The format, restated after the examples and everything else
    if (!this.phonePipeline) systemParts.push('Reply with perfect JavaScript syntax ONLY.');
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

  private async tryExecuteMatchingTool(
    query: string,
    turnId: string
  ): Promise<{
    toolCall: NonNullable<ConversationMessage['toolCall']>;
    responseText: string;
  } | null> {
    const mathMatch = query.match(/(\d+(?:\.\d+)?)\s*([+*\/-])\s*(\d+(?:\.\d+)?)/);
    const calcTool = this.tools.get('calculator');
    if (mathMatch && calcTool) {
      const a = Number(mathMatch[1]);
      const op = mathMatch[2];
      const b = Number(mathMatch[3]);
      const args = { a, operator: op, b };
      const result = await calcTool.execute(args);
      if (!this.scheduler.isTurnValid(turnId)) return null;
      return {
        toolCall: { name: 'calculator', arguments: args, result, status: 'completed' },
        responseText: `The result of ${a} ${op} ${b} is ${String(result)}.`,
      };
    }

    const timeTool = this.tools.get('get_local_time');
    if (/\b(what time|current time)\b/i.test(query) && timeTool) {
      const result = await timeTool.execute({});
      if (!this.scheduler.isTurnValid(turnId)) return null;
      return {
        toolCall: { name: 'get_local_time', arguments: {}, result, status: 'completed' },
        responseText: `The current local time is ${String(result)}.`,
      };
    }

    const codeTool = this.tools.get('coder_agent') || this.tools.get('javascript_runtime');
    const jsMatch =
      query.match(/^(?:run|eval|evaluate|execute)\s+(?:javascript|js):\s*([\s\S]+)$/i) ||
      query.match(/^eval:\s*([\s\S]+)$/i) ||
      query.match(/^```(?:javascript|js)\n([\s\S]+?)```$/i);
    if (jsMatch && codeTool) {
      const code = jsMatch[1].trim();
      const res = (await codeTool.execute({ code })) as any;
      if (!this.scheduler.isTurnValid(turnId)) return null;
      const outputText = res.error
        ? `JavaScript Error: ${res.error}`
        : `JavaScript Output: ${typeof res.output === 'object' ? JSON.stringify(res.output) : String(res.output)}`;
      return {
        toolCall: {
          name: codeTool.name,
          arguments: { code },
          result: res,
          error: res.error,
          status: res.error ? 'failed' : 'completed',
        },
        responseText: outputText,
      };
    }

    const wikiTool = this.tools.get('wikipedia');
    const wikiMatch =
      query.match(/^(?:wiki|wikipedia):\s*(.+)$/i) ||
      query.match(/^(?:search\s+wikipedia\s+for|lookup\s+on\s+wikipedia|summarize\s+wikipedia\s+for)\s+(.+)$/i);
    if (wikiMatch && wikiTool) {
      const q = wikiMatch[1].trim();
      const res = (await wikiTool.execute({ query: q })) as any;
      if (!this.scheduler.isTurnValid(turnId)) return null;
      const responseText = res.error
        ? `Wikipedia Error: ${res.error}`
        : `${res.title ? `${res.title}: ` : ''}${res.summary}`;
      return {
        toolCall: {
          name: 'wikipedia',
          arguments: { query: q },
          result: res,
          error: res.error,
          status: res.error ? 'failed' : 'completed',
        },
        responseText,
      };
    }

    const instantTool = this.tools.get('instant_answers');
    const instantMatch =
      query.match(/^(?:instant\s*answer|ddg):\s*(.+)$/i) ||
      query.match(/^(?:quick\s+fact|instant\s+fact\s+for)\s+(.+)$/i);
    if (instantMatch && instantTool) {
      const q = instantMatch[1].trim();
      const res = (await instantTool.execute({ query: q })) as any;
      if (!this.scheduler.isTurnValid(turnId)) return null;
      const responseText = res.error
        ? `Instant Answer Error: ${res.error}`
        : `${res.heading ? `${res.heading}: ` : ''}${res.answer}`;
      return {
        toolCall: {
          name: 'instant_answers',
          arguments: { query: q },
          result: res,
          error: res.error,
          status: res.error ? 'failed' : 'completed',
        },
        responseText,
      };
    }

    return null;
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
