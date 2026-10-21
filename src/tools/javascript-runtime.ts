// ============================================================================
// JavaScript Runtime: runs the model's programs
// Supports Sandboxed IFrame (default, with DOM/visual rendering),
// Web Worker (headless background compute), and Direct Eval ((0, eval) strict).
// ============================================================================

import { parse } from 'acorn';
import type { LlmRuntimeProvider, ToolDefinition } from '../types/index.ts';
import { loopProtect } from './loop-protect.ts';
import { playNotesHelper } from './music-tool.ts';
import { fetchWikipediaSummary } from './web-tools.ts';
import { closeCutOff, type StandIn } from '../core/error-hints.ts';
import { sureMatch } from '../core/fuzzy-match.ts';
import { elementKinds } from './element-kinds.ts';

/**
 * Wraps fn so that however often the result is called, fn runs at most once per animation frame,
 * on the next one, and so sees the state at the end of the burst.
 */
export function oncePerFrame(fn: () => void, raf: (callback: () => void) => unknown): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    raf(() => {
      queued = false;
      fn();
    });
  };
}

/**
 * three.js for 3D programs: a program that uses THREE finds it ready, as a global in its page.
 * It's bundled with Chatty (works offline) and loads only the first time a program uses it.
 */
async function withThree(code: string, win: Window | null, live: () => boolean = () => true): Promise<void> {
  if (!win || !/\bTHREE\b/.test(code)) return;
  try {
    const THREE = await import('three');
    // A reused frame's window is the next page's by now
    if (!live()) return;
    (win as unknown as { THREE?: unknown }).THREE = THREE;
  } catch (err) {
    console.warn('three.js could not load:', err);
  }
}
import { withActivity } from '../core/activity-breadcrumbs.ts';
import { midiSummary as softwareMidiSummary, resetMidiSummary, silenceSoftwareMidi, softwareMidiAccess, type MidiSummary } from '../audio/software-midi.ts';

export type JavascriptExecutionMode = 'iframe' | 'worker' | 'eval';

export interface JavascriptExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  logs: string[];
  spokenTexts?: string[];
  hasVisualOutput: boolean;
  executionTimeMs: number;
  code: string;
  mode: JavascriptExecutionMode;
  task?: string;
  /** Still running when the wait ended (a long song, a slow fetch): not a failure */
  stillRunning?: boolean;
  /** The program line the error came from (1-based), when the browser's stack trace says */
  errorLine?: number;
}

export type RunLogKind = 'program' | 'speak' | 'clear' | 'imagined' | 'console' | 'error';

export interface ExecutionContextOptions {
  onSpeak?: (text: string) => void;
  /** What the user asked for (the sandbox's speech check leaves NaN, Infinity and undefined alone when they are what was asked about) */
  request?: string;
  audioContextAccessor?: () => Promise<AudioContext | null> | AudioContext | null;
  rootElement?: HTMLElement | null;
}

export interface JavascriptTaskInput {
  task?: string;
  code?: string;
  mode?: JavascriptExecutionMode;
}

export type JavascriptExecutionCallback = (result: JavascriptExecutionResult) => void;

export interface JavascriptRuntimeOptions {
  mode?: JavascriptExecutionMode;
  timeoutMs?: number;
  llmProvider?: LlmRuntimeProvider;
  onResult?: JavascriptExecutionCallback;
  onVisualChange?: (hasVisual: boolean, iframe: HTMLIFrameElement | null) => void;
  iframeContainer?: HTMLElement | null;
  /** The app's running audio context, shared with programs (see programAudio) */
  getSharedAudioContext?: () => AudioContext | null;
  /** An error a program threw after it started (in a timer, event handler or async function) */
  onProgramError?: (message: string, line?: number) => void;
  /** A program started making sound (true), or has been quiet for a few seconds (false) */
  onProgramAudio?: (sounding: boolean) => void;
  /** Everything programs do that can be overwritten later: each program run, speak(), clear(), errors */
  onRunLog?: (kind: RunLogKind, text: string) => void;
  /** A program has timers or async code pending (true), or its last one ended (false) */
  onProgramActivity?: (active: boolean) => void;
  /** The program in the card can be downloaded (it ran 2.5 s without an error), or no longer can */
  onDownloadableChange?: (ready: boolean) => void;
}

export const CODING_AGENT_SYSTEM_PROMPT = [
  'You are a single-use browser application coding agent.',
  'Write self-contained, working JavaScript to implement anything requested by the user in the browser.',
  'Available runtime environments: "iframe" (for interactive DOM apps, games, canvas visuals, Web Audio, animations, timers, Web APIs), "worker" (for heavy background math/loops), "eval" (for quick math expressions).',
  'For interactive widgets, games (e.g. Pong, Snake, Tic-Tac-Toe), timers, or tools: create clean HTML elements with CSS styles and event listeners, appending to document.getElementById("root") or document.body.',
  'For visual graphics, animations, or simulations: render onto an HTML5 <canvas> (or SVG) using requestAnimationFrame.',
  'For music, sound effects, or audio: use Web Audio API (new AudioContext, await ctx.resume(), OscillatorNode, GainNode).',
  'For data, calculations, or Web APIs: execute and return the result or log via console.log.',
  'Always use MODE: iframe for interactive DOM, canvas, games, audio, or visual widgets.',
  'Respond in this format:',
  'MODE: <iframe|worker|eval>',
  '```javascript',
  '<executable code>',
  '```',
].join(' ');

/**
 * Parses the single-use coding agent response for target execution mode and code.
 */
export function parseCodingAgentOutput(text: string): {
  mode?: JavascriptExecutionMode;
  code: string;
} {
  let mode: JavascriptExecutionMode | undefined;
  const modeMatch = text.match(/\bMODE:\s*(iframe|worker|eval)\b/i);
  if (modeMatch) {
    mode = modeMatch[1].toLowerCase() as JavascriptExecutionMode;
  }

  const codeBlockMatch = text.match(/```(?:javascript|js)?\s*\n([\s\S]*?)\n```/i);
  let code = codeBlockMatch ? codeBlockMatch[1].trim() : '';

  if (!code) {
    code = text.replace(/MODE:\s*(iframe|worker|eval)/gi, '').trim();
  }

  return { mode, code };
}

export interface PreparedExecutableCode {
  code: string;
  isProse: boolean;
  /** The reply was cut off before its end: its unfinished last lines removed, its open blocks closed */
  cutOff?: { dropped: number; closed: number };
  /** A program that says nothing ended on a sentence in a comment: said with speak() (see speakClosingComment) */
  spokeComment?: string;
  /** Functions it declared but never called, called at its end (see callUncalledFunctions) */
  called?: string[];
  /** Functions its inline handlers call, made reachable from them (see exposeFunctionsToInlineHandlers) */
  exposed?: string[];
}

/**
 * Inspects raw text from the model into executable JavaScript and classifies
 * whether it is an executable JavaScript code action or conversational prose.
 */
/**
 * What a trial run's sandbox page talks to instead of the app window: messages still go to the
 * app (which only watches for errors), and sound has nowhere to go. Web Audio is an
 * OfflineAudioContext that never renders, MIDI is a port that swallows everything, and speech and
 * media elements do nothing. (Source text for the sandbox page, evaluated there.) Trials share one
 * iframe, so the page carries its trial's token and stamps it on every message: a straggler from
 * an earlier trial's page can't pass for this one's.
 */
const trialHost = (token: string) => `(() => {
  window.__chattyTrialToken = ${JSON.stringify(token)};
  let audio = null;
  const quiet = () => {
    if (audio) return audio;
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return null;
    const real = new Offline(2, 44100, 44100);
    const context = new Proxy(real, {
      get(target, prop) {
        if (prop === 'state') return 'running';
        if (prop === 'resume') return () => Promise.resolve();
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    audio = { context, output: real.destination };
    return audio;
  };
  const port = {
    id: 'quiet', name: 'Quiet', manufacturer: '', type: 'output', state: 'connected', connection: 'open',
    send() {}, clear() {}, open() { return Promise.resolve(port); }, close() { return Promise.resolve(port); },
    addEventListener() {}, removeEventListener() {},
  };
  try { HTMLMediaElement.prototype.play = () => Promise.resolve(); } catch {}
  try { window.speechSynthesis.speak = () => {}; } catch {}
  // The page shares the app's origin, and a trial clicks every button ("Clear all", "Save",
  // "Copy"): nothing it does may reach the user's data. Storage is a copy in memory, and what
  // would change something elsewhere (a request other than GET or HEAD, a beacon, the clipboard)
  // goes nowhere and reports success
  const memoryStorage = (real) => {
    const items = new Map();
    try { for (let i = 0; i < real.length; i++) items.set(real.key(i), real.getItem(real.key(i))); } catch {}
    return {
      get length() { return items.size; },
      key: (i) => Array.from(items.keys())[i] ?? null,
      getItem: (k) => (items.has(String(k)) ? items.get(String(k)) : null),
      setItem: (k, v) => { items.set(String(k), String(v)); },
      removeItem: (k) => { items.delete(String(k)); },
      clear: () => { items.clear(); },
    };
  };
  for (const name of ['localStorage', 'sessionStorage']) {
    try { Object.defineProperty(window, name, { value: memoryStorage(window[name]), configurable: true }); } catch {}
  }
  try {
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
      if (method === 'GET' || method === 'HEAD') return realFetch(input, init);
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    };
  } catch {}
  try { navigator.sendBeacon = () => true; } catch {}
  try { if (navigator.clipboard) navigator.clipboard.writeText = () => Promise.resolve(); } catch {}
  return {
    postMessage: (message) => window.parent.postMessage({ ...message, __trial: window.__chattyTrialToken }, '*'),
    __chattySharedAudio: quiet,
    __chattyMidi: () => Promise.resolve({
      inputs: new Map(), outputs: new Map([['quiet', port]]), sysexEnabled: false,
      onstatechange: null, addEventListener() {}, removeEventListener() {},
    }),
  };
})()`;

/** A request about NaN, Infinity or undefined, or dividing by zero: those are its answer, not a bug */
const VALUES_ASKED_ABOUT = /\b(?:NaN|infinity|infinite|undefined|divid\w* by (?:zero|0))\b|\/\s*0\b/i;

/** How long a program runs without an error before it can be downloaded */
const DOWNLOAD_AFTER_MS = 2500;

/** How long the shared trial frame stays after its last trial, so a run of trials reuses it */
const TRIAL_FRAME_IDLE_MS = 10_000;

const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor;

function parsesAsJs(code: string): boolean {
  try {
    new AsyncFunctionCtor('speak', 'playNotes', 'searchWikipedia', 'root', code);
    return true;
  } catch {
    return false;
  }
}

/** An ```html block as code: its markup goes on screen, then its inline scripts run. */
function htmlToCode(html: string): string {
  // Each <script> in order: inline code runs as is, one with a src is loaded first (awaited, so
  // the code after it finds what it defines: Chart, d3, Tone), and one that isn't JavaScript
  // (a shader, JSON, a template) stays in the markup for the code to read
  const scripts: string[] = [];
  const kept: string[] = [];
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1].toLowerCase() ?? '';
    if (type && !/^(?:module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/.test(type)) {
      kept.push(m[0]);
      continue;
    }
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    // three.js comes with Chatty (see withThree): no need to fetch it
    if (src && !/\bthree(?:\.module)?(?:\.min)?\.js\b/i.test(src)) scripts.push(loadScriptCode(src));
    if (m[2].trim()) scripts.push(m[2]);
  }
  // JavaScript lines written outside the <script> (small models put a speak() after it) run too,
  // instead of showing on screen as text
  const strayCode: string[] = [];
  const markup = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!doctype[^>]*>|<\/?(?:html|head|body)[^>]*>/gi, '')
    .split('\n')
    .filter((line) => {
      if (line.includes('<') || !CODE_LINE.test(line)) return true;
      strayCode.push(line);
      return false;
    })
    .join('\n')
    .trim();
  const page = [markup, ...kept].filter(Boolean).join('\n');
  return [
    page ? `document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(page)});` : '',
    ...scripts,
    ...strayCode,
  ].join('\n');
}

/** Code that loads a page's <script src>, and waits for it (a script that can't load says which) */
function loadScriptCode(src: string): string {
  const url = JSON.stringify(src);
  return `await new Promise((resolve, reject) => { const script = document.createElement("script"); script.src = ${url}; script.onload = resolve; script.onerror = () => reject(new Error("The script " + ${url} + " couldn't load")); document.head.appendChild(script); });`;
}

/**
 * A whole HTML page with its <script> written into `x.innerHTML = \`` and the string never closed
 * (the program can't parse): its markup goes on screen and its scripts run, as with an HTML reply.
 * Null when that isn't what broke the program.
 */
function unclosedPage(code: string): string | null {
  for (const match of code.matchAll(/^([^\n]*\.innerHTML\s*\+?=\s*)`/gm)) {
    const at = match.index ?? 0;
    const rest = code.slice(at + match[0].length);
    if (!/<script\b/i.test(rest)) continue;
    const repaired = `${code.slice(0, at)}${htmlToCode(rest.replace(/`;?\s*$/, ''))}`;
    // (await in a plain function is fixed before it runs: see makeAwaitingFunctionsAsync)
    if (parsesAsJs(repaired) || parsesAsJs(repaired.replace(/\bawait\s+/g, ''))) return repaired;
  }
  return null;
}

const CODE_LINE =
  /^\s*(?:const |let |var |(?:async\s+)?function\b|class |await |speak\(|playNotes\(|root\.|document\.|window\.|canvas\.|ctx\.|for\s*\(|\/\/)/;

type ReplyPart = { kind: 'code' | 'talk'; text: string };

/** A line of code (not a sentence) */
const looksLikeCode = (line: string) => CODE_LINE.test(line) || /[;{}()[\]]\s*(\/\/.*)?$/.test(line.trim());
/** A line of talk: words, not code or markup */
const looksLikeTalk = (line: string) => {
  const t = line.trim();
  return !!t && !looksLikeCode(t) && !/[<>{};=]/.test(t) && /[A-Za-z]{2,}[^A-Za-z]+[A-Za-z]{2,}/.test(t);
};

/**
 * The parts of an unfenced reply, in order. Models put a blank line between their code and their
 * talk, so each paragraph is one or the other; a paragraph that starts or ends with sentences has
 * those split off. When taking the talk out leaves code that doesn't parse (plain text inside an
 * HTML template string), it was code after all.
 */
function paragraphParts(text: string): ReplyPart[] {
  // Each piece: a paragraph's lines, split into talk before, code (or talk), talk after
  const pieces: Array<{ before: string[]; middle: string[]; after: string[]; isCode: boolean }> = [];
  for (const paragraph of text.split(/\n[ \t]*\n/)) {
    const lines = paragraph.split('\n');
    let start = 0;
    let end = lines.length;
    while (start < end && (looksLikeTalk(lines[start]) || !lines[start].trim())) start++;
    while (end > start && (looksLikeTalk(lines[end - 1]) || !lines[end - 1].trim())) end--;
    const middle = lines.slice(start, end);
    const body = middle.join('\n');
    // Not one line of code in it ("Hi!", "Sure (thanks)"): talk
    // A code line starts like code: a keyword, a call or assignment ("drawBall();", "o.type = 2;"), or a closing bracket
    const isCode = middle.some((line) => CODE_LINE.test(line) || /^\s*[\w$.]+(?:\(|\s*[+\-*/]?=[^=]|\[)/.test(line) || /^\s*[}\])]/.test(line)) ||
      (parsesAsJs(body) && /[;{}=]/.test(body));
    pieces.push({ before: lines.slice(0, start), middle, after: lines.slice(end), isCode });
  }
  const codeAt = pieces.map((piece, at) => (piece.isCode && piece.middle.join('').trim() ? at : -1)).filter((at) => at >= 0);
  const parts: ReplyPart[] = [];
  const add = (kind: ReplyPart['kind'], lines: string[], gap = '\n\n') => {
    const body = lines.join('\n').trim();
    if (!body) return;
    const prev = parts[parts.length - 1];
    if (prev && prev.kind === kind) prev.text += (kind === 'code' ? gap : ' ') + body;
    else parts.push({ kind, text: body });
  };
  const split = () => {
    for (const piece of pieces) {
      add('talk', piece.before);
      add(piece.isCode ? 'code' : 'talk', piece.middle);
      add('talk', piece.after);
    }
    return parts;
  };
  if (codeAt.length === 0) return split();
  const first = codeAt[0];
  const last = codeAt[codeAt.length - 1];
  const codeOnly = codeAt.map((at) => pieces[at].middle.join('\n')).join('\n\n');
  // Talk between code parts that the code needs in order to parse (plain text in an HTML
  // template string): everything from the first code to the last is code
  if (!parsesAsJs(codeOnly)) {
    const span = [
      pieces[first].middle.join('\n'),
      ...pieces.slice(first + 1, last + 1).map((piece, k) =>
        first + 1 + k === last ? [...piece.before, ...piece.middle].join('\n') : [...piece.before, ...piece.middle, ...piece.after].join('\n')
      ),
    ].join('\n\n');
    if (parsesAsJs(span)) {
      for (const piece of pieces.slice(0, first)) {
        add('talk', piece.before);
        add(piece.isCode ? 'code' : 'talk', piece.middle);
        add('talk', piece.after);
      }
      add('talk', pieces[first].before);
      parts.push({ kind: 'code', text: span.trim() });
      add('talk', pieces[last].after);
      for (const piece of pieces.slice(last + 1)) {
        add('talk', piece.before);
        add(piece.isCode ? 'code' : 'talk', piece.middle);
        add('talk', piece.after);
      }
      return parts;
    }
  }
  return split();
}

/**
 * Pulls the program out of a reply that wraps it in markdown or explanation (small models often
 * do, despite the prompt), with the talk around it in order, to be said with speak() (withTalk).
 * Null when the reply has no code.
 */
function extractProgram(text: string): ReplyPart[] | null {
  const blocks = Array.from(text.matchAll(/```([\w-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g));
  if (blocks.length > 0) {
    const parts: ReplyPart[] = [];
    let at = 0;
    for (const block of blocks) {
      const [whole, lang, body] = block;
      // Outside the fences may be code too ("speak(…); clear();" before an ```html block)
      parts.push(...paragraphParts(text.slice(at, block.index)));
      at = (block.index ?? 0) + whole.length;
      const l = lang.toLowerCase();
      if (l === 'html') parts.push({ kind: 'code', text: htmlToCode(body) });
      else if (l === 'css') parts.push({ kind: 'code', text: `document.head.appendChild(Object.assign(document.createElement("style"), { textContent: ${JSON.stringify(body)} }));` });
      else if (!l || /^(?:js|javascript|jsx|mjs)$/.test(l)) parts.push({ kind: 'code', text: body.trim() });
    }
    parts.push(...paragraphParts(text.slice(at)));
    return parts.some((part) => part.kind === 'code' && part.text) ? parts : null;
  }
  const parts = paragraphParts(text);
  const firstCode = parts.findIndex((part) => part.kind === 'code');
  if (firstCode < 0) return null;
  // Code that doesn't parse with talk after it is a chat reply quoting code, not a program; with
  // no talk after it, it's a program cut off or broken, run so the error reaches the fix
  const code = parts.filter((part) => part.kind === 'code').map((part) => part.text).join('\n');
  if (!parsesAsJs(code) && parts.slice(firstCode).some((part) => part.kind === 'talk')) return null;
  return parts;
}

/** A sentence about the code itself ("Here's the JavaScript code:"): nothing the user needs to hear */
const CODE_TALK = /\b(?:code|javascript|js|snippet|script|html|css|function|variable|syntax|example usage)\b|```/i;

/** Talk the model wrote outside its code, as one plain sentence or two to say, or '' */
function talkToSay(text: string, code: string): string {
  const plain = text
    .replace(/[#*_`>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = (plain.match(/[^.!?]+[.!?]*/g) ?? [])
    .map((sentence) => sentence.trim())
    // Already said by the program, or about the code rather than to the user
    .filter((sentence) => sentence && !CODE_TALK.test(sentence) && !code.includes(sentence.replace(/[.!?:]+$/, '')));
  return sentences.join(' ').replace(/:$/, '.').slice(0, 300).trim();
}

/**
 * The program with the talk around it said through speak(), each part where the model put it:
 * all messages to the user go through speak()
 */
function withTalk(parts: ReplyPart[]): string {
  const code = parts.filter((part) => part.kind === 'code').map((part) => part.text).join('\n');
  return parts
    .map((part) => {
      if (part.kind === 'code') return part.text;
      const talk = talkToSay(part.text, code);
      return talk ? `speak(${JSON.stringify(talk)});` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Code runs exactly as written, so a program that only defines its functions does nothing.
 * Calls the zero-argument top-level functions nothing else refers to (draw(), main(), ...).
 */
export function callUncalledFunctions(original: string): string {
  // Judged without comments: a word in a comment ("// then draw") is no call of draw()
  const code = stripComments(original);
  // The program's top-level functions that take nothing, however they are indented (a page's
  // <script> usually is); by their line start when the program doesn't parse
  const declared = topLevelNoArgFunctions(code) ?? [
    ...Array.from(code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(\s*\)/gm), (m) => m[1]),
    ...Array.from(code.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(\s*\)\s*=>/gm), (m) => m[1]),
  ];
  if (declared.length === 0) return original;
  // A function's own body doesn't count: one that only calls itself (a loop, a timer) still needs
  // its first call. Without a parse, every mention counts, so only the declaration may name it.
  const own = topLevelFunctionRanges(code);
  const refs = (name: string) => {
    const range = own.get(name);
    const text = range ? code.slice(0, range[0]) + code.slice(range[1]) : code;
    return text.match(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))?.length ?? 0;
  };
  const roots = declared.filter((name) => refs(name) === (own.has(name) ? 0 : 1));
  let toCall = roots.filter((name) => /^(?:main|init|start|run|setup|draw|play|render|animate|create|build|show|make)/i.test(name));
  if (toCall.length === 0 && roots.length === declared.length) toCall = [declared[declared.length - 1]];
  preparing?.called.push(...toCall);
  return toCall.length ? `${original}\n${toCall.map((name) => `await ${name}();`).join('\n')}` : original;
}

/**
 * A program that says nothing (no speak()) but ends on a comment written as a sentence to the user
 * (`// This draws a red ball that bounces.`): the sentence is said, as the prompt asked for. Code
 * notes (`// draw loop`, `// x = 5`) stay comments.
 */
export function speakClosingComment(code: string): { code: string; text: string } | null {
  if (/\bspeak\s*\(/.test(code)) return null;
  const comments: Array<{ value: string; start: number }> = [];
  let program: ReturnType<typeof parse>;
  try {
    program = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      onComment: (_block, value, start) => comments.push({ value, start }),
    });
  } catch {
    return null;
  }
  const lastCode = program.body.length ? program.body[program.body.length - 1].end : 0;
  const text = comments
    .filter((c) => c.start >= lastCode)
    .map((c) => c.value.replace(/^\s*\*+|\*+\s*$/gm, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A sentence: four words or more, letters, and nothing that reads as code
  if (text.split(' ').length < 4 || !/[A-Za-z]/.test(text) || /[=;{}()[\]<>]|=>|\b(?:const|let|var|function|return)\b/.test(text)) return null;
  return { code: `${code}\nspeak(${JSON.stringify(text)});`, text };
}

/** The names of all top-level functions (declared, or a function in a const/let/var), however indented; null when the code doesn't parse */
function topLevelFunctionNames(code: string): string[] | null {
  let program: ReturnType<typeof parse>;
  try {
    program = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch {
    return null;
  }
  const names: string[] = [];
  for (const node of program.body) {
    if (node.type === 'FunctionDeclaration' && node.id) names.push(node.id.name);
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) if (d.id.type === 'Identifier' && d.init && /^(?:Arrow)?Function/.test(d.init.type)) names.push(d.id.name);
    }
  }
  return names;
}

/** The names of the top-level functions (and arrow functions in a const/let/var) taking no parameters, or null when the code doesn't parse */
function topLevelNoArgFunctions(code: string): string[] | null {
  let program: ReturnType<typeof parse>;
  try {
    program = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch {
    return null;
  }
  const names: string[] = [];
  for (const node of program.body) {
    if (node.type === 'FunctionDeclaration' && node.id && node.params.length === 0) names.push(node.id.name);
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id.type === 'Identifier' && d.init && /^(?:Arrow)?Function/.test(d.init.type) && (d.init as { params: unknown[] }).params.length === 0) names.push(d.id.name);
      }
    }
  }
  return names;
}

/** Each top-level function's own source (its declaration), by name; empty when the code doesn't parse */
function topLevelFunctionRanges(code: string): Map<string, [number, number]> {
  const ranges = new Map<string, [number, number]>();
  let program: ReturnType<typeof parse>;
  try {
    program = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch {
    return ranges;
  }
  for (const node of program.body) {
    if (node.type === 'FunctionDeclaration' && node.id) ranges.set(node.id.name, [node.start, node.end]);
    if (node.type !== 'VariableDeclaration') continue;
    for (const d of node.declarations) {
      if (d.id.type === 'Identifier' && /FunctionExpression$/.test(d.init?.type ?? '')) ranges.set(d.id.name, [d.start, d.end]);
    }
  }
  return ranges;
}

/**
 * Where a syntax error is (1-based line), found with a parser since browsers don't say. Undefined
 * when the code parses (the error happened while running). The parser loads only when needed.
 */
export async function syntaxErrorLine(code: string): Promise<number | undefined> {
  try {
    const { parse } = await import('acorn');
    parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
    return undefined;
  } catch (err) {
    const line = (err as { loc?: { line?: number } }).loc?.line;
    return typeof line === 'number' ? line : undefined;
  }
}

/**
 * The program without its comments: they cost tokens in every later prompt and fix request, and
 * models write long ones. Found by the parser, so // inside a string or a template stays. A line
 * that held only a comment goes; code before a comment on its line stays. Code that doesn't
 * parse is left as it is.
 */
export function stripComments(code: string): string {
  const comments: Array<{ start: number; end: number }> = [];
  try {
    parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      onComment: (_block: boolean, _text: string, start: number, end: number) => comments.push({ start, end }),
    });
  } catch {
    return code;
  }
  let out = code;
  for (const { start, end } of comments.reverse()) {
    const lineStart = out.lastIndexOf('\n', start - 1) + 1;
    const nextNewline = out.indexOf('\n', end);
    const lineEnd = nextNewline < 0 ? out.length : nextNewline;
    const before = out.slice(lineStart, start);
    const after = out.slice(end, lineEnd);
    if (!before.trim() && !after.trim()) {
      // The whole line was the comment: the line goes, with its newline
      out = out.slice(0, lineStart) + out.slice(nextNewline < 0 ? lineEnd : lineEnd + 1);
    } else {
      out = out.slice(0, start).replace(/[ \t]+$/, '') + out.slice(end);
    }
  }
  return out;
}

/** Where the bracket that `close` closes opens (scanning back), or -1 */
function matchingOpen(text: string, close: number, open: string, shut: string): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (text[i] === shut) depth++;
    else if (text[i] === open && --depth === 0) return i;
  }
  return -1;
}

/**
 * Where the innermost function around `pos` starts (where "async " goes): a function
 * declaration or expression, an arrow function, or a method. Blocks of if/for/while and the like
 * are skipped. -1 when there is none.
 */
function enclosingFunctionStart(src: string, pos: number): number {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (src[i] === '}') depth++;
    if (src[i] !== '{') continue;
    if (depth > 0) {
      depth--;
      continue;
    }
    const head = src.slice(0, i).replace(/\s+$/, '');
    if (head.endsWith('=>')) {
      const params = head.slice(0, -2).replace(/\s+$/, '');
      if (params.endsWith(')')) return matchingOpen(params, params.length - 1, '(', ')');
      const name = params.match(/[\w$]+$/);
      return name ? params.length - name[0].length : -1;
    }
    if (!head.endsWith(')')) continue; // else, try, an object literal…
    const open = matchingOpen(head, head.length - 1, '(', ')');
    if (open < 0) continue;
    const before = head.slice(0, open);
    const fn = before.match(/\bfunction\s*\*?\s*[\w$]*\s*$/);
    if (fn) return before.length - fn[0].length;
    const name = before.match(/([\w$]+)\s*$/);
    if (name && !/^(?:if|for|while|switch|catch|with|return)$/.test(name[1])) return before.length - name[0].length;
  }
  return -1;
}

/**
 * Small models use `await` (usually `(await navigator.requestMIDIAccess())`, copied from the music
 * rule) inside a function that isn't async: a syntax error before anything runs. Such functions
 * are made async. Only "async " is added, so line numbers stay the same.
 */
export async function makeAwaitingFunctionsAsync(code: string): Promise<string> {
  if (!/\bawait\b/.test(code)) return code;
  const { parse } = await import('acorn');
  let src = code;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
      return src;
    } catch (err) {
      const pos = (err as { pos?: number }).pos;
      if (typeof pos !== 'number') return src;
      // The parser stops at the word after "await" (read as a plain name) or at "await" itself
      const atAwait = /\bawait\s*$/.test(src.slice(0, pos)) || /^await\b/.test(src.slice(pos));
      if (!atAwait) return src;
      const at = enclosingFunctionStart(src, pos);
      if (at < 0) return src;
      src = `${src.slice(0, at)}async ${src.slice(at)}`;
    }
  }
  return src;
}

/**
 * Small models declare with const and then change the value ("Assignment to constant variable",
 * like a bouncing ball's x += dx): such a const becomes let, which never breaks working code.
 * Names are matched across the whole program, which is fine at this size. Same line count.
 */
export async function letReassignedConsts(code: string): Promise<string> {
  if (!/\bconst\b/.test(code)) return code;
  const { parse } = await import('acorn');
  let ast: unknown;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch {
    return code;
  }
  type Node = { type?: string; start?: number; [key: string]: unknown };
  const consts: Array<{ start: number; names: string[] }> = [];
  const changed = new Set<string>();
  const targets = (node: Node | undefined): string[] => {
    if (!node) return [];
    if (node.type === 'Identifier') return [node.name as string];
    if (node.type === 'ArrayPattern') return (node.elements as Node[]).flatMap((n) => targets(n ?? undefined));
    if (node.type === 'ObjectPattern') return (node.properties as Node[]).flatMap((p) => targets((p.value ?? p.argument) as Node));
    return [];
  };
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as Node;
    if (n.type === 'VariableDeclaration' && n.kind === 'const') {
      consts.push({ start: n.start ?? 0, names: (n.declarations as Node[]).flatMap((d) => targets(d.id as Node)) });
    } else if (n.type === 'AssignmentExpression') {
      targets(n.left as Node).forEach((name) => changed.add(name));
    } else if (n.type === 'UpdateExpression') {
      targets(n.argument as Node).forEach((name) => changed.add(name));
    }
    for (const key of Object.keys(n)) if (key !== 'type') walk(n[key]);
  };
  walk(ast);
  let src = code;
  // Last first, so earlier positions stay right ("const" and "let  " are the same length)
  for (const { start, names } of consts.reverse()) {
    if (names.some((name) => changed.has(name)) && src.startsWith('const', start)) {
      src = `${src.slice(0, start)}let  ${src.slice(start + 5)}`;
    }
  }
  return src;
}

/**
 * Whether code wires up handlers a trial run should use once (addEventListener, or an on-event
 * property or inline attribute for the events a click or an input fires), so an error that only
 * happens inside a handler is found before the user clicks.
 */
export function registersHandlers(code: string): boolean {
  return /\baddEventListener\s*\(|\bon(?:click|dblclick|input|change|submit|keydown|keyup|keypress|mousedown|mouseup|pointerdown|pointerup|touchstart)\s*=/.test(
    stripComments(code)
  );
}

/**
 * Inline handlers in a program's HTML (onclick="calc()") look names up globally, but programs run
 * as function bodies, where their functions stay local: those functions are made global too.
 */
export function exposeFunctionsToInlineHandlers(code: string): string {
  if (!/\son[a-z]+\s*=\s*\\?["']/i.test(code)) return code;
  const names = topLevelFunctionNames(code) ?? [
    ...Array.from(code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm), (m) => m[1]),
    ...Array.from(code.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/gm), (m) => m[1]),
  ];
  if (names.length === 0) return code;
  preparing?.exposed.push(...new Set(names));
  return `${code}\n${[...new Set(names)].map((name) => `try { window.${name} = ${name}; } catch {}`).join('\n')}`;
}

/** Speaks the explanation that came before extracted code when the code says nothing itself. */

/**
 * Other ways small models fence code (triple double or single quotes, ~~~, or a
 * `Javascript """` line) rewritten as ``` fences, so extractProgram finds them.
 */
function normalizeFences(text: string): string {
  return text.replace(
    /^[ \t]*(?:(javascript|js|html|css)[ \t:]*)?(?:"""|'''|~~~)[ \t]*([\w-]*)[ \t]*$/gim,
    (_line, label?: string, lang?: string) => '```' + (lang || label || '')
  );
}

/** A reply that starts with a real HTML tag (not just any <word>) */
const HTML_START =
  /^<(?:!doctype\b|!--|(?:html|head|body|div|span|p|h[1-6]|canvas|svg|style|script|button|input|form|label|section|main|header|footer|nav|article|ul|ol|li|table|img|a|pre|br|hr|center|select|textarea|video|audio|b|i|strong|em|small)[\s>/])/i;

/** Markdown on code lines, removed line by line (see inspectExecutableCode, step 2b) */
export function withoutMarkdownLeftovers(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(?:#{1,6}\s|\*\*[^*]+\*\*:?\s*$|>\s)/.test(line))
    .map((line) =>
      line
        // ```speak("Done."); → speak("Done.");
        .replace(/^(\s*)```(?:(?:javascript|js|typescript|ts|html|css)(?![\w$]))?\s*(?=\S)/i, '$1')
        // `speak("Done.");` → speak("Done.");
        .replace(/^(\s*)`([^`]+)`\s*$/, '$1$2')
        // speak("Done.");` → speak("Done.");
        .replace(/([;)}\]])\s*`+\s*$/, '$1')
    )
    .join('\n');
}

/** What preparing a reply added, for the run log (see inspectExecutableCode) */
let preparing: { called: string[]; exposed: string[] } | null = null;

/**
 * The reply as the program to run, with what preparing it added: the functions it never called,
 * called at its end, and those its inline handlers (onclick="go()") need, made reachable
 */
export function inspectExecutableCode(rawText: string, options: { closeCutOff?: boolean; speakComment?: boolean } = {}): PreparedExecutableCode {
  const added = { called: [] as string[], exposed: [] as string[] };
  const outer = preparing;
  preparing = added;
  try {
    const prepared = prepareProgram(rawText, options);
    return {
      ...prepared,
      ...(added.called.length ? { called: [...new Set(added.called)] } : {}),
      ...(added.exposed.length ? { exposed: [...new Set(added.exposed)] } : {}),
    };
  } finally {
    preparing = outer;
  }
}

function prepareProgram(rawText: string, options: { closeCutOff?: boolean; speakComment?: boolean } = {}): PreparedExecutableCode {
  let cleaned = normalizeFences((rawText || '').trim());

  // HTML instead of JavaScript (a whole page for "an app", or bare <canvas> + <script>): its
  // markup goes on screen and its scripts run, as with an ```html block. Never spoken as prose.
  // A page cut off inside its <script> runs that script to its end, its open blocks closed.
  const asPage = (html: string): PreparedExecutableCode => {
    const opened = (html.match(/<script\b/gi) ?? []).length;
    const closed = (html.match(/<\/script>/gi) ?? []).length;
    let code = htmlToCode(opened > closed ? `${html}\n</script>` : html);
    const cut = options.closeCutOff === false ? null : closeCutOff(code);
    if (cut) code = cut.code;
    return { code: exposeFunctionsToInlineHandlers(callUncalledFunctions(code)), isProse: false, ...(cut ? { cutOff: { dropped: cut.dropped, closed: cut.closed } } : {}) };
  };
  if (HTML_START.test(cleaned)) return asPage(cleaned);

  // 1. Take the program out of markdown fences if present
  let hadFences = false;
  if (cleaned.includes('```')) {
    const program = extractProgram(cleaned);
    if (program) {
      cleaned = withTalk(program);
      hadFences = true;
    }
    // A page in a ```javascript fence is a page all the same
    if (HTML_START.test(cleaned)) return asPage(cleaned);
  }

  // 2. Remove any rogue <|...|> or <tool_call> tags
  cleaned = cleaned.replace(/<\|[a-z0-9_]+\|?>/gi, '').replace(/<\/?\|?tool_call\|?>/gi, '').trim();

  // 2b. Markdown left on code lines (a fence glued to code, a line in `backticks`, a closing
  // backtick, a heading or **bold** line): removed only when the program doesn't parse as it is
  // and does without them
  if (!parsesAsJs(cleaned)) {
    const tidy = withoutMarkdownLeftovers(cleaned);
    if (tidy !== cleaned && parsesAsJs(tidy)) cleaned = tidy;
  }

  // 3. If empty, speak a polite ready message
  if (!cleaned) {
    return { code: 'speak("I am ready to help.");', isProse: true };
  }

  // 3b. If the model responded with a single quoted string like "Hello" or 'Good morning', it is conversational prose
  const singleQuotedMatch = cleaned.match(/^["']([^"'\r\n]*)["']$/);
  if (singleQuotedMatch) {
    return { code: `speak(${JSON.stringify(singleQuotedMatch[1])});`, isProse: true };
  }

  // 4. Test if cleaned is syntactically valid JavaScript code
  let isValidJs = parsesAsJs(cleaned);
  if (!isValidJs) {
    try {
      new AsyncFunctionCtor('speak', 'playNotes', 'searchWikipedia', 'root', `return (${cleaned.replace(/;\s*$/, '')});`);
      isValidJs = true;
    } catch {
      isValidJs = false;
    }
  }

  // Guard against conversational prose that happens to parse as comma expressions or bare identifier calls
  // (e.g. "Sure, thanks", "Hi, there", "Sure (thanks)", "Yes, please", "Okay, thanks")
  if (isValidJs && !hadFences) {
    const hasJsKeywordsOrBuiltins = /\b(?:const|let|var|function|class|new|await|async|return|throw|if|while|for|switch|try|catch|import|export|typeof|instanceof|speak|playNotes|searchWikipedia|root|alert|prompt|confirm|fetch|requestAnimationFrame|cancelAnimationFrame|setTimeout|setInterval|clearTimeout|clearInterval|console|document|window|Math|JSON|Date|Audio|localStorage|sessionStorage)\b/.test(cleaned);
    const hasJsSyntaxOrOperators = /[=;{}[\].=>]/.test(cleaned) || /\([^)]*['"][^)]*\)/.test(cleaned) || /\(\s*\)/.test(cleaned);
    if (!hasJsKeywordsOrBuiltins && !hasJsSyntaxOrOperators) {
      isValidJs = false;
    }
  }

  if (isValidJs) {
    const said = options.speakComment === false ? null : speakClosingComment(cleaned);
    return { code: exposeFunctionsToInlineHandlers(callUncalledFunctions(said?.code ?? cleaned)), isProse: false, ...(said ? { spokeComment: said.text } : {}) };
  }

  const page = unclosedPage(cleaned);
  if (page) {
    return { code: exposeFunctionsToInlineHandlers(callUncalledFunctions(page)), isProse: false };
  }

  // 4b. Explanation wrapped around unfenced code: run the code part. After fences were taken
  // out, what is left is already the program: it runs whole, and a syntax error goes to the fix
  const program = hadFences ? [{ kind: 'code' as const, text: cleaned }] : extractProgram(cleaned);
  if (program) {
    // A reply cut off before its end (stopped repeating, or the output limit) is closed first, so
    // its functions are called after it, not inside its last open block
    let cutOff: PreparedExecutableCode['cutOff'];
    for (const part of program) {
      if (part.kind !== 'code' || options.closeCutOff === false) continue;
      const closed = closeCutOff(part.text);
      if (closed) {
        part.text = closed.code;
        cutOff = { dropped: closed.dropped, closed: closed.closed };
      }
    }
    const talked = withTalk(program);
    const said = options.speakComment === false ? null : speakClosingComment(talked);
    return {
      code: exposeFunctionsToInlineHandlers(callUncalledFunctions(said?.code ?? talked)),
      isProse: false,
      ...(cutOff ? { cutOff } : {}),
      ...(said ? { spokeComment: said.text } : {}),
    };
  }

  // 5. If it's a simple arithmetic expression or number (e.g. 42 or 3 * 7), compute and speak it
  if (/^\d+(?:\s*[\+\-\*\/\%]\s*\d+)*$/.test(cleaned)) {
    return { code: `speak(String(${cleaned}));`, isProse: false };
  }

  // 6. Otherwise, it's natural language conversational text. Unquote bare quoted prose if present.
  const bareQuoted = cleaned.match(/^["']([\s\S]*?)["']$/);
  const unquotedProse = bareQuoted ? bareQuoted[1] : cleaned;
  return { code: `speak(${JSON.stringify(unquotedProse)});`, isProse: true };
}

/**
 * Prepares raw text from the model into executable JavaScript.
 * Automatically extracts code fences, strips rogue tokens, and
 * wraps conversational speech into speak("...") if no code was written.
 */
export function prepareExecutableCode(rawText: string): string {
  return inspectExecutableCode(rawText).code;
}

/**
 * Automatically chooses the optimal runtime environment based on APIs in the code.
 */
export function detectRecommendedMode(code: string): JavascriptExecutionMode {
  // 1. Audio, visual, DOM, interactive widgets, timers, MIDI, storage, or host helpers require sandboxed iframe
  if (
    /\b(document|window|canvas|getContext|Audio|AudioContext|webkitAudioContext|OscillatorNode|GainNode|requestMIDIAccess|out|clear|svg|innerHTML|appendChild|addEventListener|setInterval|setTimeout|requestAnimationFrame|createElement|getElementById|querySelector|classList|style|onclick|root|playNotes|speak|searchWikipedia|localStorage|sessionStorage|alert|prompt|confirm|location|navigator)\b/i.test(
      code
    )
  ) {
    return 'iframe';
  }

  // 2. Heavy CPU compute or loops (without DOM, audio, storage, or host helpers) benefit from background web worker
  if (
    /\b(while|for)\s*\(/i.test(code) ||
    /\b(fibonacci|prime|sort|matrix|compute|simulation|worker)\b/i.test(code)
  ) {
    return 'worker';
  }

  // 3. Lightweight calculation or date/arithmetic expression
  return 'eval';
}

function hasTopLevelReturn(code: string): boolean {
  const withoutStrings = code.replace(/(['"\x60])(?:\\.|(?!\1)[^\\\x60])*\1/gs, '""');
  const withoutComments = withoutStrings.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  return /\breturn\b/.test(withoutComments);
}

interface PendingIframeRun {
  options?: ExecutionContextOptions;
  spokenTexts: string[];
  timer: ReturnType<typeof setTimeout>;
  finish: (data: Record<string, any> | null, errorMessage?: string) => void;
}

export class JavascriptRuntime {
  private mode: JavascriptExecutionMode;
  private timeoutMs: number;
  private llmProvider?: LlmRuntimeProvider;
  private onResult?: JavascriptExecutionCallback;
  private onVisualChange?: (hasVisual: boolean, iframe: HTMLIFrameElement | null) => void;
  private iframeContainer: HTMLElement | null = null;
  private activeIframe: HTMLIFrameElement | null = null;
  private iframeReadyPromise: Promise<void> | null = null;
  private worker: Worker | null = null;
  private reqCounter = 0;
  private defaultOptions: ExecutionContextOptions | undefined;
  private lastRunOptions: ExecutionContextOptions | undefined;
  private onIframeLoad?: (iframe: HTMLIFrameElement) => void;
  private pendingRuns = new Map<string, PendingIframeRun>();
  private getSharedAudioContext?: () => AudioContext | null;
  private onProgramError?: (message: string, line?: number) => void;
  private onProgramAudio?: (sounding: boolean) => void;
  private onProgramActivity?: (active: boolean) => void;
  private onDownloadableChange?: (ready: boolean) => void;
  /** The program in the card, and whether it has run cleanly long enough to download */
  private downloadable: { code: string; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private downloadReady = false;
  private onRunLog?: (kind: RunLogKind, text: string) => void;
  private programSounding = false;
  // The last program_activity the sandbox reported: timers, animation frames or async work pending
  private programActive = false;
  private quietWatch: { timer: ReturnType<typeof setInterval>; analyser: AnalyserNode } | null = null;
  private programOutput: GainNode | null = null;
  private cardShadow: HTMLElement | null = null;
  // Trial runs go one at a time: the end of the last one queued
  private trialQueue: Promise<unknown> = Promise.resolve();
  // The hidden frame trials run in (each gets a new page in it), and when it is dropped for being idle
  private trialFrame: HTMLIFrameElement | null = null;
  private trialFrameIdle: ReturnType<typeof setTimeout> | null = null;

  constructor(options?: JavascriptRuntimeOptions) {
    this.mode = options?.mode ?? 'iframe';
    this.timeoutMs = options?.timeoutMs ?? 5000;
    this.llmProvider = options?.llmProvider;
    this.onResult = options?.onResult;
    this.onVisualChange = options?.onVisualChange;
    this.iframeContainer = options?.iframeContainer ?? null;
    this.getSharedAudioContext = options?.getSharedAudioContext;
    this.onProgramError = options?.onProgramError;
    this.onProgramAudio = options?.onProgramAudio;
    this.onProgramActivity = options?.onProgramActivity;
    this.onDownloadableChange = options?.onDownloadableChange;
    this.onRunLog = options?.onRunLog;
    if (this.getSharedAudioContext && typeof window !== 'undefined') {
      // Read by the sandbox's AudioContext stand-in (same origin)
      (window as unknown as { __chattySharedAudio?: () => unknown }).__chattySharedAudio = () => this.programAudio();
      // Read by the sandbox's navigator.requestMIDIAccess (see audio/software-midi.ts)
      (window as unknown as { __chattyMidi?: unknown }).__chattyMidi = (options: { sysex?: boolean } | undefined, now: () => number) =>
        this.programMidi(options, now);
    }
  }

  /** Web MIDI for a program: a software synth playing into the program's audio output. */
  private async programMidi(options: { sysex?: boolean } | undefined, now: () => number): Promise<unknown> {
    const audio = this.programAudio();
    if (!audio) throw new DOMException('Audio is not available', 'NotSupportedError');
    return softwareMidiAccess(audio.context, audio.output, now, options);
  }

  /**
   * Audio for programs: the app's context, which the mic tap already unlocked (a context a
   * program creates itself may stay silent, since browsers only start audio after a tap in the
   * same document). Programs play into a gain node that the next screen wipe disconnects.
   */
  private programAudio(): { context: AudioContext; output: AudioNode } | null {
    this.soundUses++;
    const context = this.getSharedAudioContext?.();
    if (!context) {
      this.onRunLog?.('error', 'sound: no audio yet (it starts with a tap or the Start button)');
      return null;
    }
    if (!this.programOutput || this.programOutput.context !== context) {
      this.programOutput = context.createGain();
      this.programOutput.connect(context.destination);
    }
    this.watchProgramSound(this.programOutput);
    this.reportProgramSoundLevel(context, this.programOutput);
    if (context.state !== 'running') {
      void context.resume().catch(() => {});
      // Browsers (Safari above all) keep audio paused until a tap: say so (any tap starts it,
      // see the engine's unlockAudio)
      setTimeout(() => {
        if (context.state !== 'running') this.onRunLog?.('error', `sound: the audio is ${context.state}: tap the page to hear it`);
      }, 300);
    }
    return { context, output: this.programOutput };
  }

  /**
   * A program is about to make sound: tells the host (which switches the audio session to
   * playback), then reports when its output has been quiet for 3 seconds.
   */
  /**
   * Once a program has asked for sound: whether any of it reached the speakers, measured on its
   * output over its first two seconds, in the run log (a silent program otherwise looks the same
   * as a working one)
   */
  private reportProgramSoundLevel(context: AudioContext, output: GainNode): void {
    if (this.soundLevelPending) return;
    this.soundLevelPending = true;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    output.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    let checks = 0;
    let heard = false;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      for (const v of samples) peak = Math.max(peak, Math.abs(v));
      // Counted as soon as it is heard (the outcome check reads it, see soundHeardCount)
      if (!heard && peak > 0.001) {
        heard = true;
        this.soundHeard++;
      }
      if (++checks < 20) return;
      clearInterval(timer);
      try {
        output.disconnect(analyser);
      } catch {
        // Already disconnected by a screen wipe
      }
      // The browser's audio session (Safari): 'auto' can be silenced by the iPhone's silent switch
      const sessionType = (navigator as { audioSession?: { type?: string } }).audioSession?.type;
      const session = sessionType ? `, session ${sessionType}` : '';
      this.soundLevelPending = false;
      // Silent with the audio running: the sound went nowhere (a node never connected). A paused
      // context (no tap yet) says nothing either way.
      if (!heard && context.state === 'running') this.soundSilent++;
      // MIDI that never started a note is silent for that reason, whatever the audio is doing
      const midi = softwareMidiSummary();
      const noMidiNote = midi.sent > 0 && midi.noteOns === 0;
      const audio = `audio ${context.state}, ${context.sampleRate} Hz${session}`;
      this.onRunLog?.(
        peak > 0.001 ? 'console' : 'error',
        peak > 0.001
          ? `sound: reached the speakers (level ${peak.toFixed(2)}, ${audio})`
          : noMidiNote
            ? `sound: no MIDI note-on above velocity 0 was sent, so nothing reached the speakers (${audio}); the messages were ${midi.others.join('; ')}`
            : `sound: notes were sent, but nothing reached the speakers (${audio})`
      );
    }, 100);
  }

  private soundLevelPending = false;

  private watchProgramSound(output: GainNode): void {
    if (!this.onProgramAudio) return;
    if (!this.programSounding) {
      this.programSounding = true;
      this.onProgramAudio(true);
    }
    if (this.quietWatch) return;
    const analyser = output.context.createAnalyser();
    analyser.fftSize = 2048;
    output.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let quietChecks = 0;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (const v of samples) peak = Math.max(peak, Math.abs(v));
      quietChecks = peak < 0.001 ? quietChecks + 1 : 0;
      if (quietChecks >= 3) this.stopWatchingProgramSound();
    }, 1000);
    this.quietWatch = { timer, analyser };
  }

  private stopWatchingProgramSound(): void {
    if (this.quietWatch) {
      clearInterval(this.quietWatch.timer);
      this.quietWatch.analyser.disconnect();
      this.quietWatch = null;
    }
    if (this.programSounding) {
      this.programSounding = false;
      this.onProgramAudio?.(false);
    }
  }

  private silenceProgramAudio(): void {
    silenceSoftwareMidi();
    this.stopWatchingProgramSound();
    try {
      this.programOutput?.disconnect();
    } catch {
      // already disconnected
    }
    this.programOutput = null;
  }

  setMode(mode: JavascriptExecutionMode): void {
    this.mode = mode;
  }

  getMode(): JavascriptExecutionMode {
    return this.mode;
  }

  setIframeContainer(container: HTMLElement | null): void {
    this.iframeContainer = container;
    if (this.activeIframe && container && this.activeIframe.parentElement !== container) {
      container.appendChild(this.activeIframe);
    }
  }

  getActiveIframe(): HTMLIFrameElement | null {
    return this.activeIframe;
  }

  /**
   * Default speak/audio context used for runs (and late async helper calls from
   * timers/rAF/event handlers) that do not supply their own ExecutionContextOptions.
   */
  setDefaultOptions(options: ExecutionContextOptions | undefined): void {
    this.defaultOptions = options;
  }

  /**
   * Registers a hook fired every time the sandbox iframe document (re)loads, so the host
   * can (re)attach listeners to iframe.contentWindow. Fires immediately if already loaded.
   */
  setIframeLoadListener(listener: ((iframe: HTMLIFrameElement) => void) | undefined): void {
    this.onIframeLoad = listener;
    const iframe = this.activeIframe;
    if (listener && iframe?.contentDocument?.readyState === 'complete' && iframe.contentDocument.getElementById('root')) {
      listener(iframe);
    }
  }

  /**
   * Fully resets the visual screen: kills timers, rAF loops, audio and body-appended elements by
   * recreating the iframe document. Pending runs are settled with an error.
   */
  resetVisual(): Promise<void> {
    return withActivity('clearing the screen', async () => {
      await this.resetVisualNow();
      // The screen is empty now (the page's buttons follow it)
      this.onVisualChange?.(false, this.activeIframe);
    });
  }

  /**
   * The output card takes touches and clicks natively (typing, scrolling inside it) and the page
   * gets them everywhere else: the full-window iframe is clipped to the card, which limits both
   * what it paints and where it can be hit. Its shadow is drawn on the page, behind it.
   */
  private watchCard(iframe: HTMLIFrameElement): void {
    const win = iframe.contentWindow as (Window & typeof globalThis) | null;
    const card = iframe.contentDocument?.getElementById('root');
    if (!win || !card) return;
    this.cardShadow?.remove();
    const shadow = document.createElement('div');
    shadow.style.cssText =
      'position:absolute;border-radius:4px;pointer-events:none;box-shadow:0 24px 64px rgba(0,0,0,0.55),0 8px 20px rgba(0,0,0,0.35);';
    iframe.before(shadow);
    this.cardShadow = shadow;
    const update = () => {
      if (this.activeIframe !== iframe) return;
      const r = card.getBoundingClientRect();
      const shown = r.width > 0 && r.height > 0;
      iframe.style.pointerEvents = shown ? 'auto' : 'none';
      iframe.style.clipPath = shown
        ? `inset(${r.top}px ${win.innerWidth - r.right}px ${win.innerHeight - r.bottom}px ${r.left}px round 4px)`
        : 'inset(50%)';
      shadow.hidden = !shown;
      Object.assign(shadow.style, { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    // A program animating by style changes fires these every frame: measure once a frame, at its
    // end state. The page's frames, not the program's (the sandbox counts those as its work).
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(window) : (cb: () => void) => setTimeout(cb, 16);
    const soon = oncePerFrame(update, raf);
    // Size changes (images loading, layout) and content changes (which also cover a page that
    // isn't rendering yet, when resize callbacks wait)
    new win.ResizeObserver(soon).observe(card);
    new win.MutationObserver(soon).observe(card, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    win.addEventListener('resize', soon);
    update();
  }

  private async resetVisualNow(): Promise<void> {
    this.spoilDownload();
    const hadIframe = Boolean(this.activeIframe);
    this.abortPendingRuns('Visual screen was cleared');
    this.silenceProgramAudio();
    // The program's timers go with its page
    this.programActive = false;
    this.onProgramActivity?.(false);
    this.cardShadow?.remove();
    this.cardShadow = null;
    if (this.activeIframe) {
      this.activeIframe.style.pointerEvents = 'none';
      this.activeIframe.remove();
      this.activeIframe = null;
      this.iframeReadyPromise = null;
    }
    if (hadIframe && typeof document !== 'undefined' && this.iframeContainer) {
      this.ensureIframe();
      await this.iframeReadyPromise;
    }
  }

  /** True when a previous run left something on the visual screen (root or body-level elements). */
  /** The element ids on the program's page now (for error hints: an id lookup that found nothing) */
  /** Ids the program looked up that never existed, and what stood in for each */
  standInIds(): StandIn[] {
    try {
      const list = (this.activeIframe?.contentWindow as unknown as { __chattyStandIns?: () => StandIn[] } | null)?.__chattyStandIns;
      return typeof list === 'function' ? list() : [];
    } catch {
      return [];
    }
  }

  pageIds(): string[] {
    try {
      const doc = this.activeIframe?.contentDocument;
      return doc ? [...doc.querySelectorAll('[id]')].map((el) => el.id).filter((id) => id && id !== 'root') : [];
    } catch {
      return [];
    }
  }

  /** Ids of the input, textarea and select elements in the visible card (what a program reads values from) */
  pageFields(): string[] {
    try {
      const doc = this.activeIframe?.contentDocument;
      return doc ? [...doc.querySelectorAll('input[id], textarea[id], select[id]')].map((el) => el.id).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /** How many programs' sound has reached the speakers so far (measured on their output) */
  soundHeardCount(): number {
    return this.soundHeard;
  }
  private soundHeard = 0;

  /** How many programs asked for sound that stayed silent for two seconds with the audio running */
  soundSilentCount(): number {
    return this.soundSilent;
  }
  private soundSilent = 0;

  /** The MIDI messages the current program sent, by kind (note-ons above velocity 0, the others named) */
  midiSummary(): MidiSummary {
    return softwareMidiSummary();
  }

  /** How many times programs have asked for sound (Web Audio, MIDI, out, playNotes) so far */
  soundUseCount(): number {
    return this.soundUses;
  }
  private soundUses = 0;

  hasVisualContent(): boolean {
    try {
      const doc = this.activeIframe?.contentDocument;
      if (!doc?.body) return false;
      // The page knows which elements are only stand-ins for missing ids (empty, so not output)
      const own = (this.activeIframe?.contentWindow as unknown as { __chattyHasVisual?: () => boolean } | null)?.__chattyHasVisual;
      if (typeof own === 'function') return own();
      const root = doc.getElementById('root');
      if (root && root.childNodes.length > 0) return true;
      return Array.from(doc.body.children).some(
        (el) => el !== root && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE'
      );
    } catch {
      return false;
    }
  }

  /** True while the previous program still has something going: output on screen, sound, or timers/async work. */
  hasRunningProgram(): boolean {
    return this.hasVisualContent() || this.programSounding || this.programActive || this.hasCardContent();
  }

  /** Anything at all left in the card (a stand-in, an empty element): the next program starts without it */
  hasCardContent(): boolean {
    try {
      const doc = this.activeIframe?.contentDocument;
      const root = doc?.getElementById('root');
      return !!root && root.childNodes.length > 0;
    } catch {
      return false;
    }
  }

  private abortPendingRuns(reason: string): void {
    for (const run of Array.from(this.pendingRuns.values())) {
      run.finish(null, reason);
    }
    this.pendingRuns.clear();
  }

  setLlmProvider(provider: LlmRuntimeProvider): void {
    this.llmProvider = provider;
  }

  getLlmProvider(): LlmRuntimeProvider | undefined {
    return this.llmProvider;
  }

  /**
   * Evaluates if a string is direct JavaScript code rather than a natural language task description.
   */
  isProbableCode(input: string): boolean {
    const trimmed = input.trim();
    if (!trimmed) return false;
    if (/^(?:const|let|var|function|return|import|class|\(0,\s*eval\))\b/.test(trimmed)) {
      return true;
    }
    if (/[;{}]$/.test(trimmed) || trimmed.includes('=>') || trimmed.includes('console.log')) {
      return true;
    }
    if (/^Math\.\w+\(/.test(trimmed) || /^\d+\s*[\+\-\*\/]\s*\d+$/.test(trimmed)) {
      return true;
    }
    return false;
  }

  /**
   * Executes a task description or raw code.
   * If a natural language task query is provided, spins up a single-use coding agent
   * to write the JavaScript and choose the optimal runtime mode (iframe, worker, or eval).
   */
  async executeTask(
    input: string | JavascriptTaskInput,
    callback?: JavascriptExecutionCallback,
    options?: ExecutionContextOptions
  ): Promise<JavascriptExecutionResult> {
    let task = '';
    let code = '';
    let chosenMode: JavascriptExecutionMode | undefined;

    if (typeof input === 'string') {
      if (this.isProbableCode(input)) {
        code = input.trim();
      } else {
        task = input.trim();
      }
    } else {
      task = input.task?.trim() || '';
      code = input.code?.trim() || '';
      chosenMode = input.mode;
    }

    // If task is provided without code, spin up single-use coding agent
    if (task && !code) {
      if (!this.llmProvider) {
        if (this.isProbableCode(task)) {
          code = task;
        } else {
          return {
            success: false,
            error: 'Single-use coding agent requires an active LLM provider.',
            logs: [],
            hasVisualOutput: false,
            executionTimeMs: 0,
            code: '',
            mode: this.mode,
            task,
          };
        }
      } else {
        try {
          const agentPrompt = `Task: ${task}\nWrite executable JavaScript to accomplish this task in the browser and specify the best mode (iframe, worker, or eval).`;
          const genResult = await this.llmProvider.generate({
            turnId: `code_agent_${Date.now()}`,
            systemPrompt: CODING_AGENT_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: agentPrompt }],
            temperature: 0.1,
            maxOutputTokens: 512,
          });

          const parsed = parseCodingAgentOutput(genResult.text);
          code = parsed.code;
          if (!chosenMode && parsed.mode) {
            chosenMode = parsed.mode;
          }
        } catch (err) {
          return {
            success: false,
            error: `Coding agent generation failed: ${err instanceof Error ? err.message : String(err)}`,
            logs: [],
            hasVisualOutput: false,
            executionTimeMs: 0,
            code: '',
            mode: this.mode,
            task,
          };
        }
      }
    }

    // Determine runtime environment to execute
    const targetMode = chosenMode || (code ? detectRecommendedMode(code) : this.mode);

    const res = await this.execute(code, callback, options, targetMode);
    res.task = task || undefined;
    return res;
  }

  /**
   * Executes code using the active mode ('iframe', 'worker', or 'eval').
   * Supports an optional callback and ExecutionContextOptions (for speak, playNotes, etc.).
   */
  execute(
    code: string,
    callback?: JavascriptExecutionCallback,
    execOptions?: ExecutionContextOptions,
    modeOverride?: JavascriptExecutionMode
  ): Promise<JavascriptExecutionResult> {
    return withActivity('running the program', () => this.executeNow(code, callback, execOptions, modeOverride));
  }

  private async executeNow(
    code: string,
    callback?: JavascriptExecutionCallback,
    execOptions?: ExecutionContextOptions,
    modeOverride?: JavascriptExecutionMode
  ): Promise<JavascriptExecutionResult> {
    const trimmedCode = (await letReassignedConsts(await makeAwaitingFunctionsAsync(code))).trim();
    // The code as it runs (after the sandbox's repairs)
    this.onRunLog?.('program', trimmedCode);
    const options = execOptions ?? this.defaultOptions;
    const runMode = modeOverride ?? this.mode;
    let result: JavascriptExecutionResult;

    const proc = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process;
    const isNodeOrTest = Boolean(proc?.env?.VITEST || proc?.env?.NODE_ENV === 'test');

    const effectiveMode =
      runMode === 'iframe' && detectRecommendedMode(trimmedCode) === 'worker'
        ? 'worker'
        : runMode;

    // Guard loops so a synchronous infinite loop throws instead of freezing the page.
    const protectedCode = loopProtect(trimmedCode);

    if (isNodeOrTest && (effectiveMode === 'worker' || effectiveMode === 'iframe')) {
      result = await this.executeInEval(protectedCode, options);
      result.mode = effectiveMode;
    } else if (effectiveMode === 'worker') {
      result = await this.executeInWorker(protectedCode);
    } else if (effectiveMode === 'eval' || typeof document === 'undefined') {
      result = await this.executeInEval(protectedCode, options);
    } else {
      // Default: 'iframe'
      result = await this.executeInIframe(protectedCode, options);
    }

    if (result.logs.length > 0) this.onRunLog?.('console', result.logs.join('\n'));
    if (result.error) this.onRunLog?.('error', result.errorLine ? `line ${result.errorLine}: ${result.error}` : result.error);
    callback?.(result);
    this.onResult?.(result);
    return result;
  }

  // --------------------------------------------------------------------------
  // 1. Direct Eval ((0, eval) in strict mode to protect local scope)
  // --------------------------------------------------------------------------

  private async executeInEval(
    code: string,
    options?: ExecutionContextOptions
  ): Promise<JavascriptExecutionResult> {
    const logs: string[] = [];
    const spokenTexts: string[] = [];
    const start = performance.now();

    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };
    console.warn = (...args: unknown[]) => {
      logs.push('[warn] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };
    console.error = (...args: unknown[]) => {
      logs.push('[error] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };

    const speak = (msg: unknown) => {
      const text = typeof msg === 'object' ? JSON.stringify(msg) : String(msg ?? '');
      spokenTexts.push(text);
      this.onRunLog?.('speak', text);
      options?.onSpeak?.(text);
    };

    const playNotes = async (notes: string, tempo?: number) => {
      return playNotesHelper(notes, tempo, undefined, options?.audioContextAccessor);
    };

    const searchWikipedia = async (query: string) => {
      return fetchWikipediaSummary(query);
    };

    // Eval mode never touches the host DOM; only an explicitly supplied root is exposed.
    const root = options?.rootElement ?? null;

    const withTimeout = <T>(p: Promise<T> | T): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Execution timed out after ${this.timeoutMs}ms`)),
          this.timeoutMs
        );
      });
      return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
    };

    try {
      let rawResult: any;
      // 1. Compile first to validate syntax without executing any code
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      let compiledFn: any;
      let isExpression = false;
      try {
        compiledFn = new AsyncFunction('speak', 'playNotes', 'searchWikipedia', 'root', `"use strict"; return (${code.replace(/;\s*$/, '')});`);
        isExpression = true;
      } catch {
        try {
          compiledFn = new AsyncFunction('speak', 'playNotes', 'searchWikipedia', 'root', `"use strict";\n${code}`);
        } catch (compileErr) {
          // Syntax error in the code itself. Thrown before ANY execution starts!
          throw compileErr;
        }
      }

      // 2. Execute exactly once
      if (isExpression || /\bawait\b/.test(code) || hasTopLevelReturn(code)) {
        rawResult = await withTimeout(compiledFn(speak, playNotes, searchWikipedia, root));
      } else {
        const g = globalThis as any;
        const prevSpeak = g.speak;
        const prevPlay = g.playNotes;
        const prevWiki = g.searchWikipedia;
        const prevRoot = g.root;
        try {
          g.speak = speak;
          g.playNotes = playNotes;
          g.searchWikipedia = searchWikipedia;
          g.root = root;
          rawResult = (0, eval)(`"use strict";\n${code}`);
        } finally {
          if (prevSpeak !== undefined) g.speak = prevSpeak; else delete g.speak;
          if (prevPlay !== undefined) g.playNotes = prevPlay; else delete g.playNotes;
          if (prevWiki !== undefined) g.searchWikipedia = prevWiki; else delete g.searchWikipedia;
          if (prevRoot !== undefined) g.root = prevRoot; else delete g.root;
        }
      }
      if (rawResult instanceof Promise) {
        rawResult = await withTimeout(rawResult);
      }
      if (rawResult === 'use strict') {
        rawResult = undefined;
      }
      const executionTimeMs = Math.max(1, Math.round(performance.now() - start));

      let output = rawResult;
      if (output === undefined && logs.length > 0) {
        output = logs.join('\n');
      }

      const hasVisualOutput = Boolean(root && root.children && root.children.length > 0);

      return {
        success: true,
        output,
        logs,
        spokenTexts,
        hasVisualOutput,
        executionTimeMs,
        code,
        mode: 'eval',
      };
    } catch (err) {
      const executionTimeMs = Math.max(1, Math.round(performance.now() - start));
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        logs,
        spokenTexts,
        hasVisualOutput: false,
        executionTimeMs,
        code,
        mode: 'eval',
      };
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
  }

  // --------------------------------------------------------------------------
  // 2. Web Worker Runner (Background headless isolation)
  // --------------------------------------------------------------------------

  private async executeInWorker(code: string): Promise<JavascriptExecutionResult> {
    if (typeof Worker === 'undefined') {
      console.error('[JavascriptRuntime] Web Worker is not supported in this environment, falling back to eval');
      return this.executeInEval(code);
    }

    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('../workers/runtime.worker.ts', import.meta.url), {
          type: 'module',
        });
      } catch (err) {
        console.error('[JavascriptRuntime] Failed to spawn Web Worker, falling back to eval:', err);
        return this.executeInEval(code);
      }
    }

    const worker = this.worker;
    const reqId = `exec_${++this.reqCounter}_${Date.now()}`;
    const start = performance.now();

    return new Promise((resolve) => {
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const handler = (event: MessageEvent<any>) => {
        const data = event.data;
        if (!data || data.id !== reqId) return;

        cleanup();
        resolve({
          success: Boolean(data.success),
          output: data.output,
          error: data.error,
          logs: data.logs ?? [],
          spokenTexts: [],
          hasVisualOutput: false,
          executionTimeMs: data.executionTimeMs ?? Math.max(1, Math.round(performance.now() - start)),
          code,
          mode: 'worker',
        });
      };

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        worker.removeEventListener('message', handler);
      };

      timeoutTimer = setTimeout(() => {
        cleanup();
        // Terminate hanging worker (e.g. infinite loop)
        try {
          worker.terminate();
        } catch {
          // Ignore
        }
        this.worker = null;
        resolve({
          success: false,
          error: `Execution timed out after ${this.timeoutMs}ms`,
          logs: [],
          hasVisualOutput: false,
          executionTimeMs: this.timeoutMs,
          code,
          mode: 'worker',
        });
      }, this.timeoutMs);

      worker.addEventListener('message', handler);
      worker.postMessage({ id: reqId, code });
    });
  }

  // --------------------------------------------------------------------------
  // 3. Sandboxed IFrame Runner (Visual DOM/Canvas rendering + Safe Execution)
  // --------------------------------------------------------------------------

  /** The sandbox page. A trial one (hidden, muted) differs only in where the page's host calls go (trialHost, stamped with the trial's token). */
  private buildRunnerHtml(trial: boolean, host?: string, token = ''): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light dark">
  <style>
    /* Must match the host page's color-scheme, or the browser paints an opaque
       (white) backdrop behind the iframe regardless of background: transparent. */
    :root {
      color-scheme: light dark;
    }
    *, *::before, *::after {
      box-sizing: border-box;
    }
    /* Under 16px, iOS Safari zooms the page in when a field is focused (wins over the program's own sizes) */
    input, select, textarea, button {
      font-size: 16px !important;
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100vw;
      height: 100vh;
      width: 100dvw;
      height: 100dvh;
      overflow: hidden;
      background: transparent !important;
      pointer-events: none;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: light-dark(#0f172a, #f1f5f9);
      -webkit-font-smoothing: antialiased;
    }
    /* The transparent full-window layer centers the card, clear of the top bar and the bottom
       controls (the card is the only part that takes touches) */
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 76px 16px 84px;
    }
    /* Program output: one card (document.body and root both mean this element), hidden while empty */
    #root {
      max-width: 100%;
      max-height: 100%;
      overflow: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 16px;
      background: #505050;
      /* Black by default: programs often give their own boxes a light background, and white
         text inherited from the card vanished on it */
      color: #000;
      border-radius: 4px;
      contain: paint;
      /* Scrolling inside the card never carries on to the page behind it */
      overscroll-behavior: contain;
      pointer-events: auto;
    }
    #root:empty {
      display: none;
    }
    canvas, svg {
      max-width: 100%;
      max-height: 100%;
      display: block;
      pointer-events: auto;
      background: transparent;
    }
    table {
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 13px;
      background: light-dark(rgba(255, 255, 255, 0.9), rgba(15, 23, 42, 0.85));
      border-radius: 8px;
      overflow: hidden;
      backdrop-filter: blur(12px);
    }
    th, td {
      border: 1px solid light-dark(rgba(15,23,42,0.15), rgba(255,255,255,0.15));
      padding: 6px 12px;
      text-align: left;
    }
    th {
      background: light-dark(rgba(15,23,42,0.06), rgba(255,255,255,0.12));
      font-weight: 600;
    }
    button, input, select {
      font-family: inherit;
      border-radius: 8px;
      padding: 8px 14px;
      border: 1px solid light-dark(rgba(15,23,42,0.2), rgba(255,255,255,0.2));
      background: light-dark(rgba(255, 255, 255, 0.9), rgba(15, 23, 42, 0.8));
      color: light-dark(#0f172a, white);
      backdrop-filter: blur(8px);
      pointer-events: auto;
    }
    button {
      cursor: pointer;
      font-weight: 500;
      transition: background 0.15s, transform 0.1s;
    }
    button:hover {
      background: rgba(56, 189, 248, 0.25);
      border-color: #38bdf8;
    }
    button:active {
      transform: scale(0.97);
    }
    input:focus, select:focus {
      outline: 2px solid #38bdf8;
    }
    ${trial ? 'body { padding: 0; }' : ''}
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    const __chattyHost = ${host ?? (trial ? trialHost(token) : 'window.parent')};
    const __chattyTrial = ${trial};
    const hasTopLevelReturn = ${hasTopLevelReturn.toString()};
    let currentExecId = null;
    const pendingAsyncCalls = new Map();

    // The speech check follows the value checks' window (CHECK_MS), and is off when NaN,
    // Infinity or undefined is the program's subject (see the execute handler)
    let speakChecked = true;
    window.speak = (text) => {
      const s = typeof text === 'object' ? JSON.stringify(text) : String(text ?? '');
      if (speakChecked && typeof noteRejected === 'function' && badValue(s)) noteRejected('speak(' + shown(s.slice(0, 60)) + ') says ' + (s.match(/NaN|undefined|Infinity/) || [''])[0] + ': almost surely a bug');
      __chattyHost.postMessage({ type: 'speak', id: currentExecId, text: s }, '*');
    };

    // alert() and console.log() are the browser's ways to tell the user something: alert() is
    // speak() here (it is blocked in the sandbox anyway, which has no modals), and so is
    // console.log() for a program with no speak() of its own (its only way to tell the user). A
    // program that speaks logs for itself: to the run log only. And a log in a loop isn't read out
    // over and over: the same text again within 2 seconds, or a fourth in one second, stays in the log
    window.alert = (message) => window.speak(message === undefined ? '' : message);
    const logText = (args) => args.map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a))).join(' ');
    let logSpeaks = true;
    let lastLog = '';
    let lastLogAt = 0;
    let logTimes = [];
    console.log = (...args) => {
      if (!logSpeaks) return;
      const text = logText(args);
      const now = performance.now();
      logTimes = logTimes.filter((t) => now - t < 1000);
      if ((text === lastLog && now - lastLogAt < 2000) || logTimes.length >= 3) return;
      lastLog = text;
      lastLogAt = now;
      logTimes.push(now);
      window.speak(text);
    };

    window.playNotes = (notes, tempo) => {
      return new Promise((resolve) => {
        const callId = Math.random().toString(36).slice(2);
        pendingAsyncCalls.set(callId, resolve);
        __chattyHost.postMessage({ type: 'playNotes', id: currentExecId, callId, notes, tempo }, '*');
      });
    };

    window.searchWikipedia = (query) => {
      return new Promise((resolve) => {
        const callId = Math.random().toString(36).slice(2);
        pendingAsyncCalls.set(callId, resolve);
        __chattyHost.postMessage({ type: 'searchWikipedia', id: currentExecId, callId, query }, '*');
      });
    };

    window.root = document.getElementById('root');
    // Programs draw on document.body: it's the card (#root), so everything they add stays together
    Object.defineProperty(document, 'body', { configurable: true, get: () => window.root });

    // new AudioContext() gives programs the app's already-running audio (see programAudio).
    // close() and suspend() would stop the app's own audio, so they do nothing here.
    const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    function SharedAudioContext(options) {
      let shared = null;
      try {
        shared = __chattyHost.__chattySharedAudio ? __chattyHost.__chattySharedAudio() : null;
      } catch {}
      // No shared audio at all (no Web Audio in the host): one real context for the whole page,
      // however many times the program asks
      if (!shared) {
        if (!window.__chattyOwnAudio) window.__chattyOwnAudio = new NativeAudioContext(options);
        return window.__chattyOwnAudio;
      }
      const local = {};
      const contextProxy = new Proxy(shared.context, {
        get(target, prop) {
          if (prop in local) return local[prop];
          if (prop === 'destination') return shared.output;
          if (prop === 'close' || prop === 'suspend') return () => Promise.resolve();
          // A method Web Audio doesn't have: a play-like one (ctx.createNote('G2', 0.5),
          // ctx.playChord(...)) plays on the synth, a made-up create…() gives a stand-in node whose
          // play-like methods play, and anything else does nothing and returns the context (so
          // chains keep going). Each is logged as imagined.
          if (typeof prop === 'string' && !(prop in target) && !PROTOCOL_NAMES.has(prop)) {
            return (...args) => {
              imagined('audioContext.' + prop + '(' + argText(args) + ')');
              // createDrumMachine() makes something; createNote('G2', 500) plays
              if (/^create/i.test(prop) && args.length === 0) return standInNode(prop.replace(/^create/i, '') || 'node');
              if (PLAY_NAME.test(prop)) {
                if (args.length > 0) playOn(forgivingOut, args);
                return contextProxy;
              }
              if (/^create/i.test(prop)) return standInNode(prop.replace(/^create/i, '') || 'node');
              return contextProxy;
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set(_target, prop, value) {
          local[prop] = value;
          return true;
        },
      });
      return contextProxy;
    }
    window.AudioContext = SharedAudioContext;
    window.webkitAudioContext = SharedAudioContext;

    // Which line of a program an error came from. Programs are compiled with a sourceURL so
    // stack traces name them; how many lines each way of running adds before the code is
    // measured once with a probe, so it holds in every browser.
    const SOURCE_TAG = '\\n//# sourceURL=chatty-program.js';
    const ProgramFunction = Object.getPrototypeOf(async function(){}).constructor;
    const lineOffsets = { expr: null, fn: null, eval: null };
    let runMode = 'eval';
    function stackLine(err, programFrameOnly) {
      const m = String((err && err.stack) || '').match(/chatty-program\\.js:(\\d+)/);
      if (m) return Number(m[1]);
      // Safari's stack may not name the program, but its errors carry the line (an Error made
      // here, in a watcher, carries this script's own line instead: no line then)
      return !programFrameOnly && err && typeof err.line === 'number' ? err.line : null;
    }
    function errorLine(err, programFrameOnly) {
      const line = stackLine(err, programFrameOnly);
      const offset = lineOffsets[runMode];
      return line !== null && offset !== null && line - offset >= 1 ? line - offset : undefined;
    }

    // Values the browser silently ignores: NaN, Infinity or undefined given to a canvas style or
    // drawing call, a CSS property or an attribute does nothing, with no error. The first one a
    // program gives is reported as its error, with the line, so a fix can find it.
    let rejected = null;
    let runningProgram = false;
    let rejectedReported = false;
    // Text is bad only when the token is a stringified value: the whole text ("NaN"), or after a
    // label, operator or "is" ("Total: NaN", "x = undefined", "The result is NaN", "$NaN", "NaN%")
    // with no word following.
    // The same words inside ordinary text ("Infinity War", "undefined behaviour is…") are fine.
    const BAD_TEXT_WHOLE = /^\\s*[-+$€£]?\\s*(?:NaN|undefined|Infinity)\\s*(?:%|px|em|rem|ms|s|°|deg)?\\s*$/;
    const BAD_TEXT_AFTER_LABEL = /(?:[:=(\\[,|\\/]|\\b(?:is|are|was|of)\\s)\\s*[-+$€£]?(?:NaN|undefined|Infinity)(?![\\w-])(?!\\s+[A-Za-z])/;
    const badValue = (v) =>
      v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ||
      (typeof v === 'string' && (BAD_TEXT_WHOLE.test(v) || BAD_TEXT_AFTER_LABEL.test(v)));
    // During the trial's smoke pass the sample input ('test', an empty display) can make a correct
    // program show NaN: only thrown errors count then
    let smoking = false;
    // A library the page loaded (<script src>: Chart.js, d3) calls the browser its own way, which
    // can look like a bug (Chart.js measures undefined text): only the program's own calls count.
    // The caller is the first frame outside this page's own code (about:srcdoc, or wherever the
    // page itself is)
    const pageAddress = String(location.href).split('#')[0];
    function fromLibrary(err) {
      const frames = String((err && err.stack) || '').split('\\n').filter((f) => /:\\d+:\\d+\\)?\\s*$/.test(f) && !f.includes(pageAddress));
      const first = frames[0] || '';
      return !/chatty-program\\.js/.test(first) && /https?:\\/\\//.test(first);
    }
    function noteRejected(message) {
      if (rejected || rejectedReported || smoking) return;
      const err = new Error();
      if (fromLibrary(err)) return;
      const line = errorLine(err, true);
      if (runningProgram) {
        rejected = { message, line };
      } else {
        rejectedReported = true;
        __chattyHost.postMessage({ type: 'program_error', message, line }, '*');
      }
    }
    const shown = (v) => (typeof v === 'string' ? "'" + v + "'" : String(v));
    const COLOR_PROPS = new Set(['fillStyle', 'strokeStyle', 'shadowColor']);
    // These checks run on every canvas, audio and DOM call, which a heavy animation makes
    // thousands of times a second. The bugs they catch show in a program's first seconds, so they
    // stop CHECK_MS after each run starts (a new run turns them on again). A trial page checks
    // for its whole length.
    const CHECK_MS = 5000;
    let checking = true;
    let checkTimer = null;
    function checkSet(label, key, value) {
      if (badValue(value)) noteRejected(label + '.' + key + ' = ' + shown(typeof value === 'string' ? value.slice(0, 60) : value) + ': almost surely a bug');
      // A canvas color the browser doesn't know is ignored without a word (the drawing keeps
      // its old color): that is the program's error
      else if (COLOR_PROPS.has(key) && typeof value === 'string' && window.CSS && CSS.supports && !CSS.supports('color', value)) {
        noteRejected(label + '.' + key + ' = ' + shown(value.slice(0, 60)) + ' is not a color the browser knows, so it was ignored');
      }
    }
    // Values the browser quietly refuses: the property keeps its old value without a word
    // (ctx.textAlign = 'middle', input.type = 'nubmer', ctx.lineWidth = 'thick'). Each is tried on
    // a fresh object of the same kind, in a document of its own that shows and loads nothing, and
    // read back: a value that doesn't take there didn't take here either. Style values and the
    // canvas font go by CSS.supports, for the properties this browser has (one it lacks may be
    // newer than it: not the program's error). Text and markup (which the browser rewrites), form
    // state, and colors (checked above) are left out.
    const UNCHECKED_KEYS = new Set(['value', 'checked', 'selectedIndex', 'innerHTML', 'outerHTML', 'innerText', 'outerText', 'textContent', 'nodeValue', 'data', 'style', 'cssText', 'fillStyle', 'strokeStyle', 'shadowColor']);
    let inertDocument = null;
    let probeContext = null;
    const probeTemplates = new Map();
    function probeFor(label, target) {
      try {
        if (!inertDocument) {
          inertDocument = document.implementation.createHTMLDocument('');
          // Relative addresses (form.action = '/x') resolve as on the page itself
          const base = inertDocument.createElement('base');
          base.href = document.baseURI;
          inertDocument.head.append(base);
        }
        if (label === 'ctx' && target instanceof CanvasRenderingContext2D) {
          probeContext = probeContext || inertDocument.createElement('canvas').getContext('2d');
          return probeContext;
        }
        if (label === 'element' && target instanceof Element) {
          const type = target.getAttribute('type') || '';
          const kind = target.namespaceURI + ' ' + target.localName + ' ' + type;
          if (!probeTemplates.has(kind)) {
            const el = inertDocument.createElementNS(target.namespaceURI, target.localName);
            if (type) el.setAttribute('type', type);
            probeTemplates.set(kind, el);
          }
          // A fresh copy each time: a value set before can't pass for this one
          return probeTemplates.get(kind).cloneNode(false);
        }
      } catch {}
      return null;
    }
    // The values the specs give the common keyword properties: only candidates. Each is tried on
    // this browser (read back on a fresh object, or CSS.supports), and only those it takes count:
    // a refused value that is surely a slip of one of them (cneter, Center, space_between) is
    // corrected while the program runs; otherwise its error lists them
    const ALIGN = ['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly', 'stretch', 'start', 'end', 'baseline', 'normal', 'left', 'right'];
    const KEYWORDS = {
      textAlign: ['start', 'end', 'left', 'right', 'center', 'justify'],
      textBaseline: ['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'],
      lineCap: ['butt', 'round', 'square'],
      lineJoin: ['round', 'bevel', 'miter'],
      globalCompositeOperation: ['source-over', 'source-in', 'source-out', 'source-atop', 'destination-over', 'destination-in', 'destination-out', 'destination-atop', 'lighter', 'copy', 'xor', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'],
      direction: ['ltr', 'rtl', 'inherit'],
      imageSmoothingQuality: ['low', 'medium', 'high'],
      type: ['text', 'number', 'range', 'checkbox', 'radio', 'color', 'date', 'time', 'datetime-local', 'month', 'week', 'email', 'password', 'search', 'tel', 'url', 'file', 'hidden', 'button', 'submit', 'reset', 'image'],
      preload: ['none', 'metadata', 'auto'],
      crossOrigin: ['anonymous', 'use-credentials'],
      loading: ['lazy', 'eager'],
      decoding: ['sync', 'async', 'auto'],
      dir: ['ltr', 'rtl', 'auto'],
      target: ['_self', '_blank', '_parent', '_top'],
      inputMode: ['none', 'text', 'decimal', 'numeric', 'tel', 'search', 'email', 'url'],
      method: ['get', 'post', 'dialog'],
      display: ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'none', 'contents', 'table', 'table-row', 'table-cell', 'list-item', 'flow-root'],
      position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
      flexDirection: ['row', 'row-reverse', 'column', 'column-reverse'],
      flexWrap: ['nowrap', 'wrap', 'wrap-reverse'],
      justifyContent: ALIGN,
      alignItems: ALIGN,
      alignSelf: ALIGN,
      alignContent: ALIGN,
      overflow: ['visible', 'hidden', 'scroll', 'auto', 'clip'],
      visibility: ['visible', 'hidden', 'collapse'],
      cursor: ['auto', 'default', 'pointer', 'move', 'text', 'wait', 'crosshair', 'not-allowed', 'grab', 'grabbing', 'help', 'progress'],
      fontWeight: ['normal', 'bold', 'bolder', 'lighter'],
      fontStyle: ['normal', 'italic', 'oblique'],
      textDecoration: ['none', 'underline', 'overline', 'line-through'],
      textTransform: ['none', 'uppercase', 'lowercase', 'capitalize'],
      whiteSpace: ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'],
      boxSizing: ['content-box', 'border-box'],
      borderStyle: ['none', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset', 'hidden'],
      userSelect: ['none', 'auto', 'text', 'all'],
      pointerEvents: ['auto', 'none'],
      objectFit: ['fill', 'contain', 'cover', 'none', 'scale-down'],
      backgroundRepeat: ['repeat', 'no-repeat', 'repeat-x', 'repeat-y', 'space', 'round'],
      backgroundSize: ['auto', 'cover', 'contain'],
      cssFloat: ['left', 'right', 'none'],
      float: ['left', 'right', 'none'],
      verticalAlign: ['baseline', 'top', 'middle', 'bottom', 'text-top', 'text-bottom', 'sub', 'super'],
    };
    /** The refused value's sure correction among the values the browser takes, or null; and those values */
    function keywordAnswer(key, value, takes) {
      const words = KEYWORDS[key];
      if (!words) return { fix: null, valid: [] };
      const valid = words.filter((w) => { try { return takes(w); } catch { return false; } });
      let fix = null;
      // A single word only (a slip of one keyword, not a value of several parts)
      if (/^[\\w-]+$/.test(value)) {
        try { fix = sureMatch(value, valid); } catch {}
      }
      return { fix, valid };
    }
    const takesList = (valid) => (valid.length > 0 ? '. It takes: ' + valid.join(', ') : '');
    /**
     * A style value the browser doesn't take for a property it has (style.display = 'flexbox'):
     * the value to set, corrected when it is surely a slip of one it takes
     */
    function checkStyleValue(key, value) {
      if (typeof value !== 'string' || value === '' || key === 'cssText' || !window.CSS || !CSS.supports) return value;
      const prop = key === 'cssFloat' ? 'float' : key.replace(/^webkit/, '-webkit-').replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
      if (!CSS.supports(prop, 'initial') || CSS.supports(prop, value)) return value;
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const { fix, valid } = keywordAnswer(camel, value, (w) => CSS.supports(prop, w));
      if (fix) {
        imagined('style.' + key + " = '" + value.slice(0, 60) + "' → '" + fix + "': corrected while running");
        return fix;
      }
      noteRejected('style.' + key + ' = ' + shown(value.slice(0, 60)) + ' is not a value the browser takes for ' + prop + ', so it was ignored' + takesList(valid));
      return value;
    }
    /** Whether the value takes when set on a fresh probe: read back, it is no longer what was there */
    function takesOnProbe(label, d, target, value) {
      const probe = probeFor(label, target);
      if (!probe) return null;
      try {
        if (probe === probeContext) probe.save();
        const before = d.get.call(probe);
        if (typeof before !== 'string' && typeof before !== 'number' && typeof before !== 'boolean') return null;
        if (String(before) === value) return true;
        d.set.call(probe, value);
        return { before, after: d.get.call(probe) };
      } catch {
        return null;
      } finally {
        if (probe === probeContext) try { probe.restore(); } catch {}
      }
    }
    /** A value the browser quietly refuses (see above): the value to set, corrected when it is surely a slip */
    function checkTook(label, key, d, target, value) {
      if (typeof value !== 'string' || value === '' || !d.get || UNCHECKED_KEYS.has(key)) return value;
      const cssKnows = !!(window.CSS && CSS.supports);
      if (label === 'style') return checkStyleValue(key, value);
      if (label === 'ctx' && key === 'font') {
        if (cssKnows && !CSS.supports('font', value)) noteRejected('ctx.font = ' + shown(value.slice(0, 60)) + ' is not a font the browser can use (a size and a family, like "20px sans-serif"), so it was ignored');
        return value;
      }
      const tried = takesOnProbe(label, d, target, value);
      if (!tried || tried === true || tried.after !== tried.before) return value;
      const { fix, valid } = keywordAnswer(key, value, (w) => {
        const t = takesOnProbe(label, d, target, w);
        return t === true || (!!t && t.after !== t.before);
      });
      if (fix) {
        imagined(label + '.' + key + " = '" + value.slice(0, 60) + "' → '" + fix + "': corrected while running");
        return fix;
      }
      noteRejected(label + '.' + key + ' = ' + shown(value.slice(0, 60)) + " didn't take: the browser kept " + shown(String(tried.after)) + ', so it is not a value ' + key + ' can have' + takesList(valid));
      return value;
    }
    // A value the browser can't use: NaN or Infinity, text that says so, or undefined where the
    // call needs a value (a required parameter: within required)
    function checkCall(label, key, required, args) {
      const at = args.findIndex((a, i) => (typeof a === 'number' && !Number.isFinite(a)) || (typeof a === 'string' && badValue(a)) || (a === undefined && i < required));
      if (at >= 0) {
        const bad = args[at];
        noteRejected(label + '.' + key + '(' + args.map((a) => (typeof a === 'number' ? String(a) : typeof a === 'string' ? shown(a.slice(0, 40)) : a === undefined ? 'undefined' : '…')).join(', ') + ') got ' + (bad === undefined ? 'undefined' : shown(typeof bad === 'string' ? bad.slice(0, 40) : bad)) + ': almost surely a bug');
      }
    }
    // A browser call that throws often says little (Safari: "Type error"): the error gets what the
    // call was given ("element.appendChild(a string 'Buy milk') failed: …"), so a fix can see it.
    // The same error, so its line still points at the program
    function describeValue(v) {
      if (v === null) return 'null';
      if (v === undefined) return 'undefined';
      if (typeof v === 'string') return 'a string ' + shown(v.slice(0, 30));
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (typeof v === 'function') return 'a function';
      if (Array.isArray(v)) return 'a list of ' + v.length;
      try {
        if (v instanceof Element) return 'a <' + v.tagName.toLowerCase() + '> element';
        const name = v.constructor && v.constructor.name;
        return name && name !== 'Object' ? 'a ' + name : 'an object';
      } catch {
        return 'an object';
      }
    }
    function explained(err, call) {
      try {
        const kind = err && (err instanceof TypeError || (typeof DOMException !== 'undefined' && err instanceof DOMException));
        if (!kind || err.__chattyExplained) return err;
        Object.defineProperty(err, 'message', { value: call + ' failed: ' + err.message, configurable: true, writable: true });
        Object.defineProperty(err, '__chattyExplained', { value: true });
      } catch {}
      return err;
    }
    function watchSetters(proto, label) {
      if (!proto) return;
      for (const key of Object.getOwnPropertyNames(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, key);
        if (!d || !d.set || !d.configurable) continue;
        Object.defineProperty(proto, key, {
          ...d,
          set(value) {
            if (checking) {
              checkSet(label, key, value);
              value = checkTook(label, key, d, this, value);
            }
            try {
              return d.set.call(this, value);
            } catch (err) {
              throw explained(err, label + '.' + key + ' = ' + describeValue(value));
            }
          },
        });
      }
    }
    function watchCalls(proto, label) {
      if (!proto) return;
      for (const key of Object.getOwnPropertyNames(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, key);
        if (!d || typeof d.value !== 'function' || key === 'constructor' || !d.configurable) continue;
        const fn = d.value;
        // arguments, not a rest parameter: past the checking window a call allocates nothing
        proto[key] = function () {
          if (checking) checkCall(label, key, fn.length, Array.prototype.slice.call(arguments));
          try {
            return fn.apply(this, arguments);
          } catch (err) {
            throw explained(err, label + '.' + key + '(' + Array.prototype.map.call(arguments, describeValue).join(', ') + ')');
          }
        };
      }
    }
    // Controls a program makes but never puts on the page (inputs inside a <div> it never added):
    // at the end of its run, the detached container holding them goes into the card, logged.
    // An input, button, select or text area off the page can't be used, so it has one clear place.
    let createdThisRun = [];
    // Every element the program makes, newest last (see getElementById below)
    const madeByProgram = [];
    const createElementNative = Document.prototype.createElement;
    Document.prototype.createElement = function (...args) {
      const el = createElementNative.apply(this, args);
      if (runningProgram) createdThisRun.push(el);
      madeByProgram.push(el);
      if (madeByProgram.length > 500) madeByProgram.shift();
      return el;
    };
    function describeControl(el) {
      const tag = el.tagName.toLowerCase();
      const label = el.id ? '#' + el.id : el.textContent ? " '" + el.textContent.trim().slice(0, 20) + "'" : '';
      return tag + label;
    }
    const isControl = (el) => /^(?:INPUT|BUTTON|SELECT|TEXTAREA)$/.test(el.tagName);
    // Made to be seen: a canvas or media, or an element given content or a style
    function meantToShow(el) {
      if (/^(?:CANVAS|VIDEO|IMG|SVG|svg)$/.test(el.tagName)) return true;
      return el.children.length > 0 || (el.textContent || '').trim() !== '' || !!el.getAttribute('style');
    }
    // The elements (and the trees holding them) that were made but are not on the page, by the
    // tree's top element
    function orphansOf(elements, wanted) {
      const roots = new Map();
      for (const el of elements) {
        if (el.isConnected || !wanted(el)) continue;
        let top = el;
        while (top.parentNode) top = top.parentNode;
        if (top.nodeType !== 1) continue;
        if (!roots.has(top)) roots.set(top, []);
        roots.get(top).push(el);
      }
      return roots;
    }
    function attachTrees(roots) {
      for (const [top, made] of roots) {
        window.root.appendChild(top);
        const holder = top === made[0] && made.length === 1 ? '' : '<' + top.tagName.toLowerCase() + '> holding ';
        imagined('never added to the page: ' + holder + made.map(describeControl).join(', ') + ' → added to the card');
      }
    }
    // Controls made but never added go on the card at once. Anything else made to be seen (a
    // canvas, a styled ball) only if the card still shows nothing a moment later: a buffer canvas,
    // a sprite image or an overlay added later by a handler is left alone when something shows
    function attachOrphanedControls() {
      const made = createdThisRun;
      createdThisRun = [];
      attachTrees(orphansOf(made, isControl));
      realSetTimeout(() => {
        if (!hasVisualNow()) attachTrees(orphansOf(made, (el) => !isControl(el) && meantToShow(el)));
      }, 600);
    }

    // A length given as a bare number (el.style.left = x * 10) is ignored by CSS: it gets px, as
    // the number surely meant
    const LENGTHS = ['left', 'top', 'right', 'bottom', 'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
      'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'padding', 'paddingTop', 'paddingRight',
      'paddingBottom', 'paddingLeft', 'fontSize', 'borderRadius', 'borderWidth', 'gap', 'rowGap', 'columnGap', 'inset',
      'letterSpacing', 'wordSpacing', 'textIndent', 'outlineWidth', 'outlineOffset'];
    const LENGTH_SET = new Set(LENGTHS);
    const pxNoted = new Set();
    const asLength = (name, value) => {
      const bare = (typeof value === 'number' && Number.isFinite(value) && value !== 0) || (typeof value === 'string' && /^-?\\d+(?:\\.\\d+)?$/.test(value.trim()) && Number(value) !== 0);
      if (!bare) return value;
      if (!pxNoted.has(name)) {
        pxNoted.add(name);
        imagined('style.' + name + ' = ' + value + ' (a number) → ' + value + 'px');
      }
      return String(value).trim() + 'px';
    };
    // Browsers keep each style property on the style object itself (Chrome) or on its prototype,
    // so an element's style is handed out through a proxy that adds the px
    const styled = new WeakMap();
    for (const Type of [window.HTMLElement, window.SVGElement]) {
      const desc = Type && Object.getOwnPropertyDescriptor(Type.prototype, 'style');
      if (!desc || !desc.get) continue;
      Object.defineProperty(Type.prototype, 'style', {
        configurable: true,
        enumerable: desc.enumerable,
        set: desc.set,
        get() {
          const real = desc.get.call(this);
          if (!real) return real;
          let proxy = styled.get(real);
          if (!proxy) {
            proxy = new Proxy(real, {
              get(target, prop) {
                const value = Reflect.get(target, prop, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
              set(target, prop, value) {
                let given = LENGTH_SET.has(prop) ? asLength(prop, value) : value;
                // (the properties are the style object's own in Chrome: the prototype's watchers don't see them)
                if (checking && typeof prop === 'string') given = checkStyleValue(prop, given);
                return Reflect.set(target, prop, given, target);
              },
            });
            styled.set(real, proxy);
          }
          return proxy;
        },
      });
    }

    // Every browser interface a program draws, builds or plays with: elements and nodes, canvas
    // and WebGL contexts, audio nodes and params, paths, class lists
    const WATCHED = /^(?:Node|Element|HTML\\w*Element|SVG\\w*Element|CharacterData|Text|CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D|WebGL2?RenderingContext|Path2D|DOMTokenList|BaseAudioContext|AudioContext|AudioNode|\\w+Node|AudioParam|AudioScheduledSourceNode)$/;
    for (const name of Object.getOwnPropertyNames(window)) {
      if (!WATCHED.test(name)) continue;
      const proto = window[name] && window[name].prototype;
      const label = /Context/.test(name) ? 'ctx' : /Audio|Node$/.test(name) && !/^(?:Node|Text)$/.test(name) ? 'audio' : 'element';
      watchSetters(proto, label);
      watchCalls(proto, label);
    }
    {
      // Style properties sit on the style object's own prototype in some browsers
      let proto = Object.getPrototypeOf(document.createElement('div').style);
      while (proto && proto !== Object.prototype) {
        watchSetters(proto, 'style');
        watchCalls(proto, 'style');
        proto = Object.getPrototypeOf(proto);
      }
    }
    (async () => {
      const probe = async (mode, run) => {
        try { await run(); } catch (e) { const l = stackLine(e); if (l !== null) lineOffsets[mode] = l - 1; }
      };
      await probe('eval', () => (0, eval)('null.probe' + SOURCE_TAG));
      await probe('fn', () => new ProgramFunction('speak', 'playNotes', 'searchWikipedia', 'root', 'null.probe' + SOURCE_TAG)());
      await probe('expr', () => new ProgramFunction('speak', 'playNotes', 'searchWikipedia', 'root', 'return (null.probe);' + SOURCE_TAG)());
    })();

    // What the program still has pending (timeouts, intervals, animation frames, its own async
    // code): the host shows Stop while anything is, and hides it when the last one ends
    const programWork = new Set();
    let workReported = false;
    let workCheck = null;
    const realSetTimeout = window.setTimeout.bind(window);
    const realClearTimeout = window.clearTimeout.bind(window);
    const realSetInterval = window.setInterval.bind(window);
    const realClearInterval = window.clearInterval.bind(window);
    const realRequestFrame = window.requestAnimationFrame.bind(window);
    const realCancelFrame = window.cancelAnimationFrame.bind(window);
    function workChanged() {
      // Checked a moment later, so a loop scheduling its next step doesn't flicker
      if (workCheck !== null) return;
      workCheck = realSetTimeout(() => {
        workCheck = null;
        const active = programWork.size > 0;
        if (active === workReported) return;
        workReported = active;
        __chattyHost.postMessage({ type: 'program_activity', active }, '*');
      }, 200);
    }
    window.setTimeout = (fn, ms, ...args) => {
      if (typeof fn !== 'function') return realSetTimeout(fn, ms, ...args);
      const id = realSetTimeout((...a) => {
        programWork.delete('t' + id);
        try { fn(...a); } finally { workChanged(); }
      }, ms, ...args);
      programWork.add('t' + id);
      workChanged();
      return id;
    };
    window.setInterval = (fn, ms, ...args) => {
      const id = realSetInterval(fn, ms, ...args);
      programWork.add('t' + id);
      workChanged();
      return id;
    };
    // Timeouts and intervals share ids, and programs mix up which one they clear
    window.clearTimeout = window.clearInterval = (id) => {
      realClearTimeout(id);
      realClearInterval(id);
      if (programWork.delete('t' + id)) workChanged();
    };
    // The same callback asked for again before its frame comes (a loop that calls
    // requestAnimationFrame twice) runs once in that frame, as the browser would let it multiply
    const pendingFrames = new Map();
    let doubledFrameNoted = false;
    window.requestAnimationFrame = (fn) => {
      if (typeof fn === 'function' && pendingFrames.has(fn)) {
        if (!doubledFrameNoted) {
          doubledFrameNoted = true;
          imagined('requestAnimationFrame(' + (fn.name || 'callback') + ') asked for again in the same frame → once a frame');
        }
        return pendingFrames.get(fn);
      }
      const id = realRequestFrame((time) => {
        programWork.delete('f' + id);
        pendingFrames.delete(fn);
        try { fn(time); } finally { workChanged(); }
      });
      if (typeof fn === 'function') pendingFrames.set(fn, id);
      programWork.add('f' + id);
      workChanged();
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      realCancelFrame(id);
      // A cancelled frame is no longer pending: asking again schedules a new one
      for (const [fn, pending] of pendingFrames) if (pending === id) pendingFrames.delete(fn);
      if (programWork.delete('f' + id)) workChanged();
    };

    // The MIDI output a program gets as \`out\` when it uses one without asking for it; MIDI
    // starts only when it first plays a note
    let defaultMidi = null;
    // Once per program: a loop that can't sound would otherwise report every note
    let soundErrorSent = false;
    const defaultMidiOut = {
      send(...args) {
        defaultMidi ??= navigator.requestMIDIAccess().then((access) => access.outputs.values().next().value);
        defaultMidi
          .then((output) => output && output.send(...args))
          .catch((err) => {
            // Sound that can't play is reported in the run log, not swallowed
            defaultMidi = null;
            if (soundErrorSent) return;
            soundErrorSent = true;
            __chattyHost.postMessage({ type: 'sound_error', text: String(err && err.message || err) }, '*');
          });
      },
      play(...args) { this.send(...args); },
      playNote(...args) { this.send(...args); },
    };

    // Models call methods Chatty's own helpers don't have (out.playChord(), out.setTempo(90)).
    // A missing method does what its name says: play-like names play, anything else does nothing
    // and returns the helper (so chains keep going). Every such call goes to the run log as
    // "imagined".
    const PLAY_NAME = /^(?:play|note|send|trigger|hit|strike|sound|fire)|note|chord|drum|melody/i;
    // Names JavaScript itself asks for: a real answer (undefined), never a made-up method
    const PROTOCOL_NAMES = new Set(['then', 'catch', 'finally', 'toJSON', 'constructor', 'prototype', 'nodeType', 'valueOf', 'toString', 'asymmetricMatch', '$$typeof']);
    function imagined(text) {
      __chattyHost.postMessage({ type: 'imagined', id: currentExecId, text: String(text).slice(0, 200) }, '*');
    }
    function argText(args) {
      try { return args.map((a) => typeof a === 'function' ? 'fn' : JSON.stringify(a)).join(', '); } catch { return '…'; }
    }
    // A made-up play call's arguments as a send() message: a bare note ('G2', 500) or a frequency
    // in Hz (440, 0.5) gets an instrument in front, and a frequency becomes its note number
    function sendArgs(args) {
      const [first, ...rest] = args;
      // An array is a whole message when it starts with an instrument name (['drums', 'kick']),
      // otherwise a list of notes (['C4', 'E4', 'G4'] or [60, 64, 67])
      if (Array.isArray(first)) {
        const startsWithInstrument = typeof first[0] === 'string' && !/^[A-Ga-g](?:#|b)?-?\\d/.test(first[0]);
        return startsWithInstrument ? first : ['piano', first, ...rest];
      }
      if (typeof first === 'number' && first > 127) return ['piano', Math.round(69 + 12 * Math.log2(first / 440)), ...rest];
      if (typeof first === 'number' || (typeof first === 'string' && /^[A-Ga-g](?:#|b)?-?\\d?(?:\\s|$|m|maj|min|dim|aug|sus|7)/.test(first))) {
        return ['piano', first, ...rest];
      }
      return args;
    }
    // A made-up play call's arguments, played: a whole message ([…], time), the plain form
    // (instrument, notes, duration, time), or bare notes / a frequency (see sendArgs)
    function playOn(port, args) {
      const [first] = args;
      // Named values: { instrument, notes, loudness, duration, time }
      if (first && typeof first === 'object' && !Array.isArray(first)) return port.send(first, args[1]);
      if (Array.isArray(first) && typeof first[0] === 'string' && !/^[A-Ga-g](?:#|b)?-?\\d/.test(first[0])) port.send(first, args[1]);
      else if (typeof first === 'string' && !/^[A-Ga-g](?:#|b)?-?\\d?(?:\\s|$|m|maj|min|dim|aug|sus|7)/.test(first)) port.send(...args);
      else port.send(sendArgs(args));
    }
    const forgivingCache = new WeakMap();
    function forgiving(target, name) {
      if (forgivingCache.has(target)) return forgivingCache.get(target);
      const proxy = new Proxy(target, {
        get(obj, prop) {
          if (typeof prop === 'symbol' || PROTOCOL_NAMES.has(prop) || prop in obj) {
            const value = Reflect.get(obj, prop, obj);
            return typeof value === 'function' ? value.bind(obj) : value;
          }
          return (...args) => {
            imagined(name + '.' + prop + '(' + argText(args) + ')');
            if (PLAY_NAME.test(prop) && args.length > 0) playOn(obj, args);
            return proxy;
          };
        },
      });
      forgivingCache.set(target, proxy);
      return proxy;
    }
    const forgivingOut = forgiving(defaultMidiOut, 'out');

    // What a made-up audioContext.createX() returns: a node-like object that connects, starts and
    // stops harmlessly, and whose play-like methods (made up too) play on the synth
    function standInNode(kind) {
      const node = {
        // The stand-in itself, so chains (node.connect(dest).play(…)) stay on it
        connect() { return proxy; },
        disconnect() {},
        start() {},
        stop() {},
        send(...args) { playOn(forgivingOut, args); },
      };
      const proxy = forgiving(node, kind.charAt(0).toLowerCase() + kind.slice(1));
      return proxy;
    }

    // Element.clear() (document.body.clear() is a common guess): empties it like clear()
    if (!('clear' in HTMLElement.prototype)) {
      Object.defineProperty(HTMLElement.prototype, 'clear', {
        configurable: true,
        value: function () {
          imagined((this === document.body ? 'document.body' : this.tagName.toLowerCase()) + '.clear()');
          if (this === document.body || this === window.root) window.clear();
          else this.replaceChildren();
        },
      });
    }

    // Programs often wait for the page to load (DOMContentLoaded, load, window.onload), but it
    // already has, so that setup would never run: it runs right away instead
    const LOAD_EVENTS = new Set(['DOMContentLoaded', 'load']);
    for (const target of [document, window]) {
      const addListener = target.addEventListener.bind(target);
      target.addEventListener = (type, listener, options) => {
        if (!LOAD_EVENTS.has(type) || !listener) return addListener(type, listener, options);
        setTimeout(() => {
          const event = new Event(type);
          if (typeof listener === 'function') listener.call(target, event);
          else listener.handleEvent?.(event);
        }, 0);
      };
    }
    Object.defineProperty(window, 'onload', {
      configurable: true,
      get: () => null,
      set: (fn) => { if (typeof fn === 'function') setTimeout(() => fn.call(window, new Event('load')), 0); },
    });

    // Small models often fill an element they never made (getElementById('app').innerHTML = ...):
    // a missing id gets an empty <div> on the page instead of null
    const findElementById = document.getElementById.bind(document);
    // Stand-ins made for ids the page doesn't have yet (see carryWiring)
    const placeholders = new Map();
    // Ids given to the element the program made last (id → its tag)
    const borrowed = new Map();
    // The kind of element the program uses each id as ('canvas', 'media', 'field', 'dialog')
    let idKinds = {};
    const KIND_TAGS = { canvas: ['CANVAS'], media: ['AUDIO', 'VIDEO'], field: ['INPUT', 'TEXTAREA', 'SELECT'], dialog: ['DIALOG'] };
    // What stands in for each kind; sound gets a <div> (a silent <audio> would fail without an error)
    const KIND_STAND_IN = { canvas: 'canvas', field: 'input', dialog: 'dialog' };
    // An id one slip from an id on the page ('startbutton' for 'startButton', 'start_btn' for
    // 'start-btn') means that element, not a new empty one
    // (Chatty's shared name matcher, the same rules as every repair: fuzzy-match.ts)
    const sureMatch = ${sureMatch.toString()};

    // A misspelt property written to a browser object doesn't fail: it makes a new property and
    // nothing happens (button.onClick = go, el.innerHtml = '…', ctx.fillstyle = 'red'). Once the
    // program's top level has run, each element's and drawing context's own properties are read:
    // one the browser didn't define that is surely a slip of a real property (not a method) gets
    // its value moved there, and stays as a passage to it. The program's own extras
    // (el.speed = 3) aren't close to any real name, and stay as they are.
    const contexts = new Set();
    {
      const realGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function () {
        const made = realGetContext.apply(this, arguments);
        if (made) contexts.add(made);
        return made;
      };
    }
    const propertyNames = new WeakMap();
    function realProperties(proto) {
      if (propertyNames.has(proto)) return propertyNames.get(proto);
      const names = [];
      for (let o = proto; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
        for (const k of Object.getOwnPropertyNames(o)) {
          const d = Object.getOwnPropertyDescriptor(o, k);
          if (d && (d.get || d.set || typeof d.value !== 'function') && k !== 'constructor') names.push(k);
        }
      }
      propertyNames.set(proto, names);
      return names;
    }
    function repairMisspeltWrites() {
      const objects = [...Array.from(document.querySelectorAll('*')).slice(0, 2000), ...contexts];
      for (const obj of objects) {
        let own;
        try { own = Object.getOwnPropertyNames(obj); } catch { continue; }
        if (own.length === 0) continue;
        const real = realProperties(Object.getPrototypeOf(obj));
        for (const name of own) {
          const d = Object.getOwnPropertyDescriptor(obj, name);
          if (!d || !('value' in d) || real.includes(name)) continue;
          let to = null;
          try { to = sureMatch(name, real); } catch {}
          if (!to) continue;
          const label = obj instanceof Element ? obj.localName : 'ctx';
          try {
            obj[to] = d.value;
            Object.defineProperty(obj, name, { configurable: true, get: () => obj[to], set: (v) => { obj[to] = v; } });
            imagined(label + '.' + name + ' → ' + label + '.' + to + ': corrected while running');
          } catch {}
        }
      }
    }
    function slipOfId(id) {
      const ids = [...document.querySelectorAll('[id]')].map((el) => el.id).filter((other) => other && other !== 'root' && !placeholders.has(other));
      return sureMatch(id, ids);
    }
    document.getElementById = (id) => {
      const found = findElementById(id);
      if (found || typeof id !== 'string' || !id) return found;
      const slip = slipOfId(id);
      if (slip) {
        imagined("getElementById('" + id + "') → '" + slip + "'");
        return findElementById(slip);
      }
      // The kind it is used as (getContext: a canvas), else one its name says (an id with
      // "canvas" in it), or any
      const kind = idKinds[id] || (/canvas/i.test(id) ? 'canvas' : null);
      const isCanvas = kind === 'canvas';
      // The element of that kind the program made last and put on the page without an id: it made
      // the element and then looked it up by an id it never gave it
      for (let i = madeByProgram.length - 1; i >= 0; i--) {
        const el = madeByProgram[i];
        if (el.id || !el.isConnected || (el.parentNode !== document.body && el.parentNode !== window.root)) continue;
        if (kind && !KIND_TAGS[kind].includes(el.tagName)) continue;
        // Without a kind, only an empty element that is no control (an output <div> it made):
        // borrowing it can't overwrite a button's label or anything the program built
        if (!kind && (el.childNodes.length > 0 || /^(?:BUTTON|INPUT|SELECT|TEXTAREA|A|LABEL|OPTION|CANVAS|AUDIO|VIDEO|IMG|SVG|IFRAME|DIALOG)$/.test(el.tagName))) continue;
        el.id = id;
        borrowed.set(id, el.tagName.toLowerCase());
        imagined("getElementById('" + id + "') → the <" + el.tagName.toLowerCase() + "> it made last");
        return el;
      }
      const made = document.createElement((kind && KIND_STAND_IN[kind]) || 'div');
      if (isCanvas) {
        made.setAttribute('width', '400');
        made.setAttribute('height', '300');
      }
      made.id = id;
      // A sound it never made (an <audio> with no file): play() plays a short note instead of
      // failing, pause() and load() do nothing
      if (kind === 'media') {
        made.play = () => {
          imagined("getElementById('" + id + "').play(): no such sound → a short note");
          try { forgivingOut.send({ notes: 'C5', duration: 300 }); } catch {}
          return Promise.resolve();
        };
        made.pause = () => {};
        made.load = () => {};
      }
      document.body.appendChild(made);
      placeholders.set(id, made);
      return made;
    };
    // Ids that never existed and what stood in for each, for the error hints (see standInIds)
    window.__chattyStandIns = () => [
      ...[...placeholders].map(([id, el]) => ({ id, tag: el.tagName.toLowerCase(), made: 'empty' })),
      ...[...borrowed].map(([id, tag]) => ({ id, tag, made: 'last' })),
    ];

    // querySelector('#id') has the same problem: null here would throw before anything draws. A plain
    // id selector (nothing else in it) gets the same stand-in; every other selector is left alone.
    // A loose element not on the page still answers null, since it isn't looking at the page.
    const SIMPLE_ID_SELECTOR = /^#(-?[A-Za-z_][\\w-]*)$/;
    for (const proto of [Document.prototype, Element.prototype]) {
      const findBySelector = proto.querySelector;
      proto.querySelector = function (selector) {
        const found = findBySelector.call(this, selector);
        if (found || typeof selector !== 'string' || !SIMPLE_ID_SELECTOR.test(selector.trim())) return found;
        if (this.nodeType === 1 && !this.isConnected) return found;
        return document.getElementById(selector.trim().slice(1));
      };
    }

    // Small models wire elements up before writing the markup that creates them, or rewrite the
    // markup after wiring it. When an element with an id appears and an earlier element with that
    // id was a stand-in or has left the page, the earlier one's listeners and on* handlers move to
    // the new one, and reads and writes through a variable still holding the earlier one reach it.
    const HANDLER_PROPS = ['onclick', 'oninput', 'onchange', 'onsubmit', 'onkeyup', 'onkeydown'];
    const FORWARDED_PROPS = ['value', 'checked', 'textContent', 'innerText', 'innerHTML'];
    const wiring = new WeakMap();
    // An event name written as its handler property ('onclick') or in other letter case or with
    // separators ('keyDown', 'mouse_down') never fires: it becomes the event the target does fire,
    // as the browser lists them (its on… properties). Only the same letters count, so a real
    // event without an on… property (focusin, DOMContentLoaded) stays as written, and so does a
    // name the program fires itself (new Event('…'), new CustomEvent('…')).
    let ownEvents = new Set();
    const repairedEvents = new Set();
    function eventNameFor(target, type) {
      if (typeof type !== 'string' || !type || ownEvents.has(type)) return type;
      try {
        if (('on' + type) in target) return type;
        const fired = new Set();
        for (let o = target; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
          for (const k of Object.getOwnPropertyNames(o)) if (k.length > 2 && k.slice(0, 2) === 'on') fired.add(k.slice(2));
        }
        const flat = (name) => name.toLowerCase().replace(/[-_\\s]/g, '');
        for (const candidate of [type, /^on/i.test(type) ? type.slice(2) : '']) {
          const to = candidate && flat(candidate);
          if (!to || !fired.has(to)) continue;
          if (!repairedEvents.has(type)) {
            repairedEvents.add(type);
            imagined("addEventListener('" + type + "') → '" + to + "': corrected while running");
          }
          return to;
        }
      } catch {}
      return type;
    }
    const nativeRemoveListener = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      return nativeRemoveListener.call(this, eventNameFor(this, type), listener, options);
    };
    const nativeAddListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      type = eventNameFor(this, type);
      if (this instanceof Element) {
        if (!wiring.has(this)) wiring.set(this, []);
        wiring.get(this).push([type, listener, options]);
      }
      return nativeAddListener.call(this, type, listener, options);
    };
    function carryWiring(from, to) {
      // A type the new element was wired for itself (a re-render that re-attaches) isn't doubled
      const own = new Set((wiring.get(to) || []).map((w) => w[0]));
      for (const [type, listener, options] of wiring.get(from) || []) {
        if (!own.has(type)) to.addEventListener(type, listener, options);
      }
      for (const prop of HANDLER_PROPS) if (from[prop] && !to[prop]) to[prop] = from[prop];
      for (const prop of FORWARDED_PROPS) {
        try {
          Object.defineProperty(from, prop, { configurable: true, get: () => to[prop], set: (v) => { to[prop] = v; } });
        } catch {}
      }
    }
    const departed = new Map();
    const withIds = (node) => (node.nodeType === 1 ? [node, ...node.querySelectorAll('[id]')].filter((el) => el.id) : []);
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) for (const el of withIds(node)) if (!el.isConnected) departed.set(el.id, el);
      }
      for (const record of records) {
        for (const node of record.addedNodes) {
          for (const el of withIds(node)) {
            if (!el.isConnected) continue;
            const stand = placeholders.get(el.id);
            const earlier = stand && stand !== el && !stand.contains(el) ? stand : departed.get(el.id);
            if (!earlier || earlier === el) continue;
            carryWiring(earlier, el);
            departed.delete(el.id);
            if (earlier === stand) {
              placeholders.delete(el.id);
              stand.remove();
            }
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });

    // Web MIDI on every device: a software synth on Chatty's audio (iPhone has no Web MIDI, and
    // desktop Web MIDI only reaches plugged-in devices). Timestamps are on this page's clock.
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: (options) => __chattyHost.__chattyMidi(options, () => performance.now()),
    });

    // Whether the program has put anything on screen (canvas, svg, div, table, etc.)
    // A stand-in made for a missing id that is still empty (no children, no text, nothing drawn)
    // shows nothing, so it is not output
    function isEmptyStandIn(el) {
      if (!el || !placeholders.has(el.id) || placeholders.get(el.id) !== el) return false;
      if (el.firstChild || (el.textContent || '').trim()) return false;
      if (el.tagName !== 'CANVAS') return true;
      try {
        // Compared with a blank canvas of its size (toDataURL leaves the context type free)
        const blank = document.createElement('canvas');
        blank.width = el.width;
        blank.height = el.height;
        return el.toDataURL() === blank.toDataURL();
      } catch { return false; }
    }
    function hasVisualNow() {
      const rootEl = document.getElementById('root');
      const shows = (n) => n.nodeType === 3 ? n.textContent.trim().length > 0 : n.nodeType === 1 && !isEmptyStandIn(n);
      return Boolean(rootEl && Array.from(rootEl.childNodes).some(shows)) ||
        Array.from(document.querySelectorAll('canvas, svg, table, img, video, form, button, input, div:not(#root)')).some((el) => !isEmptyStandIn(el)) ||
        Array.from(document.body.children).some(c => c !== rootEl && c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE' && !isEmptyStandIn(c));
    }
    // The host asks this page (see hasVisualContent)
    window.__chattyHasVisual = hasVisualNow;

    // clear(): empties the card, so a program can start the screen over
    window.clear = () => {
      window.root.innerHTML = '';
      __chattyHost.postMessage({ type: 'clear' }, '*');
    };

    // After the page has loaded, document.write would replace all of it (the card, the program's
    // wiring and this runner): its HTML goes into the card instead, and its scripts run
    function writeHtml(html) {
      const scripts = [];
      const markup = String(html).replace(/<script[^>]*>([\\s\\S]*?)<\\/script>/gi, (_m, code) => {
        scripts.push(code);
        return '';
      });
      window.root.insertAdjacentHTML('beforeend', markup);
      for (const code of scripts) (0, eval)(code);
    }
    document.write = (...parts) => writeHtml(parts.join(''));
    document.writeln = (...parts) => writeHtml(parts.join('') + '\\n');
    document.open = () => document;
    document.close = () => {};

    // Errors after the run started (timers, handlers, async code) would otherwise fail silently
    window.addEventListener('error', (event) => {
      const err = event.error;
      __chattyHost.postMessage({ type: 'program_error', message: err ? (err.message || String(err)) : event.message, line: errorLine(err) }, '*');
    });
    window.addEventListener('unhandledrejection', (event) => {
      const err = event.reason;
      __chattyHost.postMessage({ type: 'program_error', message: err ? (err.message || String(err)) : 'Promise rejected', line: errorLine(err) }, '*');
    });

    window.addEventListener('message', async (event) => {
      const data = event.data;
      if (!data) return;

      if (data.type === 'async_response' && data.callId) {
        const resolver = pendingAsyncCalls.get(data.callId);
        if (resolver) {
          pendingAsyncCalls.delete(data.callId);
          resolver(data.result);
        }
        return;
      }

      // Trial runs only: use every control once, so an error inside a handler shows up now
      if (data.type === 'smoke') {
        smokeControls();
        return;
      }

      if (data.type !== 'execute') return;
      const { id, code } = data;
      currentExecId = id;
      // The events it fires itself are its own names (see eventNameFor)
      ownEvents = new Set(Array.from(String(code).matchAll(/new\\s+(?:Custom)?Event\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]/g), (m) => m[1]));
      // console.log() speaks only for a program that doesn't speak itself (see logSpeaks)
      logSpeaks = !/\\bspeak\\s*\\(/.test(code);
      lastLog = '';
      logTimes = [];
      // The value checks run for this program's first seconds (see CHECK_MS)
      checking = true;
      speakChecked = !data.valuesExpected && !/(['"\`])[^'"\`\\n]*\\b(?:NaN|Infinity)\\b/.test(code);
      realClearTimeout(checkTimer);
      if (!__chattyTrial) checkTimer = realSetTimeout(() => { checking = false; speakChecked = false; }, CHECK_MS);
      // What kind of element each looked-up id is used as (element-kinds.ts)
      idKinds = data.idKinds || {};
      // The names the music rule tells programs to declare (bpm, beat, start, out): a program
      // that forgets one gets a default instead of an error. Its own declarations win.
      window.bpm = 100;
      window.beat = 60000 / 100;
      window.start = performance.now() + 100;
      window.out = forgivingOut;
      soundErrorSent = false;
      rejected = null;
      rejectedReported = false;
      createdThisRun = [];
      runningProgram = true;
      const logs = [];
      const origLog = console.log;
      const origWarn = console.warn;
      const origError = console.error;

      console.log = (...args) => {
        logs.push(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
        origLog(...args);
      };
      console.warn = (...args) => logs.push('[warn] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
      console.error = (...args) => logs.push('[error] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));

      programWork.add('run');
      workChanged();
      try {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        let compiledFn;
        let isExpression = false;
        try {
          compiledFn = new AsyncFunction('speak', 'playNotes', 'searchWikipedia', 'root', 'return (' + code.replace(/;\\s*$/, '') + ');' + SOURCE_TAG);
          isExpression = true;
        } catch {
          try {
            compiledFn = new AsyncFunction('speak', 'playNotes', 'searchWikipedia', 'root', code + SOURCE_TAG);
          } catch (compileErr) {
            throw compileErr;
          }
        }

        let res;
        if (isExpression || /\\bawait\\b/.test(code) || hasTopLevelReturn(code)) {
          runMode = isExpression ? 'expr' : 'fn';
          res = await compiledFn(window.speak, window.playNotes, window.searchWikipedia, window.root);
        } else {
          runMode = 'eval';
          res = (0, eval)(code + SOURCE_TAG);
        }
        if (res instanceof Promise) {
          res = await res;
        }

        attachOrphanedControls();
        repairMisspeltWrites();
        const hasVisualElements = hasVisualNow();

        // A function (often the program's last line defines or exposes one) is never a reply
        let out = typeof res === 'function' ? undefined : res;
        if (out === undefined && logs.length > 0) {
          out = logs.join('\\n');
        }
        // Functions, DOM nodes etc. can't be posted to the host; send a description instead
        try {
          structuredClone(out);
        } catch {
          out = typeof out === 'function' ? '[function ' + (out.name || 'anonymous') + ']' : String(out);
        }

        // It ran, but gave the browser a value it ignores (NaN, undefined): that is its error
        if (rejected) {
          const first = rejected;
          rejected = null;
          rejectedReported = true;
          __chattyHost.postMessage({
            type: 'result',
            id,
            success: false,
            error: first.message,
            errorLine: first.line,
            logs,
            hasVisual: hasVisualElements,
          }, '*');
          return;
        }
        __chattyHost.postMessage({
          type: 'result',
          id,
          success: true,
          output: out,
          logs,
          hasVisual: hasVisualElements,
        }, '*');
      } catch (err) {
        __chattyHost.postMessage({
          type: 'result',
          id,
          success: false,
          error: err ? (err.message || String(err)) : String(err),
          errorLine: errorLine(err),
          logs,
          // A program that failed partway may already have drawn something (the Clear button shows)
          hasVisual: hasVisualNow(),
        }, '*');
      } finally {
        runningProgram = false;
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
        programWork.delete('run');
        workChanged();
      }
    });

    // Clicks every button and feeds every field an input and a change event (at most 20
    // controls), then reports when done; a handler that throws reaches the window error listener
    function smokeControls() {
      const MAX_CONTROLS = 20;
      const CLICKABLE = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], [onclick]';
      const FIELDS = 'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="hidden"]), select, textarea';
      const SAMPLES = { number: '5', range: '5', email: 'a@b.co', date: '2024-01-15', time: '12:00', color: '#336699', url: 'https://example.com', tel: '5551234567' };
      // A submit would load a new page over this one
      const noSubmit = (e) => e.preventDefault();
      document.addEventListener('submit', noSubmit, true);
      smoking = true;
      try {
        // Links aren't clicked: one would load a new page over this one
        const controls = [...document.querySelectorAll(CLICKABLE + ', ' + FIELDS)]
          .filter((el) => !el.disabled && !el.matches('a[href]'))
          .slice(0, MAX_CONTROLS);
        for (const el of controls) {
          try {
            if (el.matches(CLICKABLE)) {
              el.click();
              continue;
            }
            if (el.tagName === 'SELECT') {
              const other = [...el.options].find((o) => o.value !== el.value);
              if (other) el.value = other.value;
            } else if (el.type === 'checkbox' || el.type === 'radio') {
              el.checked = !el.checked;
            } else {
              el.value = SAMPLES[el.type] || 'test';
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } catch {}
        }
      } finally {
        realSetTimeout(() => {
          document.removeEventListener('submit', noSubmit, true);
          smoking = false;
          __chattyHost.postMessage({ type: 'smoke_done' }, '*');
        }, 300);
      }
    }

    // A tap or key press in the card starts Chatty's audio too (browsers only start it in one)
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
      window.addEventListener(type, () => { try { __chattyHost.__chattyUnlockAudio?.(); } catch {} }, true);
    }

    // Notify parent that iframe is ready
    __chattyHost.postMessage({ type: 'iframe_ready' }, '*');
  </script>
</body>
</html>`;
  }

  /** A new program is in the card: it can be downloaded once it has run 2.5 s without an error */
  private trackDownload(code: string): void {
    this.spoilDownload();
    const entry: { code: string; timer: ReturnType<typeof setTimeout> | null } = { code, timer: null };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.downloadable !== entry) return;
      this.downloadReady = true;
      this.onDownloadableChange?.(true);
    }, DOWNLOAD_AFTER_MS);
    this.downloadable = entry;
  }

  /** An error or a cleared card: nothing to download */
  private spoilDownload(): void {
    if (this.downloadable?.timer) clearTimeout(this.downloadable.timer);
    this.downloadable = null;
    if (!this.downloadReady) return;
    this.downloadReady = false;
    this.onDownloadableChange?.(false);
  }

  /** The program ran but failed a check made outside the sandbox (it played or showed nothing) */
  withdrawDownload(): void {
    this.spoilDownload();
  }

  isDownloadReady(): boolean {
    return this.downloadReady;
  }

  /**
   * The program in the card as one self-contained HTML file: the same page it runs in here, with
   * Chatty's part (sound, MIDI, notes, Wikipedia, speech) and three.js, when it uses THREE, inlined.
   */
  async standaloneHtml(): Promise<string | null> {
    const code = this.downloadReady ? this.downloadable?.code : null;
    if (!code) return null;
    const scriptOf = async (url: string) => {
      const text = await (await fetch(url)).text();
      // In a function: the bundle's top-level names stay out of the program's global scope
      return `<script>(function () {\n${text.replace(/<\/script/gi, '<\\/script')}\n})();</script>`;
    };
    const [{ default: hostUrl }, three] = await Promise.all([
      import('../standalone/host.ts?worker&url'),
      /\bTHREE\b/.test(code) ? import('../standalone/three-global.ts?worker&url') : null,
    ]);
    const head = [await scriptOf(hostUrl), three ? await scriptOf(three.default) : ''].join('\n');
    const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
    const start = `<script>window.postMessage({ type: 'execute', id: 'standalone', code: ${json(code)}, idKinds: ${json(elementKinds(code))} }, '*');</script>`;
    return this.buildRunnerHtml(false, 'window.__chattyStandaloneHost')
      // Functions as replacements: the inlined code has $ patterns a replacement string would expand
      .replace('<head>', () => `<head>\n  <title>Chatty program</title>\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n${head}`)
      .replace(/<\/body>\s*<\/html>\s*$/, () => `${start}\n</body>\n</html>`);
  }

  /** Builds the sandbox iframe ahead of the first program (empty card, hidden) if none exists */
  prepare(): void {
    if (this.mode !== 'iframe' || typeof document === 'undefined' || this.activeIframe) return;
    this.ensureIframe();
  }

  private ensureIframe(): HTMLIFrameElement {
    if (this.activeIframe && this.activeIframe.contentWindow) {
      return this.activeIframe;
    }

    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.setAttribute('allow', 'autoplay; midi');
    iframe.setAttribute('title', 'Chatty JavaScript Runtime Sandbox');
    iframe.style.position = 'absolute';
    iframe.style.inset = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.background = 'transparent';
    iframe.style.pointerEvents = 'none';

    const runnerHtml = this.buildRunnerHtml(false);

    this.activeIframe = iframe;
    window.addEventListener('message', this.handleHostMessage);
    this.iframeReadyPromise = new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          window.removeEventListener('message', onReady);
          resolve();
        }
      };
      const onReady = (e: MessageEvent) => {
        if (e.source === iframe.contentWindow && e.data?.type === 'iframe_ready') {
          done();
        }
      };
      window.addEventListener('message', onReady);
      iframe.addEventListener('load', () => {
        if (this.activeIframe === iframe) this.watchCard(iframe);
        if (this.activeIframe === iframe) this.onIframeLoad?.(iframe);
        setTimeout(done, 50);
      });
      // Timeout fallback for ready signal
      setTimeout(done, 600);
    });

    if (this.iframeContainer) {
      this.iframeContainer.innerHTML = '';
      this.iframeContainer.appendChild(iframe);
    } else {
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
    }

    iframe.srcdoc = runnerHtml;
    return iframe;
  }

  /**
   * Persistent host-side listener for the current iframe. It outlives individual runs so that
   * speak/playNotes/searchWikipedia calls from timers, rAF loops and event handlers keep working.
   */
  private handleHostMessage = (event: MessageEvent<any>): void => {
    const iframe = this.activeIframe;
    if (!iframe || event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'speak') {
      const text = String(data.text ?? '');
      const run = this.pendingRuns.get(data.id);
      run?.spokenTexts.push(text);
      this.onRunLog?.('speak', text);
      (run?.options ?? this.lastRunOptions ?? this.defaultOptions)?.onSpeak?.(text);
      return;
    }

    if (data.type === 'playNotes' || data.type === 'searchWikipedia') {
      void this.handleAsyncCall(iframe, data);
      return;
    }

    if (data.type === 'program_activity') {
      this.programActive = Boolean(data.active);
      this.onProgramActivity?.(this.programActive);
      return;
    }

    if (data.type === 'clear') {
      this.onRunLog?.('clear', '');
      return;
    }

    if (data.type === 'sound_error') {
      this.onRunLog?.('error', `sound: ${String(data.text ?? '')}`);
      return;
    }

    if (data.type === 'imagined') {
      this.onRunLog?.('imagined', String(data.text ?? ''));
      return;
    }

    if (data.type === 'program_error') {
      this.spoilDownload();
      this.onRunLog?.('error', typeof data.line === 'number' ? `line ${data.line}: ${data.message}` : String(data.message ?? 'Unknown error'));
      this.onProgramError?.(String(data.message ?? 'Unknown error'), typeof data.line === 'number' ? data.line : undefined);
      return;
    }

    if (data.type === 'result') {
      const run = this.pendingRuns.get(data.id);
      if (!run) return; // Late result of a run that already timed out / was reset
      run.finish(data);
    }
  };

  private async handleAsyncCall(iframe: HTMLIFrameElement, data: Record<string, any>): Promise<void> {
    const opts = this.pendingRuns.get(data.id)?.options ?? this.lastRunOptions ?? this.defaultOptions;
    let result: unknown;
    try {
      if (data.type === 'playNotes') {
        this.soundUses++;
        result = await playNotesHelper(
          String(data.notes ?? ''),
          data.tempo,
          undefined,
          opts?.audioContextAccessor
        );
      } else {
        result = await fetchWikipediaSummary(String(data.query ?? ''));
      }
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      iframe.contentWindow?.postMessage({ type: 'async_response', callId: data.callId, result }, '*');
    } catch {
      // iframe went away
    }
  }

  private async executeInIframe(
    code: string,
    options?: ExecutionContextOptions
  ): Promise<JavascriptExecutionResult> {
    const iframe = this.ensureIframe();
    await this.iframeReadyPromise;

    if (!iframe.contentWindow || this.activeIframe !== iframe) {
      console.error('[JavascriptRuntime] IFrame contentWindow unavailable, falling back to eval');
      return this.executeInEval(code, options);
    }

    const reqId = `iframe_exec_${++this.reqCounter}_${Date.now()}`;
    const start = performance.now();
    const spokenTexts: string[] = [];
    this.lastRunOptions = options;
    // Each program run is counted on its own (what its MIDI was, see midiSummary)
    resetMidiSummary();

    return new Promise((resolve) => {
      const settle = (
        data: Record<string, any> | null,
        errorMessage?: string
      ): void => {
        clearTimeout(timer);
        this.pendingRuns.delete(reqId);
        if (!data) {
          resolve({
            success: false,
            error: errorMessage ?? 'IFrame execution failed',
            logs: [],
            spokenTexts,
            hasVisualOutput: false,
            executionTimeMs: Math.max(1, Math.round(performance.now() - start)),
            code,
            mode: 'iframe',
          });
          return;
        }
        const hasVisual = Boolean(data.hasVisual);
        this.onVisualChange?.(hasVisual, this.activeIframe);
        if (!data.success) this.spoilDownload();
        resolve({
          success: Boolean(data.success),
          output: data.output,
          error: data.error,
          errorLine: typeof data.errorLine === 'number' ? data.errorLine : undefined,
          logs: data.logs ?? [],
          spokenTexts,
          hasVisualOutput: hasVisual,
          executionTimeMs: Math.max(1, Math.round(performance.now() - start)),
          code,
          mode: 'iframe',
        });
      };

      // Stop waiting after timeoutMs, but the program keeps running and this isn't a failure:
      // anything it says later is spoken outside the turn (via lastRunOptions). Hangs are caught
      // separately by the loop guard.
      const timer = setTimeout(() => {
        this.pendingRuns.delete(reqId);
        const hasVisual = this.hasVisualContent();
        this.onVisualChange?.(hasVisual, this.activeIframe);
        resolve({
          success: true,
          stillRunning: true,
          logs: [],
          spokenTexts,
          hasVisualOutput: hasVisual,
          executionTimeMs: this.timeoutMs,
          code,
          mode: 'iframe',
        });
      }, this.timeoutMs);

      this.pendingRuns.set(reqId, { options, spokenTexts, timer, finish: settle });
      this.trackDownload(code);
      void withThree(code, iframe.contentWindow).then(() =>
        iframe.contentWindow?.postMessage({ type: 'execute', id: reqId, code, idKinds: elementKinds(code), valuesExpected: VALUES_ASKED_ABOUT.test(options?.request ?? '') }, '*')
      );
    });
  }

  /**
   * Runs code in a separate hidden, muted iframe for up to ms. Nothing is shown, spoken or played,
   * and nothing reaches the run log or the visible card (see trialHost).
   * Resolves with the first error (as a real run reports it, including the sandbox's own checks),
   * or null when it ran that long without one. Trials queue: one at a time. If the trial page
   * can't be set up at all (no DOM), that is null too: nothing was shown to be wrong.
   * Trials share one iframe element, kept TRIAL_FRAME_IDLE_MS after the last, and each gets a
   * brand-new page in it. The page isn't wiped in place: the sandbox patches the built-in
   * prototypes and a program can too (globals, listeners, timers), and only a new window is
   * certain to be clean.
   */
  trialRun(code: string, ms = 1500): Promise<{ error: string | null; errorLine?: number; reached?: boolean }> {
    const run = this.trialQueue.then(() => this.trialNow(code, ms));
    this.trialQueue = run.catch(() => undefined);
    return run.catch(() => ({ error: null }));
  }

  private trialNow(code: string, ms: number): Promise<{ error: string | null; errorLine?: number; reached?: boolean }> {
    if (typeof document === 'undefined' || !document.body) return Promise.resolve({ error: null });
    const iframe = this.takeTrialFrame();
    const id = `trial_${++this.reqCounter}_${Date.now()}`;

    return new Promise((resolve) => {
      let finished = false;
      let ready = false;
      let started = false;
      let smoked = false;
      let startedAt = 0;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let readyTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (error: string | null, errorLine?: number): void => {
        if (finished) return;
        finished = true;
        clearTimeout(stopTimer);
        clearTimeout(readyTimer);
        window.removeEventListener('message', onMessage);
        iframe.removeEventListener('load', onLoad);
        // Whether the code marked with globalThis.__chattyReached ran (see blankStage)
        let reached = false;
        try {
          const page = iframe.contentWindow as unknown as { __chattyReached?: boolean; __chattyTrialToken?: string } | null;
          reached = page?.__chattyTrialToken === id && !!page.__chattyReached;
        } catch {
          // frame went away
        }
        // An empty page replaces the program's, which ends its timers, animation frames and audio
        try {
          iframe.srcdoc = '';
        } catch {
          // already gone
        }
        this.trialFrameIdle = setTimeout(() => this.dropTrialFrame(), TRIAL_FRAME_IDLE_MS);
        resolve(error === null ? { error: null, reached } : { error, errorLine, reached });
      };

      const start = (): void => {
        if (started || finished) return;
        started = true;
        startedAt = Date.now();
        clearTimeout(readyTimer);
        stopTimer = setTimeout(() => finish(null), ms);
        try {
          // Not if the trial ended while three.js loaded: the frame is the next trial's by then
          void withThree(code, iframe.contentWindow, () => !finished).then(() => {
            if (!finished) iframe.contentWindow?.postMessage({ type: 'execute', id, code, idKinds: elementKinds(code) }, '*');
          });
        } catch (err) {
          finish(err instanceof Error ? err.message : String(err));
        }
      };

      // The frame also loads the empty page between trials: only this trial's page counts
      const onLoad = (): void => {
        const page = iframe.contentWindow as unknown as { __chattyTrialToken?: string } | null;
        if (page?.__chattyTrialToken !== id) return;
        setTimeout(() => {
          if (!ready) start();
        }, 50);
      };

      const onMessage = (event: MessageEvent<any>): void => {
        if (event.source !== iframe.contentWindow) return;
        const data = event.data;
        // The frame's window outlives its pages: a late message from an earlier trial's page
        // arrives from the same source, but with that trial's token
        if (!data || typeof data !== 'object' || data.__trial !== id) return;
        const line = typeof data.line === 'number' ? data.line : typeof data.errorLine === 'number' ? data.errorLine : undefined;
        if (data.type === 'iframe_ready') {
          ready = true;
          start();
        } else if (data.type === 'program_error') {
          finish(String(data.message ?? 'Unknown error'), line);
        } else if (data.type === 'result') {
          if (!data.success) finish(String(data.error ?? 'Unknown error'), line);
          else if (!smoked && registersHandlers(code)) {
            // The program ran and wired up handlers: use each control once. An error inside one
            // arrives like any other (program_error, with its line).
            smoked = true;
            clearTimeout(stopTimer);
            stopTimer = setTimeout(() => finish(null), Math.max(ms - (Date.now() - startedAt), 0) + 500);
            try {
              iframe.contentWindow?.postMessage({ type: 'smoke' }, '*');
            } catch {
              // frame went away
            }
          }
        } else if (data.type === 'smoke_done') {
          // Every control was used: done once the trial's own time is up too
          clearTimeout(stopTimer);
          stopTimer = setTimeout(() => finish(null), Math.max(ms - (Date.now() - startedAt), 0));
        } else if (data.type === 'playNotes' || data.type === 'searchWikipedia') {
          // Nothing plays and nothing is fetched; the program just gets an answer
          try {
            iframe.contentWindow?.postMessage(
              { type: 'async_response', callId: data.callId, result: { success: data.type === 'playNotes' } },
              '*'
            );
          } catch {
            // frame went away
          }
        }
      };

      try {
        window.addEventListener('message', onMessage);
        iframe.addEventListener('load', onLoad);
        // Fallback if the ready signal never comes
        readyTimer = setTimeout(start, 600);
        iframe.srcdoc = this.buildRunnerHtml(true, undefined, id);
      } catch (err) {
        finish(err instanceof Error ? err.message : String(err));
      }
    });
  }

  /** The shared trial frame, made when there isn't one: off screen, but laid out at a fixed size (canvas and DOM code reads sizes) */
  private takeTrialFrame(): HTMLIFrameElement {
    if (this.trialFrameIdle) clearTimeout(this.trialFrameIdle);
    this.trialFrameIdle = null;
    if (this.trialFrame?.isConnected) return this.trialFrame;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.setAttribute('title', 'Chatty trial run');
    iframe.style.cssText =
      'position:fixed;left:-10000px;top:0;width:400px;height:300px;border:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(iframe);
    this.trialFrame = iframe;
    return iframe;
  }

  private dropTrialFrame(): void {
    if (this.trialFrameIdle) clearTimeout(this.trialFrameIdle);
    this.trialFrameIdle = null;
    this.trialFrame?.remove();
    this.trialFrame = null;
  }

  dispose(): void {
    this.abortPendingRuns('Runtime disposed');
    this.silenceProgramAudio();
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.handleHostMessage);
    }
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // Ignore
      }
      this.worker = null;
    }
    if (this.activeIframe) {
      this.activeIframe.remove();
      this.activeIframe = null;
    }
    this.dropTrialFrame();
  }
}

/**
 * Creates the standard ToolDefinition for Gemma integration as 'coder_agent'
 */
export function createCoderAgentTool(
  runtimeInstance: JavascriptRuntime,
  callback?: JavascriptExecutionCallback,
  toolName = 'coder_agent'
): ToolDefinition {
  return {
    name: toolName,
    description:
      'Executes dynamic browser actions, audio, visuals, calculations, simulations, or custom JavaScript scripts. Call this when the user asks to run code, compute, or simulate.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Task description or JavaScript code to execute',
        },
      },
      required: ['task'],
    },
    execute: async (args: Record<string, unknown>) => {
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      const code = typeof args.code === 'string' ? args.code.trim() : '';
      const anyStr = Object.values(args).find(
        (v) => typeof v === 'string' && v.trim().length > 0
      ) as string | undefined;
      const input =
        task ||
        code ||
        String(
          args.prompt ||
            args.description ||
            args.query ||
            args.app ||
            args.game ||
            args.input ||
            anyStr ||
            ''
        ).trim();

      return runtimeInstance.executeTask(
        {
          task: task || (runtimeInstance.isProbableCode(input) ? undefined : input),
          code: code || (runtimeInstance.isProbableCode(input) ? input : undefined),
        },
        callback
      );
    },
  };
}

/**
 * Creates the standard ToolDefinition for Gemma integration (backwards-compatible alias)
 */
export function createJavascriptRuntimeTool(
  runtimeInstance: JavascriptRuntime,
  callback?: JavascriptExecutionCallback,
  toolName = 'javascript_runtime'
): ToolDefinition {
  return createCoderAgentTool(runtimeInstance, callback, toolName);
}
