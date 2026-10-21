// ============================================================================
// First-Class Conversation Orchestrator (Addendum Sections 1-8)
// ============================================================================

import type {
  ConversationMessage,
  LlmGenerationOptions,
  ConversationSummary,
  InteractionState,
  LlmRuntimeProvider,
  PhraseSegment,
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
import { isTalkOnly, pastProgramResult, programDraws } from './history-format.ts';
import {
  isComplaint,
  isFollowUpEdit,
  runReadyTool,
  type LastAction,
  type ReadyToolOutcome,
  type TurnRouter,
} from './phone-pipeline.ts';
import {
  JavascriptRuntime,
  inspectExecutableCode,
  stripComments,
  syntaxErrorLine,
} from '../tools/javascript-runtime.ts';
import { appendRunLog } from './run-log.ts';
import { blankChoices, blankRequest, choiceRequest, declareMissing, fillBlank, findBlank, type Blank } from './blank-fix.ts';
import { applyFixReply, brokenLines, enclosingFunction, FIX_SYSTEM_PROMPT, fixRequest, restoreDeclarations } from './line-fix.ts';
import { dropBrowserCopies, dropHelperCopies, dropStrayQuote, fixAudioNodeProperties, fixIteratorResults, fixKeySlips, loopOneFrameAnimations, dropUnusedPackages, errorHint, fixCaseSlips, provideThree } from './error-hints.ts';
import { applyAssignmentFixes, renameMembers, unknownMemberError, unknownMembers, unusableAssignments } from './property-check.ts';
import { AFTER_HEAVY_MS, settle, settleOnIos } from './settle.ts';
import { LOCAL_CHAT_MODELS } from './settings.ts';
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
  // A block of lines written again and again in a row (the same few lines of code, a paragraph):
  // three times for a short block, twice for one of 8 lines or more (up to 40, two functions taking
  // turns), which ordinary code never repeats line for line
  const blockStart = Math.max(0, text.length - 8000);
  const done = text.slice(blockStart).split('\n').slice(0, -1); // the last line may still be arriving
  for (let k = 2; k <= 40; k++) {
    const copies = k >= 8 ? 2 : 3;
    if (done.length < k * copies) break;
    // Where the lines start repeating every k lines
    let p = done.length - k;
    while (p > 0 && done[p - 1] === done[p - 1 + k]) p--;
    if (done.length - p < k * copies) continue;
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
const SOUND_WORDS =
  String.raw`\b(?:music|songs?|sing(?:s|ing)?|sound|beats?|groove|drums?|pianos?|bass|guitars?|organ|violins?|trumpets?|sax(?:ophone)?|flutes?|chords?|melod(?:y|ies)|tunes?|midi|rhythm|jam|loop(?:ed)? (?:the )?(?:song|beat|music|melody)|tempo|bpm|beeps?|audio|instruments?|(?:in|key of) [a-g][#b]? (?:major|minor|pentatonic)|[a-g][#b]? (?:major|minor|pentatonic) (?:scales?|chords?|keys?|progressions?|arpeggios?)|(?:major|minor|pentatonic) scale|scale (?:in|of) [a-g])\b|requestMIDIAccess|AudioContext`;
/** (a bare "play" also asks for games and videos: it chooses the rule, but isn't a sound on its own) */
const SOUND_REQUEST = new RegExp(String.raw`\bplay(?:s|ing)?\b|${SOUND_WORDS}`, 'i');
const SOUND_WORDS_REQUEST = new RegExp(SOUND_WORDS, 'i');
const DRAWING_REQUEST =
  /\b(?:draw|paint|sketch|picture|image|art\b|animat|game|simulat|bounc|canvas|scene|shape|circle|square|triangle|stars?\b|sky|rainbow|landscape|pattern|fractal|particle|mov(?:e|ing)|getContext)/i;
const THREE_D_REQUEST = /(?:\b3d\b|\bthree[- ]?d\b|\bgames?\b|\brender|\bscene|\bcube|\bsphere|\bwebgl|\brotat|\bspin|\borbit|THREE\.)/i;
const DIAGRAM_REQUEST = /\b(?:svg|diagram|icon|chart|graph|logo|vector|flowchart|map)/i;
/** Things that must appear on screen: an app, a form, a to-do list, a timer */
const INTERFACE_THING =
  /\b(?:app|calculator|converter|form(?!\s+of\b)|button|input|slider|todo|to-do|timer|stopwatch|count ?down|clock|dashboard|widget|tracker|quiz|counter|picker|toggle|checklist|planner|calendar|scoreboard|editor|menu|interface|ui)s?\b/i;
/** What the interface rule is for: the things above, and the verbs that ask for something to look at */
const INTERFACE_REQUEST = new RegExp(`${INTERFACE_THING.source}|\\b(?:form|list|table|page|show|display)s?\\b`, 'i');
/** Anything shown on screen, which goes in the card (what the rules go by) */
const VISUAL_REQUEST = new RegExp([INTERFACE_REQUEST, DRAWING_REQUEST, THREE_D_REQUEST, DIAGRAM_REQUEST].map((r) => r.source).join('|'), 'i');
/** What must be on screen for the request to be done (what the outcome check goes by) */
const VISUAL_THING = new RegExp([INTERFACE_THING, DRAWING_REQUEST, THREE_D_REQUEST, DIAGRAM_REQUEST].map((r) => r.source).join('|'), 'i');
/** A question or a look-up: asked as one ("Who was…", "…?"), or a look-up named outright */
/** Arithmetic ("15 percent of 84", "3 times 4"): worked out, not looked up */
const MATH_REQUEST = /\d\s*(?:%|percent|times|plus|minus|divided|squared|\*|\+|\/|x\s*\d)|\b(?:sum|average|square root) of\b/i;
/** Asked as a question ("Who won the game", "Why is the sky blue") or a look-up named outright */
const QUESTION_WORDS =
  /^\s*(?:who|what|when|where|why|which|how (?:many|much|old|tall|far|big|long))\b|\b(?:tell me about|look up|search for|find out|define|meaning of|capital of|population of|weather|news|wiki(?:pedia)?)\b/i;
const FACTS_WORDS = new RegExp(`${QUESTION_WORDS.source}|\\?\\s*$`, 'i');
const FACTS_REQUEST = { test: (request: string) => FACTS_WORDS.test(request) && !MATH_REQUEST.test(request) };

/**
 * The rules, as bullets (small models copy numbering into their replies). A rule with `when` is
 * for some requests only: models with a small context (the smallest ones, on any device) get it
 * only when the request, or the program it changes, matches. Bigger models get every rule, the
 * same prompt each turn.
 */
const PROMPT_RULES: ReadonlyArray<{ text: string; when?: { test(request: string): boolean } }> = [
  { text: '- ONLY return executable JavaScript: a simple, elegant program that does what was asked (draw, build, play, compute, look up) with minimal code and complete functionality.' },
  { text: '- All messages to the user go through speak(text). Calculate all results using JavaScript logic and put them in its template string.' },
  { text: '- What you add to document.body appears in a card on screen.', when: VISUAL_REQUEST },
  { text: '- Use HTML and CSS for interfaces: buttons, forms, tables, dashboards and widgets.', when: INTERFACE_REQUEST },
  { text: '- Use <canvas> for visuals: drawings, art, animations, games and simulations. For motion, keep each thing\'s position and speed in variables, and move and redraw it in one requestAnimationFrame loop.', when: DRAWING_REQUEST },
  { text: '- For 3D, THREE (three.js) is ready to use: render with a THREE.WebGLRenderer, whose canvas you add to document.body.', when: THREE_D_REQUEST },
  { text: '- <svg> works for diagrams and icons.', when: DIAGRAM_REQUEST },
  { text: "- Sound: music and instruments play through Web MIDI. Get an output with const midi = await navigator.requestMIDIAccess() and const output = [...midi.outputs.values()][0]. Choose a General MIDI instrument for a channel with output.send([0xC0 + channel, program]) (0 piano, 19 organ, 24 guitar, 32 bass, 40 violin, 48 strings, 56 trumpet, 65 sax, 73 flute). Play a note with output.send([0x90 + channel, note, velocity], time) and end it with output.send([0x80 + channel, note, 0], time + length) (note 60 is middle C; times are performance.now() ms). Drums are channel 9: note 36 kick, 38 snare, 42 hi-hat. At the top, declare const bpm (beats per minute: 60 to 180), beat = 60000 / bpm (one beat in ms) and start = performance.now() + 100. To loop, put one pass of notes in a function that schedules them from a start time, call it, then call it again with setInterval every pass, moving the start time on by the pass length. Beeps, tones and sound effects use Web Audio (new AudioContext(), oscillators, gain, each connected to its destination).", when: SOUND_REQUEST },
  { text: '- Answer what you know directly. For facts you lack, fetch a public API that allows cross-origin requests, such as Wikipedia (https://en.wikipedia.org/api/rest_v1/page/summary/<title>), and speak a sentence or two of it.', when: FACTS_REQUEST },
];

/** The rules for a request: all of them, or (filter) only those it needs */
export function promptRules(request = '', filter = false): string {
  const rules = PROMPT_RULES.filter((rule) => !filter || !rule.when || rule.when.test(request));
  return [
    "You are an assistant that acts by writing JavaScript: your reply runs as one program in the user's browser.",
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
  { role: 'user', content: 'Hi!' },
  // Only speech: small models copied a drawn "Hi!" heading into every program
  { role: 'assistant', content: 'speak("Hi! What would you like me to make?");' },
];

/** What the example reply says (FORMAT_TURNS): a program that copies it into itself doesn't mean it */
const EXAMPLE_SPOKEN = FORMAT_TURNS.flatMap((t) => (t.role === 'assistant' ? [...t.content.matchAll(/speak\((["'`])(.*?)\1\)/g)].map((m) => m[2]) : []));

/**
 * Before a program runs: a speak() of the example reply's own words, in a program that does
 * something else too, is taken out (small models copy the example into their program)
 */
export function dropCopiedExample(code: string): { code: string; dropped: boolean } {
  const lines = code.split('\n');
  const copied = (line: string) => EXAMPLE_SPOKEN.some((text) => new RegExp(`^\\s*speak\\((["'\`])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\);?\\s*$`).test(line));
  const kept = lines.filter((line) => !copied(line));
  if (kept.length === lines.length || kept.join('').trim() === '') return { code, dropped: false };
  return { code: kept.join('\n'), dropped: true };
}

export const CONCISE_VOICE_SYSTEM_PROMPT = promptRules();

/** A line of a streaming reply that starts code: the reply isn't prose (shown and spoken as it comes) */
/** A line that builds a program (not talk, a fence or a comment): "Generating." is said for it */
const CODING_LINE = /^\s*(?:const|let|var|function|class|for|while|if|root\.|document\.|window\.|out\.send|setInterval|requestAnimationFrame)\b/m;
const STREAM_CODE_LINE = /^(?:const|let|var|function|class|import|MODE:|```|\/\/|\/\*|root\.|document\.|window\.)\b/m;
/** What the code panel shows of a streaming reply: the inside of its code fences, when it has any */
function codeView(text: string): string {
  if (!text.includes('```')) return text;
  return [...text.matchAll(/```[\w-]*[^\n]*\n([\s\S]*?)(?:```|$)/g)].map((m) => m[1]).join('\n');
}

/** Requests to make or do something: a reply that only talks hasn't done it */
const ACTION_REQUEST =
  /\b(?:play|draw|make|build|create|animate|code|program|design|generate|paint|sketch|render|chart|plot|graph|count ?down|timer|stopwatch|calculator|converter|simulate|game|app)\b/i;
/**
 * What the outcome check is for: a request to make or show something, not a question or a phrase
 * that names one ("who won the game", "speed of sound", "nearest star"), which a spoken answer
 * completes. "Can you draw a cat?" and "draw a 3x3 grid" are requests.
 */
const asksForOutcome = (request: string) =>
  (ACTION_REQUEST.test(request) || /\b(?:show|display)\b/i.test(request)) && !QUESTION_WORDS.test(request);
/** Goes with the retry only (not into history) */

/** How many times the model may try to fix one request's program */
/**
 * The most replies the model gets to fix one request: each is a try, whether it asks a new
 * question (the line, the whole function, the blank) or the same one again sampled differently
 */
const MAX_FIX_TRIES = 5;
/**
 * A line fix whose reply is unchanged or unusable is asked for again at once (this many times,
 * sampled differently) within the same try: a one-line reply is quick, so it costs no try of its
 * own. Every other kind is asked once per try, and each try asks a new question (see fixSampling).
 */
const LINE_FIX_REASKS = 2;
/**
 * The questions a fix can ask, in the order each try takes the next one that fits: the blank
 * (fill in the failing expression), the marked line, the whole function, the whole program, and
 * the line once more, told the replies that didn't work. A large model starts with the line.
 */
type FixKind = 'blank' | 'line' | 'function' | 'program' | 'different';
const FIX_ORDER_SMALL: ReadonlyArray<FixKind> = ['blank', 'line', 'function', 'program', 'different'];
const FIX_ORDER_LARGE: ReadonlyArray<FixKind> = ['line', 'function', 'blank', 'program', 'different'];
/** The progress note a try adds to the chat */
const fixNote = (n: number, text: string) => `Fixing (${n} of ${MAX_FIX_TRIES}): ${text}`;

/**
 * How each fix attempt samples. Neighbouring attempts sit far apart (cool and greedy, then wide,
 * then cool and narrow, then hot, then in between), so a model that gives one prompt the same
 * reply every time gives a really different one next: small steps barely changed the reply.
 */
export const SAMPLING_SWINGS: ReadonlyArray<{ temperature: number; topP: number }> = [
  { temperature: 0.2, topP: 0.9 },
  { temperature: 1, topP: 0.99 },
  { temperature: 0.5, topP: 0.6 },
  { temperature: 1.3, topP: 0.95 },
  { temperature: 0.8, topP: 0.75 },
];

/** Above this, small models write gibberish (mixed scripts, no code), and WebLLM's grammars break */
const SMALL_MODEL_MAX_TEMPERATURE = 1;

/**
 * A swing as the model can take it: on WebLLM (every model but Gemma 4 on LiteRT) temperatures are
 * scaled down so the hottest is SMALL_MODEL_MAX_TEMPERATURE: small models write gibberish above it,
 * and WebLLM's grammars break there (WEBLLM_MAX_TEMPERATURE). Every try still samples differently.
 */
export function forModel(sampling: { temperature: number; topP: number }, modelId: string): { temperature: number; topP: number } {
  if (/^gemma-4/i.test(modelId)) return sampling;
  const hottest = Math.max(...SAMPLING_SWINGS.map((s) => s.temperature));
  const scale = Math.min(1, SMALL_MODEL_MAX_TEMPERATURE / hottest);
  return { ...sampling, temperature: Math.round(sampling.temperature * scale * 100) / 100 };
}

/** Attempt 1 takes the runtime's near-greedy decoding (exact); each later one its swing */
export function fixSampling(attempt: number): { temperature: number; topP: number } | undefined {
  if (attempt <= 1) return undefined;
  return SAMPLING_SWINGS[(attempt - 1) % SAMPLING_SWINGS.length];
}

/**
 * The swing farthest from the one just used, among those not used yet in this attempt, so the
 * last re-ask doesn't land near the replies that already failed
 */
export function contrastSampling(
  previous: { temperature: number; topP: number },
  used: ReadonlyArray<{ temperature: number; topP: number }> = []
): { temperature: number; topP: number } {
  const distance = (s: { temperature: number; topP: number }) => Math.abs(s.temperature - previous.temperature) + Math.abs(s.topP - previous.topP);
  const fresh = SAMPLING_SWINGS.filter((s) => !used.some((u) => u.temperature === s.temperature && u.topP === s.topP));
  return [...(fresh.length ? fresh : SAMPLING_SWINGS)].sort((a, b) => distance(b) - distance(a))[0];
}

/** The sampling of re-ask number `extra` within one fix attempt: the swings after the attempt's own */
export function reaskSampling(attempt: number, extra: number): { temperature: number; topP: number } {
  return SAMPLING_SWINGS[(Math.max(attempt, 1) - 1 + extra) % SAMPLING_SWINGS.length];
}

/** The blank stage's system prompt: one small answer, in the shape the request names */
const BLANK_SYSTEM_PROMPT = [
  "You complete one blank in a JavaScript program that runs in the user's browser.",
  'Reply with only what the request asks for: one JavaScript expression on one line, or the single letter of the expression chosen.',
].join('\n');

/** The most candidate expressions the blank stage tries in test runs for one attempt */
const MAX_BLANK_CANDIDATES = 6;

/** The index a multiple-choice reply picks: its first letter A, B, … within the choices, or -1 */
export function chosenIndex(reply: string, count: number): number {
  // A lone letter, or one that ends the reply or is followed by "." / ")" ("B", "B.", "(B)", "The answer is B")
  const m = /^\(?([A-Z])(?:[.):]|$)/.exec(reply.trim()) ?? /(?:^|[^A-Za-z])([A-Z])[.)]?\s*$/.exec(reply.trim());
  const i = m ? m[1].charCodeAt(0) - 65 : -1;
  return i >= 0 && i < count ? i : -1;
}

/** The expression in a reply: its first line that is not blank, a comment or a code fence, without the closing semicolon */
export function firstExpression(reply: string): string | null {
  for (const raw of reply.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('```') || line.startsWith('//')) continue;
    const expr = line.replace(/^`+|`+$/g, '').replace(/;+$/, '').trim();
    return expr || null;
  }
  return null;
}

/** How many times a fix attempt asks again, at warmer sampling, when its reply is unusable */

/** The lines a fix reply changed in the program (those the original lacks), compact and short */
export function changedLines(original: string, program: string, max = 100): string {
  const had = new Set(original.split('\n').map((l) => l.trim()));
  const changed = program.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//') && !had.has(l));
  return changed.join(' ').slice(0, max);
}

/** An error message as one key: the same error with other line numbers or values is the same */
export function normalizedError(error: string): string {
  return error.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 120);
}

type FixError = { attempt: number; error: string; line?: number };

/**
 * Why a fix can't be used, or null: it lost the program (became chat or a bare speak(), stopped
 * drawing what the program drew, or dropped the function it was asked for), changed nothing (edits
 * that matched nothing would only repeat the error), or came back cut off (doesn't parse)
 */
async function unusableFix(
  original: string,
  fixedProgram: string,
  code: string,
  functionName?: string
): Promise<'lost' | 'unchanged' | 'incomplete' | null> {
  const dropped = !!functionName && !new RegExp(`\\bfunction\\s+${functionName.replace(/\$/g, '\\$')}(?![\\w$])`).test(code);
  // Judged without its comments: a reply of only comments (`// Solution: append a <div>…`) is no program
  const program = stripComments(code).trim();
  if (!program || isTalkOnly(program) || (programDraws(original) && !programDraws(program)) || dropped) return 'lost';
  if (stripComments(fixedProgram).replace(/\s+/g, '') === stripComments(original).replace(/\s+/g, '')) return 'unchanged';
  if ((await syntaxErrorLine(code)) !== undefined) return 'incomplete';
  return null;
}

/**
 * How long a fix reply may be: about twice what it replaces, plus room for its Cause line (a
 * small model can otherwise ramble or repeat until the output limit, a minute on a phone)
 */
export function fixReplyTokens(program: string, line: number | undefined, block: { start: number; end: number } | undefined, max: number): number {
  const lines = program.split('\n');
  const replaced = block ? lines.slice(block.start - 1, block.end).join('\n') : line ? (lines[line - 1] ?? '') : program;
  // About 3 characters a token for code
  return Math.min(max, Math.max(160, Math.round((replaced.length / 3) * 2) + 120));
}

/**
 * The browser calls that put something on the page (or draw on it): a program that showed nothing
 * and has none of them has nothing a fix could correct
 */
const ADDS_TO_PAGE =
  /\b(?:appendChild|append|prepend|insertAdjacent(?:HTML|Element|Text)|replaceChildren|replaceWith|innerHTML|outerHTML|textContent|innerText|getContext|THREE)\b|document\.write|\broot\b/;

/** A reply that left nothing to run */
const NO_PROGRAM = 'The reply had no program in it';
/** The program a fix turn starts from when there was none (a fix turn is known by its program) */
const NO_PROGRAM_YET = '// (no program yet)';

const UNUSABLE_WHY = {
  lost: 'The fix lost the program',
  unchanged: "The fix didn't change the program",
  incomplete: 'The fix came back incomplete',
  repeated: 'The fix failed the same way in a test run',
};

/** The pause between test runs, so hidden iframes are not created back to back */
const TRIAL_GAP_MS = 150;

/** WebLLM models from this download size up (about 1.5B parameters) follow a line fix well */
const LINE_FIX_MIN_BYTES = 850_000_000;

/**
 * Whether the model is large enough to be asked for the line or function fix first (the blank
 * stage follows only if that fails): the Gemma 4 models, and WebLLM models of about 1.5B
 * parameters or more. Smaller models keep the blank stage first, a smaller question.
 */
export function prefersLineFix(modelId: string): boolean {
  if (/^gemma-4/i.test(modelId)) return true;
  const model = LOCAL_CHAT_MODELS.find((m) => m.id === modelId);
  return !!model && !model.phone && model.sizeBytes >= LINE_FIX_MIN_BYTES;
}

/** The run status once every fix try has failed (the page clears the card on it) */
export const GAVE_UP_STATUS = `(gave up after ${MAX_FIX_TRIES} tries)`;
/** The run note for a fresh ask after a talk-only reply: not a fix */
export const GENERATING_NOTE = 'Generating…';

/** What Chatty says when the last fix attempt failed too */
function gaveUpText(error: string): string {
  const short = error.length > 80 ? `${error.slice(0, 77)}…` : error;
  return `I couldn't get this working after ${MAX_FIX_TRIES} tries (the last error: ${short}). You could ask again in other words, or choose a larger model in Settings.`;
}

/** Whether an error is about the candidate itself (`Cannot access 'notes' before …` for `notes`) */
function namesCandidate(error: string, expr: string): boolean {
  const name = /^[A-Za-z_$][\w$]*$/.test(expr.trim()) ? expr.trim() : null;
  return !!name && new RegExp(`['"\\s(]${name.replace(/\$/g, '\\$')}['"\\s).]`).test(` ${error} `);
}

/** A run's error history with its own error added */
function withError(run: { errorHistory?: FixError[]; error: string | null; errorLine?: number; fixAttempt?: number }): FixError[] {
  const history = run.errorHistory ?? [];
  return run.error ? [...history, { attempt: run.fixAttempt ?? 0, error: run.error, line: run.errorLine }] : history;
}

/** Earlier attempts' errors that differ from the current one, labeled, for the next fix request */
export function earlierErrors(history: FixError[] | undefined, current: string): string | undefined {
  const seen = new Set([current]);
  const lines: string[] = [];
  for (const h of history ?? []) {
    if (seen.has(h.error)) continue;
    seen.add(h.error);
    const label = h.attempt === 0 ? 'The first program' : `Fix ${h.attempt}`;
    lines.push(`${label} failed${h.line ? ` at line ${h.line}` : ''}: ${h.error}`);
  }
  return lines.length ? `Earlier attempts failed differently. ${lines.join(' ')}` : undefined;
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
  /** Aborts the blank stage's model calls when the user starts a new turn (see blankStage) */
  private blankAbort: AbortController | null = null;
  /** Requests (by original turn) whose blank stage has run: a large model gets it once, after its line fix fails */
  /** The questions each request's fixes have asked (by requestKey) */
  private fixKindsUsed = new Map<string, Set<FixKind>>();
  /** Fix replies that were not used, by request: the last question lists them */
  private failedReplies = new Map<string, string[]>();
  /** Requests (by original turn) that Chatty has given up on: nothing is corrected or fixed after that */
  private gaveUp = new Set<string>();
  /** When the last test run ended, to pause between them */
  private lastTrialEnd = 0;
  private lastRun: {
    turnId: string;
    code: string;
    /** What the user asked for, so a fix request can lead with it (see fixRequest) */
    task: string;
    isAutoFix: boolean;
    fixRequested: boolean;
    error: string | null;
    errorLine?: number;
    /** Slips already corrected without the model in this program (see runCorrected) */
    corrections?: number;
    /** Which model fix this program came from (0: the reply to the request itself) */
    fixAttempt?: number;
    /** The request's own turn, which every fix of it stands for */
    originalTurnId?: string;
    /** Errors of the programs before this one for the same request, oldest first */
    errorHistory?: FixError[];
  } | null = null;
  /** The system prompt last written to the run log, so it is logged only when it changes */
  private loggedSystemPrompt: { chat: string; text: string } | null = null;
  /** Programs whose slips were corrected and re-run, by turn: they stand for the turn's program in later prompts */
  private correctedPrograms = new Map<string, string>();
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
        fromProgram: this.activeAssistantMessage.fromProgram,
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
      /** A fix for the whole function around the failing line, or for lines that don't parse (see askFix) */
      fixBlock?: { start: number; end: number; name?: string };
      /** The whole program is asked for (no marked line) */
      fixWhole?: boolean;
      /** Which fix attempt this turn is (1 to MAX_FIX_TRIES) */
      fixAttempt?: number;
      /** Errors of the earlier programs for this request (see earlierErrors) */
      errorHistory?: FixError[];
      /** The program asked for after a reply that only talked: not one of the tries, no note */
      freeRetry?: boolean;
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
    this.blankAbort?.abort(); // a blank stage still asking the model gives way to the new turn
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
      // (the summary's generation and the reply's don't follow each other at once on iPhone)
      await settleOnIos(AFTER_HEAVY_MS);
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
      ...(options?.autoFix
        ? { autoFix: true, ...(options.freeRetry ? {} : { fixNotice: fixNote(options.fixAttempt ?? 1, this.lastRun?.error ?? 'the error') }) }
        : {}),
      timestamp: Date.now(),
    };

    // Editing the last program ("make it bigger")? Then the model needs that program's code;
    // otherwise past programs appear only as one-line summaries.
    const lastAction = this.getLastAction(conversationId);
    // "It didn't work" is about that program too: it goes in full, with a note saying so
    const complaint = !options?.autoFix && lastAction?.kind === 'code' && isComplaint(normalized);
    const programBeingEdited =
      options?.autoFix ??
      (lastAction?.kind === 'code' && (isFollowUpEdit(normalized) || complaint) ? lastAction.code : null);
    // Stage 2: Resolve context BEFORE adding current message so history is clean
    // (A fix turn sends no history, memories or references: nothing to resolve)
    const resolvedContext: ReturnType<ConversationMemoryStore['resolveContextForQuery']> = options?.autoFix
      ? { workingMessages: [], conversationSummary: null, relevantMemories: [], resolvedReferencesNote: null, estimatedTokens: 0 }
      : this.memoryStore.resolveContextForQuery(
          normalized,
          Math.floor(this.memoryStore.usablePromptTokens(this.llmProvider.contextLimit) * this.compactionThreshold),
          // The program shown in full counts against the budget (older history gives way to it)
          programBeingEdited ? this.memoryStore.estimateTokens(programBeingEdited) : 0
        );

    // Commit user message to working memory
    this.memoryStore.addMessage(userMsg);
    this.events.onMessageCreated?.(userMsg);


    // Stage 3: Build the prompt respecting model context budget
    let { systemPrompt, promptMessages } = this.buildModelPrompt(
      normalized,
      resolvedContext,
      programBeingEdited,
      complaint
    );
    // A fix turn is its own job: a short prompt about fixing and only the fix request (the
    // rules, examples and history are for writing programs, and small models rewrote the
    // program they saw there, bug and all). The turn whose program it fixes:
    const fixedTurnId = options?.autoFix ? (this.lastRun?.originalTurnId ?? this.lastRun?.turnId) : undefined;
    // The line the fix request marked, where the corrected line goes back
    // (none for a whole-program fix: the reply is the program)
    const fixLine = options?.autoFix && (!options.fixWhole || options.fixBlock) ? (options.fixBlock?.start ?? this.lastRun?.errorLine) : undefined;
    if (options?.autoFix === NO_PROGRAM_YET) {
      // Nothing to fix: the program is written new, with the writing prompt, and only this request
      promptMessages = [{ role: 'user', content: normalized }];
    } else if (options?.autoFix) {
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
      // What the program being written is for (remembered for follow-up edits); a fix's program
      // is still for the original request, not for the fix request
      let codeTask = options?.autoFix ? (this.lastRun?.task ?? normalized) : normalized;

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
        let announcedCoding = false;

        const generateReply = (messages: typeof promptMessages, retry = 0, reask?: { temperature: number; topP: number }) => withActivity('generating a reply', () => generationProvider.generate({
          turnId,
          systemPrompt,
          messages,
          temperature: 0.1,
          maxOutputTokens: options?.autoFix && options.autoFix !== NO_PROGRAM_YET
            ? fixReplyTokens(options.autoFix, fixLine, options.fixBlock, generationProvider.maxOutputTokens)
            : generationProvider.maxOutputTokens,
          // A first fix wants the one most likely line; each later attempt samples differently
          ...(options?.autoFix
            ? reask
              ? { sampling: forModel(reask, generationProvider.modelId) }
              : fixSampling(options.fixAttempt ?? 1)
                ? { sampling: forModel(fixSampling(options.fixAttempt ?? 1)!, generationProvider.modelId) }
                : options.autoFix === NO_PROGRAM_YET
                  ? {} // a new program: the normal temperature, as for any request
                  : { exact: true }
            : {}),
          // (a new program, asked for when there was none, is held to no fix shape)
          ...(options?.autoFix && options.autoFix !== NO_PROGRAM_YET
            ? { fixShape: options.fixBlock ? ('function' as const) : fixLine ? ('line' as const) : ('program' as const) }
            : {}),
          ...(retry > 0 ? { retry } : {}),
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
            // The code panel shows only code: the fenced part once a fence starts. A fix's reply
            // shows there too while it comes (a slow fix would look stalled otherwise); the program
            // comes back if the fix isn't used
            this.events.onRawOutput?.(turnId, codeView(currentFull));
            // A reply that turns out to be a program (more than talk) says so once: a note in the
            // chat, and aloud in speech mode
            if (!announcedCoding && !options?.autoFix && (CODING_LINE.test(currentFull) || STREAM_MARKUP.test(currentFull))) {
              announcedCoding = true;
              this.addFixNote(GENERATING_NOTE, turnId);
              void this.speakOutOfTurn('Generating.');
            }

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

        // What goes to the model: which model, the conversation's length, the request as sent (with
        // its notes) and the system prompt whenever it differs from the one last logged
        {
          const chat = this.getConversationId?.() ?? '';
          const systemChanged = this.loggedSystemPrompt?.chat !== chat || this.loggedSystemPrompt.text !== systemPrompt;
          if (systemChanged) this.loggedSystemPrompt = { chat, text: systemPrompt };
          const last = promptMessages[promptMessages.length - 1];
          appendRunLog(
            'sent',
            [
              `model ${generationProvider.modelId}${options?.autoFix ? ' (fix turn)' : ''}, ${promptMessages.length} messages`,
              ...(systemChanged ? ['system prompt:', systemPrompt] : ['system prompt: same as before']),
              `last message (${last?.role ?? 'none'}):`,
              last?.content ?? '',
            ].join('\n')
          );
        }
        let genResult = await generateReply(promptMessages);
        // A request to make something that got only talk back goes to the chat as it is (it may be a
        // question); after it runs, a statement is followed by a request for the program (askFix)

        // A fix reply that is unchanged, lost or incomplete is asked for again at once, warmer: a
        // one-line reply takes about 2 seconds, so a whole attempt is not spent on it
        // A reply that passes is test-run once (hidden): one that fails the way the program did
        // has made no progress, and is not run for real either
        let repeatedTrial = false;
        // Replies asked for again in this turn: each is a try of its own
        let reasksDone = 0;
        if (options?.autoFix) {
          const original = options.autoFix;
          const failedError = this.lastRun?.error ?? null;
          const unusableWhy = async (raw: string): Promise<string | undefined> => {
            repeatedTrial = false;
            const applied = applyFixReply(original, raw, fixLine, options.fixBlock?.end);
            // (judged as it would run: a whole program with the declarations it dropped put back)
            const program = options.fixWhole ? restoreDeclarations(original, applied).code : applied;
            const code = inspectExecutableCode(program).code.trim();
            const problem = await unusableFix(original, program, code, options.fixBlock?.name);
            if (problem) return UNUSABLE_WHY[problem];
            if (failedError && typeof this.javascriptRuntime.trialRun === 'function') {
              // (the reply's generation and the hidden test run don't follow each other at once on iPhone)
              await settleOnIos(AFTER_HEAVY_MS);
              const trial = await this.trial(code);
              appendRunLog('retry', `a test run of the fix gave ${trial.error ? errorText(trial.error, trial.errorLine) : 'no error'}`);
              if (trial.error === failedError) {
                repeatedTrial = true;
                return UNUSABLE_WHY.repeated;
              }
            }
            return undefined;
          };
          // The same question again (line fixes only, within the same try), the last sampled far
          // from the one before
          const reasks = options.fixWhole || options.fixBlock ? 0 : LINE_FIX_REASKS;
          let lastSampling = fixSampling(options.fixAttempt ?? 1) ?? SAMPLING_SWINGS[0];
          const usedSamplings = [lastSampling];
          // The last reply is judged too (it is not asked for again)
          for (let extra = 0; extra <= reasks; extra++) {
            if (!this.scheduler.isTurnValid(turnId) || signal.aborted || (genResult.aborted && !stoppedRepeating)) break;
            const why = await unusableWhy(rawAccumulatedTokens || assistantMsg.canonicalContent || genResult.text);
            if (!why || extra === reasks) break;
            const sampling = extra + 1 === reasks ? contrastSampling(lastSampling, usedSamplings) : reaskSampling(options.fixAttempt ?? 1, extra + 1);
            lastSampling = sampling;
            usedSamplings.push(sampling);
            appendRunLog('discarded', `// ${why}, so it was asked for again. The model replied:\n${rawAccumulatedTokens || genResult.text}`);
            reasksDone++;
            appendRunLog('retry', `${why.toLowerCase()}: asked again at temperature ${sampling.temperature}, top-p ${sampling.topP} (try ${options.fixAttempt ?? 1} of ${MAX_FIX_TRIES}, ask ${reasksDone + 1} of ${reasks + 1})`);
            // One chat note per try: a re-ask within the try is in the run log only
            rawAccumulatedTokens = '';
            assistantMsg.canonicalContent = '';
            lastSpokenTextEmitted = '';
            processedSpeakMatches = 0;
            streamMode = forceProse ? 'prose' : 'unknown';
            stoppedRepeating = false;
            repeatCheckedAt = 0;
            generationAbort = new AbortController();
            genResult = await generateReply(promptMessages, 0, sampling);
          }
        }

        if (generationProvider !== this.llmProvider) this.events.onStatusChange?.(null);

        signal.removeEventListener('abort', abortGeneration);
        // Discard stale results if turn was canceled during generation
        if (!this.scheduler.isTurnValid(turnId) || (genResult.aborted && !stoppedRepeating)) {
          // Stopped while the model wrote: what it had written goes in the run log, and the status
          // line (with its log and copy buttons) says so
          const partial = rawAccumulatedTokens || genResult.text;
          appendRunLog('discarded', `// Stopped before the reply was finished, so nothing ran. The model had written:\n${partial || '(nothing yet)'}`);
          this.events.onRunStatus?.(turnId, { kind: 'none', text: 'Stopped before the program was finished' });
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
          let fixedProgram = options?.autoFix ? applyFixReply(options.autoFix, rawContent, fixLine, options.fixBlock?.end) : rawContent;
          // A whole program that dropped declarations it still uses gets them back (line-fix.ts)
          if (options?.autoFix && options.fixWhole) {
            const kept = restoreDeclarations(options.autoFix, fixedProgram);
            if (kept.restored.length) {
              fixedProgram = kept.code;
              appendRunLog('imagined', `the fix dropped ${kept.restored.join(', ')} → kept from the program: corrected before running`);
            }
          }
          if (fixedProgram !== rawContent && !options?.autoFix) this.events.onRawOutput?.(turnId, fixedProgram);
          // (a fix reply cut off is judged incomplete instead: closing it could cut its program short;
          // a new program asked for when there was none is closed like any first reply)
          const inspected = inspectExecutableCode(fixedProgram, {
            closeCutOff: !options?.autoFix || options.autoFix === NO_PROGRAM_YET,
            // (a fix says what the program it fixes said)
            speakComment: !options?.autoFix || options.autoFix === NO_PROGRAM_YET,
          });
          if (inspected.spokeComment) appendRunLog('imagined', `its closing comment → speak(${JSON.stringify(inspected.spokeComment.slice(0, 80))}): corrected before running`);
          if (inspected.called?.length) appendRunLog('imagined', `${inspected.called.map((n) => `${n}()`).join(', ')} declared but never called → called at the end: corrected before running`);
          if (inspected.exposed?.length) appendRunLog('imagined', `${inspected.exposed.map((n) => `${n}()`).join(', ')} made reachable from the page's inline handlers: corrected before running`);
          if (inspected.cutOff) {
            const { dropped, closed } = inspected.cutOff;
            appendRunLog('imagined', `the reply was cut off: ${dropped ? `its unfinished last ${dropped === 1 ? 'line' : `${dropped} lines`} removed and ` : ''}${closed} open block${closed === 1 ? '' : 's'} closed: corrected before running`);
          }
          // Comments go before it runs (and before it enters the history); a fix's program
          // already came without them
          // Trimmed like the runtime trims it, so error lines match the program kept here
          let executableCode = (options?.autoFix ? inspected.code : stripComments(inspected.code)).trim();
          // First, lines that go (so the line numbers below match the program that runs).
          // Its own speak()/out/clear: taken out so the real helpers are used (error-hints.ts)
          if (!inspected.isProse) {
            const copies = dropHelperCopies(executableCode);
            if (copies.dropped.length > 0 || copies.renamed.length > 0 || copies.kept.length > 0) {
              executableCode = copies.code;
              for (const name of copies.dropped) appendRunLog('imagined', `its own ${name} → the ready-made one: corrected before running`);
              // Its own speak() holding the whole program: renamed, the real speak() kept for what it says
              for (const rename of copies.renamed) appendRunLog('imagined', `its own ${rename}() (it held the program): corrected before running`);
              // Its own clear(), root, out that does something of its own: kept under another name
              for (const rename of copies.kept) appendRunLog('imagined', `its own ${rename} (a helper's name, kept as the program's): corrected before running`);
            }
            // The example reply's own words, copied in: taken out
            const example = dropCopiedExample(executableCode);
            if (example.dropped) {
              executableCode = example.code;
              appendRunLog('imagined', "the example reply's speak() copied into the program → taken out: corrected before running");
            }
            // Its own requestAnimationFrame(), setTimeout() …: taken out, so the browser's runs
            const browserCopies = dropBrowserCopies(executableCode);
            if (browserCopies.dropped.length > 0) {
              executableCode = browserCopies.code;
              for (const name of browserCopies.dropped) appendRunLog('imagined', `its own ${name}() → the browser's: corrected before running`);
            }
            // A stray quote or backtick ending a line (markdown's, kept): removed when that alone
            // makes the program parse
            const stray = dropStrayQuote(executableCode);
            if (stray) {
              executableCode = stray.code;
              appendRunLog('imagined', `a stray quote at the end of line ${stray.line} → removed: corrected before running`);
            }
            // three.js imports: THREE is provided
            const three = provideThree(executableCode);
            if (three.changed) {
              executableCode = three.code;
              appendRunLog('imagined', "import from 'three' → the ready-made THREE: corrected before running");
            }
            // Packages the browser doesn't have, loaded and never used: taken out
            const packages = dropUnusedPackages(executableCode);
            if (packages.dropped.length > 0) {
              executableCode = packages.code;
              for (const from of packages.dropped) appendRunLog('imagined', `unused package '${from}' → removed: corrected before running`);
            }
          }
          // Members its objects don't have (ctx.fillstyle, style.backgroundColour): a sure slip is
          // corrected now; anything else is reported after the run as its error (property-check.ts)
          const unknown = inspected.isProse ? [] : unknownMembers(executableCode);
          const slips = unknown.filter((issue) => issue.slip);
          if (slips.length > 0) {
            executableCode = renameMembers(executableCode, slips.map((issue) => ({ object: issue.object, from: issue.member, to: issue.slip! })));
            for (const issue of slips) appendRunLog('imagined', `${issue.object}.${issue.member} → ${issue.object}.${issue.slip}: corrected before running`);
          }
          const notThere: Array<{ line: number; error: string }> = unknown
            .filter((issue) => !issue.slip)
            .map((issue) => ({ line: issue.line, error: unknownMemberError(issue) }));
          if (!inspected.isProse) {
            // Writes to read-only properties and invalid style values (property-check.ts): a sure
            // answer is corrected, the rest reported after the run
            const unusable = unusableAssignments(executableCode);
            if (unusable.some((issue) => issue.fix)) {
              executableCode = applyAssignmentFixes(executableCode, unusable);
              for (const issue of unusable) if (issue.fix) appendRunLog('imagined', `${issue.fix.note}: corrected before running`);
            }
            for (const issue of unusable) if (!issue.fix) notThere.push({ line: issue.line, error: issue.message });
            // A name in the wrong letter case (mycount for myCount): the declared one
            const cased = fixCaseSlips(executableCode);
            if (cased.fixed.length > 0) {
              executableCode = cased.code;
              for (const { from, to } of cased.fixed) appendRunLog('imagined', `${from} → ${to}: corrected before running`);
            }
            // A key its own object literal doesn't have, one slip from one it does (sounds.drum for drums)
            const keys = fixKeySlips(executableCode);
            if (keys.fixed.length > 0) {
              executableCode = keys.code;
              for (const { object, from, to } of keys.fixed) appendRunLog('imagined', `${object}.${from} → ${object}.${to} (the key it has): corrected before running`);
            }
            // An iterator's result kept instead of its item (outputs.values().next()): its value
            const iterated = fixIteratorResults(executableCode);
            if (iterated.fixed.length > 0) {
              executableCode = iterated.code;
              for (const name of iterated.fixed) appendRunLog('imagined', `${name} = ….next() is { value, done } → ….next().value: corrected before running`);
            }
            // An audio node read as a property of an AudioContext: the create…() that makes it
            const nodes = fixAudioNodeProperties(executableCode);
            if (nodes.fixed.length > 0) {
              executableCode = nodes.code;
              for (const change of nodes.fixed) appendRunLog('imagined', `audio context ${change}: corrected before running`);
            }
            // An animation that moves things but asks for one frame only: it asks for the next too
            const frames = loopOneFrameAnimations(executableCode);
            if (frames.looped.length > 0) {
              executableCode = frames.code;
              for (const issue of notThere) issue.line += frames.atLines.filter((at) => at < issue.line).length;
              for (const name of frames.looped) appendRunLog('imagined', `${name}() moved things for one frame only → it asks for the next frame: corrected before running`);
            }
            // A drawing context, canvas or audio context it uses but never made: made at its top
            const missing = declareMissing(executableCode);
            if (missing.declared.length > 0) {
              executableCode = missing.code;
              // (its lines moved down by the declarations put at its top)
              for (const issue of notThere) issue.line += missing.declared.length;
              for (const { name, make } of missing.declared) appendRunLog('imagined', `${name} was never made → const ${name} = ${make}: corrected before running`);
            }
          }
          const isProse = inspected.isProse || forceProse;
          assistantMsg.rawCode = executableCode;
          assistantMsg.rawLlmOutput = rawContent;

          // A fix that came back as chat or a bare speak(), or that no longer draws what the program
          // drew, has lost the program. Nothing runs and nothing is said or shown; the original
          // stays the current program (lastRun, lastAction) and the status says why.
          const originalCode = options?.autoFix;
          const problem = originalCode
            ? ((await unusableFix(originalCode, fixedProgram, executableCode, options?.fixBlock?.name)) ?? (repeatedTrial ? ('repeated' as const) : null))
            : null;
          const lostProgram = problem === 'lost';
          const unchangedProgram = problem === 'unchanged';
          const incompleteProgram = problem === 'incomplete';
          const repeatedProgram = problem === 'repeated';

          if (lostProgram || unchangedProgram || incompleteProgram || repeatedProgram) {
            if (options?.autoFix) this.finishFixLog(lostProgram ? 'lost' : unchangedProgram || repeatedProgram ? 'unchanged' : 'incomplete');
            if (options?.autoFix && options.autoFix !== NO_PROGRAM_YET) this.events.onRawOutput?.(turnId, options.autoFix);
            const failed = this.lastRun;
            const why = UNUSABLE_WHY[problem!];
            appendRunLog('discarded', `// ${why}, so it was not run. The model replied:\n${rawContent}`);
            // The code panel keeps the program that is still current (untouched); the reply is in
            // the run log and the status says why
            this.events.onRunStatus?.(turnId, {
              kind: 'error',
              text: `${why}, so it was not run. ${failed?.error ? errorText(failed.error, failed.errorLine) : 'The program failed.'}`,
            });
            // The reply is remembered (the last question lists those that didn't work), and the next
            // try asks the next question, told what went wrong with this reply
            const attempt = options?.fixAttempt ?? 1;
            if (failed) {
              // What the reply changed in the program (its first line when it changed nothing)
              const applied = options?.autoFix ? applyFixReply(options.autoFix, rawContent, fixLine, options.fixBlock?.end) : rawContent;
              const shown =
                (options?.autoFix ? changedLines(options.autoFix, options.fixWhole ? restoreDeclarations(options.autoFix, applied).code : applied) : '') ||
                rawContent.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//') && !l.startsWith('```'));
              if (shown) {
                const key = this.requestKey(failed);
                this.failedReplies.set(key, [...(this.failedReplies.get(key) ?? []), shown]);
              }
            }
            if (failed?.error && attempt < MAX_FIX_TRIES) {
              this.nextTry(failed, attempt + 1, `Your last reply was not a working fix (${why.toLowerCase()}).`);
            } else if (failed?.error && options?.autoFix) {
              // That was the last attempt: say so, and what the user can do
              this.markGaveUp(failed);
              const text = gaveUpText(failed.error);
              assistantMsg.canonicalContent = text;
              this.events.onTokenStream?.(turnId, text, text);
              this.events.onMessageUpdated?.({ ...assistantMsg });
              for (const phrase of segmenter.push(text + ' ')) enqueuePhraseForSpeech(phrase);
            }
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
            // A fix that is used: now the code panel shows the program that runs
            if (options?.autoFix) this.events.onRawOutput?.(turnId, executableCode);
            // On iPhone the reply's generation (and a fix's test run) settle before the program runs
            await settleOnIos(AFTER_HEAVY_MS);
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
            const spokenThisRun = new Set<string>();
            const soundMark = {
              uses: this.javascriptRuntime.soundUseCount?.() ?? 0,
              heard: this.javascriptRuntime.soundHeardCount?.() ?? 0,
              silent: this.javascriptRuntime.soundSilentCount?.() ?? 0,
            };
            const execResult = await this.javascriptRuntime.execute(executableCode, undefined, {
              onSpeak: (phrase) => {
                if (saidBefore(phrase)) return;
                // The same sentence twice in one run (said before and inside its code) is said once
                if (!runFinished) {
                  if (spokenThisRun.has(phrase.trim())) return;
                  spokenThisRun.add(phrase.trim());
                }
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
            // It ran, but uses a member its object doesn't have: that is its error (it did nothing)
            if (!execResult.error && notThere.length > 0) {
              execResult.error = notThere[0].error;
              execResult.errorLine = notThere[0].line;
              appendRunLog('error', `line ${notThere[0].line}: ${execResult.error}`);
            }
            // It ran, but did nothing the request asked for: no sound at all for a sound request,
            // nothing on screen for a drawing or an app. What the sandbox saw, not a guess from the
            // code; a program that starts a moment late gets 1.5 seconds.
            // A reply with nothing left to run is that, not a program that "played nothing"
            if (!execResult.error && !executableCode.trim()) {
              execResult.error = NO_PROGRAM;
              appendRunLog('error', NO_PROGRAM);
            }
            // Only talk that asks the user something: their answer comes next, nothing is missing
            const asksUser = isTalkOnly(executableCode) && /\?\s*["'`]\s*\)/.test(executableCode);
            if (asksUser) appendRunLog('retry', 'the reply asks the user a question: waiting for the answer');
            if (!execResult.error && !asksUser) {
              const missing = await this.missingOutcome(codeTask, soundMark);
              if (missing) {
                execResult.error = missing;
                appendRunLog('error', missing);
              }
            }
            // Failed here, after the sandbox saw no error: nothing to download
            if (execResult.error) this.javascriptRuntime.withdrawDownload?.();
            this.lastRun = {
              turnId,
              code: executableCode,
              task: codeTask,
              isAutoFix: !!options?.autoFix,
              fixRequested: false,
              error: execResult.error ?? null,
              errorLine: execResult.errorLine,
              fixAttempt: options?.autoFix ? (options.fixAttempt ?? 1) : 0,
              originalTurnId: fixedTurnId ?? turnId,
              errorHistory: options?.errorHistory,
            };
            // A reply that only talked, for a request to make something: not a failed program, the
            // program is still to come (its talk was said; the next turn asks for the program)
            const onlyTalked = !!execResult.error && !options?.autoFix && this.autoFixErrors && isTalkOnly(executableCode) && ACTION_REQUEST.test(normalized);
            this.events.onRunStatus?.(
              turnId,
              onlyTalked
                ? { kind: 'running', text: 'Writing the program…' }
                : execResult.error
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
              // The reply text is what the program said (speak(), console.log(), alert()), as against
              // Chatty's own words when the program said nothing
              let programSaid = false;
              const spokenTexts = [...new Set((execResult.spokenTexts ?? []).map((t) => t.trim()))].filter((t) => t && !saidBefore(t));
              if (spokenTexts.length > 0) {
                spokenText = spokenTexts.join(' ');
                spokenTextsHandled = true;
                programSaid = true;
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
                programSaid = true;
              } else if (execResult.error && options?.autoFix && (options.fixAttempt ?? 0) >= MAX_FIX_TRIES) {
                // The last fix failed too: say so, and what the user can do
                this.gaveUp.add(fixedTurnId ?? turnId);
                spokenText = gaveUpText(execResult.error);
                this.events.onRunStatus?.(turnId, { kind: 'error', text: `${errorText(execResult.error, execResult.errorLine)} ${GAVE_UP_STATUS}` });
              } else if (execResult.error && !this.autoFixErrors) {
                // (When a fix follows, its reply is the answer)
                spokenText = 'Something went wrong while running that.';
              } else if (!execResult.error) {
                // It ran and said nothing (no speak(), console.log() or closing comment)
                spokenText = 'Generation complete.';
              }

              if (spokenText) {
                const shown = assistantMsg.canonicalContent;
                assistantMsg.canonicalContent = spokenText;
                const added = assistantMsg.canonicalContent.startsWith(shown)
                  ? assistantMsg.canonicalContent.slice(shown.length)
                  : assistantMsg.canonicalContent;
                // Tagged as the program's (not the model's chat) when it did more than talk; a
                // talk-only reply is the model chatting and stays untagged
                if (!isTalkOnly(executableCode)) assistantMsg.fromProgram = programSaid;
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
        toolCall: assistantMsg.toolCall,
        fixesTurnId: assistantMsg.fixesTurnId,
        fromProgram: assistantMsg.fromProgram,
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
   * Runs the program again with a slipped method name corrected (ctx.fillrect → ctx.fillRect),
   * without asking the model. What the program already said isn't said again. A new error goes
   * through maybeAutoFix like any other.
   */
  private async runCorrected(
    run: NonNullable<typeof this.lastRun>,
    correction: { code: string; note: string },
    /** A blank-stage fix: already logged, and it is the model-fix attempt `fixAttempt` */
    blankFix?: { fixAttempt: number; errorHistory: FixError[] }
  ): Promise<void> {
    const code = correction.code;
    const named = correction.note;
    if (this.gaveUp.has(this.requestKey(run))) return;
    if (!blankFix) appendRunLog('imagined', `${named}: corrected and run again`);
    this.events.onRunStatus?.(run.turnId, { kind: 'running', text: `Corrected ${named}; running it again` });
    this.events.onRawOutput?.(run.turnId, code);
    if (this.javascriptRuntime.hasRunningProgram?.()) {
      await this.javascriptRuntime.resetVisual();
      await settle(AFTER_HEAVY_MS);
    }
    if (this.scheduler.getActiveTurnId() || this.gaveUp.has(this.requestKey(run))) return; // the user has moved on
    const said = this.memoryStore.getMessages().find((m) => m.id === `msg_assistant_${run.turnId}`)?.canonicalContent ?? '';
    const result = await this.javascriptRuntime.execute(code, undefined, {
      onSpeak: (phrase) => {
        if (phrase.trim() && !said.includes(phrase.trim())) void this.speakOutOfTurn(phrase);
      },
      audioContextAccessor: this.audioContextAccessor,
    });
    if (result.error && result.errorLine === undefined) result.errorLine = await syntaxErrorLine(code);
    this.correctedPrograms.set(run.turnId, code);
    if (this.lastAction?.kind === 'code' && this.lastAction.code === run.code) this.lastAction = { ...this.lastAction, code };
    this.lastRun = {
      ...run,
      code,
      error: result.error ?? null,
      errorLine: result.errorLine,
      fixRequested: false,
      ...(blankFix ? { fixAttempt: blankFix.fixAttempt, errorHistory: blankFix.errorHistory } : { corrections: (run.corrections ?? 0) + 1 }),
    };
    this.events.onRunStatus?.(
      run.turnId,
      result.error
        ? { kind: 'error', text: errorText(result.error, result.errorLine) }
        : { kind: 'ok', text: `Ran in ${Math.max(1, Math.round(result.executionTimeMs))} ms (corrected ${named})` }
    );
    if (result.error && blankFix && blankFix.fixAttempt >= MAX_FIX_TRIES) this.sayGaveUp(run.turnId, result.error);
    if (result.error) this.maybeAutoFix(run.turnId);
  }

  /**
   * One automatic fix per request: the error goes back to the model, shown the lines around it,
   * and it rewrites the program (see line-fix.ts).
   */
  private maybeAutoFix(turnId: string): void {
    const run = this.lastRun;
    if (!this.autoFixErrors) return;
    if (!run || run.turnId !== turnId || !run.error || run.fixRequested) return;
    if (this.scheduler.getActiveTurnId()) return; // the user has already moved on
    if (this.gaveUp.has(this.requestKey(run))) return; // Chatty has said it gave up: nothing follows
    // The reply to the request only talked (or had nothing to run): the program is asked for once
    // more, reminded what speak() is for, outside the tries
    if (!run.isAutoFix && (!run.code.trim() || isTalkOnly(run.code))) {
      run.fixRequested = true;
      this.askForProgram(run);
      return;
    }
    // A line past the program's end came from somewhere else (the sandbox's own code): no line
    if (run.errorLine && run.errorLine > run.code.split('\n').length) run.errorLine = undefined;
    // A sure slip (a method's wrong case, a typo of a declared name, an element id one slip
    // from an id on the page) is corrected and run again without the model, even in a fix's
    // program; anything else goes to the model with the facts it was missing (error-hints.ts)
    const hint = errorHint(run.code, run.error, run.errorLine, { ids: this.javascriptRuntime.pageIds?.() ?? [], standIns: this.javascriptRuntime.standInIds?.() ?? [] });
    if (hint?.correction && hint.correction.code !== run.code && (run.corrections ?? 0) < 3) {
      run.fixRequested = true;
      void this.runCorrected(run, hint.correction);
      return;
    }
    // A fix's own program can fail too: the model gets up to MAX_FIX_TRIES tries per request
    const attempt = (run.fixAttempt ?? 0) + 1;
    if (attempt > MAX_FIX_TRIES) return;
    run.fixRequested = true;
    this.nextTry(run, attempt, undefined, hint?.text);
  }

  /**
   * Try `attempt`: the next question in the order for this model that fits the error and hasn't
   * been asked for this request yet (see FixKind); the whole program when none is left
   */
  private nextTry(run: NonNullable<typeof this.lastRun>, attempt: number, note?: string, hintText?: string): void {
    if (!run.error) return;
    if (attempt > MAX_FIX_TRIES) {
      this.sayGaveUp(run.turnId, run.error);
      return;
    }
    // In speech mode, each try says so
    void this.speakOutOfTurn('Fixing.');
    const key = this.requestKey(run);
    // The kinds asked are kept per error: a different error starts again from the first kind
    const kindsKey = `${key}\n${normalizedError(run.error)}`;
    const used = this.fixKindsUsed.get(kindsKey) ?? new Set<FixKind>();
    this.fixKindsUsed.set(kindsKey, used);
    const broken = brokenLines(run.code);
    const blank = this.blankFor(run);
    const fits = (kind: FixKind) =>
      kind === 'blank'
        ? !!blank
        : kind === 'function'
          ? !broken && !!enclosingFunction(run.code, run.errorLine)
          : kind === 'line' || kind === 'different'
            ? !!run.errorLine || !!broken
            : true;
    const unused = (this.largeModel() ? FIX_ORDER_LARGE : FIX_ORDER_SMALL).find((k) => !used.has(k) && fits(k));
    // Every kind asked already (one didn't fit): the whole program, told the replies that failed,
    // so this question too differs from every one before
    const kind = unused ?? 'program';
    used.add(kind);
    const hint = hintText ?? errorHint(run.code, run.error, run.errorLine, { ids: this.javascriptRuntime.pageIds?.() ?? [], standIns: this.javascriptRuntime.standInIds?.() ?? [] })?.text;
    if (kind === 'blank' && blank) {
      run.fixRequested = true;
      this.events.onRunStatus?.(run.turnId, { kind: 'error', text: `${errorText(run.error, run.errorLine)} (trying fixes for ${blank.text})` });
      void this.blankStage(run, blank, attempt, hint);
      return;
    }
    const tried = this.failedReplies.get(key) ?? [];
    const different = (kind === 'different' || !unused) && tried.length
      ? `Write a fix different from these, which didn't work: ${tried.slice(-3).map((r) => `\`${r}\``).join('; ')}.`
      : undefined;
    this.askFix(run, attempt, kind === 'blank' ? 'line' : kind, [note, different, hint].filter(Boolean).join(' ') || undefined);
  }

  /** The request a run belongs to (every fix of it shares the key) */
  private requestKey(run: { turnId: string; originalTurnId?: string }): string {
    return run.originalTurnId ?? run.turnId;
  }

  /** Chatty has said it gave up on this run's request: nothing more is corrected or fixed */
  private markGaveUp(run: { turnId: string; originalTurnId?: string }): void {
    this.gaveUp.add(this.requestKey(run));
  }

  /** Whether the active model gets the line fix before the blank stage (see prefersLineFix) */
  private largeModel(): boolean {
    return prefersLineFix(this.llmProvider.modelId);
  }

  /** The blank for a failed run, when its program can be test-run and parses */
  private blankFor(run: NonNullable<typeof this.lastRun>): Blank | null {
    return run.error && typeof this.javascriptRuntime.trialRun === 'function' && !brokenLines(run.code) ? findBlank(run.code, run.error, run.errorLine) : null;
  }

  /** A hidden test run, a short pause after the one before */
  private async trial(code: string): ReturnType<NonNullable<JavascriptRuntime['trialRun']>> {
    const wait = TRIAL_GAP_MS - (Date.now() - this.lastTrialEnd);
    if (wait > 0) await settle(wait);
    try {
      return await this.javascriptRuntime.trialRun!(code);
    } finally {
      this.lastTrialEnd = Date.now();
    }
  }

  /** After a reply that only talked: the program, asked for once, as none of the tries */
  private askForProgram(run: NonNullable<typeof this.lastRun>): void {
    appendRunLog('retry', 'the reply only talked: asking for the program (not one of the tries)');
    const ask = [
      'ONLY OUTPUT JAVASCRIPT. USE speak() TO CHAT WITH THE USER, AND WRITE THE PROGRAM THAT DOES THE REQUEST.',
      `Write the complete JavaScript program for: ${run.task}`,
      'Reply with the complete program, then one speak() sentence telling the user what it does.',
    ].join('\n');
    void settle(AFTER_HEAVY_MS).then(() => {
      if (this.scheduler.getActiveTurnId()) return;
      return this.submitUserInput(ask, {
        autoFix: NO_PROGRAM_YET,
        fixAttempt: 0,
        errorHistory: withError(run),
        fixWhole: true,
        freeRetry: true,
      });
    });
  }

  /**
   * A fix turn: the marked line (or the statements that don't parse), the whole function around
   * it, or the whole program, as try `attempt`
   */
  private askFix(run: NonNullable<typeof this.lastRun>, attempt: number, kind: Exclude<FixKind, 'blank'>, factsText?: string): void {
    if (!run.error) return;
    run.fixRequested = true;
    this.events.onRunStatus?.(run.turnId, {
      kind: 'error',
      text: `${errorText(run.error, run.errorLine)} (asking the model to fix it)`,
    });
    // No program to fix (nothing ran, only speak(), or it showed nothing and puts nothing on the
    // page at all): the request is asked for again, as a whole program
    const nothingToShow = run.error.startsWith('The program showed nothing') && !ADDS_TO_PAGE.test(run.code);
    if (!run.code.trim() || isTalkOnly(run.code) || nothingToShow) {
      this.startFixLog(run);
      appendRunLog('retry', `the reply had no program: asking the model for the whole program (try ${attempt} of ${MAX_FIX_TRIES})`);
      const ask = [
        `Write the complete JavaScript program for: ${run.task}`,
        `The last reply had no program that does it (${run.error.replace(/\.+$/, '')}).`,
        'Reply with the complete program.',
      ].join('\n');
      void settle(AFTER_HEAVY_MS).then(() => {
        if (this.scheduler.getActiveTurnId()) return;
        return this.submitUserInput(ask, {
          // A fix turn is known by the program it fixes, so an empty one gets a stand-in
          autoFix: NO_PROGRAM_YET,
          fixAttempt: attempt,
          errorHistory: withError(run),
          fixWhole: true,
        });
      });
      return;
    }
    const broken = kind === 'program' ? null : brokenLines(run.code);
    const fn = kind === 'function' ? enclosingFunction(run.code, run.errorLine) : null;
    const block = broken
      ? { ...broken, why: 'syntax' as const }
      : fn
        ? { start: fn.start, end: fn.end, name: fn.name || undefined }
        : undefined;
    const line = kind === 'program' ? undefined : run.errorLine;
    const facts = [earlierErrors(run.errorHistory, run.error), factsText].filter(Boolean).join(' ') || undefined;
    const request = fixRequest(run.task, run.code, line, run.error, facts, block);
    this.startFixLog(run);
    const what = broken
      ? `lines ${broken.start}-${broken.end}, which don't parse`
      : fn
        ? `the whole function${fn.name ? ` ${fn.name}()` : ''} (lines ${fn.start}-${fn.end})`
        : kind === 'program'
          ? 'the whole program'
          : kind === 'different'
            ? 'the marked line, unlike the replies that failed'
            : 'the marked line';
    appendRunLog('retry', `the program failed (${errorText(run.error, run.errorLine)}): asking the model for ${what} (try ${attempt} of ${MAX_FIX_TRIES})`);
    // A short pause before the model runs again, unless the user moves on meanwhile
    void settle(AFTER_HEAVY_MS).then(() => {
      if (this.scheduler.getActiveTurnId()) return;
      return this.submitUserInput(request, {
        autoFix: run.code,
        fixAttempt: attempt,
        errorHistory: withError(run),
        ...(kind === 'program' ? { fixWhole: true } : {}),
        ...(block ? { fixBlock: { start: block.start, end: block.end, ...(fn?.name ? { name: fn.name } : {}) } } : {}),
      });
    });
  }

  /** Chatty's closing message when the last fix attempt failed, outside any chat turn */
  private sayGaveUp(turnId: string, error: string): void {
    const text = gaveUpText(error);
    this.events.onRunStatus?.(turnId, { kind: 'error', text: `${errorText(error)} ${GAVE_UP_STATUS}` });
    if (this.lastRun?.turnId === turnId) this.markGaveUp(this.lastRun);
    else this.gaveUp.add(turnId);
    const msg: ConversationMessage = {
      id: `msg_assistant_gaveup_${turnId}_${Date.now()}`,
      turnId: `gaveup_${turnId}_${Date.now()}`,
      role: 'assistant',
      canonicalContent: text,
      speechReadyContent: text,
      phrases: [],
      timestamp: Date.now(),
    };
    this.memoryStore.addMessage(msg);
    this.events.onMessageCreated?.({ ...msg });
    void this.speakOutOfTurn(text);
  }

  /**
   * The blank stage (blank-fix.ts), one fix attempt: the expression the error names is replaced by
   * candidates, each tried in a hidden run (trialRun), until one runs without that error. The
   * candidates, in order: the model's pick among the page's own names (multiple choice), its
   * expressions for the blank (three samples), then the remaining choices. At most MAX_CANDIDATES
   * are tried; the first that passes is run for real. When none does, the line fix follows as the
   * next attempt. Stops at once when the user starts a new turn.
   */
  /** What a sound or visual request's program never did, after a short wait, or null */
  private async missingOutcome(request: string, soundMark: { uses: number; heard: number; silent: number }): Promise<string | null> {
    if (!asksForOutcome(request)) return null;
    // A request that names something to see as well still gets its visual check; a bare "play"
    // (a game, a video) is not a sound on its own then
    const namesVisual = VISUAL_THING.test(request);
    // (a runtime that can't tell, as in tests, is taken at its word)
    // A bare "play" (a game, a video) chooses the sound rule but asks for no sound by itself
    const wantsSound = SOUND_WORDS_REQUEST.test(request) && !!this.javascriptRuntime.soundUseCount;
    const wantsVisual = namesVisual && !!this.javascriptRuntime.hasVisualContent;
    if (!wantsSound && !wantsVisual) return null;
    // Sound asked for, then measured at the speakers (two seconds): heard, or silent with the audio
    // running. Not measured (audio paused until a tap, or a runtime that can't): the request counts
    const asked = () => (this.javascriptRuntime.soundUseCount?.() ?? 0) > soundMark.uses;
    const heard = () => (this.javascriptRuntime.soundHeardCount?.() ?? 0) > soundMark.heard;
    const silent = () => !heard() && (this.javascriptRuntime.soundSilentCount?.() ?? 0) > soundMark.silent;
    const measures = !!this.javascriptRuntime.soundHeardCount;
    const soundSettled = () => heard() || silent() || (asked() && !measures);
    const shown = () => !!this.javascriptRuntime.hasVisualContent?.();
    const done = () => (!wantsSound || soundSettled()) && (!wantsVisual || shown());
    // Long enough for the speaker measurement when sound was asked for
    for (let waited = 0; !done() && waited < (wantsSound && asked() ? 2500 : 1500); waited += 100) await settle(100);
    const missing = [
      wantsSound && !asked()
        ? 'The program played nothing: notes play through a Web MIDI output (output.send([0x90 + channel, note, velocity], time)) or Web Audio oscillators.'
        : wantsSound && silent()
          ? "The program's sound never reached the speakers: connect each sound to the audio context's destination (node.connect(audioContext.destination))."
          : '',
      wantsVisual && !shown() ? 'The program showed nothing: what it adds to document.body appears in the card on screen.' : '',
    ].filter(Boolean);
    if (missing.length === 0) {
      appendRunLog('retry', `outcome check: ${[wantsSound ? 'wanted sound: heard' : '', wantsVisual ? 'wanted visual: seen' : ''].filter(Boolean).join('; ')}`);
      return null;
    }
    return missing.join(' ');
  }

  /** A fix's progress note in the chat ("Fixing (3 of 10): …"): added like a fix turn's own */
  private addFixNote(text: string, turnId: string): void {
    const stamp = Date.now();
    const note: ConversationMessage = {
      id: `msg_user_fixnote_${turnId}_${stamp}_${Math.random().toString(36).slice(2, 6)}`,
      turnId: `fixnote_${turnId}_${stamp}`,
      role: 'user',
      canonicalContent: text,
      autoFix: true,
      fixNotice: text,
      timestamp: stamp,
    };
    this.memoryStore.addMessage(note);
    this.events.onMessageCreated?.(note);
  }

  private async blankStage(run: NonNullable<typeof this.lastRun>, blank: Blank, attempt: number, hintText?: string): Promise<void> {
    const error = run.error;
    if (!error) return;
    const moved = () => !!this.scheduler.getActiveTurnId() || this.lastRun !== run;
    // A pause before the stage's hidden runs and model calls, for phones' memory
    await settle(AFTER_HEAVY_MS);
    if (moved()) return;
    this.addFixNote(fixNote(attempt, error), `blank_${run.turnId}`);
    this.startFixLog(run);
    appendRunLog('retry', `the program failed (${errorText(error, run.errorLine)}): trying expressions for the blank \`${blank.text}\` (${blank.why}), each in a test run (try ${attempt} of ${MAX_FIX_TRIES})`);

    const abort = new AbortController();
    this.blankAbort = abort;
    const provider = this.phonePipeline?.coder ?? this.llmProvider;
    const facts = [earlierErrors(run.errorHistory, error), hintText].filter(Boolean).join(' ') || undefined;
    const page = { ids: this.javascriptRuntime.pageIds?.() ?? [], fields: this.javascriptRuntime.pageFields?.() ?? [] };
    const choices = blankChoices(run.code, blank, page);

    const ask = (request: string, shape: Partial<LlmGenerationOptions>): Promise<string | null> =>
      withActivity('asking for a fix', async () => {
        if (moved() || abort.signal.aborted) return null;
        try {
          const result = await provider.generate({
            turnId: `blank_${run.turnId}_${attempt}`,
            systemPrompt: BLANK_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: request }],
            temperature: 0.1,
            signal: abort.signal,
            ...shape,
          });
          return moved() || abort.signal.aborted || result.aborted ? null : result.text;
        } catch {
          return null;
        }
      });

    // Every candidate: the page's and program's choices (ranked by how well they fit the name) and
    // what the model picked or wrote (a vote each)
    const votes = new Map<string, number>();
    // A bare literal ([], 0, '', null, undefined) runs but only silences the error: not a fix
    const LITERAL = /^(?:-?[\d.]+(?:e[-+]?\d+)?|'[^']*'|"[^"]*"|`[^`$]*`|\[\s*\]|\{\s*\}|null|undefined|NaN|true|false)$/;
    const vote = (expr: string | null) => {
      const key = expr?.trim();
      if (key && key !== blank.text.trim() && !LITERAL.test(key)) votes.set(key, (votes.get(key) ?? 0) + 1);
    };
    let count = 0;
    type Candidate = { code: string; expr: string; level: number; rank: number; votes: number };
    let best = null as Candidate | null;
    const rankOf = (expr: string) => {
      const i = choices.indexOf(expr);
      return i < 0 ? choices.length : i;
    };
    const mentions = new RegExp(`(?<![\\w$])${blank.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
    const tested = new Set<string>();
    // A test run can't tell which candidate is meant (two fields both run), only how far each got:
    // the furthest wins, then the one whose name fits, then the model's votes
    const test = async (expr: string): Promise<void> => {
      if (tested.has(expr) || count >= MAX_BLANK_CANDIDATES || moved() || abort.signal.aborted) return;
      tested.add(expr);
      const filled = fillBlank(run.code, blank, expr);
      if (!filled || filled === run.code) return;
      count++;
      // The test copy marks the blank, to tell a clean run from one that never got there (a click
      // handler, an animation frame)
      const probe = fillBlank(run.code, blank, `((globalThis.__chattyReached = true), ${expr})`) ?? filled;
      const trial = await this.trial(probe);
      if (moved()) return;
      // 3: ran through the blank without an error; 2: an error further on; 1: another error, no
      // longer about the blank, or no error but the blank never ran. An error without a line (a
      // value the page rejected) can't be placed after the blank: no progress
      const level = !trial.error
        ? trial.reached === false && probe !== filled
          ? 1
          : 3
        : namesCandidate(trial.error, expr) || trial.errorLine === undefined
          ? 0
          : trial.error !== error && trial.errorLine !== undefined && trial.errorLine > (run.errorLine ?? blank.line) + (blank.declareAt ? 1 : 0)
            ? 2
            : trial.error !== error && !mentions.test(trial.error)
              ? 1
              : 0;
      appendRunLog('retry', `a test run: \`${expr}\` for \`${blank.text}\` gave ${trial.error ? `${errorText(trial.error, trial.errorLine)}${level ? ' (progress)' : ''}` : trial.reached === false ? 'no error, but the blank never ran' : 'no error'}`);
      if (!level) return;
      const entry = { code: filled, expr, level, rank: rankOf(expr), votes: votes.get(expr) ?? 0 };
      if (!best || entry.level > best.level || (entry.level === best.level && (entry.rank < best.rank || (entry.rank === best.rank && entry.votes > best.votes)))) best = entry;
    };
    // Nothing beats a clean run of the best-fitting choice
    const settled = () => { const b = best as Candidate | null; return b !== null && b.level === 3 && b.rank === 0; };
    try {
      if (choices.length >= 2) {
        const reply = await ask(choiceRequest(run.task, run.code, blank, error, choices, facts), { exact: true, fixShape: 'choice', choiceCount: choices.length, maxOutputTokens: 8 });
        const picked = reply === null ? -1 : chosenIndex(reply, choices.length);
        if (picked >= 0) vote(choices[picked]);
      }
      // The best-fitting choice first: when it runs cleanly, the model needn't write anything
      if (choices.length > 0) await test(choices[0]);
      if (!settled()) {
        // Greedy, then wide, then narrow: three really different answers
        for (const sampling of [{ exact: true }, { sampling: fixSampling(2) }, { sampling: fixSampling(3) }]) {
          if (moved() || abort.signal.aborted) break;
          const reply = await ask(blankRequest(run.task, run.code, blank, error, facts), { ...sampling, fixShape: 'expression', maxOutputTokens: 96 });
          vote(reply === null ? null : firstExpression(reply));
        }
        const candidates = [...new Set([...choices, ...votes.keys()])].sort(
          (a, b) => (votes.get(b) ?? 0) - (votes.get(a) ?? 0) || rankOf(a) - rankOf(b)
        );
        for (const expr of candidates) {
          if (settled() || moved() || abort.signal.aborted || count >= MAX_BLANK_CANDIDATES) break;
          await test(expr);
        }
      }
    } finally {
      if (this.blankAbort === abort) this.blankAbort = null;
    }

    if (moved() || abort.signal.aborted) {
      this.finishFixLog('lost');
      return;
    }
    // (set inside test(), which TypeScript can't follow)
    const found = best as Candidate | null;
    if (found) {
      this.finishFixLog('ran');
      appendRunLog('imagined', `${blank.text} → ${found.expr}: corrected by a test run (${found.level === 3 ? 'it ran' : 'it got further'}, the best of ${count})`);
      // (the test runs settle before the real one on iPhone)
      await settleOnIos(AFTER_HEAVY_MS);
      await this.runCorrected(run, { code: found.code, note: `${blank.text} → ${found.expr}` }, { fixAttempt: attempt, errorHistory: withError(run) });
      return;
    }
    this.finishFixLog('unchanged');
    appendRunLog('retry', `no expression passed a test run (${count} tried for \`${blank.text}\`): asking for the marked line instead`);
    this.nextTry(run, attempt + 1, undefined, hintText);
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
  /** The newest program in this chat that does more than talk, for Replay */
  replayableProgram(): string | null {
    const action = this.getLastAction(this.getConversationId?.());
    return action?.kind === 'code' && action.code && !isTalkOnly(action.code) ? action.code : null;
  }

  /**
   * Runs this chat's newest program again (the main button's Replay): no model, and nothing added
   * to the chat. A program still running is stopped first; what it says is voiced as it runs.
   */
  async replayLastProgram(): Promise<boolean> {
    const code = this.replayableProgram();
    if (!code || this.scheduler.getActiveTurnId()) return false;
    // Always from a clean slate: the last run's timers, notes and card go first (a program that
    // only scheduled notes doesn't count as running, and would otherwise play on top)
    await this.javascriptRuntime.resetVisual();
    await settle(AFTER_HEAVY_MS);
    appendRunLog('request', '(Replay: the program ran again)');
    const result = await this.javascriptRuntime.execute(code, undefined, { onSpeak: (phrase) => void this.speakOutOfTurn(phrase) });
    this.events.onRunStatus?.(
      null,
      result.error ? { kind: 'error', text: errorText(result.error, result.errorLine) } : { kind: 'ok', text: 'Ran again' }
    );
    return true;
  }

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
  // Prompt Construction
  // --------------------------------------------------------------------------

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
      : ['Reply with one simple, complete JavaScript program for the request, then one speak() sentence telling the user what it does.'];
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
    programBeingEdited: string | null = null,
    complaint = false
  ): {
    systemPrompt: string;
    promptMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  } {
    // Rules are picked by the request and, for an edit or a fix, the program it changes
    const { head, tail } = this.staticPromptParts(`${userMessage}\n${programBeingEdited ?? ''}`);
    const systemParts: string[] = [...head];

    // What applies to this request only: memories picked for it, a reference it makes. In the system prompt these would change it on most turns, and the model would
    // have to process the whole prompt again; with the request they stay with it.
    const notes: string[] = [];
    if (complaint && programBeingEdited) {
      notes.push('The user says your last program (shown above) did not do what they asked. Write it again so it does.');
    }
    if (context.relevantMemories.length > 0) {
      const memStr = context.relevantMemories.map((m) => `${m.key}: ${m.value}`).join('; ');
      notes.push(`User approved memory: ${memStr}.`);
    }
    if (context.resolvedReferencesNote) {
      notes.push(context.resolvedReferencesNote);
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
    // Assistant messages before the user's first one are the app's own (the welcome greeting).
    // Sent, they'd merge into the format turn's reply (consecutive turns are joined): left out.
    let userHasSpoken = false;
    // Chatty's own "fix this error" turns and the replies to them stay out of later prompts: the
    // chat hides them, and a model that sees them answers the next request the same way
    const fixTurnIds = new Set(
      context.workingMessages.filter((m) => m.role === 'user' && m.autoFix).map((m) => m.turnId)
    );

    // A working fix's program stands for the broken one it fixed (the broken message isn't edited)
    const fixedCode = new Map<string, string>();
    for (const m of context.workingMessages) {
      if (m.role === 'assistant' && m.fixesTurnId && m.rawCode) {
        fixedCode.set(m.fixesTurnId, this.correctedPrograms.get(m.turnId) ?? m.rawCode);
      }
    }
    // …and so does a program whose slips were corrected
    for (const [turnId, code] of this.correctedPrograms) if (!fixedCode.has(turnId)) fixedCode.set(turnId, code);

    for (const stored of context.workingMessages) {
      if (fixTurnIds.has(stored.turnId)) continue;
      const fixed = stored.role === 'assistant' ? fixedCode.get(stored.turnId) : undefined;
      // (the version that ran: its history says so, not that the broken one failed)
      const msg = fixed
        ? {
            ...stored,
            rawCode: fixed,
            rawLlmOutput: fixed,
            toolCall: { name: stored.toolCall?.name ?? 'execute_javascript', arguments: stored.toolCall?.arguments ?? {}, status: 'completed' as const },
          }
        : stored;
      if (msg.role === 'user') userHasSpoken = true;
      else if (msg.role === 'assistant' && !userHasSpoken) continue;
      if (msg.role === 'assistant') {
        // Past programs leave the message history (with the request that asked for them) and are
        // described in the system prompt, except the one being edited, which is shown in full.
        // Phone chat model (split pipeline) sees only what was said.
        // Every request and reply stays in the history: a past program as what it said and what
        // happened when it ran (pastProgramResult), the one being edited in full
        const content = (
          this.phonePipeline
            ? msg.canonicalContent || ''
            : programBeingEdited && msg.rawCode === programBeingEdited
              ? msg.rawCode
              : pastProgramResult(msg)
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
