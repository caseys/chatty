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
import { parse, tokenizer, type Node as AcornNode } from 'acorn';
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
  askOnCard,
  type CanvasTrace,
  JavascriptRuntime,
  inspectExecutableCode,
  stripComments,
  syntaxErrorLine,
} from '../tools/javascript-runtime.ts';
import { setForRecentRequests } from './recent-requests.ts';
import { appendRunLog } from './run-log.ts';
import { memberBlank, fillMember, blankChoices, blankRequest, choiceRequest, declareMissing, fillBlank, fillCallsItself, findBlank, standsForMissingFunction, type Blank } from './blank-fix.ts';
import { madeAsWrongClass, memberList, wholeCanvasClear, withLibraryClassNames, type RealMember } from './method-hints.ts';
import { applyFixReply, brokenLines, enclosingFunction, failingStatement, FIX_SYSTEM_PROMPT, fixRequest, isBareText, restoreWhole } from './line-fix.ts';
import { missingStepsError, sameShortfallNote } from './sound-setup.ts';
import { addNewToClasses, closeAttributeQuotes, runAppendOfNothing, escapeScriptBackticks, missingReadFacts, shareDeclarations, dropBrowserCopies, dropHelperCopies, dropEndlessSelfCalls, dropFenceLabels, dropRequestEcho, dropStrayCharacter, joinSplitReturn, moveClassesUp, parsesAsProgram, wrapLogicalAssignment, strayName, unwrapBackticks, wrapBracelessArrows, fixAudioNodeProperties, fixIteratorResults, fixKeySlips, fixToneCalls, loopOneFrameAnimations, dropUnusedPackages, errorHint, fixCaseSlips, looksThrown, provideThree, quoteToneTimes, unusedDrawingValues, dropExampleTags } from './error-hints.ts';
import { applyAssignmentFixes, moveToContext, renameMembers, unknownMemberError, unknownMembers, unusableAssignments } from './property-check.ts';
import { AFTER_HEAVY_MS, settle, settleOnIos } from './settle.ts';
import { isAppleMobile, LOCAL_CHAT_MODELS } from './settings.ts';
import { redeclaredCut } from './repeat-guard.ts';
import type { RuleName } from './rule-cases.ts';
import { withActivity } from './activity-breadcrumbs.ts';
import { MIDI_OUTPUT, MIDI_PLAIN_FORM, MIDI_RULE } from './midi-form.ts';
import { copiedExampleNotes, emptyExampleNotes, restoreMidiOutputLine, routePlainSendToMidi, useRequestedInstrument, useRequestedShape, wrongInstrument } from './example-copy.ts';

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
  // Lines are compared without their indent: a fix that wrote `function drawLoop() {` and
  // `requestAnimationFrame(drawLoop);` some 30 times, each copy inside the one before and so
  // indented deeper, ran for 22 seconds (Qwen2.5 0.5B)
  const bare = done.map((line) => line.trimStart());
  for (let k = 2; k <= 40; k++) {
    const copies = k >= 8 ? 2 : 3;
    if (done.length < k * copies) break;
    // Where the lines start repeating every k lines
    let p = done.length - k;
    while (p > 0 && bare[p - 1] === bare[p - 1 + k]) p--;
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
const MUSIC_WORDS = String.raw`music|songs?|sing(?:s|ing)?|beats?|groove|drums?|pianos?|bass|guitars?|organ|violins?|trumpets?|sax(?:ophone)?|flutes?|chords?|melod(?:y|ies)|tunes?|midi|rhythm|jam|loop(?:ed)? (?:the )?(?:song|beat|music|melody)|tempo|bpm|instruments?|(?:in|key of) [a-g][#b]? (?:major|minor|pentatonic)|[a-g][#b]? (?:major|minor|pentatonic) (?:scales?|chords?|keys?|progressions?|arpeggios?)|(?:major|minor|pentatonic) scale|scale (?:in|of) [a-g]`;
const SOUND_WORDS = String.raw`\b(?:${MUSIC_WORDS}|sound|beeps?|audio)\b|requestMIDIAccess|AudioContext`;
/** (a bare "play" also asks for games and videos: it chooses the sound rules, but isn't a sound on its own) */
const SOUND_REQUEST = new RegExp(String.raw`\bplay(?:s|ing)?\b|${SOUND_WORDS}`, 'i');
/** Music, which Web MIDI plays: instruments, a song, a melody, chords, a beat, drums, a tempo, a key (or a program already written with Web MIDI or Tone) */
const MUSIC_REQUEST = new RegExp(String.raw`\b(?:${MUSIC_WORDS})\b|requestMIDIAccess`, 'i');
const TONE_PROGRAM = /\bTone\s*\./;
/** Sound effects, which Web Audio plays: a beep, a chime, an alarm, a click (or a program already written with Web Audio) */
const EFFECT_REQUEST = new RegExp(String.raw`\b(?:beeps?|tones?|chimes?|alarms?|dings?|buzz(?:es|ed|ing|er)?|clicks?|sirens?|sound effects?)\b|AudioContext`, 'i');

/** A heart that beats, which isn't a beat to play ("a heart that beats with CSS" got the music rule) */
const HEART_BEATS = /\bhearts?\b(?:\s+\w+){0,4}?\s+beat(?:s|ing)?\b/gi;
/**
 * Which sound rules a request needs: Web MIDI for music, Web Audio for sound effects, both when it
 * names both or names neither ("play a sound"), none when it has nothing to do with sound
 */
function soundKinds(said: string): { music: boolean; effects: boolean } {
  const request = said.replace(HEART_BEATS, 'heart');
  const music = MUSIC_REQUEST.test(request) || TONE_PROGRAM.test(request);
  const effects = EFFECT_REQUEST.test(request);
  if (!music && !effects) {
    const either = SOUND_WORDS_REQUEST.test(request) || (SOUND_REQUEST.test(request) && !PLAYS_A_GAME.test(request));
    return { music: either, effects: either };
  }
  return { music, effects };
}
const SOUND_WORDS_REQUEST = new RegExp(SOUND_WORDS, 'i');
/** Games that are drawn whatever the request says ("Let me play pong against the computer" got no drawing rule) */
const DRAWN_GAMES = String.raw`pong|tetris|breakout|flappy|asteroids|space invaders|pac-?man|chess ?boards?|checker ?boards?`;
/**
 * A game, which a bare "play" is for: no sound ("Make a pong game I play with the arrow keys" got both sound
 * rules). A sound named in it still is ("Play a sound when the snake eats food")
 */
const PLAYS_A_GAME = new RegExp(String.raw`\bgames?\b|\b(?:${DRAWN_GAMES}|snake|tic-?tac-?toe|chess|checkers|hangman|solitaire|sudoku|blackjack|poker|cards|catch|tag|fetch)\b`, 'i');
const DRAWING_REQUEST = new RegExp(
  String.raw`\b(?:draw|paint|sketch|picture|image|art\b|animat|game|simulat|bounc|canvas|scene|shape|circle|square|triangle|stars?\b|sky|rainbow|landscape|pattern|fractal|particle|mov(?:e|ing)|getContext|(?:${DRAWN_GAMES})\b)`,
  'i'
);
/** What is made to be used: an app the user presses or types in (not a display, a clock or a drawing) */
const USED_WORDS = 'calculator|converter|form(?!\\s+of\\b)|quiz|to-?do|checklist|stopwatch|picker|toggle|sliders?|tracker|planner|editor|generator|roller|mixer|buttons?';
/**
 * Asked to make one of those: the verb, an article, up to two words, then the app word ("Code a tip
 * calculator", "Build a unit converter"). Not an app word after "about", "of" or "for" ("Write a poem
 * about a calculator", "Make a list of quiz questions"), which is something else made of it.
 */
export const MAKES_USED_THING = new RegExp(
  `\\b(?:make|build|create|code|write|design|develop|generate|program|implement)\\s+(?:(?:me|us)\\s+)?(?:(?:a|an|the|my|our|some)\\s+)?(?:(?!about\\b|of\\b|for\\b|on\\b|with\\b)[\\w'-]+\\s+){0,2}(?:${USED_WORDS})\\b`,
  'i'
);
/** A request to draw: the verb, but not a card, a number or a winner (those are drawn at random, in words) */
const DRAW_REQUEST = /\b(?:draw|paint|sketch|illustrate)\b(?!(?:\s+\w+){0,2}\s+(?:card|cards|number|numbers|name|names|winner|lot|lots|straw|conclusion|breath|blood|attention|raffle)\b)/i;
/**
 * What the canvas rule is for: something drawn. Not every drawing word: a guessing, word or number game is
 * played in words ("a guessing game…" built a canvas with it), a square number is arithmetic ("show a table of
 * the first ten square numbers"), and a conclusion drawn or a picture painted with words is writing ("draw me a
 * conclusion from this…", "paint me a picture with words of a sunset"). A card drawn is still drawn ("Draw a
 * memory card"), so only a drawn conclusion is left out. A clock with hands is drawn ("an analog clock with hands"
 * got no drawing rule). A heart isn't put forward: with the rule, "show a big red heart in the middle of the page"
 * gave an empty canvas or a red square (3 of 4, Qwen3 0.6B and Qwen2.5 0.5B), without it a heart in words
 */
const CANVAS_WORDS = new RegExp(
  String.raw`\b(?:draw(?:s|n|ings?)?|paint(?:s|ed|ings?)?|sketch(?:es|ed|ing)?|illustrat\w*)\b(?!(?:\s+\w+){0,2}\s+(?:conclusions?|breath|blood|attention|inspiration|comparisons?|parallels?)\b)|\b(?:${DRAWN_GAMES})\b|\b(?:picture|image|art\b|animat|simulat|bounc|canvas|scene|shape|circle|(?<!\b(?:its|their) )squares?\b(?!\s+(?:of|numbers?|roots?|feet|foot|meters?|metres?|miles?|inch(?:es)?|yards?|kilomet\w*|centimet\w*)\b)|triangle|stars?\b|sky|rainbow|landscape|pattern|fractal|particle|mov(?:e|ing)|getContext|analog(?:ue)? (?:clocks?|watch(?:es)?)|clock ?faces?|(?:hour|minute|second|clock)s? hands?\b)`,
  'i'
);
const GAME_WORDS = /\bgames?\b/i;
/** A game played in words or with cards and tiles on the page, not drawn ("memory matching game" got the 3D rule) */
const GAME_IN_WORDS = /\bguess\w*|\b(?:trivia|quiz|riddle|word|number|spelling|math|question|memory|matching|card)s? games?\b/i;
const IN_WORDS = /\b(?:with|in|using) (?:\w+ )?words\b|\bword ?pictures?\b/i;
const CANVAS_REQUEST = {
  test: (request: string) =>
    !IN_WORDS.test(request) &&
    (CANVAS_WORDS.test(seenIn(request)) || (GAME_WORDS.test(request) && !GAME_IN_WORDS.test(request))),
};
/** A request for something the user does to it: tap, click, press, type in, drag, move by mouse or keys */
const ASKS_FOR_INPUT = /\b(?:tap(?:s|ping)?|click(?:s|ing)?|pressing|swipe|drag(?:ging)?|typ(?:e|ing) (?:in|into)|arrow keys|keyboard|mouse or touch|(?:with|by|using) (?:the |your )?mouse)\b/i;
/** What asks for something that changes by itself on screen */
const MOTION_REQUEST = /\b(?:animat\w*|bounc\w*|mov(?:ing|es)|spinn?(?:ing)?|rotating|orbit\w*|pulsing|blinking|flashing|falling|floating|flying|scrolling|count ?down|ticking)\b/i;
/** A program driven by the pointer or keys: what moves is up to the user */
const MOVES_WITH_USER = /\baddEventListener\s*\(\s*['"`](?:mouse|pointer|touch|key|wheel)\w*['"`]|\bon(?:mouse|pointer|touch|key|wheel)\w*\s*=/i;
const THREE_D_SCENE = /(?:\b3d\b|\bthree[- ]?d\b|\brender|\bscene|\bcube|\bsphere|\bwebgl|\brotat|\bspin|\borbit|THREE\.)/i;
const THREE_D_REQUEST = new RegExp(`${THREE_D_SCENE.source}|\\bgames?\\b`, 'i');
/**
 * The 3D rule: for a 3D scene or shape, not for every game. A game is drawn flat unless it asks for 3D ("a 3D
 * racing game"): "Make a snake game", a pong game and a tic-tac-toe game of tapped squares all got the 3D rule
 */
const THREE_RULE_REQUEST = THREE_D_SCENE;
const DIAGRAM_REQUEST = /\b(?:svg|diagram|icon|chart|graph|logo|vector|flowchart|map)/i;
/** Things that must appear on screen: an app, a form, a to-do list, a timer */
const INTERFACE_THING =
  /\b(?:app|calculator|converter|form(?!\s+of\b)|button|input|slider|todo|to-do|timer|stopwatch|count ?down|clock|dashboard|widget|tracker|quiz|counter|picker|toggle|checklist|planner|calendar|scoreboard|editor|menu|interface|ui)s?\b/i;
/** What the interface rule is for: the things above, the verbs that ask for something to look at, and what is tapped or played */
const INTERFACE_REQUEST = new RegExp(`${INTERFACE_THING.source}|\\b(?:form|list|table|page|show|display|game|keyboard|key)s?\\b|\\b(?:tap|click|press)\\w*`, 'i');
/** Anything shown on screen, which goes in the card (what the rules go by) */
const VISUAL_REQUEST = new RegExp([INTERFACE_REQUEST, DRAWING_REQUEST, THREE_D_REQUEST, DIAGRAM_REQUEST].map((r) => r.source).join('|'), 'i');
/** What must be on screen for the request to be done (what the outcome check goes by) */
const VISUAL_THING = new RegExp([INTERFACE_THING, DRAWING_REQUEST, THREE_D_REQUEST, DIAGRAM_REQUEST].map((r) => r.source).join('|'), 'i');
/** A request to see something (a verb for it, or the screen itself) */
const ASKS_TO_SEE = /\b(?:draw|paint|sketch|animat\w*|show|display|visuali[sz]\w*|illustrate|canvas|chart|plot|graph|screen|picture|image)\b/i;
/**
 * Whether the request names something to see. A request for sound whose only visual words are nouns
 * (a song's title: "Twinkle Twinkle Little Star", a "square" wave) asks for nothing to look at, unless it asks
 * to see something or names an interface, a diagram or a 3D scene.
 */
const namesVisualThing = (request: string): boolean =>
  VISUAL_THING.test(request) &&
  !(SOUND_WORDS_REQUEST.test(request) && !ASKS_TO_SEE.test(request) && !INTERFACE_THING.test(request) && !DIAGRAM_REQUEST.test(request) && !THREE_D_REQUEST.test(request));
/** A question or a look-up: asked as one ("Who was…", "…?"), or a look-up named outright */
/** Arithmetic ("15 percent of 84", "3 times 4"): worked out, not looked up */
const MATH_REQUEST = /\d\s*(?:%|percent|times|plus|minus|divided|squared|\*|\+|\/|x\s*\d)|\b(?:sum|average|square root) of\b/i;
/** Asked as a question ("Who won the game", "Why is the sky blue") or a look-up named outright */
const QUESTION_WORDS =
  /^\s*(?:who|what|when|where|why|which|how (?:many|much|old|tall|far|big|long))\b|\b(?:tell me about|look up|search for|find out|define|meaning of|capital of|population of|weather|news|wiki(?:pedia)?)\b/i;
const FACTS_WORDS = new RegExp(`${QUESTION_WORDS.source}|\\?\\s*$`, 'i');
const FACTS_REQUEST = {
  test: (request: string) => FACTS_WORDS.test(request) && !MATH_REQUEST.test(request) && !(WEATHER_TOPIC.test(request) && !WHO_WHY_WHEN.test(request)),
};
/** A question about the weather's history or causes ("Who invented the weather forecast?", "Why is snow white?"): facts, not today's weather */
const WHO_WHY_WHEN = /^\s*(?:who|why|when|which)\b/i;
/** The weather, here or somewhere: not snow or rain to draw ("Show a snowfall animation") */
const WEATHER_WORDS = /\b(?:weather|temperature|forecast|rain|rainy|raining|rains|snow|snowy|snowing|sunny|wind|windy|winds|humid\w*|umbrella|jacket|hot|cold|warm|chilly)\b/i;
/**
 * Writing about the weather, not asking for it: a piece to write, or a story or poem it goes in ("write one
 * sentence describing the weather in the opening of my novel" fetched the weather). Not a program written to
 * tell it ("Write a program that tells me the temperature in Oslo")
 */
const WRITES_ABOUT =
  /^\s*(?:please\s+)?(?:write|compose|draft)\b(?!(?:\s+\w+){0,3}\s+(?:code|program|app|script|function|widget|tool|page)s?\b)|\b(?:novel|story|stories|poem|chapter|essay|haiku|limerick|lyrics)\b/i;
const WEATHER_TOPIC = { test: (request: string) => WEATHER_WORDS.test(request) && !DRAWING_REQUEST.test(request) };
const WEATHER_REQUEST = { test: (request: string) => WEATHER_TOPIC.test(request) && !WRITES_ABOUT.test(request) };
/**
 * Something kept between visits: notes, a list, a name, a count. Not a bare "keep" or "notes" ("keep the ball
 * bouncing", the notes C, E and G), and not in a game or a drawing: the rule's example is a text field, which
 * has no place there ("a snake game that remembers my high score", "save it as a PNG")
 */
const SAVE_WORDS =
  /\b(?:sav(?:e|es|ed|ing)|remember\w*|keep (?:my|it|them|this)|kept|persist\w*|stor(?:e|es|ed|age)|still (?:be )?(?:here|there)|next time|come back|reload\w*|refresh\w*|clos(?:e|ing) (?:the |this )?(?:tab|page|app|browser)|my notes|take notes|notes app|sticky notes|notepad|to-?dos?|journal|diary|between visits)\b/i;
const SAVE_REQUEST = { test: (request: string) => SAVE_WORDS.test(request) && !DRAWING_REQUEST.test(request) };
/**
 * The saving rule, for text the user types: load it when the program starts, show it in a field, save it on
 * each change. The parse is in a try: the card's storage is shared by every card (javascript-runtime.ts
 * scopedStorageSource), and a value another program saved as plain text isn't JSON. Only the field's own
 * load and save: a pair without the field was pasted in alone, with nothing to type into (Qwen3 0.6B, 0 of 6
 * kept), and a count's line in a comment wasn't followed (0 of 4). The field is a textarea for both: the
 * element's name as a slot was left empty, createElement("") (2 of 2 notes runs)
 */
const SAVE_RULE = `- To keep what the user types between visits (a name, notes), load it when the program starts, show it in a field, and save it on each change:
\`\`\`js
const key = ""; // what is kept, like "name" or "notes"
let value = "";
try { value = JSON.parse(localStorage.getItem(key)) ?? value; } catch {}
const field = document.createElement("textarea");
field.value = value;
field.oninput = () => { value = field.value; localStorage.setItem(key, JSON.stringify(value)); };
document.body.appendChild(field);
\`\`\``;

/**
 * The weather rule: the place an empty slot for the model to fill, with nothing in its comment that reads as a
 * place (a placeholder name was copied as an undeclared variable; "for where the user is" was copied in)
 */
const WEATHER_RULE = `- For weather, getWeather gives the weather right now:
\`\`\`js
const place = ""; // the city asked about; leave "" when none is named
const { temperature, rain, sky } = await getWeather(place); // °C, mm of rain, and the sky in a word like "cloudy"
\`\`\``;

/** Data at a web address: an API, JSON, a URL to read (not a picture's address: the page can't show other sites' images) */
const FETCH_WORDS = /https?:\/\/|\b(?:apis?|json|endpoints?|web address|urls?|fetch(?:es|ing)? (?:the |some |a )?(?:data|json|info\w*|list|price|results?|joke|quote|fact)s?)\b/i;
const IMAGE_ADDRESS = /\b(?:picture|image|photo|img)s?\b|\.(?:png|jpe?g|gif|webp|svg)\b/i;
/** A question about APIs themselves ("What is an API?"), with no address to read: the facts rule's */
const ASKS_ABOUT_IT = /^\s*(?:what|why|how|explain|tell me about)\b/i;
const FETCH_REQUEST = {
  test: (request: string) => FETCH_WORDS.test(request) && !IMAGE_ADDRESS.test(request) && !(ASKS_ABOUT_IT.test(request) && !/https?:\/\//i.test(request)),
};
const FETCH_RULE = `- For data from a web address, fetch it and read its JSON:
\`\`\`js
const url = ""; // the address asked for
const data = await (await fetch(url)).json();
\`\`\``;

/** Copying text for the user to paste: not in a drawing ("copy the style of Picasso", "a copy of the Mona Lisa") */
const CLIPBOARD_WORDS = /\b(?:clipboard|paste|copy (?:button|link)|cop(?:y|ies|ied|ying) (?:it|this|that|them|the|my|to|into|with)|(?:to|can|and) copy)\b/i;
const CLIPBOARD_REQUEST = { test: (request: string) => CLIPBOARD_WORDS.test(request) && !DRAWING_REQUEST.test(request) };
const CLIPBOARD_RULE = `- To copy text for the user, write it to the clipboard when a button is clicked (browsers allow it only then):
\`\`\`js
const button = document.createElement("button");
button.textContent = "Copy";
button.onclick = () => navigator.clipboard.writeText(""); // the text to copy
document.body.appendChild(button);
\`\`\``;
/** Text to count, reverse or change. Not a letter written to someone ("copy editing tips for a cover letter" got it) */
const TEXT_REQUEST =
  /\b(?:words?|(?<!\b(?:cover|love|thank[- ]you|business|open|resignation|recommendation|reference|application) )letters?(?!\s+(?:to|for|from)\b)|characters?|sentences?|text|paragraph|revers\w*|backwards?|replac\w*|swap\w*|chang(?:e|es|ing)|upper ?case|lower ?case|capitali[sz]\w*|palindromes?|vowels?|consonants?|spell\w*|anagrams?)\b/i;
/**
 * Played with the keyboard: arrow keys, WASD, the space bar, a key pressed. Not a bare "key" or "keyboard": a
 * piano keyboard, the key of G and "three keys to" something matched those, and the model (Qwen3 0.6B) couldn't
 * tell them apart.
 */
const KEYS_REQUEST =
  /\b(?:arrow ?keys?|arrows|wasd|space ?bar|keystrokes?|key ?press(?:es)?|(?:press|hit|type)\w* (?:a |an |any |the |each |every )?(?:\w+ )?keys?|keys? (?:i|you|we) (?:press|hit|type)|steer\w*|(?:with|using|on) (?:the |my |your |a )?(?:computer )?keyboard)\b|\baddEventListener\s*\(\s*['"`]key/i;
/** Moved by the pointer: dragged, or following the mouse or a finger (not a bare "mouse": the animal, or one drawn). For the card rule only: a drag rule of its own did worse than none (Qwen3 0.6B) */
const DRAG_REQUEST =
  /\b(?:drag\w*|(?:follows?|following|chas\w+) (?:the |my |your )?(?:mouse|cursor|pointer|finger)|(?:with|by|using) (?:the |my |your |a )?(?:mouse|finger))\b|\baddEventListener\s*\(\s*['"`](?:pointer|mouse)move/i;
/** An element that changes by itself in CSS: fading, sliding, growing, pulsing (not "animate": that's mostly canvas motion, the canvas rule's) */
const CSS_MOTION_REQUEST =
  /\b(?:fad(?:e|es|ed|ing)|slid(?:e|es|ing)|puls(?:e|es|ing)|grow(?:s|ing)?|shrink\w*|transitions?|keyframes|css|wiggl\w*|shak(?:e|es|ing)|glow\w*|blink\w*|flash\w*|hover\w*)\b/i;
/**
 * Drawing words that also name a song or a sound: "Twinkle Twinkle Little Star", "Over the Rainbow", a square
 * wave, a drum pattern ("Play Twinkle Twinkle Little Star on the piano" got the drawing and card rules). Not a
 * bare pattern: "a drum machine with a pattern grid" is one to see
 */
const HEARD_WORDS = /\b(?:stars?|sky|skies|rainbows?|circles?|squares?|triangles?|shapes?|(?:drum|beat|rhythm|bass|note) patterns?)\b/gi;
/** One of those made or animated ("Make a star that twinkles to music"), which is to see: not a square wave */
const MAKES_SEEN_THING =
  /\b(?:make|create|build|animate|add)\s+(?:me\s+)?(?:(?:a|an|some|the)\s+)?(?:[\w'-]+\s+){0,2}?(?:stars?|sky|skies|rainbows?|circles?|squares?|triangles?|shapes?)\b(?!\s+waves?\b)/i;
/**
 * The request as the drawing and card rules read it: in a request for sound that asks to see nothing (no verb
 * for it, none of those words made, nothing tapped or dragged, no interface, diagram or 3D scene), those
 * words are left out, as namesVisualThing does for the outcome check. What moves ("a bouncing ball that beeps") is still drawn
 */
const seenIn = (request: string): string => {
  const { music, effects } = soundKinds(request);
  const heardOnly =
    (music || effects) && !ASKS_TO_SEE.test(request) && !MAKES_SEEN_THING.test(request) && !ASKS_FOR_INPUT.test(request) && !INTERFACE_THING.test(request) && !DIAGRAM_REQUEST.test(request) && !THREE_D_SCENE.test(request);
  return heardOnly ? request.replace(HEARD_WORDS, '') : request;
};
/** What the card rule is for: anything shown, and what is played with keys or the pointer or moves in CSS */
const CARD_WORDS = new RegExp([VISUAL_REQUEST, KEYS_REQUEST, DRAG_REQUEST, CSS_MOTION_REQUEST].map((r) => r.source).join('|'), 'i');
const CARD_REQUEST = { test: (request: string) => CARD_WORDS.test(seenIn(request)) };

/**
 * The rules, as bullets (small models copy numbering into their replies). A rule with `when` is
 * for some requests only: models with a small context (the smallest ones, on any device) get it
 * only when the request, or the program it changes, matches. Bigger models get every rule, the
 * same prompt each turn.
 */
const PROMPT_RULES: ReadonlyArray<{
  text: string;
  name?: RuleName;
  when?: { test(request: string): boolean };
  /** What in the program being changed calls for the rule, when that isn't its keywords (window has "wind", ctx.save() "save") */
  inProgram?: { test(program: string): boolean };
}> = [
  { text: '- ONLY return executable JavaScript: a simple, short, elegant program that does only what was asked (draw, build, play, compute, look up) with minimal code and complete functionality.' },
  { text: '- ONLY chat with user via the speak() function.' },
  { text: '- What you add to document.body appears in a card on screen.', name: 'card', when: CARD_REQUEST },
  { text: '- Use HTML and CSS for interfaces: buttons, forms, tables, dashboards and widgets.', name: 'ui', when: INTERFACE_REQUEST },
  { text: '- Use <canvas> for visuals: drawings, art, animations, games and simulations.', name: 'canvas', when: CANVAS_REQUEST },
  // Only for what moves: a board game or a still drawing given it wrote frame loops, elapsed time and
  // movement for things that never move (Qwen2.5 0.5B, a two-player game of taps)
  {
    text: "- For motion, keep each thing's position and speed in variables, and move and redraw it in one requestAnimationFrame loop.",
    when: { test: (request: string) => DRAWING_REQUEST.test(request) && MOTION_REQUEST.test(request) },
  },
  // Steps in words, no code: tested on five 3D requests (Qwen3 0.6B, twice each), every reply put the canvas on the
  // page, added its mesh and rendered, where a code example was copied (its cube) and lost the render loop
  {
    text: "- For 3D, THREE (three.js) is ready to use: make a THREE.Scene, a THREE.PerspectiveCamera and a THREE.WebGLRenderer, put the renderer's canvas on the page with document.body.appendChild(renderer.domElement), add each object with scene.add(new THREE.Mesh(geometry, material)) using the geometry of the shape asked for, and call renderer.render(scene, camera) in a requestAnimationFrame loop.",
    name: 'three',
    when: THREE_RULE_REQUEST,
  },
  { text: '- <svg> works for diagrams and icons.', name: 'svg', when: DIAGRAM_REQUEST },
  {
    text: MIDI_RULE,
    name: 'music',
    when: { test: (request: string) => soundKinds(request).music },
  },
  {
    text: '- Beeps, tones and sound effects use Web Audio (new AudioContext(), oscillators, gain, each connected to its destination).',
    name: 'fx',
    when: { test: (request: string) => soundKinds(request).effects },
  },
  { text: '- Answer what you know directly. For facts you lack, fetch a public API that allows cross-origin requests, such as Wikipedia (https://en.wikipedia.org/api/rest_v1/page/summary/<title>), and speak a sentence or two of it.', name: 'facts', when: FACTS_REQUEST },
  // Without it, small models wrote in an answer they made up ("Word count: 10", the word reversed wrong) instead of
  // working it out: on a word count, a reversal and a find-and-replace, twice each, Qwen3 0.6B ran clean 4 times in 6
  // and got none right, and with it 11 in 12, 7 right (Qwen2.5 0.5B: 5 in 6 without, 6 in 6 with)
  { text: '- For text tools (counting words, reversing, replacing), put the text from the request in a string and speak the result of its string methods, such as split, reverse, join and replaceAll.', name: 'text', when: TEXT_REQUEST },
  // Tested through the pipeline against no rule (Qwen3 0.6B): keys, 5 of 20 programs moved something when keys were
  // pressed, against 0 of 20, with as many first programs running clean; CSS motion, 17 of 17 ran clean against 15
  { text: '- For keyboard control, listen for "keydown" on document and check event.key ("ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d", " " for space).', name: 'keys', when: KEYS_REQUEST },
  { text: '- For page elements that fade, slide, grow or pulse, use CSS: a transition on opacity or transform, or a @keyframes animation.', name: 'css', when: CSS_MOTION_REQUEST },
  // Saving and the weather: empty slots for the model to fill (examples with values in them were copied). Scored on
  // the job done, not a clean run alone: what was typed is back after a reload, the temperature spoken is the one
  // fetched for the place asked about. Saving, Qwen3 0.6B 5 of 8 against 0 of 8 without (Qwen2.5 0.5B 0 of 8 either
  // way); weather, Qwen3 4 of 6 against 0 of 6, Qwen2.5 2 of 6 against 0 of 6 (without it, both made a forecast up).
  // A dates rule did no better than none (2, 2 and 0 of 8 against 2 of 8, Qwen3) and was left out
  { text: SAVE_RULE, name: 'save', when: SAVE_REQUEST, inProgram: /\blocalStorage\b/ },
  { text: WEATHER_RULE, name: 'weather', when: WEATHER_REQUEST, inProgram: /\bgetWeather\b/ },
  // Data from a web address and the clipboard, by keywords alone (no per-model cutoffs: one rule set for every
  // model). Scored on the first program's real job, three requests three times each, with and without the rule:
  // fetch, the value asked for (not the JSON dumped) spoken from the fetched reply, Qwen2.5 0.5B 5 of 9 against
  // 1 of 9, Qwen3 0.6B 0 of 9 either way (both wrote "[object Object]" or guessed a field); clipboard, the text
  // asked for on the clipboard after a click on the copy button, Qwen3 3 of 9 against 1 of 9, Qwen2.5 3 of 9
  // against 0 (all on "copies 'hello world'": a password or a quote with a copy button got none either way).
  // Left out, no better than none: clicks and typing (Qwen3 3 of 6 either way, Qwen2.5 1 of 6 against 2) and
  // timers (an empty setInterval; 6 of 24 against 5 of 24 in all, the model filling the tick with a constant), and
  // making each field the program reads (createElement, then append it) for converters and forms: typing in the
  // field changed the output 6 of 18 times against 5 of 18 (Qwen3.5 2B 2 against 3), within noise
  { text: FETCH_RULE, name: 'fetch', when: FETCH_REQUEST, inProgram: /\bfetch\s*\(/ },
  { text: CLIPBOARD_RULE, name: 'clipboard', when: CLIPBOARD_REQUEST, inProgram: /\bnavigator\.clipboard\b/ },
];

/** The optional rules a request's keywords put forward */
export function rulesNamedBy(request: string): Set<RuleName> {
  return new Set(PROMPT_RULES.filter((rule) => rule.name && rule.when?.test(request)).map((rule) => rule.name as RuleName));
}

/**
 * The rules for a request: all of them, or (filter) only those it needs, by their keywords in the
 * request or the program it changes (`program`). The same for every model: a model once confirmed
 * some rules by a scored yes/no, above cutoffs fitted for each model, so two models picked differently
 */
export function promptRules(request = '', filter = false, program = ''): string {
  const needed = (rule: (typeof PROMPT_RULES)[number]): boolean => {
    if (!rule.when) return true;
    if (program !== '' && (rule.inProgram ?? rule.when).test(program)) return true;
    // The request comes with the program after it (staticPromptParts): a rule with its own program test goes by the request alone
    return rule.when.test(rule.inProgram && program !== '' && request.endsWith(program) ? request.slice(0, -program.length) : request);
  };
  const rules = PROMPT_RULES.filter((rule) => !filter || needed(rule));
  return [
    'Context:',
    "You are an assistant that acts by writing JavaScript: your reply runs as one program in the user's browser.",
    'Rules:',
    ...rules.map((rule) => rule.text),
  ].join('\n');
}


/**
 * The example exchange once sent before the conversation to show the reply format. None now: the
 * system prompt's Output section states the format, and the example's speak-only reply ("Hi!" →
 * speak("Hi! What would you like me to make?")) had small models answer music requests with a
 * speak() line alone (Qwen3 0.6B, Twinkle and a drum beat: speak-only every time with it, programs
 * without it) and copy its question into programs.
 */
export const FORMAT_TURNS: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }> = [];

/** The example reply's question, still recognised when a model or an older chat repeats it */
const EXAMPLE_QUESTION = 'Hi! What would you like me to make?';

/** What the app says as it greets (the first time, and after): in the chat, so a small model copies them into its program */
export const WELCOME_MESSAGE = 'Welcome to Chatty, I can do anything your browser can do.';
export const WELCOME_BACK_MESSAGE = 'Welcome back, what would you like to do with this browser?';

/** What the example reply says (FORMAT_TURNS) and the app's greetings: a program that copies one into itself doesn't mean it */
const EXAMPLE_SPOKEN = [
  EXAMPLE_QUESTION,
  WELCOME_MESSAGE,
  WELCOME_BACK_MESSAGE,
];

/**
 * Before a program runs: a speak() of the example reply's own words, in a program that does
 * something else too, is taken out (small models copy the example into their program)
 */
export function dropCopiedExample(code: string): { code: string; dropped: boolean } {
  const lines = code.split('\n');
  // A line that says the example's words, or most of them in a row (the greeting dropped: "What
  // would you like me to make?"), in other case or punctuation
  const copied = (line: string) => {
    const spoken = line.match(/^\s*speak\((["'`])(.*)\1\);?\s*$/)?.[2];
    if (spoken === undefined) return false;
    const said = flatText(spoken);
    return !!said && EXAMPLE_SPOKEN.some((text) => flatText(text) === said || (` ${flatText(text)} `.includes(` ${said} `) && said.split(' ').length >= flatText(text).split(' ').length * 0.6) || closeVariant(said, flatText(text)));
  };
  // The same words in another order or with a few changed ("Let me know what you'd like me to make!" for "Hi! What
  // would you like me to make?"): most of the example's words are in it, and no more than three of its own are other words
  const closeVariant = (said: string, example: string) => {
    const mine = new Set(said.split(' '));
    const theirs = new Set(example.split(' '));
    const shared = [...theirs].filter((word) => mine.has(word)).length;
    return shared >= 4 && shared / theirs.size >= 0.6 && mine.size - shared <= 3;
  };
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
/** A program that waits for the user: handlers for the events a key, a tap, a click or an input fires */
const LISTENS_FOR_USER =
  /\baddEventListener\s*\(\s*['"`](?:click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|touchend|keydown|keyup|keypress|input|change|submit)['"`]|\bon(?:click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|touchend|keydown|keyup|keypress|input|change|submit)\s*=/i;

/**
 * What the outcome check is for: a request to make or show something, not a question or a phrase
 * that names one ("who won the game", "speed of sound", "nearest star"), which a spoken answer
 * completes. "Can you draw a cat?" and "draw a 3x3 grid" are requests. So is any instruction
 * that says what the user will tap, click or type ("Roll a die when I tap a button"): there is
 * something on screen for that.
 */
const asksForOutcome = (request: string) =>
  (ACTION_REQUEST.test(request) || /\b(?:show|display)\b/i.test(request) || (STARTS_WITH_ACTION.test(request.trim()) && ASKS_FOR_INPUT.test(request))) && !QUESTION_WORDS.test(request);
/** A request that begins with an imperative verb: the user is asking for something to be done ("Flip a coin", "Roll two dice") */
const STARTS_WITH_ACTION =
  /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:play|draw|make|build|create|animate|code|program|design|generate|paint|sketch|render|chart|plot|graph|show|display|simulate|write|calculate|compute|convert|flip|roll|pick|choose|list|count|start|set|run|open|find|give|tell|add|remove|clear|change|turn|sort|shuffle|spin|throw)\b/i;
/** Whether a request is an instruction (something to make or do), not a phrase whose spoken echo is the answer ("Happy birthday to you") */
export const isInstruction = (request: string): boolean => asksForOutcome(request) || STARTS_WITH_ACTION.test(request.trim());
/** Goes with the retry only (not into history) */

/** How many times the model may try to fix one request's program */
/**
 * The most replies the model gets to fix one request: each is a try, whether it asks a new
 * question (the line, the whole function, the blank) or the same one again sampled differently
 */
const MAX_FIX_TRIES = 5;
/**
 * Tries in a row that don't improve on the best version so far before Chatty stops early: by
 * then each kind of question has had its turn (the blank, the line, the function, the whole
 * program; the fifth only asks the line again), and each try costs a reply. See recordRun.
 */
const FIX_PATIENCE = 4;

/** A program that never ran: a syntax error, or no program at all */
const NOTHING_RAN = /SyntaxError|Unexpected (?:token|end|identifier|string|number|keyword|character)|Invalid or unexpected token|Unterminated|missing \) after|The reply had no program/i;
/** The outcome check's errors: it ran without an error, but did nothing that was asked */
const OUTCOME_MISSING = /^The program (?:played nothing|showed nothing)|^The program's sound never reached/;

/**
 * How far a run got, so a fix loop keeps the best version (after RePair, Findings of ACL 2024:
 * score every attempt, keep going only while it improves, and roll back to the best). Higher is
 * better: 4 ran and did what was asked; 3 failed but did some of it (drew the scene, played
 * notes); 2 ran without an error but did nothing asked; 1 failed with nothing asked done; 0 never
 * ran. Only a higher score counts as progress.
 */
export function runScore(error: string | null, didAsked: boolean): number {
  if (!error) return 4;
  if (NOTHING_RAN.test(error)) return 0;
  if (didAsked) return 3;
  return OUTCOME_MISSING.test(error) ? 2 : 1;
}
/**
 * A line fix whose reply is unchanged or unusable is asked for again at once (this many times,
 * sampled differently) within the same try: a one-line reply is quick, so it costs no try of its
 * own. Every other kind is asked once per try, and each try asks a new question (see fixSampling).
 */
const LINE_FIX_REASKS = 2;
/**
 * The questions a fix can ask, in the order each try takes the next one that fits: the blank
 * (fill in the failing expression; the member blank first, a choice among the real members of an
 * object that lacks the one used), the marked line, the line that makes the value the error is
 * about (when that is another line), the whole function, the whole program, and the line once
 * more, told the replies that didn't work. A large model starts with the line.
 */
type FixKind = 'member' | 'blank' | 'line' | 'made' | 'function' | 'program' | 'different';
const FIX_ORDER_SMALL: ReadonlyArray<FixKind> = ['member', 'blank', 'line', 'made', 'function', 'program', 'different'];
const FIX_ORDER_LARGE: ReadonlyArray<FixKind> = ['line', 'made', 'function', 'member', 'blank', 'program', 'different'];
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
/** An error that is endless recursion (Chrome and Safari; Firefox) */
const RECURSION = /Maximum call stack size exceeded|too much recursion/;

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

/**
 * A reply that didn't work, as the one short line the fix request lists ("Write a fix different
 * from these"): what it changed, else its first line of code. A reply that began with the
 * program's own first line, unchanged, says nothing about what was tried (a whole program sent
 * back as it was), so it is no entry. A line is cut to about 100 characters (one of escaped HTML
 * is far more than the model needs to avoid repeating it).
 */
export function failedReplyLine(original: string | undefined, changed: string, reply: string): string {
  const cut = (line: string) => (line.length > FAILED_LINE_MAX ? `${line.slice(0, FAILED_LINE_MAX - 1)}…` : line);
  if (changed) return cut(changed);
  const first = reply.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//') && !l.startsWith('```'));
  if (!first || (original !== undefined && first === original.split('\n').map((l) => l.trim()).find((l) => l))) return '';
  return cut(first);
}
const FAILED_LINE_MAX = 100;

/** An error message as one key: the same error with other line numbers or values is the same */
export function normalizedError(error: string): string {
  return error.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 120);
}

type FixError = { attempt: number; error: string; line?: number };

/**
 * What a request needs a program to go on doing, each with the browser calls that do it. A fix
 * that takes out every call of a kind the request asks for, and the program had, can't be what
 * was asked: it makes the error go away by deleting the part that failed (a music program
 * "fixed" into a <div>). A fix that keeps any of them is judged by running it, as before.
 */
const CAPABILITIES: ReadonlyArray<{ name: string; asks: (request: string) => boolean; calls: RegExp }> = [
  {
    name: 'sound',
    asks: (r) => SOUND_WORDS_REQUEST.test(r),
    calls: /\.send\s*\(|\bAudioContext\b|\.createOscillator\s*\(|\brequestMIDIAccess\b|\bTone\s*\.|\bplayNotes\s*\(|\.play\s*\(|\bnew\s+Audio\s*\(|\bspeechSynthesis\b/,
  },
  {
    name: 'drawing',
    asks: (r) => DRAWING_REQUEST.test(r) || THREE_D_REQUEST.test(r) || DIAGRAM_REQUEST.test(r),
    calls: /\bgetContext\s*\(|\.(?:fillRect|strokeRect|fillText|strokeText|arc|lineTo|drawImage|ellipse|rect)\s*\(|<svg|\bcreateElementNS\s*\(|\bTHREE\b/,
  },
  {
    name: 'page',
    asks: (r) => INTERFACE_THING.test(r),
    // (text set on an element builds the page too: a fix that turns innerHTML into textContent keeps it)
    calls: /\bcreateElement\s*\(|\binnerHTML\b|\binsertAdjacentHTML\b|\.(?:append|appendChild|prepend|replaceChildren)\s*\(|\.(?:textContent|innerText)\s*=/,
  },
  {
    name: 'controls',
    asks: (r) => INTERFACE_THING.test(r) || /\bgames?\b/i.test(r),
    calls: /\baddEventListener\s*\(|\.on(?:click|dblclick|input|change|submit|keydown|keyup|pointerdown|pointermove|mousedown|mousemove|touchstart|touchmove)\s*=|\son(?:click|input|change|submit)\s*=/,
  },
  {
    name: 'motion',
    asks: (r) => /\b(?:animat\w*|bounc\w*|moving|spin\w*|rotat\w*|orbit\w*|games?|count ?down|timer|clock|stopwatch)\b/i.test(r),
    calls: /\brequestAnimationFrame\s*\(|\bsetInterval\s*\(|\bsetTimeout\s*\(|\.animate\s*\(|@keyframes|\btransition\b/,
  },
];

/** The kinds of thing the request asks for that the original program did and the fix no longer does at all */
export function droppedCapabilities(request: string, original: string, fixed: string): string[] {
  if (!request || !asksForOutcome(request)) return [];
  const before = stripComments(original);
  const after = stripComments(fixed);
  return CAPABILITIES.filter((c) => c.asks(request) && c.calls.test(before) && !c.calls.test(after)).map((c) => c.name);
}

/**
 * Why a fix can't be used, or null: it lost the program (became chat or a bare speak(), stopped
 * drawing what the program drew, or dropped the function it was asked for), changed nothing (edits
 * that matched nothing would only repeat the error), or came back cut off (doesn't parse)
 */
async function unusableFix(
  original: string,
  fixedProgram: string,
  code: string,
  functionName?: string,
  request = ''
): Promise<'lost' | 'unchanged' | 'incomplete' | null> {
  const dropped = !!functionName && !new RegExp(`\\bfunction\\s+${functionName.replace(/\$/g, '\\$')}(?![\\w$])`).test(code);
  // Judged without its comments: a reply of only comments (`// Solution: append a <div>…`) is no program
  const program = stripComments(code).trim();
  // (a question's answer is talk alone, when the reply it replaces had no program to lose either)
  const answers = isQuestion(request) && !asksForOutcome(request) && isTalkOnly(stripComments(original).trim()) && !saysQuestionBack(program, request);
  // (a reply that is prose with its code in backticks parses as one template string: not a program)
  if (!program || (isTalkOnly(program) && !answers) || (programDraws(original) && !programDraws(program)) || dropped || (isBareText(program) && !answers)) return 'lost';
  // It took out everything of a kind the request needs (all the sound of a song): see CAPABILITIES
  if (droppedCapabilities(request, original, code).length > 0) return 'lost';
  if (stripComments(fixedProgram).replace(/\s+/g, '') === stripComments(original).replace(/\s+/g, '')) return 'unchanged';
  if ((await syntaxErrorLine(code)) !== undefined) return 'incomplete';
  return null;
}

/**
 * How long a fix reply may be: about twice what it replaces, plus room for its Cause line (a
 * small model can otherwise ramble or repeat until the output limit, a minute on a phone)
 */
/** The least room a whole program asked for again gets (fixReplyTokens) */
const WHOLE_FIX_MIN_TOKENS = 700;

export function fixReplyTokens(program: string, line: number | undefined, block: { start: number; end: number } | undefined, max: number): number {
  const lines = program.split('\n');
  const replaced = block ? lines.slice(block.start - 1, block.end).join('\n') : line ? (lines[line - 1] ?? '') : program;
  // About 3 characters a token for code. A whole program asked for again is a new one, whatever the
  // failed one's length: a 4-line program that did nothing got 290 tokens, and every rewrite of it as
  // the app asked for was cut off before its end
  const floor = block || line ? 160 : WHOLE_FIX_MIN_TOKENS;
  return Math.min(max, Math.max(floor, Math.round((replaced.length / 3) * 2) + 120));
}

/**
 * The browser calls that put something on the page (or draw on it): a program that showed nothing
 * and has none of them has nothing a fix could correct
 */
const ADDS_TO_PAGE =
  /\b(?:appendChild|append|prepend|insertAdjacent(?:HTML|Element|Text)|replaceChildren|replaceWith|innerHTML|outerHTML|textContent|innerText|getContext|THREE)\b|document\.write|\broot\b/;

/**
 * Whether the page is being painted: an animation frame arrives soon. A page nobody sees (a hidden
 * pane, a covered or background window) gets none, whatever its visibility state says, and then
 * nothing that runs on frames can be judged: the check says only what it saw.
 */
async function framesArrive(): Promise<boolean> {
  if (typeof requestAnimationFrame !== 'function') return true;
  return Promise.race([new Promise<boolean>((resolve) => requestAnimationFrame(() => resolve(true))), settle(700).then(() => false)]);
}

/**
 * Whether the card keeps changing by itself: its text, its markup or a canvas's pixels (see
 * pageSignature) differ at least twice within about four seconds. A card that did not, with a timer,
 * an interval or an animation frame still pending, is not shown to be wrong (a countdown of days
 * ticks every second and the text stays; a light blinks every two seconds; "count down from 2"
 * ends): the pending work counts as updating. A page that can't be read, or isn't watched
 * (hidden), counts as moving too: the check says only what it saw.
 */
async function screenChanges(runtime: Pick<JavascriptRuntime, 'pageSignature'> & { hasScheduledWork?: () => boolean }): Promise<boolean> {
  const read = () => runtime.pageSignature?.() ?? null;
  let last = read();
  if (last === null) return true;
  let changes = 0;
  for (let waited = 0; waited < 3600; waited += 300) {
    await settle(300);
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return true;
    const now = read();
    if (now === null) return true;
    if (now !== last && ++changes >= 2) return true;
    last = now;
  }
  return !!runtime.hasScheduledWork?.();
}

/**
 * What the drawing calls of a canvas that shows nothing say about why, from where they landed: under no
 * transform, a kind of call whose every box is past the canvas's edge ("every arc() is drawn at x
 * 2100–2600, outside the 390×700 canvas: what is drawn has left it"). Under a transform the
 * coordinates are not the canvas's own: only that nothing drawn is visible. Null when there is no trace.
 */
export function offCanvasFact(traces: CanvasTrace[]): string | null {
  const trace = traces.find((t) => t.kinds.length > 0);
  if (!trace) return null;
  if (trace.nonIdentity > 0) return 'Nothing drawn is visible on the canvas.';
  const range = (a: number, b: number) => (Math.round(a) === Math.round(b) ? `${Math.round(a)}` : `${Math.round(a)}–${Math.round(b)}`);
  const facts: string[] = [];
  for (const kind of trace.kinds) {
    const sides: string[] = [];
    if (kind.maxX < 0 || kind.minX > trace.width) sides.push(`x ${range(kind.minX, kind.maxX)}`);
    if (kind.maxY < 0 || kind.minY > trace.height) sides.push(`y ${range(kind.minY, kind.maxY)}`);
    if (sides.length > 0) facts.push(`every ${kind.kind}() is drawn at ${sides.join(' and ')}, outside the ${trace.width}×${trace.height} canvas`);
  }
  return facts.length > 0 ? `${facts[0].charAt(0).toUpperCase()}${facts.join('; ').slice(1)}: what is drawn has left it.` : 'Nothing drawn is visible on the canvas.';
}

/**
 * For a program that keeps drawing on a 2D canvas: whether anything is visible on it at the end of
 * the check window (about a second after the run started), judged by its picture (a 24 × 24 look:
 * one flat color, or nothing, is nothing seen) over a few samples. The text for the outcome check
 * when nothing is, with where the drawing calls landed when they can say; null when something is,
 * when the canvas isn't being drawn on any more (a drawing that is made once is judged by its
 * drawing calls), or when the page can't say.
 */
async function nothingLands(runtime: Pick<JavascriptRuntime, 'canvasState' | 'seenNow' | 'traceDrawing'>): Promise<string | null> {
  if (!runtime.canvasState || !runtime.seenNow || !runtime.traceDrawing) return null;
  const before = runtime.canvasState();
  if (before.length === 0) return null;
  await settle(250);
  const after = runtime.canvasState();
  // (a page that isn't shown draws no frames: nothing to judge)
  if (!after.some((canvas, i) => canvas.calls > (before[i]?.calls ?? 0))) return null;
  // The end of the window: the things that leave in under a second have left by now
  await settle(900);
  for (let sample = 0; sample < 3; sample++) {
    if (runtime.seenNow()) return null;
    if (sample < 2) await settle(120);
  }
  const fact = offCanvasFact(await runtime.traceDrawing(300));
  appendRunLog('retry', 'outcome check: the canvas is drawn on all the time but shows nothing at the end');
  return `Nothing the program draws is visible on its canvas at the end (it is blank or one flat color), though it keeps drawing on it.${fact ? ` ${fact}` : ''}`;
}

/**
 * Whether a failure may come from a name read off an element or event that the object doesn't have: a value that
 * shows NaN or undefined, an outcome check that failed (nothing shown, nothing happening), or an error that is
 * about a missing property
 */
export function readsMayExplain(error: string | null): boolean {
  return !!error && (/NaN|undefined|Infinity|Cannot read prop|is not a function/.test(error) || /^(?:The program (?:played nothing|showed nothing|put nothing visible)|The page has nothing|The screen never changed|Nothing the program draws)/.test(error));
}

/** A reply that left nothing to run */
const NO_PROGRAM = 'The reply had no program in it';
const SAID_BACK = 'The reply only said the question back to the user, with no answer';

/** Text as its words only: case, punctuation and spacing aside */
const flatText = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** A real question: it ends in ? or begins with a question word, and has three words or more ("hello" is a greeting) */
export function isQuestion(request: string): boolean {
  const words = flatText(request);
  return words.split(' ').length >= 3 && (/\?\s*$/.test(request.trim()) || /^(?:who|what|when|where|why|how|which|whose|is|are|was|were|do|does|did|can|could|will|would|should)\b/.test(words));
}

const COPIED_QUESTION = "The reply only asked the example's question again (what would you like me to make?) instead of doing the request";

/**
 * Whether a program that only talks asks the example reply's own question (FORMAT_TURNS) in one of
 * its sentences, alone or after the request's words: speak("Play a simple drum beat. What would
 * you like me to make?"). Asked of a user who has just said what they want (three words or more:
 * a greeting is answered with the example's own), that question asks nothing.
 */
export function onlyAsksExample(code: string, request: string): boolean {
  if (flatText(request).split(' ').length < 3) return false;
  const says = /(?:speak|alert|console\.log)\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1\s*\)\s*;?/g;
  const body = stripComments(code);
  const said = Array.from(body.matchAll(says), (m) => flatText(m[2]));
  if (said.length === 0 || body.replace(says, '').trim() !== '') return false;
  const questions = EXAMPLE_SPOKEN.map((text) => flatText(text.replace(/^[^?.!]*[.!]\s*/, '')));
  return said.some((text) => questions.some((question) => question.split(' ').length >= 4 && text.includes(question)));
}

/**
 * Whether a program that only talks says nothing but the user's own question back (speak("Who was
 * Ada Lovelace?") for "Who was Ada Lovelace?"): that asks nothing of the user, it answers nothing.
 * Sure only for a real question (it ends in ? or begins with a question word, three words or more:
 * "hello" answered "hello" is a greeting), and when everything the program does is say the
 * question itself, whatever its case and punctuation.
 */
export function saysQuestionBack(code: string, request: string): boolean {
  const asked = flatText(request);
  if (!isQuestion(request)) return false;
  // What a program says: speak(), and console.log() or alert(), which the sandbox speaks too
  const says = /(?:speak|alert|console\.log)\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1\s*\)\s*;?/g;
  const body = stripComments(code);
  const said = Array.from(body.matchAll(says), (m) => flatText(m[2]));
  return said.length > 0 && body.replace(says, '').trim() === '' && said.every((text) => text === asked);
}

/**
 * Words that say nothing of an answer: the question's own grammar (what, is, of, the), who is asking (you, my), and
 * talk about the asking ("You asked what is half of three quarters."). "Which" is not one: "Which Ada do you mean?"
 * asks the user to choose.
 */
const NO_ANSWER_WORDS = new Set(
  (
    'a an the and or but if so then than to of in on at for from with by about as into over under up down out ' +
    'what who whom whose when where why how is are was were be been being am do does did done can could will would should shall may might must ' +
    'i me my mine we us our you your yours it its s t re ll ve d m that this these those there here ' +
    'ask asks asked asking question questions let lets tell know'
  ).split(' ')
);
/** A question answered yes or no ("is 91 a prime number", "should I bring a jacket today?") */
const YES_NO_QUESTION = /^\s*(?:is|are|was|were|am|do|does|did|can|could|will|would|should|shall|has|have|had)\b/i;
/** A question that offers the answers: "which …", "whether …", "… or …" */
const CHOICE_QUESTION = /^\s*(?:which|whether)\b|\bor\b/i;

/**
 * What a question's run said, when it says nothing but the question again: every word it spoke is a word of
 * the request or one of NO_ANSWER_WORDS, and it spoke at least one of the request's own words. Qwen3 0.6B,
 * "should I bring a jacket today?": getWeather was called, then speak("Should I bring a jacket today?"); "what's
 * 15% of 80": the result logged, then speak("What's 15% of 80?") (a program that speaks doesn't have its logs
 * read out); "what is half of three quarters": speak("You asked what is half of three quarters."). Any word of
 * its own (a number, a name, "yes") is an answer of some kind and stays. Only for a question (see isQuestion)
 * that asks for nothing to be made (see asksForOutcome).
 */
export function onlyRestates(request: string, spoken: string[]): string | null {
  if (!isQuestion(request) || asksForOutcome(request)) return null;
  const said = flatText(spoken.join(' '));
  if (!said) return null;
  const asked = new Set(flatText(request).split(' '));
  // A yes-or-no question is answered in its own words, said as a statement ("91 is a prime number." for "is 91 a
  // prime number", Qwen3.5 2B; wrong, but an answer): only said as a question again is it no answer
  // So is a choice between things it names ("Which is bigger, 7 or 9?": "9 is bigger."; "Is 7 odd or even?": "7 is odd.")
  const answeredInItsWords = YES_NO_QUESTION.test(request) || CHOICE_QUESTION.test(request);
  if (answeredInItsWords && !spoken.every((text) => !text.trim() || /\?\s*$/.test(text.trim()))) return null;
  const words = said.split(' ');
  if (!words.every((word) => asked.has(word) || NO_ANSWER_WORDS.has(word))) return null;
  if (!words.some((word) => asked.has(word) && !NO_ANSWER_WORDS.has(word))) return null;
  return spoken.map((text) => text.trim()).filter(Boolean).join(' ');
}

/** The numbers written in a text, as numbers ("15%" is 15, "1,000" is 1000; "1st" and "mp3" are not numbers) */
const numbersIn = (text: string): number[] =>
  Array.from(text.replace(/(\d),(?=\d{3}(?!\d))/g, '$1').matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w])/g), (m) => Number(m[0]));

/** A speak() with no words: speak(), speak(''), speak("") */
const EMPTY_SPEAK = /\bspeak\(\s*(?:(["'`])\1\s*)?\)/;
/** What a program that says nothing may still be doing: waiting (a timer, a tap, a key), keeping something (the clipboard, storage, a download), or fetching, playing or asking */
const ACTS_WITHOUT_WORDS =
  /\b(?:setTimeout|setInterval|requestAnimationFrame|clipboard|localStorage|sessionStorage|indexedDB|download|fetch|XMLHttpRequest|getWeather|searchWikipedia|playNotes|prompt|confirm)\b/;

/**
 * A run that said nothing when it meant to: every speak() was empty, as the program calls speak() with no words.
 * Qwen3 0.6B wrote `speak();` alone for "write a four-line poem about autumn" (its own speak function, which logged
 * the poem, taken out as a copy of the ready-made one), and console.log("…") then speak() for "a haiku about the
 * sea" (a program that speaks doesn't have its logs read out). Not a program that waits, keeps something, fetches
 * or plays (see ACTS_WITHOUT_WORDS, LISTENS_FOR_USER): it has done or will do something without words. The caller
 * judges it only when the card shows nothing and nothing played either.
 */
export function saidNothing(code: string, spoken: string[]): string | null {
  if (spoken.some((text) => text.trim()) || !EMPTY_SPEAK.test(code)) return null;
  if (LISTENS_FOR_USER.test(code) || ACTS_WITHOUT_WORDS.test(code)) return null;
  return `The program said nothing: speak() was called with no words${
    /\bconsole\.log\s*\(/.test(code) ? ", and what console.log() writes isn't read out in a program that speaks" : ''
  }. Put the reply in it: speak("…").`;
}

/** What a card that shows nothing is told: what was empty, and how something shows */
const nothingVisible = (emptied: string[]) =>
  `The program put nothing visible on screen: its canvas has nothing drawn on it, or its elements are empty${emptied.length ? ` (${emptied.join(', ')} have no text and no size)` : ''}. Put text in an element (textContent, innerHTML) or give it a size (a style with width and height), or draw with the 2d context (fillRect, arc, lineTo, fill, stroke, fillText) in a function that is called.`;

/** A temperature a reply states: a number with a degree sign or word after it ("12.5 degrees", "18°C", "-3 °F") */
const STATED_TEMPERATURE = /(?<![\w.])(-|−|minus\s+)?(\d+(?:\.\d+)?)\s*(?:[°º]\s?[CF]?\b|[°º℃℉]|degrees?\b|deg\b|celsius\b|fahrenheit\b)/gi;
/** The weather as it is now (or today), asked for: what a temperature can only be read from */
const CURRENT_WEATHER = /\b(?:weather|forecast|now|today|tonight|outside|currently)\b/i;
/** The weather in general (a season, a month, on average, on another planet): the climate, which facts answer */
const CLIMATE =
  /\b(?:usually|usual|average|typical|typically|normally|climate|record|ever|winters?|summers?|spring|autumn|fall|january|february|march|april|may|june|july|august|september|october|november|december|mars|venus|moon|sun|space)\b/i;

/** The number literals of a program outside its strings (a threshold it compares with: temperature < 15), or null when it doesn't parse */
function codeNumbers(code: string): number[] | null {
  try {
    const found: number[] = [];
    for (const token of tokenizer(code, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true })) {
      const value = (token as { value?: unknown }).value;
      if (token.type.label === 'num' && typeof value === 'number') found.push(value);
    }
    return found;
  } catch {
    return null;
  }
}

/**
 * A temperature the reply to a weather question states that no look-up gave. Qwen3.5 2B, "how hot is it in Tokyo
 * right now?": getWeather('Tokyo') was awaited, then speak("It is currently 25 degrees Celsius in Tokyo, with clear
 * skies and no rain.") (the reading was 12.5). A temperature counts as read when it is within a degree of one that
 * getWeather() gave or a fetched reply held (rounded, cut to whole degrees), in °F or from kelvin too. One the
 * request names ("is 20 degrees warm?") or that the code compares with (temperature < 15: "below 15 degrees") is no
 * reading. With nothing looked up at all, only for the weather as it is now ("What's the weather in Berlin?"): a
 * question about the climate ("How cold is Moscow in winter?", "the temperature on Mars") is answered from facts.
 */
export function madeUpWeather(
  request: string,
  code: string,
  spoken: string[],
  lookedUp: { weather: Array<number | null>; requests: number; numbers: number[] }
): string | null {
  if (!WEATHER_REQUEST.test(request)) return null;
  const named = new Set(numbersIn(request));
  const stated = Array.from(spoken.join(' ').matchAll(STATED_TEMPERATURE), (m) => ({ text: m[0].trim(), value: (m[1] ? -1 : 1) * Number(m[2]) })).filter(
    (t) => !named.has(Math.abs(t.value))
  );
  if (stated.length === 0) return null;
  const readings = [...lookedUp.weather.filter((t): t is number => typeof t === 'number'), ...lookedUp.numbers];
  const asRead = (value: number) =>
    readings.some((t) => [t, (t * 9) / 5 + 32, t - 273.15, ((t - 273.15) * 9) / 5 + 32].some((c) => Math.abs(value - c) <= 1));
  const looked = lookedUp.weather.length > 0 || lookedUp.requests > 0;
  if (!looked) {
    if (!CURRENT_WEATHER.test(request) || CLIMATE.test(request)) return null;
    return `The program says ${stated[0].text} without looking the weather up: get it with const { temperature } = await getWeather("") (the city's name in the quotes, "" for where the user is) and speak its temperature.`;
  }
  const compared = codeNumbers(code);
  if (!compared) return null;
  const madeUp = stated.find((t) => !asRead(t.value) && !compared.includes(Math.abs(t.value)));
  if (!madeUp) return null;
  const read = lookedUp.weather.find((t): t is number => typeof t === 'number');
  return lookedUp.weather.length > 0
    ? `The weather numbers spoken (${madeUp.text}) don't come from getWeather()${read !== undefined ? `, which gave ${read} °C` : ''}: speak its temperature (speak(\`It is \${temperature} degrees\`)).`
    : `The weather numbers spoken (${madeUp.text}) don't come from what the program fetched: speak the temperature its reply gives.`;
}

/** Counting in a text the request quotes ("count the words in 'the quick brown fox'"): what is counted, and the text */
const COUNTS_QUOTED_TEXT = /\b(?:count|how many|number of)\b[^.?!"'“‘]*?\b(words?|letters?|characters?|vowels?)\b[^"'“‘]*?["“'‘](.{2,}?)["”'’]\s*[?.!]?\s*$/i;
/** Reversing a word the request gives ("reverse the word 'stressed'", "spell hello backwards") */
const REVERSES_WORD = /^\s*(?:please\s+)?(?:reverse|spell)\s+(?:the\s+(?:word|name)\s+)?["“'‘]?([\p{L}]{2,})["”'’]?(?:\s+backwards?)?\s*[?.!]?\s*$/iu;
/** Arithmetic on two numbers, with one operation: "what's 17 times 23", "15% of 84", "100 divided by 8" */
const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const PLAIN_SUMS: Array<{ shape: RegExp; work: (a: number, b: number) => number; how: string; arity?: number }> = [
  { shape: new RegExp(`${NUMBER}\\s*(?:%|percent)\\s+of\\s+${NUMBER}`, 'i'), work: (a, b) => (a * b) / 100, how: 'b * a / 100' },
  { shape: new RegExp(`${NUMBER}\\s*(?:times|multiplied by|x|\\*|×)\\s*${NUMBER}`, 'i'), work: (a, b) => a * b, how: 'a * b' },
  { shape: new RegExp(`${NUMBER}\\s*(?:plus|\\+)\\s*${NUMBER}`, 'i'), work: (a, b) => a + b, how: 'a + b' },
  { shape: new RegExp(`${NUMBER}\\s*(?:minus|−|\\s-\\s)\\s*${NUMBER}`, 'i'), work: (a, b) => a - b, how: 'a - b' },
  { shape: new RegExp(`${NUMBER}\\s*(?:divided by|over|/|÷)\\s*${NUMBER}`, 'i'), work: (a, b) => a / b, how: 'a / b' },
  { shape: new RegExp(`${NUMBER}\\s*(?:°|degrees?)\\s*(?:f|fahrenheit)\\s+(?:in|to|into)\\s+(?:°?c\\b|celsius)`, 'i'), work: (a) => ((a - 32) * 5) / 9, how: '(f - 32) * 5 / 9', arity: 1 },
  { shape: new RegExp(`${NUMBER}\\s*(?:°|degrees?)\\s*(?:c|celsius)\\s+(?:in|to|into)\\s+(?:°?f\\b|fahrenheit)`, 'i'), work: (a) => (a * 9) / 5 + 32, how: 'c * 9 / 5 + 32', arity: 1 },
];

/**
 * The one answer a request has that can be worked out here, or null: arithmetic on the two numbers it gives with one
 * operation (or a °F/°C conversion), a count of the words, letters, characters or vowels of a text it quotes, or a
 * word it gives reversed. What a program is told when it says something else: how it is worked out, never the
 * answer itself (a fix would copy it).
 */
function workedOut(request: string): { numbers: number[]; how: string } | { reversed: string; word: string; how: string } | null {
  const reverse = request.match(REVERSES_WORD);
  if (reverse) return { reversed: [...reverse[1]].reverse().join('').toLowerCase(), word: reverse[1].toLowerCase(), how: "text.split('').reverse().join('')" };
  const count = request.match(COUNTS_QUOTED_TEXT);
  if (count) {
    const text = count[2];
    const kind = count[1].toLowerCase().replace(/s$/, '');
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    if (kind === 'word') {
      // Counted one way only when every word is letters ("well-known", "3-step", a dash alone count either way)
      const words = text.trim().split(/\s+/);
      if (!words.every((word) => /^\p{L}+(?:['’]\p{L}+)*[,.;:!?]?$/u.test(word))) return null;
      return { numbers: [words.length], how: 'count the words with text.trim().split(/\\s+/).length' };
    }
    if (kind === 'letter') return { numbers: [letters], how: 'count the letters with text.match(/[a-z]/gi).length' };
    if (kind === 'character') return { numbers: [text.length, text.replace(/\s/g, '').length], how: 'count the characters with text.length' };
    // (y is a vowel to some: either count is the count)
    return { numbers: [text.match(/[aeiou]/gi)?.length ?? 0, text.match(/[aeiouy]/gi)?.length ?? 0], how: 'count the vowels with text.match(/[aeiou]/gi).length' };
  }
  // Only its own numbers: "what is 2 plus 3 times 4" has two operations
  const sums = PLAIN_SUMS.filter((sum) => sum.shape.test(request));
  if (sums.length !== 1 || numbersIn(request).length !== (sums[0].arity ?? 2)) return null;
  const [, a, b] = request.match(sums[0].shape)!;
  return { numbers: [sums[0].work(Number(a), Number(b))], how: `work out ${sums[0].how} with the request's numbers` };
}

/** Whether a number said is the value, to as many decimal places as it was said with (12.6 for 12.6, 0.33 for 1/3) */
const saysValue = (said: number, value: number) => {
  const places = (String(said).split('.')[1] ?? '').length;
  return Math.abs(Number(value.toFixed(places)) - said) < 1e-9;
};

/** The single plain string literal (no ${}) of each speak(), console.log() or alert() call in a program, or null when it doesn't parse */
function literalSays(code: string): string[] | null {
  let tree: AcornNode;
  try {
    tree = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch {
    return null;
  }
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const n = node as { type?: string; callee?: any; arguments?: any[] };
    if (n.type === 'CallExpression' && n.arguments?.length === 1) {
      const callee = n.callee;
      const says =
        (callee?.type === 'Identifier' && (callee.name === 'speak' || callee.name === 'alert')) ||
        (callee?.type === 'MemberExpression' && callee.object?.name === 'console' && callee.property?.name === 'log');
      const arg = n.arguments[0];
      if (says && arg.type === 'Literal' && typeof arg.value === 'string') found.push(arg.value.trim());
      if (says && arg.type === 'TemplateLiteral' && arg.expressions.length === 0) found.push(String(arg.quasis[0]?.value?.cooked ?? '').trim());
    }
    for (const key of Object.keys(node)) if (key !== 'type' && key !== 'start' && key !== 'end') visit((node as Record<string, unknown>)[key]);
  };
  visit(tree);
  return found;
}

/**
 * A wrong answer typed into the program's words, for a request whose one answer can be worked out here (see
 * workedOut): what was said is a whole plain string the program speaks (speak("Word count: 10"), for seven words
 * quoted; a small model counting in its head), and the number in it, or the reversed word, isn't the answer. A
 * right answer typed in passes ("17 times 23 is 391"), and so does one the program put together (speak("15% of 84
 * is " + 0.15 * 84)) whatever its value: only the literal text is judged. Nothing to judge when the literal holds no
 * number of its own (words around an answer said elsewhere) or the request isn't one worked out here ("how many
 * words are in a novel?"). Not for something to make (a word counter app): what that says is for its user.
 */
export function wrongTypedAnswer(request: string, code: string, spoken: string[]): string | null {
  if (asksForOutcome(request)) return null;
  const answer = workedOut(request);
  if (!answer) return null;
  const literals = literalSays(code);
  if (!literals || literals.length === 0) return null;
  const said = spoken.map((text) => text.trim()).filter(Boolean);
  if ('reversed' in answer) {
    // A word of the same letters as the one given, in another order: the reversal tried, and missed
    const sameLetters = (word: string) => [...word].sort().join('') === [...answer.word].sort().join('');
    for (const text of said) {
      if (!literals.includes(text)) continue;
      const words: string[] = text.toLowerCase().match(/\p{L}+/gu) ?? [];
      if (words.includes(answer.reversed)) return null;
      const tried = words.find((word) => word !== answer.word && word.length === answer.word.length && sameLetters(word));
      if (tried) return `${JSON.stringify(text.slice(0, 60))} is typed into the program, and "${tried}" isn't the word reversed: reverse it in the program (${answer.how}) and speak the result.`;
    }
    return null;
  }
  const named = new Set(numbersIn(request));
  // A number of its own said in words the program put together (speak(0.15 * 84) after speak("Step 1: 15% is
  // 0.15")): the answer was worked out, and the literal's numbers are working
  if (said.some((text) => !literals.includes(text) && numbersIn(text).some((n) => !named.has(n)))) return null;
  for (const text of said) {
    if (!literals.includes(text)) continue;
    const typed = numbersIn(text).filter((n) => !named.has(n));
    if (typed.length === 0 || typed.some((n) => answer.numbers.some((value) => saysValue(n, value)))) continue;
    return `${JSON.stringify(text.slice(0, 60))} is typed into the program, and ${typed[0]} isn't the answer: ${answer.how} in the program and speak the result.`;
  }
  return null;
}
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

/** The run status once Chatty stops fixing (the page clears the card on it) */
export const GAVE_UP_STATUS = '(gave up fixing it)';
/** The run note for a fresh ask after a talk-only reply: not a fix */
export const GENERATING_NOTE = 'Generating…';

/** What Chatty says when the last fix attempt failed too */
function gaveUpText(error: string, tries = MAX_FIX_TRIES): string {
  const short = error.length > 80 ? `${error.slice(0, 77)}…` : error;
  return `I couldn't get this working after ${tries} ${tries === 1 ? 'try' : 'tries'} (the last error: ${short}). You could ask again in other words, or choose a larger model in Settings.`;
}

/**
 * An error's text without the mark a test copy carried (`((globalThis.__chattyReached = true), root)`
 * around a filled expression, which the browser prints in the message as part of the source): the
 * expression alone, as it reads in the program. The mark's brackets are matched, so an expression
 * with calls in it comes out whole.
 */
export function unmarkReached(text: string): string {
  // The mark as the browser prints it in a message: with its assignment (`((globalThis.__chattyReached = true), x)`)
  // or without (`(globalThis.__chattyReached , x)`: Chrome leaves the assignment out of a call site)
  const name = 'globalThis.__chattyReached';
  let out = text;
  for (let at = out.indexOf(name); at >= 0; at = out.indexOf(name)) {
    let start = at;
    while (start > 0 && out[start - 1] === '(') start--;
    const opens = at - start;
    let i = at + name.length;
    const assigned = /^\s*=\s*true\s*\)/.exec(out.slice(i));
    if (assigned) i += assigned[0].length;
    // The bracket that opens the sequence: with the assignment shown, one pair is the assignment's own
    const sequenceOpen = assigned ? (opens >= 2 ? at - 2 : -1) : opens >= 1 ? at - 1 : -1;
    const comma = /^\s*,\s*/.exec(out.slice(i));
    if (sequenceOpen < 0 || !comma) break;
    i += comma[0].length;
    let depth = 0;
    let end = -1;
    for (let k = i; k < out.length; k++) {
      if (out[k] === '(') depth++;
      else if (out[k] === ')') {
        if (depth === 0) {
          end = k;
          break;
        }
        depth--;
      }
    }
    if (end < 0) break;
    out = out.slice(0, sequenceOpen) + out.slice(i, end) + out.slice(end + 1);
  }
  return out;
}

/**
 * Whether a run failed at the fill itself: its message names the expression that was put in (an
 * element lookup that is not what was wanted: `(document.getElementById('result')).getContext is
 * not a function`), or says the blank name it declares has no such member (`canvas.getContext is not a
 * function`), or the same member is missing as in the failure being fixed. A fill that fails there is
 * the wrong candidate, however far along the program the failure is.
 */
export function failsAtFill(error: string, expr: string, blankText: string, originalError: string): boolean {
  const text = expr.trim();
  if (namesCandidate(error, text) || (!/^[A-Za-z_$][\w$]*$/.test(text) && error.includes(text)) || sameMissingMember(error, originalError)) return true;
  const name = blankText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$.])${name}\\.[\\w$]+ (?:is not a function|is undefined)`).test(error);
}

/** Whether an error is about the candidate itself (`Cannot access 'notes' before …` for `notes`) */
function namesCandidate(error: string, expr: string): boolean {
  const name = /^[A-Za-z_$][\w$]*$/.test(expr.trim()) ? expr.trim() : null;
  return !!name && new RegExp(`['"\\s(]${name.replace(/\$/g, '\\$')}['"\\s).]`).test(` ${error} `);
}

/**
 * Whether two errors are the same member missing, whatever object was put in front of it. The
 * browser words the object as the expression's own text (`(…, document.getElementById(...)).start
 * is not a function`), so a swapped-in expression changes the message while the failure stays; and
 * one that came out undefined turns "x.m is not a function" into "reading 'm'" of undefined.
 */
export function sameMissingMember(a: string, b: string): boolean {
  const member = (error: string) =>
    error.match(/\.([A-Za-z_$][\w$]*) is not a function\s*$/)?.[1] ??
    error.match(/\(reading '([A-Za-z_$][\w$]*)'\)\s*$/)?.[1] ??
    error.match(/undefined is not an object \(evaluating '[^']*\.([A-Za-z_$][\w$]*)'\)\s*$/)?.[1];
  const first = member(a);
  return !!first && first === member(b);
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

/**
 * The repairs a program gets before it runs, by rule and without the model: the lines that go,
 * the slipped names and members, the declarations it forgot, and then the library-specific group
 * (Tone.js) last. `note` is told each one (the run log). The same repairs go over a fix's test
 * run, so what is judged is what would run. `notThere` is what its objects lack, reported after
 * the run if the program did nothing asked.
 */
export function repairBeforeRunning(code: string, isProse: boolean, note: (text: string) => void, request = ''): { code: string; notThere: Array<{ line: number; error: string; soft?: boolean }> } {
  let executableCode = code;
  const earlyPass = () => {
    // First, lines that go (so the line numbers below match the program that runs).
    // Its own speak()/out/clear: taken out so the real helpers are used (error-hints.ts)
    if (!isProse) {
      // Tone's note values written without quotes (8n is a BigInt; 1m, 4t, 8n. don't parse): the text they stand for
      const times = quoteToneTimes(executableCode);
      if (times) {
        executableCode = times.code;
        note(`${times.quoted.join(', ')} written without quotes → ${times.quoted.map((q) => JSON.stringify(q)).join(', ')} (Tone's note values are text): corrected before running`);
      }
      // The hint's Web MIDI output line copied wrong, so the program doesn't parse: the hint's own line
      const midiLine = restoreMidiOutputLine(executableCode, parsesAsProgram);
      if (midiLine) {
        executableCode = midiLine.code;
        note(`line ${midiLine.line}: the Web MIDI output line copied wrong → the hint's own line: corrected before running`);
      }
      // The plain music call (an instrument and a list of notes) aimed at something that isn't the Web MIDI output
      const routed = routePlainSendToMidi(executableCode);
      if (routed) {
        executableCode = routed.code;
        note(`${[...new Set(routed.calls)].join(', ')}(instrument, notes) → the Web MIDI output's send(): corrected before running`);
      }
      // The one instrument the request names, where the program plays another (or a name that's none)
      const instrument = useRequestedInstrument(executableCode, request);
      if (instrument) {
        executableCode = instrument.code;
        note(`the instrument "${instrument.from}" → "${instrument.to}", the one the request names: corrected before running`);
      }
      // The one 3D shape the request names, where the program builds another
      const shape = useRequestedShape(executableCode, request);
      if (shape) {
        executableCode = shape.code;
        note(`THREE.${shape.from} → THREE.${shape.to}, the shape the request names: corrected before running`);
      }
      // clearRect() with nothing in it throws: it can only mean the whole canvas
      const cleared = wholeCanvasClear(executableCode);
      if (cleared.filled > 0) {
        executableCode = cleared.code;
        note('clearRect() with no size → the whole canvas: corrected before running');
      }
      // The prompt's example notes, tags and all (<example>C4</example>): the notes without the tags
      const tagged = dropExampleTags(executableCode);
      if (tagged.dropped > 0) {
        executableCode = tagged.code;
        note('the example\'s tags copied into the program → removed: corrected before running');
      }
      const copies = dropHelperCopies(executableCode);
      if (copies.dropped.length > 0 || copies.renamed.length > 0 || copies.kept.length > 0) {
        executableCode = copies.code;
        for (const name of copies.dropped) note(`its own ${name} → the ready-made one: corrected before running`);
        // Its own speak() holding the whole program: renamed, the real speak() kept for what it says
        for (const rename of copies.renamed) note(`its own ${rename}() (it held the program): corrected before running`);
        // Its own clear(), root, out that does something of its own: kept under another name
        for (const rename of copies.kept) note(`its own ${rename} (a helper's name, kept as the program's): corrected before running`);
      }
      // The example reply's own words, copied in: taken out
      const example = dropCopiedExample(executableCode);
      if (example.dropped) {
        executableCode = example.code;
        note("the example reply's speak() copied into the program → taken out: corrected before running");
      }
      // The user's own words said back, in a program that does something else too: taken out
      const echo = isInstruction(request) ? dropRequestEcho(executableCode, request) : { code: executableCode, dropped: 0 };
      if (echo.dropped > 0) {
        executableCode = echo.code;
        note("a speak() of the request's own words → taken out: corrected before running");
      }
      // Its own requestAnimationFrame(), setTimeout() …: taken out, so the browser's runs
      const browserCopies = dropBrowserCopies(executableCode);
      if (browserCopies.dropped.length > 0) {
        executableCode = browserCopies.code;
        for (const name of browserCopies.dropped) note(`its own ${name}() → the browser's: corrected before running`);
      }
      // A stray quote or backtick ending a line (markdown's, kept), or a closing bracket
      // nothing opened: removed when that alone makes the program parse
      const stray = dropStrayCharacter(executableCode);
      if (stray) {
        executableCode = stray.code;
        note(`${strayName(stray.removed)} on line ${stray.line} → removed: corrected before running`);
      }
      // An attribute in a markup string closed with the string's quote, not its own (onclick='go()">)
      const attributes = closeAttributeQuotes(executableCode);
      if (attributes) {
        executableCode = attributes.code;
        note(`line${attributes.lines.length > 1 ? 's' : ''} ${attributes.lines.join(', ')}: an attribute in markup closed with the other quote (which ended the string) → closed with the quote it opened with: corrected before running`);
      }
      // `a && b = c`: a logical expression can't be assigned to; it is `a && (b = c)`
      const logical = wrapLogicalAssignment(executableCode);
      if (logical) {
        executableCode = logical.code;
        note(`${logical.lines.length > 1 ? `lines ${logical.lines.join(', ')}` : `line ${logical.lines[0]}`}: an assignment after && / || / ?? (a logical expression can't be assigned to) → wrapped in ( ): corrected before running`);
      }
      // Template literals inside a <script> inside a template literal (a page written as one string): escaped
      const scripted = escapeScriptBackticks(executableCode);
      if (scripted) {
        executableCode = scripted.code;
        note(`${scripted.scripts === 1 ? 'a <script>' : `${scripted.scripts} <script>s`} written inside a template string held backticks of its own → escaped: corrected before running`);
      }
      // A fence's language label left on a line of its own (`javascript`): taken out
      const labelled = dropFenceLabels(executableCode);
      if (labelled.labels.length > 0) {
        executableCode = labelled.code;
        note(`${labelled.labels.map((l) => `a line of just "${l}"`).join(', ')} (a fence's label, left in the code) → removed: corrected before running`);
      }
      // Statements where an arrow function's body should be a block: wrapped in braces
      const arrows = wrapBracelessArrows(executableCode);
      if (arrows) {
        executableCode = arrows.code;
        note(`statements as an arrow function's body (line${arrows.lines.length > 1 ? 's' : ''} ${arrows.lines.join(', ')}) → wrapped in { }: corrected before running`);
      }
      // A function that calls itself with no end while a frame request already repeats it
      const endless = dropEndlessSelfCalls(executableCode);
      if (endless.dropped.length > 0) {
        executableCode = endless.code;
        for (const name of endless.dropped) note(`${name}() called itself with no end (its own frame request already repeats it) → that call removed: corrected before running`);
      }
      // A line of code written inside backticks (a template literal that does nothing): unwrapped
      const ticked = unwrapBackticks(executableCode);
      if (ticked) {
        executableCode = ticked.code;
        note(`code written inside backticks (line${ticked.lines.length > 1 ? 's' : ''} ${ticked.lines.join(', ')}) → the backticks taken off: corrected before running`);
      }
      // three.js imports: THREE is provided
      const three = provideThree(executableCode);
      if (three.changed) {
        executableCode = three.code;
        for (const name of three.provided) note(`import of '${name === 'THREE' ? 'three' : 'tone'}' → the ready-made ${name}: corrected before running`);
      }
      // Packages the browser doesn't have, loaded and never used: taken out
      const packages = dropUnusedPackages(executableCode);
      if (packages.dropped.length > 0) {
        executableCode = packages.code;
        for (const from of packages.dropped) note(`unused package '${from}' → removed: corrected before running`);
      }
      // `return` alone on a line with its value on the next (a semicolon is inserted after `return`)
      const returns = joinSplitReturn(executableCode);
      if (returns) {
        executableCode = returns.code;
        note(`return alone on line${returns.lines.length > 1 ? 's' : ''} ${returns.lines.join(', ')} (its value on the next line returned nothing) → the value returned: corrected before running`);
      }
      // A class of the program's own called as a function (`Ball()` for a `class Ball`): made with new
      const ownClasses = addNewToClasses(executableCode);
      if (ownClasses) {
        executableCode = ownClasses.code;
        note(`${ownClasses.count} call${ownClasses.count === 1 ? '' : 's'} of a class (${ownClasses.names.join(', ')}) → made with new (a class called as a function always throws): corrected before running`);
      }
      // parent.appendChild(quiz()) where quiz() returns nothing: quiz() runs, and what it made goes on the card
      const appendsNothing = runAppendOfNothing(executableCode);
      if (appendsNothing) {
        executableCode = appendsNothing.code;
        note(`${appendsNothing.calls.join(', ')}: the function returns nothing, and appending nothing always fails → the function runs, and what it made goes on the card: corrected before running`);
      }
      // A class used above its declaration at the top of the program: moved above its first use
      const classes = moveClassesUp(executableCode);
      if (classes) {
        executableCode = classes.code;
        for (const name of classes.names) note(`class ${name} was used above its declaration (classes are not hoisted) → declared above its first use: corrected before running`);
      }
    }
  };
  // (a syntax repair can make the program parse where the repairs ahead of it had nothing to read:
  // they run again then, and find only what is new)
  const parsedAtStart = isProse || parsesAsProgram(executableCode);
  earlyPass();
  if (!parsedAtStart && parsesAsProgram(executableCode)) earlyPass();
  // Drawing calls and settings made on the canvas element itself: they go through its context
  if (!isProse) {
    const onCanvas = moveToContext(executableCode);
    if (onCanvas.moved.length > 0) {
      executableCode = onCanvas.code;
      for (const { object, members } of onCanvas.moved) note(`${members.map((m) => `${object}.${m}`).join(', ')} → ${object}.getContext("2d")…: a canvas element draws through its context: corrected before running`);
    }
    // prompt(), which the card can't show (it answers null): asked on the card, the program waiting for the answer
    const asked = askOnCard(executableCode);
    if (asked) {
      executableCode = asked.code;
      note(`prompt() (${asked.calls === 1 ? 'a box' : `${asked.calls} boxes`} the card can't open: it answers null) → asked on the card, and the program waits for the answer: corrected before running`);
    }
  }
  // Members its objects don't have (ctx.fillstyle, style.backgroundColour): a sure slip is
  // corrected now; anything else is reported after the run as its error (property-check.ts)
  const unknown = isProse ? [] : unknownMembers(executableCode);
  const slips = unknown.filter((issue) => issue.slip);
  if (slips.length > 0) {
    executableCode = renameMembers(executableCode, slips.map((issue) => ({ object: issue.object, from: issue.member, to: issue.slip!, spans: issue.spans })));
    for (const issue of slips) note(`${issue.object}.${issue.member} → ${issue.object}.${issue.slip}: corrected before running`);
  }
  // (soft: a member this browser lacks may be one a newer browser has, ctx.filter on
  // Safari: on a run that works it is noted, not made the error)
  const notThere: Array<{ line: number; error: string; soft?: boolean }> = unknown
    .filter((issue) => !issue.slip)
    .map((issue) => ({ line: issue.line, error: unknownMemberError(issue), soft: true }));
  if (!isProse) {
    // Writes to read-only properties and invalid style values (property-check.ts): a sure
    // answer is corrected, the rest reported after the run
    const unusable = unusableAssignments(executableCode);
    if (unusable.some((issue) => issue.fix)) {
      executableCode = applyAssignmentFixes(executableCode, unusable);
      for (const issue of unusable) if (issue.fix) note(`${issue.fix.note}: corrected before running`);
    }
    for (const issue of unusable) if (!issue.fix) notThere.push({ line: issue.line, error: issue.message });
    // A name in the wrong letter case (mycount for myCount): the declared one
    const cased = fixCaseSlips(executableCode);
    if (cased.fixed.length > 0) {
      executableCode = cased.code;
      for (const { from, to } of cased.fixed) note(`${from} → ${to}: corrected before running`);
    }
    // A key its own object literal doesn't have, one slip from one it does (sounds.drum for drums)
    const keys = fixKeySlips(executableCode);
    if (keys.fixed.length > 0) {
      executableCode = keys.code;
      for (const { object, from, to } of keys.fixed) note(`${object}.${from} → ${object}.${to} (the key it has): corrected before running`);
    }
    // An iterator's result kept instead of its item (outputs.values().next()): its value
    const iterated = fixIteratorResults(executableCode);
    if (iterated.fixed.length > 0) {
      executableCode = iterated.code;
      // (an iterator read with [n] comes back as its own `from → to`; a .next() result as the name that kept it)
      for (const name of iterated.fixed) {
        note(name.includes(' → ') ? `${name}: corrected before running` : `${name} = ….next() is { value, done } → ….next().value: corrected before running`);
      }
    }
    // An audio node read as a property of an AudioContext: the create…() that makes it
    const nodes = fixAudioNodeProperties(executableCode);
    if (nodes.fixed.length > 0) {
      executableCode = nodes.code;
      for (const change of nodes.fixed) note(`audio context ${change}: corrected before running`);
    }
    // An animation that moves things but asks for one frame only: it asks for the next too
    const frames = loopOneFrameAnimations(executableCode);
    if (frames.looped.length > 0) {
      executableCode = frames.code;
      for (const issue of notThere) issue.line += frames.atLines.filter((at) => at < issue.line).length;
      for (const name of frames.looped) note(`${name}() moved things for one frame only → it asks for the next frame: corrected before running`);
    }
    // A variable declared inside one function and used in another: declared for the whole program
    const sharing = shareDeclarations(executableCode);
    if (sharing.shared.length > 0) {
      executableCode = sharing.code;
      for (const { name, from, line } of sharing.shared) {
        // (each adds one line before its function)
        for (const issue of notThere) if (issue.line >= line) issue.line += 1;
        note(`${name} was declared inside ${from}() but used outside it → declared for the whole program, set in ${from}(): corrected before running`);
      }
    }
    // A drawing context, canvas or audio context it uses but never made: made at its top
    const missing = declareMissing(executableCode);
    if (missing.declared.length > 0) {
      executableCode = missing.code;
      // (its lines moved down by the declarations put at its top)
      for (const issue of notThere) issue.line += missing.declared.length;
      for (const { name, make } of missing.declared) note(`${name} was never made → const ${name} = ${make}: corrected before running`);
    }
    // ---- Library-specific repairs (Tone.js): after every general one above ----
    // Notes added to a time, and a pitch given to a NoiseSynth (error-hints.ts)
    const toneCalls = fixToneCalls(executableCode);
    if (toneCalls.fixed.length > 0) {
      executableCode = toneCalls.code;
      for (const change of toneCalls.fixed) note(`${change}: corrected before running`);
    }
  }
  // The program as the runtime reads it (it trims the program, and the lines the sandbox reports for an
  // error count from the first one that is left): the program kept and the lines named in errors are the same text
  const leading = executableCode.match(/^\s*/)?.[0].split('\n').length ?? 1;
  executableCode = executableCode.trim();
  if (leading > 1) for (const issue of notThere) issue.line = Math.max(1, issue.line - (leading - 1));
  return { code: executableCode, notThere };
}

/** A program run, as the fix loop knows it */
type RunRecord = {
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
  /** Where a thrown error with no line of the program's came from, found by test runs (see locateFailure) */
  located?: { text: string } | 'tried';
};

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
  /** The questions each request's fixes have asked (by requestKey and error). This and the next three keep only the last MAX_REQUESTS_KEPT requests (see recent-requests.ts) */
  private fixKindsUsed = new Map<string, Set<FixKind>>();
  /** Fix replies that were not used, by request: the last question lists them */
  private failedReplies = new Map<string, string[]>();
  /** Requests (by original turn) that Chatty has given up on: nothing is corrected or fixed after that */
  private gaveUp = new Set<string>();
  /** When the last test run ended, to pause between them */
  private lastTrialEnd = 0;
  private lastRun: RunRecord | null = null;
  /**
   * Each request's fix loop: its best run so far and that run's score, the latest run's score,
   * and how many model tries in a row haven't beaten the best (see runScore, FIX_PATIENCE)
   */
  private fixProgress = new Map<string, { best: RunRecord; score: number; latest: number; latestCode: string; stale: number; rolledBack: boolean; errors: Set<string> }>();
  /** The system prompt last written to the run log, so it is logged only when it changes */
  private loggedSystemPrompt: { chat: string; text: string } | null = null;
  /** Programs whose slips were corrected and re-run, by turn: they stand for the turn's program in later prompts */
  private correctedPrograms = new Map<string, { code: string; request: string }>();
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
    let { systemPrompt, promptMessages } = this.buildModelPrompt(normalized, resolvedContext, programBeingEdited, complaint);
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
              let cut = repetitionCutIndex(rawAccumulatedTokens);
              let why = 'the reply started repeating itself';
              // Or going round in circles with variations: a name declared a third time in one scope
              const again = cut < 0 ? redeclaredCut(rawAccumulatedTokens) : null;
              if (again) {
                cut = again.index;
                why = `the reply started declaring ${again.name} a third time`;
              }
              if (cut >= 0) {
                stoppedRepeating = true;
                appendRunLog('retry', `${why}: generation stopped there (no retry)`);
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
            const applied = applyFixReply(original, raw, fixLine, options.fixBlock?.end, options.fixWhole);
            // (judged as it would run: a whole program with the declarations it dropped put back)
            const program = options.fixWhole ? restoreWhole(original, applied, this.lastRun?.errorLine).code : applied;
            const prepared = inspectExecutableCode(program);
            // (with the repairs it gets before a real run: a test run judges what would run)
            const code = prepared.isProse ? prepared.code.trim() : repairBeforeRunning(prepared.code.trim(), false, () => {}, codeTask).code.trim();
            const problem = await unusableFix(original, program, code, options.fixBlock?.name, codeTask);
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
          // An unchanged line for an error about a value made on another line: asking the same
          // question at other temperatures gets the same line (the next try marks where it is made)
          const madeElsewhere = (madeAsWrongClass(original, failedError ?? '', this.javascriptRuntime.pageScope?.() ?? undefined)?.line ?? fixLine) !== fixLine;
          let lastSampling = fixSampling(options.fixAttempt ?? 1) ?? SAMPLING_SWINGS[0];
          const usedSamplings = [lastSampling];
          // The last reply is judged too (it is not asked for again)
          for (let extra = 0; extra <= reasks; extra++) {
            if (!this.scheduler.isTurnValid(turnId) || signal.aborted || (genResult.aborted && !stoppedRepeating)) break;
            const why = await unusableWhy(rawAccumulatedTokens || assistantMsg.canonicalContent || genResult.text);
            if (!why || extra === reasks || (madeElsewhere && why === UNUSABLE_WHY.unchanged)) break;
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
          let fixedProgram = options?.autoFix ? applyFixReply(options.autoFix, rawContent, fixLine, options.fixBlock?.end, options.fixWhole) : rawContent;
          // A whole program that dropped declarations it still uses gets them back (line-fix.ts)
          if (options?.autoFix && options.fixWhole) {
            const kept = restoreWhole(options.autoFix, fixedProgram, this.lastRun?.errorLine);
            if (kept.lines > 0) appendRunLog('imagined', `the fix deleted ${kept.lines} line${kept.lines === 1 ? '' : 's'} outside the error → kept from the program: corrected before running`);
            if (kept.restored.length) appendRunLog('imagined', `the fix dropped ${kept.restored.join(', ')} → kept from the program: corrected before running`);
            fixedProgram = kept.code;
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
          if (inspected.wired?.length) appendRunLog('imagined', `${inspected.wired.map((n) => `${n}()`).join(', ')} works out what the user types and was never called → runs as they type and when a form is sent: corrected before running`);
          if (inspected.standInFields?.length) appendRunLog('imagined', `the field${inspected.standInFields.length === 1 ? '' : 's'} it reads (${inspected.standInFields.join(', ')}) never made → ${inspected.standInFields.length === 1 ? 'a text box' : 'a text box for each'} on the card: corrected before running`);
          if (inspected.shownMarkup?.length) appendRunLog('imagined', `the markup in ${inspected.shownMarkup.join(', ')} was never put on the page → added to the card: corrected before running`);
          if (inspected.hoistedScripts) appendRunLog('imagined', `${inspected.hoistedScripts === 1 ? 'a <script>' : `${inspected.hoistedScripts} <script>s`} in markup the program sets never runs in the browser → its code is part of the program: corrected before running`);
          if (inspected.exposed?.length) appendRunLog('imagined', `${inspected.exposed.map((n) => `${n}()`).join(', ')} made reachable from the page's inline handlers: corrected before running`);
          if (inspected.framed?.length) appendRunLog('imagined', `${inspected.framed.join(', ')}: a frame loop that did nothing but ask for the next frame now runs the drawing function nothing called: corrected before running`);
          if (inspected.markupBlocks) appendRunLog('imagined', `${inspected.markupBlocks === 1 ? 'a line of' : `${inspected.markupBlocks} blocks of`} markup between the code blocks said aloud → put on the page instead: corrected before running`);
          if (inspected.repeatedBlocks) appendRunLog('imagined', `the program written out again in another code block → one copy kept: corrected before running`);
          for (const note of inspected.markup ?? []) appendRunLog('imagined', `${note}: corrected before running`);
          if (inspected.redeclared?.length) appendRunLog('imagined', `${inspected.redeclared.join(', ')} declared again → set again (the first declaration made let): corrected before running`);
          if (inspected.cutOff) {
            const { dropped, closed, template } = inspected.cutOff;
            const closes = [template ? 'its open template string' : '', closed ? `${closed} open block${closed === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
            appendRunLog('imagined', `the reply was cut off: ${dropped ? `its unfinished last ${dropped === 1 ? 'line' : `${dropped} lines`} removed and ` : ''}${closes} closed: corrected before running`);
          }
          // Comments go before it runs (and before it enters the history); a fix's program
          // already came without them
          // Trimmed like the runtime trims it, so error lines match the program kept here
          let executableCode = (options?.autoFix ? inspected.code : stripComments(inspected.code)).trim();
          const repaired = repairBeforeRunning(executableCode, !!inspected.isProse, (text) => appendRunLog('imagined', text), codeTask);
          executableCode = repaired.code;
          const notThere = repaired.notThere;
          const isProse = inspected.isProse || forceProse;
          assistantMsg.rawCode = executableCode;
          assistantMsg.rawLlmOutput = rawContent;

          // A fix that came back as chat or a bare speak(), or that no longer draws what the program
          // drew, has lost the program. Nothing runs and nothing is said or shown; the original
          // stays the current program (lastRun, lastAction) and the status says why.
          const originalCode = options?.autoFix;
          const problem = originalCode
            ? ((await unusableFix(originalCode, fixedProgram, executableCode, options?.fixBlock?.name, codeTask)) ?? (repeatedTrial ? ('repeated' as const) : null))
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
              const applied = options?.autoFix ? applyFixReply(options.autoFix, rawContent, fixLine, options.fixBlock?.end, options.fixWhole) : rawContent;
              const shown = failedReplyLine(
                options?.autoFix,
                options?.autoFix ? changedLines(options.autoFix, options.fixWhole ? restoreWhole(options.autoFix, applied, this.lastRun?.errorLine).code : applied) : '',
                rawContent
              );
              if (shown) {
                const key = this.requestKey(failed);
                setForRecentRequests(this.failedReplies, key, [...(this.failedReplies.get(key) ?? []), shown]);
              }
            }
            // A try that couldn't even run made no progress
            if (failed && options?.autoFix && attempt >= 1) this.noteStaleTry(failed);
            if (failed?.error && attempt < MAX_FIX_TRIES && !this.outOfPatience(failed)) {
              this.nextTry(failed, attempt + 1, `Your last reply was not a working fix (${why.toLowerCase()}).`);
            } else if (failed?.error && options?.autoFix) {
              // That was the last attempt (or tries stopped getting anywhere): say so, and what
              // the user can do
              this.markGaveUp(failed);
              const text = gaveUpText(failed.error, attempt);
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
            // A class of a library called as a function (Tone.PolySynth(), THREE.Mesh()) always throws, in every
            // browser, and with new it is the one form that works: the library is in the page now, so every
            // call of a class gets it, once, before the first run
            if (!isTalkOnly(executableCode) && /\b(?:Tone|THREE)\b/.test(executableCode)) {
              const scope = await this.javascriptRuntime.libraryScope?.(executableCode);
              const classed = scope ? addNewToClasses(executableCode, scope) : null;
              if (classed) {
                executableCode = classed.code;
                assistantMsg.rawCode = executableCode;
                if (options?.autoFix) this.events.onRawOutput?.(turnId, executableCode);
                appendRunLog('imagined', `${classed.count} call${classed.count === 1 ? '' : 's'} of a class (${classed.names.join(', ')}) → made with new (a class called as a function always throws): corrected before running`);
              }
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
              request: codeTask,
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
            // It ran, but wrote what its object can't take (a read-only property, a style value
            // the browser rejects): that is its error (it did nothing)
            const hardNotThere = notThere.filter((issue) => !issue.soft);
            const softNotThere = notThere.filter((issue) => issue.soft);
            if (!execResult.error && hardNotThere.length > 0) {
              execResult.error = hardNotThere[0].error;
              execResult.errorLine = hardNotThere[0].line;
              appendRunLog('error', `line ${hardNotThere[0].line}: ${execResult.error}`);
            }
            // It ran, but did nothing the request asked for: no sound at all for a sound request,
            // nothing on screen for a drawing or an app. What the sandbox saw, not a guess from the
            // code; a program that starts a moment late gets 1.5 seconds.
            // A reply with nothing left to run is that, not a program that "played nothing"
            if (!execResult.error && !executableCode.trim()) {
              execResult.error = NO_PROGRAM;
              appendRunLog('error', NO_PROGRAM);
            }
            // Talk that only says the question back is no answer: the question is asked again
            const copiedQuestion = !execResult.error && onlyAsksExample(executableCode, codeTask);
            const saidBack = !execResult.error && !copiedQuestion && saysQuestionBack(executableCode, codeTask);
            if (saidBack || copiedQuestion) {
              execResult.error = copiedQuestion ? COPIED_QUESTION : SAID_BACK;
              appendRunLog('error', execResult.error);
            }
            // It ran and said something, but not an answer (see answerFault)
            const madeUp = !execResult.error ? this.answerFault(codeTask, executableCode, execResult, soundMark) : null;
            if (madeUp) {
              execResult.error = madeUp;
              appendRunLog('error', madeUp);
            }
            // Only talk that asks the user something: their answer comes next, nothing is missing
            const asksUser = !saidBack && !copiedQuestion && !madeUp && isTalkOnly(executableCode) && /\?\s*["'`]\s*\)/.test(executableCode);
            if (asksUser) appendRunLog('retry', 'the reply asks the user a question: waiting for the answer');
            if (!execResult.error && !asksUser) {
              const missing = await this.missingOutcome(codeTask, soundMark, executableCode);
              // A member its object doesn't have, in a program that did nothing asked for: the
              // likely reason, and the error to fix. In one that did, only a note
              if (missing && softNotThere.length > 0) {
                execResult.error = softNotThere[0].error;
                execResult.errorLine = softNotThere[0].line;
                appendRunLog('error', `line ${softNotThere[0].line}: ${execResult.error}`);
              } else if (missing) {
                execResult.error = missing;
                appendRunLog('error', missing);
              } else {
                for (const issue of softNotThere) appendRunLog('retry', `line ${issue.line}: ${issue.error} (the program worked: left as it is)`);
              }
            }
            // Things on the card that all show nothing, for a request the outcome check doesn't judge by its words
            const blank = !execResult.error && !asksUser ? await this.blankCard(codeTask, executableCode, execResult) : null;
            if (blank) {
              execResult.error = blank;
              appendRunLog('error', blank);
            }
            // Failed here, after the sandbox saw no error: nothing to download
            if (execResult.error) this.javascriptRuntime.withdrawDownload?.();
            this.lastRun = {
              turnId,
              code: executableCode,
              task: codeTask,
              isAutoFix: !!options?.autoFix,
              fixRequested: false,
              error: execResult.error ? this.namedError(execResult.error, executableCode) : null,
              errorLine: execResult.errorLine,
              fixAttempt: options?.autoFix ? (options.fixAttempt ?? 1) : 0,
              originalTurnId: fixedTurnId ?? turnId,
              errorHistory: options?.errorHistory,
            };
            this.recordRun(this.lastRun, this.didAsked(codeTask, soundMark.uses), !!options?.autoFix && (options.fixAttempt ?? 0) >= 1);
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
              } else if (execResult.error && options?.autoFix && ((options.fixAttempt ?? 0) >= MAX_FIX_TRIES || this.outOfPatience(this.lastRun))) {
                // The last fix failed too, or tries stopped getting anywhere: say so, and what the
                // user can do (the best version comes back once the turn is over)
                this.gaveUp.add(fixedTurnId ?? turnId);
                spokenText = gaveUpText(execResult.error, options.fixAttempt ?? MAX_FIX_TRIES);
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
      void this.rollBackToBest();
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
    run.error = this.namedError(message, run.code);
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
    /**
     * A blank-stage fix: already logged, and it is the model-fix attempt `fixAttempt`. `fill` says what
     * was put in: when the run fails where it was used, the program goes back to what it was (a fill
     * that failed is not the model's code, and the next try must not blank it as if it were)
     */
    blankFix?: { fixAttempt: number; errorHistory: FixError[]; fill?: { original: string; error: string; errorLine?: number; expr: string; blankText: string } }
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
    const soundBefore = this.javascriptRuntime.soundUseCount?.() ?? 0;
    const soundMark = { uses: soundBefore, heard: this.javascriptRuntime.soundHeardCount?.() ?? 0, silent: this.javascriptRuntime.soundSilentCount?.() ?? 0 };
    const result = await this.javascriptRuntime.execute(code, undefined, {
      onSpeak: (phrase) => {
        if (phrase.trim() && !said.includes(phrase.trim())) void this.speakOutOfTurn(phrase);
      },
      audioContextAccessor: this.audioContextAccessor,
    });
    if (result.error && result.errorLine === undefined) result.errorLine = await syntaxErrorLine(code);
    // A corrected program that ran is held to the request like any other: it may still draw nothing
    // or stay silent (the fix loop goes on from there)
    if (!result.error && !isTalkOnly(code) && !this.scheduler.getActiveTurnId()) {
      const missing = await this.missingOutcome(run.task, soundMark, code);
      if (missing) {
        result.error = missing;
        appendRunLog('error', missing);
      }
    }
    const madeUp = !result.error && !this.scheduler.getActiveTurnId() ? (this.answerFault(run.task, code, result, soundMark) ?? (await this.blankCard(run.task, code, result))) : null;
    if (madeUp) {
      result.error = madeUp;
      appendRunLog('error', madeUp);
    }
    setForRecentRequests(this.correctedPrograms, run.turnId, { code, request: this.requestKey(run) }, (_turnId, v) => v.request);
    if (this.lastAction?.kind === 'code' && this.lastAction.code === run.code) this.lastAction = { ...this.lastAction, code };
    this.lastRun = {
      ...run,
      code,
      error: result.error ? this.namedError(result.error, code) : null,
      errorLine: result.errorLine,
      fixRequested: false,
      ...(blankFix ? { fixAttempt: blankFix.fixAttempt, errorHistory: blankFix.errorHistory } : { corrections: (run.corrections ?? 0) + 1 }),
    };
    // (a blank-stage fix is one of the model's tries; a correction by rule isn't)
    this.recordRun(this.lastRun, this.didAsked(run.task, soundBefore), !!blankFix);
    // A fill that fails where it is used, or fails as the program did, is reverted: the next try starts from the program as it was
    const fill = blankFix?.fill;
    if (fill && result.error && (result.error === fill.error || failsAtFill(result.error, fill.expr, fill.blankText, fill.error))) {
      appendRunLog('retry', `the fill \`${fill.expr}\` failed where it was used (${errorText(result.error, result.errorLine)}): back to the program as it was, for the next try`);
      this.lastRun = { ...this.lastRun, code: fill.original, error: fill.error, errorLine: fill.errorLine };
      this.events.onRawOutput?.(run.turnId, fill.original);
    }
    this.events.onRunStatus?.(
      run.turnId,
      result.error
        ? { kind: 'error', text: errorText(result.error, result.errorLine) }
        : { kind: 'ok', text: `Ran in ${Math.max(1, Math.round(result.executionTimeMs))} ms (corrected ${named})` }
    );
    if (result.error && blankFix && (blankFix.fixAttempt >= MAX_FIX_TRIES || this.outOfPatience(this.lastRun))) {
      this.sayGaveUp(run.turnId, result.error, blankFix.fixAttempt);
      return;
    }
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
    // Tries that stopped getting anywhere: Chatty stops, and the best version comes back
    if (run.isAutoFix && this.outOfPatience(run)) {
      run.fixRequested = true;
      appendRunLog('retry', `${FIX_PATIENCE} tries in a row did no better than the best version so far: stopping`);
      this.sayGaveUp(run.turnId, run.error, run.fixAttempt ?? FIX_PATIENCE);
      return;
    }
    // A fix that did worse than the best version so far isn't built on: the next try starts from the best
    const base = this.fixBase(run);
    if (base !== run) {
      run.fixRequested = true;
      this.lastRun = base;
      this.events.onRawOutput?.(run.turnId, base.code);
      return this.maybeAutoFix(turnId);
    }
    // A line past the program's end came from somewhere else (the sandbox's own code): no line
    if (run.errorLine && run.errorLine > run.code.split('\n').length) run.errorLine = undefined;
    // An error thrown inside a library has no line of the program's: the statement that made it is found by test runs
    // of the program's starts (once for each program), so the line-based repairs and the marker have a line
    if (!run.errorLine && !run.located && looksThrown(run.error) && typeof this.javascriptRuntime.trialRun === 'function' && !brokenLines(run.code)) {
      run.located = 'tried';
      run.fixRequested = true;
      void this.locateFailure(run).then(() => {
        if (this.lastRun !== run) return;
        run.fixRequested = false;
        this.maybeAutoFix(turnId);
      });
      return;
    }
    // A sure slip (a method's wrong case, a typo of a declared name, an element id one slip
    // from an id on the page) is corrected and run again without the model, even in a fix's
    // program; anything else goes to the model with the facts it was missing (error-hints.ts)
    const found = errorHint(run.code, run.error, run.errorLine, this.pageFacts());
    const where = run.located && run.located !== 'tried' ? run.located.text : undefined;
    const hint = where && !found?.correction ? { ...found, text: [where, found?.text].filter(Boolean).join(' ') } : found;
    if (hint?.correction && hint.correction.code !== run.code && (run.corrections ?? 0) < 3) {
      run.fixRequested = true;
      void this.correctByRule(run, hint.correction);
      return;
    }
    // A fix's own program can fail too: the model gets up to MAX_FIX_TRIES tries per request
    const attempt = (run.fixAttempt ?? 0) + 1;
    if (attempt > MAX_FIX_TRIES) return;
    run.fixRequested = true;
    // What the program read from its elements and events that they don't have (seen in a hidden test run
    // of it: the real run pays nothing), when the failure may come from that
    if (typeof this.javascriptRuntime.trialReads === 'function' && readsMayExplain(run.error)) {
      void this.withReadFacts(run, hint?.text).then((text) => {
        if (this.lastRun !== run || this.scheduler.getActiveTurnId() || this.gaveUp.has(this.requestKey(run))) return;
        this.nextTry(run, attempt, undefined, text);
      });
      return;
    }
    this.nextTry(run, attempt, undefined, hint?.text);
  }

  /**
   * The statement a thrown error with no line of the program's came from (it happened inside a library): test runs of
   * the program's starts find the shortest one that already fails the same way. Sets the run's error line, and says
   * what failed where. Nothing changes when no start fails alike (a timer, a click, a run that depends on time).
   */
  private async locateFailure(run: NonNullable<typeof this.lastRun>): Promise<void> {
    const error = run.error;
    if (!error) return;
    try {
      await settleOnIos(AFTER_HEAVY_MS);
      const found = await failingStatement(run.code, async (start) => {
        if (this.lastRun !== run || this.scheduler.getActiveTurnId() || this.gaveUp.has(this.requestKey(run))) throw new Error('moved');
        const result = await this.trial(start);
        return !!result.error && result.error === error;
      });
      if (!found) return;
      run.errorLine = found.line;
      run.located = { text: `\`${found.text}\` at line ${found.line} failed inside the library (${error}).` };
      appendRunLog('retry', `the error carried no line of the program's: the program up to line ${found.line} already fails the same way (\`${found.text}\`)`);
    } catch {
      // moved on, or the runs could not say
    }
  }

  /** The hint text with the facts of the reads a test run of the program saw that the objects don't have (once for each program) */
  private async withReadFacts(run: NonNullable<typeof this.lastRun>, hintText?: string): Promise<string | undefined> {
    try {
      let facts = this.readFactsCache.get(run.code);
      if (facts === undefined) {
        await settleOnIos(AFTER_HEAVY_MS);
        const reads = await this.javascriptRuntime.trialReads!(run.code);
        facts = missingReadFacts(run.code, reads, this.javascriptRuntime.pageScope?.() ?? undefined).join(' ');
        this.readFactsCache.set(run.code, facts);
        if (facts) appendRunLog('retry', `a test run read names the elements and events don't have: ${facts}`);
      }
      return [hintText, facts].filter(Boolean).join(' ') || undefined;
    } catch {
      return hintText;
    }
  }
  private readFactsCache = new Map<string, string>();

  /**
   * A correction by rule, test-run first where the runtime can (hidden, like a fix reply's): one
   * that fails exactly as the program did hasn't addressed the error, so it isn't run for real,
   * and the model is asked instead. A runtime that can't test-run runs it as before.
   */
  private async correctByRule(run: NonNullable<typeof this.lastRun>, correction: { code: string; note: string; mustRunClean?: boolean }): Promise<void> {
    if (typeof this.javascriptRuntime.trialRun === 'function' && run.error) {
      await settleOnIos(AFTER_HEAVY_MS);
      if (this.lastRun !== run || this.scheduler.getActiveTurnId() || this.gaveUp.has(this.requestKey(run))) return;
      const trial = await this.trial(correction.code);
      if (this.lastRun !== run || this.scheduler.getActiveTurnId() || this.gaveUp.has(this.requestKey(run))) return;
      if (trial.error === run.error || (correction.mustRunClean && trial.error)) {
        appendRunLog('imagined', `${correction.note}: a test run of the correction ${trial.error === run.error ? 'failed the same way' : 'gave an error'} (${errorText(trial.error, trial.errorLine)}), so it was not made`);
        const attempt = (run.fixAttempt ?? 0) + 1;
        if (attempt <= MAX_FIX_TRIES) this.nextTry(run, attempt);
        return;
      }
    }
    await this.runCorrected(run, correction);
  }

  /**
   * Try `attempt`: the next question in the order for this model that fits the error and hasn't
   * been asked for this request yet (see FixKind); the whole program when none is left
   */
  private nextTry(run: NonNullable<typeof this.lastRun>, attempt: number, note?: string, hintText?: string): void {
    if (!run.error) return;
    if (attempt > MAX_FIX_TRIES || this.outOfPatience(run)) {
      if (attempt <= MAX_FIX_TRIES) appendRunLog('retry', `${FIX_PATIENCE} tries in a row did no better than the best version so far: stopping`);
      this.sayGaveUp(run.turnId, run.error, attempt - 1);
      return;
    }
    // In speech mode, each try says so
    void this.speakOutOfTurn('Fixing.');
    const key = this.requestKey(run);
    // The kinds asked are kept per error: a different error starts again from the first kind
    const kindsKey = `${key}\n${normalizedError(run.error)}`;
    const used = this.fixKindsUsed.get(kindsKey) ?? new Set<FixKind>();
    setForRecentRequests(this.fixKindsUsed, kindsKey, used, (k) => k.slice(0, k.indexOf('\n')));
    const broken = brokenLines(run.code);
    const blank = this.blankFor(run);
    const member = this.memberBlankFor(run);
    const fits = (kind: FixKind) =>
      kind === 'member'
        ? !!member
        : kind === 'blank'
        ? !!blank
        : kind === 'function'
          ? !broken && !!enclosingFunction(run.code, run.errorLine)
          : kind === 'line' || kind === 'different'
            ? !!run.errorLine || !!broken
            : kind === 'made'
              ? !broken && !!run.errorLine && (madeAsWrongClass(run.code, run.error ?? '', this.javascriptRuntime.pageScope?.() ?? undefined)?.line ?? run.errorLine) !== run.errorLine
              : true;
    const unused = (this.largeModel() ? FIX_ORDER_LARGE : FIX_ORDER_SMALL).find((k) => !used.has(k) && fits(k));
    // Every kind asked already (one didn't fit): the whole program, told the replies that failed,
    // so this question too differs from every one before
    const kind = unused ?? 'program';
    used.add(kind);
    // What Chatty's libraries (Tone.js, three.js) printed or threw for this program goes to the fix as facts
    const libraryFacts = (this.javascriptRuntime.soundSetup?.()?.library ?? []).join(' ');
    // The last fix left the same things missing (its changes touched none of them): the next ask says so
    const previousError = run.errorHistory?.at(-1)?.error;
    const unchanged = previousError && normalizedError(previousError) === normalizedError(run.error) ? sameShortfallNote(run.error) : null;
    const hint =
      [unchanged, hintText ?? errorHint(run.code, run.error, run.errorLine, this.pageFacts())?.text, libraryFacts]
        .filter(Boolean)
        .join(' ') || undefined;
    if (kind === 'member' && member) {
      run.fixRequested = true;
      this.events.onRunStatus?.(run.turnId, { kind: 'error', text: `${errorText(run.error, run.errorLine)} (choosing among the real members of ${member.blank.member!.object})` });
      void this.blankStage(run, member.blank, attempt, hint, member.members);
      return;
    }
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
    this.askFix(run, attempt, kind === 'blank' || kind === 'member' ? 'line' : kind, [note, different, hint].filter(Boolean).join(' ') || undefined);
  }

  /** An error with a bundle's shortened class names replaced by the library's own ("an instance of e" → "Tone.Param", "Class constructor Cu" → "Tone.PolySynth"), when the page can say */
  private namedError(error: string, code: string): string {
    const scope = /is an instance of|Class constructor|Cannot call a class constructor/.test(error) ? this.javascriptRuntime.pageScope?.() : null;
    return scope ? withLibraryClassNames(error, code, scope) : error;
  }

  /** What the live page holds, for the hints of an error (see error-hints.ts PageFacts) */
  private pageFacts() {
    return { ids: this.javascriptRuntime.pageIds?.() ?? [], standIns: this.javascriptRuntime.standInIds?.() ?? [], scope: this.javascriptRuntime.pageScope?.() ?? undefined };
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
  /** The member blank for the run's error: a choice among the real members of an object that lacks the one the program used */
  private memberBlankFor(run: NonNullable<typeof this.lastRun>): ReturnType<typeof memberBlank> {
    return run.error && typeof this.javascriptRuntime.trialRun === 'function' && !brokenLines(run.code) ? memberBlank(run.code, run.error, run.errorLine, this.javascriptRuntime.pageScope?.() ?? undefined) : null;
  }

  private blankFor(run: NonNullable<typeof this.lastRun>): Blank | null {
    return run.error && typeof this.javascriptRuntime.trialRun === 'function' && !brokenLines(run.code) ? findBlank(run.code, run.error, run.errorLine) : null;
  }

  /** A hidden test run, a short pause after the one before */
  private async trial(code: string): ReturnType<NonNullable<JavascriptRuntime['trialRun']>> {
    const wait = TRIAL_GAP_MS - (Date.now() - this.lastTrialEnd);
    if (wait > 0) await settle(wait);
    try {
      // (named the way the real run's error is, so the two compare as the same error)
      // (a library class called as a function is made with new here too: a test run judges what would run)
      const scope = /\b(?:Tone|THREE)\b/.test(code) ? this.javascriptRuntime.pageScope?.() : null;
      const classed = scope ? addNewToClasses(code, scope) : null;
      const result = await this.javascriptRuntime.trialRun!(classed?.code ?? code);
      // (without the mark a test copy carries in its expressions: what is logged and shown is the program's own text)
      return result.error ? { ...result, error: this.namedError(unmarkReached(result.error), code) } : result;
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
  private askFix(run: NonNullable<typeof this.lastRun>, attempt: number, kind: Exclude<FixKind, 'blank' | 'member'>, factsText?: string): void {
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
    // The line that makes the value the error is about, when the fix belongs there ("x.m is not a function" where x is made on another line)
    const made = kind === 'made' ? madeAsWrongClass(run.code, run.error, this.javascriptRuntime.pageScope?.() ?? undefined) : null;
    const line = kind === 'program' ? undefined : (made?.line ?? run.errorLine);
    const facts =
      [earlierErrors(run.errorHistory, run.error), made ? `The error at line ${run.errorLine} comes from ${made.name}, which is made on the marked line.` : '', factsText].filter(Boolean).join(' ') || undefined;
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
            : made
              ? `the line that makes ${made.name} (line ${made.line})`
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
  private sayGaveUp(turnId: string, error: string, tries = MAX_FIX_TRIES): void {
    const text = gaveUpText(error, tries);
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
    void this.rollBackToBest();
  }

  /** Whether the run is the program that does what was asked, or some of it (the sandbox saw it: shown, or sound started) */
  private didAsked(request: string, soundUsesBefore: number): boolean {
    if (!asksForOutcome(request)) return false;
    const shown = namesVisualThing(request) && !!this.javascriptRuntime.hasVisualContent?.();
    const sound = SOUND_WORDS_REQUEST.test(request) && (this.javascriptRuntime.soundUseCount?.() ?? 0) > soundUsesBefore;
    return shown || sound;
  }

  /**
   * Scores a run for its request's fix loop: the request's own run starts the loop; a run that
   * beats the best so far becomes the best. A model try that doesn't is one more without
   * progress, unless it failed with an error not seen before for this request and scored no
   * lower than the best (it fixed one bug and met the next: the scores are too coarse to show it)
   */
  private recordRun(run: NonNullable<typeof this.lastRun>, didAsked: boolean, modelTry: boolean): void {
    const key = this.requestKey(run);
    const score = runScore(run.error, didAsked);
    const progress = this.fixProgress.get(key);
    const error = run.error ? normalizedError(run.error) : '';
    if (!run.isAutoFix || !progress) {
      setForRecentRequests(this.fixProgress, key, { best: run, score, latest: score, latestCode: run.code, stale: 0, rolledBack: false, errors: new Set(error ? [error] : []) });
      return;
    }
    const fresh = !!error && !progress.errors.has(error);
    if (error) progress.errors.add(error);
    // (the latest program that ran: what the card shows)
    progress.latest = score;
    progress.latestCode = run.code;
    if (score > progress.score) {
      appendRunLog('retry', `progress: this version did better than the best so far (${progress.score} → ${score} of 4)`);
      Object.assign(progress, { best: run, score, stale: 0 });
    } else if (modelTry) {
      progress.stale = fresh && score >= progress.score ? 0 : progress.stale + 1;
    }
  }

  /** A model try that couldn't be run (its reply was unusable): no progress */
  private noteStaleTry(run: { turnId: string; originalTurnId?: string }): void {
    const progress = this.fixProgress.get(this.requestKey(run));
    if (progress) progress.stale++;
  }

  /** FIX_PATIENCE tries in a row without beating the best version */
  private outOfPatience(run: { turnId: string; originalTurnId?: string } | null): boolean {
    if (!run) return false;
    return (this.fixProgress.get(this.requestKey(run))?.stale ?? 0) >= FIX_PATIENCE;
  }

  /**
   * The program the next try fixes: the latest, unless it did worse than the best so far, then
   * the best (its code and error), keeping the latest's place in the tries
   */
  private fixBase(run: NonNullable<typeof this.lastRun>): NonNullable<typeof this.lastRun> {
    const progress = this.fixProgress.get(this.requestKey(run));
    if (!progress || progress.latest >= progress.score || progress.best.code === run.code || !progress.best.error) return run;
    appendRunLog('retry', `the last fix did worse than an earlier version (${progress.latest} against ${progress.score} of 4): the next try starts from that version`);
    return {
      ...run,
      code: progress.best.code,
      error: progress.best.error,
      errorLine: progress.best.errorLine,
      fixRequested: false,
    };
  }

  /**
   * After giving up: when an earlier version did better than the last one, it comes back (run
   * again, quietly) and is the program follow-ups edit. Once per request, when no turn is running.
   */
  private async rollBackToBest(): Promise<void> {
    const run = this.lastRun;
    if (!run || !this.gaveUp.has(this.requestKey(run))) return;
    const progress = this.fixProgress.get(this.requestKey(run));
    if (!progress || progress.rolledBack) return;
    progress.rolledBack = true;
    // The card already shows the best (or as good)
    if (progress.score <= progress.latest || progress.best.code === progress.latestCode) return;
    await settle(AFTER_HEAVY_MS);
    if (this.scheduler.getActiveTurnId()) return;
    appendRunLog('retry', `gave up: showing the best version again (${progress.score} of 4, against ${progress.latest} for the last)`);
    const best = progress.best;
    this.events.onRawOutput?.(run.turnId, best.code);
    if (this.javascriptRuntime.hasRunningProgram?.()) {
      await this.javascriptRuntime.resetVisual();
      await settle(AFTER_HEAVY_MS);
    }
    if (this.scheduler.getActiveTurnId()) return;
    // Its words were said when it first ran
    const result = await this.javascriptRuntime.execute(best.code, undefined, { onSpeak: () => {}, audioContextAccessor: this.audioContextAccessor });
    this.lastRun = { ...run, code: best.code, error: result.error ?? best.error, errorLine: result.errorLine ?? best.errorLine, fixRequested: true };
    if (this.lastAction?.kind === 'code') this.lastAction = { ...this.lastAction, code: best.code };
    this.events.onRunStatus?.(run.turnId, {
      kind: 'error',
      text: `${result.error ? errorText(result.error, result.errorLine) : 'The best version ran'} ${GAVE_UP_STATUS}`,
    });
  }

  /**
   * What a run that said something got wrong about what it said, or null: a temperature for the weather that no
   * look-up gave (madeUpWeather), a wrong answer typed into its words for a request whose answer is worked out here
   * (wrongTypedAnswer); and, when the card shows nothing, nothing played and nothing is still to come, a question said
   * again with nothing of its own (onlyRestates) or nothing said at all (saidNothing). A runtime that can't say what
   * was looked up (as in tests) has the weather taken at its word.
   */
  private answerFault(request: string, code: string, result: { spokenTexts?: string[]; stillRunning?: boolean }, soundMark: { uses: number }): string | null {
    const spoken = result.spokenTexts ?? [];
    if (spoken.length === 0) return null;
    const lookedUp = this.javascriptRuntime.lookedUp?.();
    const weather = lookedUp ? madeUpWeather(request, code, spoken, lookedUp) : null;
    if (weather) return weather;
    const typed = wrongTypedAnswer(request, code, spoken);
    if (typed) return typed;
    const nothingElse = !result.stillRunning && !this.javascriptRuntime.hasVisualContent?.() && (this.javascriptRuntime.soundUseCount?.() ?? 0) <= soundMark.uses;
    if (!nothingElse) return null;
    const restated = onlyRestates(request, spoken);
    if (restated) return `The program only said the question again (${JSON.stringify(restated.slice(0, 80))}), with no answer: it has to say the answer itself (work it out, or look it up, and speak it).`;
    return saidNothing(code, spoken);
  }

  /**
   * A card the program put things on that all show nothing (elements with no text and no size, canvases nothing
   * was drawn on), after the moment missingOutcome gives a first frame, for a request whose words that check doesn't
   * judge: a thing named without a verb ("a button that counts how many times I click it", "a grocery list where I
   * can add and remove items": an empty <div> each, Qwen2.5 0.5B) or a shape it has no word for ("show a big red
   * heart in the middle of the page": an empty <div> styled red, Qwen3.5 2B). Only for a request to make or show
   * something, or a run that said nothing either: an empty element beside a spoken answer (a joke) hides nothing.
   * Not judged: a program still running, one whose frames a hidden page never gets, or one that fetched and got its
   * answer (a picture may still be loading).
   */
  private async blankCard(request: string, code: string, result: { spokenTexts?: string[]; stillRunning?: boolean }): Promise<string | null> {
    const runtime = this.javascriptRuntime;
    if (result.stillRunning || !runtime.hasDrawnContent || !runtime.hasVisualContent?.()) return null;
    if ((result.spokenTexts ?? []).some((text) => text.trim()) && !asksForOutcome(request)) return null;
    const waits = LISTENS_FOR_USER.test(code);
    const drawn = () => !!runtime.hasDrawnContent?.(waits);
    for (let waited = 0; !drawn() && waited < 1500; waited += 100) await settle(100);
    if (drawn()) return null;
    // (a picture still loading, or a fade-in longer than the wait, shows later)
    if (runtime.stillAppearing?.()) return null;
    if (/\brequestAnimationFrame\b/.test(code) && !(await framesArrive())) return null;
    const network = runtime.networkFacts?.() ?? [];
    if (network.length === 0 && (runtime.lookedUp?.().requests ?? 0) > 0) return null;
    appendRunLog('retry', 'outcome check: the card holds only things that show nothing');
    return [nothingVisible(runtime.emptyElements?.() ?? []), network.length > 0 ? `${network.join('; ')}.` : ''].filter(Boolean).join(' ');
  }

  /**
   * The blank stage (blank-fix.ts), one fix attempt: the expression the error names is replaced by
   * candidates, each tried in a hidden run (trialRun), until one runs without that error. The
   * candidates, in order: the model's pick among the page's own names (multiple choice), its
   * expressions for the blank (three samples), then the remaining choices. A runtime that can score
   * the choices (scoreChoices) answers the multiple choice in one pass: every choice gets the
   * model's probability and they are tried best-first, with no letter asked for. At most MAX_CANDIDATES
   * are tried; the first that passes is run for real. When none does, the line fix follows as the
   * next attempt. Stops at once when the user starts a new turn.
   */
  /** What a sound or visual request's program never did, after a short wait, or null */
  private async missingOutcome(request: string, soundMark: { uses: number; heard: number; silent: number }, code = ''): Promise<string | null> {
    if (!asksForOutcome(request)) return null;
    // Sound that waits for the user (an instrument played by keys or taps, a Play button) can't be
    // heard before they press something: it isn't missing yet
    const soundWaits = LISTENS_FOR_USER.test(code);
    // For the sound check, only a program with something that makes sound: one with none can't play on a tap either
    const soundWaitsForUser = soundWaits && CAPABILITIES.some((c) => c.name === 'sound' && c.calls.test(code));
    // A request that names something to see as well still gets its visual check; a bare "play"
    // (a game, a video) is not a sound on its own then
    const namesVisual = namesVisualThing(request);
    // (a runtime that can't tell, as in tests, is taken at its word)
    // A bare "play" (a game, a video) chooses the sound rule but asks for no sound by itself
    const wantsSound = SOUND_WORDS_REQUEST.test(request) && !!this.javascriptRuntime.soundUseCount && !soundWaitsForUser;
    if (soundWaitsForUser && SOUND_WORDS_REQUEST.test(request)) appendRunLog('retry', 'outcome check: the sound waits for the user (a key, a tap, a button): not checked');
    // A program that draws on animation frames, in a page that gets none, can't be judged: not a failure, untested
    const unpainted = namesVisual && /\brequestAnimationFrame\b/.test(code) && !(await framesArrive());
    if (unpainted) appendRunLog('retry', 'outcome check: the page gets no animation frames (nobody is watching it): what the program draws on frames is not judged');
    const wantsVisual = namesVisual && !!this.javascriptRuntime.hasVisualContent && !unpainted;
    if (!wantsSound && !wantsVisual) return null;
    // Sound asked for, then measured at the speakers (two seconds): heard, or silent with the audio
    // running. Not measured (audio paused until a tap, or a runtime that can't): the request counts
    // (a program that made instruments or sources asked for sound too, though the audio was asked for once, when the
    // library loaded into a page that a program before it left: the count alone misses it)
    const setupNow = () => this.javascriptRuntime.soundSetup?.() ?? null;
    const made = () => (setupNow()?.things.some((t) => t.role !== 'node') ?? false);
    const asked = () => (this.javascriptRuntime.soundUseCount?.() ?? 0) > soundMark.uses || made();
    const heard = () => (this.javascriptRuntime.soundHeardCount?.() ?? 0) > soundMark.heard;
    const silent = () => !heard() && (this.javascriptRuntime.soundSilentCount?.() ?? 0) > soundMark.silent;
    const measures = !!this.javascriptRuntime.soundHeardCount;
    const soundSettled = () => heard() || silent() || (asked() && !measures);
    const shown = () => !!this.javascriptRuntime.hasVisualContent?.();
    // A canvas nothing was drawn on, or an element with nothing in it, shows nothing, unless the
    // program waits for the user to start it (a click, a key); it gets a moment to fill its first frame
    // (a program that waits for the user may draw its canvas on the first tap, but elements with nothing in them show nothing to tap)
    const drawn = () => (!this.javascriptRuntime.hasDrawnContent ? shown() : this.javascriptRuntime.hasDrawnContent(soundWaits));
    const done = () => (!wantsSound || soundSettled()) && (!wantsVisual || drawn());
    // Long enough for the speaker measurement when sound was asked for
    for (let waited = 0; !done() && waited < (wantsSound && asked() ? 2500 : 1500); waited += 100) await settle(100);
    // Something drawn or shown, for a request of something that moves or counts: the screen has to
    // keep changing on its own for a few seconds (when the page is watched: a hidden page's
    // animation frames stop), unless the user drives it (a click, a key, the pointer)
    // A canvas drawn on all the time that shows nothing at the end of the window: what is drawn has left it
    // (or hides behind a flat fill). Judged on what is visible, not on the drawing calls, which go on
    const offCanvas = wantsVisual && !soundWaits && drawn() ? await nothingLands(this.javascriptRuntime) : null;
    // Text set several times in one go, where only the last value ever shows (a countdown with no waiting)
    const overwrites = this.javascriptRuntime.overwrittenText?.() ?? [];
    const stillScreen =
      wantsVisual && MOTION_REQUEST.test(request) && !soundWaits && !MOVES_WITH_USER.test(code) && drawn() && !(await screenChanges(this.javascriptRuntime));
    // MIDI that never started a note is silent for that reason: the audio context has nothing to do with it
    const midi = this.javascriptRuntime.midiSummary?.();
    const noNoteStarted = !!midi && midi.sent > 0 && midi.noteOns === 0;
    // Web MIDI asked for, and nothing sent to the output: the audio context has nothing to do with that either
    const nothingSent = /\brequestMIDIAccess\b/.test(code) && !!midi && midi.sent === 0;
    // Silent with the audio running: the step the program didn't take, when its page says which
    // (Tone.Transport never started, a source never connected), in place of the generic advice
    // (also when the speakers weren't measured: what the program made says what is missing, heard or not)
    const stepMissing = wantsSound && asked() && !heard() && !noNoteStarted && !nothingSent ? missingStepsError(setupNow()) : null;
    // A drawing asked for, and the card holds only text: the words stand where the picture should be
    const textOnly = wantsVisual && DRAW_REQUEST.test(request) && !soundWaits && shown() && drawn() && this.javascriptRuntime.hasGraphics?.() === false;
    const emptied = wantsVisual && shown() && !drawn() ? (this.javascriptRuntime.emptyElements?.() ?? []) : [];
    const deadHandlers = wantsVisual && shown() && drawn() ? (this.javascriptRuntime.deadHandlers?.() ?? []) : [];
    const missing = [
      // The example's empty list of notes, copied as it is: said first, it's why nothing played
      wantsSound && soundKinds(request).music ? (emptyExampleNotes(code, request) ?? '') : '',
      wantsSound && !asked()
        ? soundKinds(request).music
          ? `The program played nothing: notes play through Web MIDI. Get an output with ${MIDI_OUTPUT}, then ${MIDI_PLAIN_FORM}.`
          : 'The program played nothing: sounds play through Web Audio oscillators, each connected to the audio context\'s destination.'
        : wantsSound && (silent() || !!stepMissing)
          ? noNoteStarted
            ? `No note was started: every MIDI message was something else${midi.others.length ? ` (${midi.others.join('; ')})` : ''}. Notes play like this: ${MIDI_OUTPUT}, then ${MIDI_PLAIN_FORM}.`
            : nothingSent
              ? `The program asked for Web MIDI but sent no message to an output: the output is the first of the access's outputs (${MIDI_OUTPUT}), and ${MIDI_PLAIN_FORM}.`
              : stepMissing ??
              (/\bTone\s*\./.test(code)
                ? "The program's sound never reached the speakers: connect each Tone synth to the output with .toDestination(), and play notes with triggerAttackRelease(note, duration, time)."
                : "The program's sound never reached the speakers: connect each sound to the audio context's destination (node.connect(audioContext.destination)).")
          : '',
      // Heard, but the prompt's example copied: its notes, or its instrument where the request names another
      wantsSound && soundKinds(request).music ? (copiedExampleNotes(code, request) ?? '') : '',
      wantsSound && soundKinds(request).music ? (wrongInstrument(code, request) ?? '') : '',
      wantsVisual && !shown()
        ? 'The program showed nothing: what it adds to document.body appears in the card on screen.'
        : wantsVisual && !drawn()
          ? nothingVisible(emptied)
          : offCanvas
            ? offCanvas
          : textOnly
            ? 'The program drew nothing: the card shows only text. A drawing is a canvas drawn on (fillRect, arc, lineTo, fill, stroke), an <svg>, or elements with a size and a background color.'
          : stillScreen
              ? `The screen never changed and nothing is scheduled to change it: something that moves or counts has to keep updating what it shows (setInterval, or requestAnimationFrame that draws again each frame).${overwrites.length ? ` ${overwrites.join('; ')}: wait between the updates (setInterval, or await a timeout in the loop).` : ''}`
              : '',
      // A button whose handler in the markup (onclick="rollDice()") names a function the page does not have throws when pressed
      deadHandlers.length ? `The page's inline handlers call ${deadHandlers.map((name) => `${name}()`).join(', ')}, which the program never defines: onclick="${deadHandlers[0]}()" runs the function of that name when pressed, so it has to exist (function ${deadHandlers[0]}() { … }).` : '',
    ].filter(Boolean);
    // Why it came out empty, when the data it asked the network for never came
    const network = missing.length > 0 ? (this.javascriptRuntime.networkFacts?.() ?? []) : [];
    if (network.length > 0) missing.push(`${network.join('; ')}.`);
    if (missing.length === 0) {
      appendRunLog('retry', `outcome check: ${[wantsSound ? 'wanted sound: heard' : '', wantsVisual ? 'wanted visual: seen' : ''].filter(Boolean).join('; ')}`);
      return null;
    }
    // Names the program wrote on its objects that they don't have (a property nothing reads): what the object does have
    // A drawing that shows nothing: what the page and the program say about why (a canvas cleared after its drawing; values set for the drawing that nothing reads)
    const failedDrawing = missing.some((text) => /^(?:The program put nothing visible|Nothing the program draws|The program drew nothing)/.test(text));
    const drawingFacts: string[] = [];
    if (failedDrawing && (DRAW_REQUEST.test(request) || DRAWING_REQUEST.test(request))) {
      const cleared = this.javascriptRuntime.clearedWithoutDrawing?.();
      if (cleared?.covered) drawingFacts.push(cleared.fn ? `${cleared.fn}() paints over the whole canvas after the last drawing.` : 'The whole canvas is painted over after the last drawing.');
      else if (cleared) drawingFacts.push(cleared.fn ? `${cleared.fn}() clears the canvas and then draws nothing.` : 'The canvas is cleared after the last drawing.');
      const supports = (globalThis as { CSS?: { supports?: (property: string, value: string) => boolean } }).CSS?.supports;
      const unused = code ? unusedDrawingValues(code, (value) => { try { return !!supports && supports('color', value); } catch { return false; } }) : [];
      if (unused.length > 0) drawingFacts.push(`${unused.join(', ')} ${unused.length === 1 ? 'is' : 'are'} set but never used.`);
    }
    const writes = this.javascriptRuntime.unknownWrites?.() ?? [];
    const scope = writes.length > 0 ? this.javascriptRuntime.pageScope?.() : null;
    const facts: string[] = [];
    for (const { type, name } of writes) {
      const list = scope ? memberList(type, name, scope) : null;
      if (!list || list.settings.length === 0) continue;
      const label = type.startsWith('element:') ? `a <${type.slice(8)}> element` : type;
      facts.push(`${name} isn't a setting of ${label}; its settings: ${list.settings.map((s) => s.name).join(', ')}.`);
    }
    return [...missing, ...drawingFacts, ...facts].join(' ');
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

  private async blankStage(run: NonNullable<typeof this.lastRun>, blank: Blank, attempt: number, hintText?: string, members?: RealMember[]): Promise<void> {
    const error = run.error;
    if (!error) return;
    const moved = () => !!this.scheduler.getActiveTurnId() || this.lastRun !== run;
    // A pause before the stage's hidden runs and model calls, for phones' memory
    await settle(AFTER_HEAVY_MS);
    if (moved()) return;
    this.addFixNote(fixNote(attempt, error), `blank_${run.turnId}`);
    this.startFixLog(run);
    appendRunLog('retry', `the program failed (${errorText(error, run.errorLine)}): trying ${members ? 'the real members' : 'expressions'} for the blank \`${blank.text}\` (${blank.why}), each in a test run (try ${attempt} of ${MAX_FIX_TRIES})`);

    const abort = new AbortController();
    this.blankAbort = abort;
    const provider = this.phonePipeline?.coder ?? this.llmProvider;
    const facts = [earlierErrors(run.errorHistory, error), hintText].filter(Boolean).join(' ') || undefined;
    const page = { ids: this.javascriptRuntime.pageIds?.() ?? [], fields: this.javascriptRuntime.pageFields?.() ?? [], tags: this.javascriptRuntime.pageTags?.(), helpers: this.javascriptRuntime.helperMembers?.() };
    // (a member blank: the real members that fit and are related to the name)
    const choices = members ? members.map((m) => m.name) : blankChoices(run.code, blank, page);

    const asking = (request: string, shape: Partial<LlmGenerationOptions> = {}): LlmGenerationOptions => ({
      turnId: `blank_${run.turnId}_${attempt}`,
      systemPrompt: BLANK_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: request }],
      temperature: 0.1,
      signal: abort.signal,
      ...shape,
    });
    const ask = (request: string, shape: Partial<LlmGenerationOptions>): Promise<string | null> =>
      withActivity('asking for a fix', async () => {
        if (moved() || abort.signal.aborted) return null;
        try {
          const result = await provider.generate(asking(request, shape));
          return moved() || abort.signal.aborted || result.aborted ? null : result.text;
        } catch {
          return null;
        }
      });
    // The probability of each label as the answer to a choice request, or null (a runtime that
    // can't score, or a pass that gave nothing)
    const score = (request: string, labels: string[]): Promise<number[] | null> =>
      withActivity('asking for a fix', async () => {
        if (!provider.scoreChoices || moved() || abort.signal.aborted) return null;
        try {
          const scores = await provider.scoreChoices(asking(request, { exact: true, fixShape: 'choice', choiceCount: labels.length, maxOutputTokens: 1 }), labels);
          return moved() || abort.signal.aborted || scores?.length !== labels.length ? null : scores;
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
    // The choice the model's scores clearly prefer: 0.75 or more, and twice the next
    let clearlyPreferred: string | null = null;
    type Candidate = { code: string; expr: string; level: number; rank: number; votes: number };
    let best = null as Candidate | null;
    // The choices best-first: by name at first, by the model's probabilities once it has scored them
    let ranked = choices;
    const rankOf = (expr: string) => {
      const i = ranked.indexOf(expr);
      return i < 0 ? ranked.length : i;
    };
    const mentions = new RegExp(`(?<![\\w$])${blank.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
    const tested = new Set<string>();
    // A test run can't tell which candidate is meant (two fields both run), only how far each got:
    // the furthest wins, then the one whose name fits, then the model's votes
    const test = async (expr: string): Promise<void> => {
      if (tested.has(expr) || count >= MAX_BLANK_CANDIDATES || moved() || abort.signal.aborted) return;
      tested.add(expr);
      // A missing function's name only gets a function that shares a word with it or that the model
      // clearly chose, and never the function it is in (that would only call itself): see blank-fix.ts
      if (!standsForMissingFunction(run.code, blank, error, expr, clearlyPreferred === expr) || fillCallsItself(run.code, blank, expr)) {
        appendRunLog('retry', `\`${expr}\` for \`${blank.text}\`: ${fillCallsItself(run.code, blank, expr) ? 'the function it is in, which would only call itself' : 'shares no word with it, and the model did not clearly choose it'}: not tried`);
        return;
      }
      const filled = members ? fillMember(run.code, blank, expr) : fillBlank(run.code, blank, expr);
      if (!filled || filled === run.code) return;
      count++;
      // The test copy marks the blank, to tell a clean run from one that never got there (a click
      // handler, an animation frame, a Tone.Loop's callback). A member name can't carry the mark, so
      // the object it is a member of does
      const probe = members ? (fillMember(run.code, blank, expr, 'globalThis.__chattyReached = true') ?? filled) : (fillBlank(run.code, blank, `((globalThis.__chattyReached = true), ${expr})`) ?? filled);
      const trial = await this.trial(probe);
      if (moved()) return;
      // 3: ran through the blank without an error. With an error: 0 when it is at the fill itself (the
      // value fails where it is used: the candidate named, or its member missing), is the program's own error again, or has no line; otherwise by what ran: 2 when the run got
      // through the blank (its mark ran) and failed somewhere else, 0 when it never reached the blank
      // (an error that comes before it says nothing about the fill). A run that can't say whether it
      // reached the blank is judged by the line, as before: 2 past the blank, 1 another error.
      // (a pick whose use the run never reached, with no error, is level 1; for a member it is not applied: nothing showed it works)
      const atFill = !!trial.error && failsAtFill(trial.error, expr, blank.text, error);
      // A run that ends in endless recursion made the program worse, however far it got (nextTurn put
      // where isValidMove was called, in a tic-tac-toe, overflowed the stack and was taken for progress)
      const recursed = !!trial.error && RECURSION.test(trial.error) && !RECURSION.test(error);
      const level = recursed ? 0 : !trial.error
        ? trial.reached === false && probe !== filled
          ? members
            ? 0
            : 1
          : 3
        : atFill || trial.errorLine === undefined || trial.error === error
          ? 0
          : trial.reached === true
            ? 2
            : trial.reached === false
              ? 0
              : trial.errorLine > (run.errorLine ?? blank.line) + (blank.declareAt ? 1 : 0)
                ? 2
                : !mentions.test(trial.error)
                  ? 1
                  : 0;
      appendRunLog('retry', `a test run: \`${expr}\` for \`${blank.text}\` gave ${trial.error ? `${errorText(trial.error, trial.errorLine)}${level ? ' (progress)' : ''}` : trial.reached === false ? `no error, but the blank never ran${members ? ' (not applied)' : ''}` : 'no error'}`);
      if (!level) return;
      const entry = { code: filled, expr, level, rank: rankOf(expr), votes: votes.get(expr) ?? 0 };
      if (!best || entry.level > best.level || (entry.level === best.level && (entry.rank < best.rank || (entry.rank === best.rank && entry.votes > best.votes)))) best = entry;
    };
    // Nothing beats a clean run of the best-fitting choice
    const settled = () => { const b = best as Candidate | null; return b !== null && b.level === 3 && b.rank === 0; };
    try {
      if (choices.length >= 2) {
        const request = choiceRequest(run.task, run.code, blank, error, choices, facts);
        // One pass of the question gives the model's probability for every choice (a runtime that
        // can scores them): the choices are then tried best-first, and no letter is asked for
        const labels = choices.slice(0, 26).map((_, i) => String.fromCharCode(65 + i));
        const scores = await score(request, labels);
        if (scores) {
          // (equal scores keep their order by name)
          const order = labels.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
          ranked = [...order.map((i) => choices[i]), ...choices.slice(labels.length)];
          if (scores[order[0]] >= 0.75 && scores[order[0]] >= 2 * (scores[order[1]] ?? 0)) clearlyPreferred = choices[order[0]];
          // (a runtime reports only its likeliest few: the rest follow them in their order)
          const shown = order.filter((i) => scores[i] > 0);
          appendRunLog('retry', `scored the choices by probability: ${shown.map((i) => `\`${choices[i]}\` ${scores[i].toFixed(2)}`).join(', ')}${choices.length > shown.length ? ` (${choices.length - shown.length} more, less likely)` : ''}`);
        } else {
          const reply = await ask(request, { exact: true, fixShape: 'choice', choiceCount: choices.length, maxOutputTokens: 8 });
          const picked = reply === null ? -1 : chosenIndex(reply, choices.length);
          if (picked >= 0) vote(choices[picked]);
        }
      }
      // The best choice first (by probability, else by name): when it runs cleanly, the model
      // needn't write anything
      if (ranked.length > 0) await test(ranked[0]);
      if (!settled()) {
        // Greedy, then wide, then narrow: three really different answers (a member blank has only
        // the real members to choose from: no expression is written)
        for (const sampling of members ? [] : [{ exact: true }, { sampling: fixSampling(2) }, { sampling: fixSampling(3) }]) {
          if (moved() || abort.signal.aborted) break;
          const reply = await ask(blankRequest(run.task, run.code, blank, error, facts), { ...sampling, fixShape: 'expression', maxOutputTokens: 96 });
          vote(reply === null ? null : firstExpression(reply));
        }
        const candidates = [...new Set([...ranked, ...votes.keys()])].sort(
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
      await this.runCorrected(run, { code: found.code, note: `${blank.text} → ${found.expr}` }, { fixAttempt: attempt, errorHistory: withError(run), fill: { original: run.code, error, errorLine: run.errorLine, expr: found.expr, blankText: blank.text } });
      return;
    }
    this.finishFixLog('unchanged');
    appendRunLog('retry', `no expression passed a test run (${count} tried for \`${blank.text}\`): asking for the marked line instead`);
    // A try that got nowhere
    this.noteStaleTry(run);
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
  private staticPromptParts(request?: string, program = ''): { head: string[]; tail: string[] } {
    // Every model gets only the rules this request needs: one set of rules for all of them. (Bigger
    // models once got every rule, the same prompt each turn for its cache: Qwen3.5 2B, given all of them
    // for a tip calculator, wrote a 4-line program that made no field)
    const filter = request !== undefined;
    const rules = filter ? promptRules(`${request}\n${program}`, true, program) : CONCISE_VOICE_SYSTEM_PROMPT;
    const head = this.phonePipeline
      ? [`${this.phonePipeline.chatSystemPrompt} Current date and time: ${new Date().toLocaleString()}.`]
      : [rules];

    // The format, restated after everything else. iPhone and iPad (Safari) ask for the shortest
    // program: a long reply takes long there, and it's where small models start repeating themselves
    const tail = this.phonePipeline
      ? []
      : [
          'Output:',
          isAppleMobile()
            ? 'Reply with the shortest complete JavaScript program for the request in a ```javascript block, ending with one speak() sentence that tells the user what it does.'
            : 'Reply with one simple, complete JavaScript program for the request in a ```javascript block, ending with one speak() sentence that tells the user what it does.',
        ];
    return { head, tail };
  }

  /** Estimated tokens of what every prompt carries: the system prompt and the format turns */
  private fixedPromptTokens(): number {
    // Every prompt has the core rules and only the rules a request needs, so count the core rules
    // (the format turns are always there)
    const { head, tail } = this.staticPromptParts('');
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
    const { head, tail } = this.staticPromptParts(userMessage, programBeingEdited ?? '');
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
        fixedCode.set(m.fixesTurnId, this.correctedPrograms.get(m.turnId)?.code ?? m.rawCode);
      }
    }
    // …and so does a program whose slips were corrected
    for (const [turnId, { code }] of this.correctedPrograms) if (!fixedCode.has(turnId)) fixedCode.set(turnId, code);

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
