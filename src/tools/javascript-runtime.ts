// ============================================================================
// JavaScript Runtime Tool for Gemma
// Supports Sandboxed IFrame (default, with DOM/visual rendering),
// Web Worker (headless background compute), and Direct Eval ((0, eval) strict).
// ============================================================================

import { parse } from 'acorn';
import type { LlmRuntimeProvider, ToolDefinition } from '../types/index.ts';
import { loopProtect } from './loop-protect.ts';
import { playNotesHelper } from './music-tool.ts';
import { fetchWikipediaSummary } from './web-tools.ts';
import { withActivity } from '../core/activity-breadcrumbs.ts';
import { silenceSoftwareMidi, softwareMidiAccess } from '../audio/software-midi.ts';

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
}

/**
 * Inspects raw text from the model into executable JavaScript and classifies
 * whether it is an executable JavaScript code action or conversational prose.
 */
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
  const scripts = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi), (m) => m[1]);
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
  return [
    markup ? `document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(markup)});` : '',
    ...scripts,
    ...strayCode,
  ].join('\n');
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
export function callUncalledFunctions(code: string): string {
  const declared = [
    ...Array.from(code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(\s*\)/gm), (m) => m[1]),
    ...Array.from(code.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(\s*\)\s*=>/gm), (m) => m[1]),
  ];
  if (declared.length === 0) return code;
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
  return toCall.length ? `${code}\n${toCall.map((name) => `await ${name}();`).join('\n')}` : code;
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
 * Inline handlers in a program's HTML (onclick="calc()") look names up globally, but programs run
 * as function bodies, where their functions stay local: those functions are made global too.
 */
export function exposeFunctionsToInlineHandlers(code: string): string {
  if (!/\son[a-z]+\s*=\s*\\?["']/i.test(code)) return code;
  const names = [
    ...Array.from(code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm), (m) => m[1]),
    ...Array.from(code.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/gm), (m) => m[1]),
  ];
  if (names.length === 0) return code;
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

export function inspectExecutableCode(rawText: string): PreparedExecutableCode {
  let cleaned = normalizeFences((rawText || '').trim());

  // HTML instead of JavaScript (a whole page for "an app", or bare <canvas> + <script>): its
  // markup goes on screen and its scripts run, as with an ```html block. Never spoken as prose.
  if (HTML_START.test(cleaned)) {
    return { code: callUncalledFunctions(htmlToCode(cleaned)), isProse: false };
  }

  // 1. Take the program out of markdown fences if present
  let hadFences = false;
  if (cleaned.includes('```')) {
    const program = extractProgram(cleaned);
    if (program) {
      cleaned = withTalk(program);
      hadFences = true;
    }
  }

  // 2. Remove any rogue <|...|> or <tool_call> tags
  cleaned = cleaned.replace(/<\|[a-z0-9_]+\|?>/gi, '').replace(/<\/?\|?tool_call\|?>/gi, '').trim();

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
    return { code: exposeFunctionsToInlineHandlers(callUncalledFunctions(cleaned)), isProse: false };
  }

  const page = unclosedPage(cleaned);
  if (page) {
    return { code: exposeFunctionsToInlineHandlers(callUncalledFunctions(page)), isProse: false };
  }

  // 4b. Explanation wrapped around unfenced code: run the code part. After fences were taken
  // out, what is left is already the program: it runs whole, and a syntax error goes to the fix
  const program = hadFences ? [{ kind: 'code' as const, text: cleaned }] : extractProgram(cleaned);
  if (program) {
    return { code: exposeFunctionsToInlineHandlers(callUncalledFunctions(withTalk(program))), isProse: false };
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
    /\b(document|window|canvas|getContext|Audio|AudioContext|webkitAudioContext|OscillatorNode|GainNode|requestMIDIAccess|svg|innerHTML|appendChild|addEventListener|setInterval|setTimeout|requestAnimationFrame|createElement|getElementById|querySelector|classList|style|onclick|root|playNotes|speak|searchWikipedia|localStorage|sessionStorage|alert|prompt|confirm|location|navigator)\b/i.test(
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
  private onRunLog?: (kind: RunLogKind, text: string) => void;
  private programSounding = false;
  // The last program_activity the sandbox reported: timers, animation frames or async work pending
  private programActive = false;
  private quietWatch: { timer: ReturnType<typeof setInterval>; analyser: AnalyserNode } | null = null;
  private programOutput: GainNode | null = null;
  private cardShadow: HTMLElement | null = null;

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
    const context = this.getSharedAudioContext?.();
    if (!context) return null;
    if (!this.programOutput || this.programOutput.context !== context) {
      this.programOutput = context.createGain();
      this.programOutput.connect(context.destination);
    }
    this.watchProgramSound(this.programOutput);
    if (context.state !== 'running') void context.resume().catch(() => {});
    return { context, output: this.programOutput };
  }

  /**
   * A program is about to make sound: tells the host (which switches the audio session to
   * playback), then reports when its output has been quiet for 3 seconds.
   */
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
    return withActivity('clearing the screen', () => this.resetVisualNow());
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
    // Size changes (images loading, layout) and content changes (which also cover a page that
    // isn't rendering yet, when resize callbacks wait)
    new win.ResizeObserver(update).observe(card);
    new win.MutationObserver(() => setTimeout(update, 0)).observe(card, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    win.addEventListener('resize', update);
    update();
  }

  private async resetVisualNow(): Promise<void> {
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
  pageIds(): string[] {
    try {
      const doc = this.activeIframe?.contentDocument;
      return doc ? [...doc.querySelectorAll('[id]')].map((el) => el.id).filter((id) => id && id !== 'root') : [];
    } catch {
      return [];
    }
  }

  hasVisualContent(): boolean {
    try {
      const doc = this.activeIframe?.contentDocument;
      if (!doc?.body) return false;
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
    return this.hasVisualContent() || this.programSounding || this.programActive;
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

    const runnerHtml = `<!DOCTYPE html>
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
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    const hasTopLevelReturn = ${hasTopLevelReturn.toString()};
    let currentExecId = null;
    const pendingAsyncCalls = new Map();

    window.speak = (text) => {
      const s = typeof text === 'object' ? JSON.stringify(text) : String(text ?? '');
      window.parent.postMessage({ type: 'speak', id: currentExecId, text: s }, '*');
    };

    window.playNotes = (notes, tempo) => {
      return new Promise((resolve) => {
        const callId = Math.random().toString(36).slice(2);
        pendingAsyncCalls.set(callId, resolve);
        window.parent.postMessage({ type: 'playNotes', id: currentExecId, callId, notes, tempo }, '*');
      });
    };

    window.searchWikipedia = (query) => {
      return new Promise((resolve) => {
        const callId = Math.random().toString(36).slice(2);
        pendingAsyncCalls.set(callId, resolve);
        window.parent.postMessage({ type: 'searchWikipedia', id: currentExecId, callId, query }, '*');
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
        shared = window.parent.__chattySharedAudio ? window.parent.__chattySharedAudio() : null;
      } catch {}
      if (!shared) return new NativeAudioContext(options);
      const local = {};
      return new Proxy(shared.context, {
        get(target, prop) {
          if (prop in local) return local[prop];
          if (prop === 'destination') return shared.output;
          if (prop === 'close' || prop === 'suspend') return () => Promise.resolve();
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set(_target, prop, value) {
          local[prop] = value;
          return true;
        },
      });
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
    function stackLine(err) {
      const m = String((err && err.stack) || '').match(/chatty-program\\.js:(\\d+)/);
      if (m) return Number(m[1]);
      // Safari's stack may not name the program, but its errors carry the line
      return err && typeof err.line === 'number' ? err.line : null;
    }
    function errorLine(err) {
      const line = stackLine(err);
      const offset = lineOffsets[runMode];
      return line !== null && offset !== null && line - offset >= 1 ? line - offset : undefined;
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
        window.parent.postMessage({ type: 'program_activity', active }, '*');
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
    window.requestAnimationFrame = (fn) => {
      const id = realRequestFrame((time) => {
        programWork.delete('f' + id);
        try { fn(time); } finally { workChanged(); }
      });
      programWork.add('f' + id);
      workChanged();
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      realCancelFrame(id);
      if (programWork.delete('f' + id)) workChanged();
    };

    // The MIDI output a program gets as \`out\` when it uses one without asking for it; MIDI
    // starts only when it first plays a note
    let defaultMidi = null;
    const defaultMidiOut = {
      send(data, time) {
        defaultMidi ??= navigator.requestMIDIAccess().then((access) => access.outputs.values().next().value);
        defaultMidi.then((output) => output && output.send(data, time)).catch(() => {});
      },
      play(data, time) { this.send(data, time); },
      playNote(data, time) { this.send(data, time); },
    };

    // Models call methods our objects don't have (out.playChord(), access.getOutputs(),
    // out.setTempo(90)). On the objects Chatty gives programs (MIDI access, outputs, out), a
    // missing method does what its name says: play-like names play, lookup-like names return
    // the output, anything else does nothing and returns the object (so chains keep going).
    // Every such call goes to the run log as "imagined".
    const PLAY_NAME = /^(?:play|note|send|trigger|hit|strike|sound|fire)|note|chord|drum|melody/i;
    const LOOKUP_NAME = /^(?:get|first|default|find|select|open|connect|output|port|synth|instrument)/i;
    // Names JavaScript itself asks for: a real answer (undefined), never a made-up method
    const PROTOCOL_NAMES = new Set(['then', 'catch', 'finally', 'toJSON', 'constructor', 'prototype', 'nodeType', 'valueOf', 'toString', 'asymmetricMatch', '$$typeof']);
    function imagined(text) {
      window.parent.postMessage({ type: 'imagined', id: currentExecId, text: String(text).slice(0, 200) }, '*');
    }
    function argText(args) {
      try { return args.map((a) => typeof a === 'function' ? 'fn' : JSON.stringify(a)).join(', '); } catch { return '…'; }
    }
    const forgivingCache = new WeakMap();
    function forgiving(target, name, output) {
      if (!target || (typeof target !== 'object' && typeof target !== 'function')) return target;
      if (forgivingCache.has(target)) return forgivingCache.get(target);
      const proxy = new Proxy(target, {
        get(obj, prop) {
          if (typeof prop === 'symbol' || PROTOCOL_NAMES.has(prop)) {
            const value = Reflect.get(obj, prop, obj);
            return typeof value === 'function' ? value.bind(obj) : value;
          }
          if (prop in obj) {
            const value = Reflect.get(obj, prop, obj);
            if (typeof value !== 'function') return prop === 'outputs' || prop === 'value' ? forgiving(value, name + '.' + prop, output) : value;
            return (...args) => {
              const result = value.apply(obj, args);
              // A lookup's result (the output, its iterator step) stays forgiving too
              return result && typeof result === 'object' && typeof result.then !== 'function' ? forgiving(result, name, output) : result;
            };
          }
          return (...args) => {
            imagined(name + '.' + prop + '(' + argText(args) + ')');
            const port = output?.() ?? (typeof obj.send === 'function' ? obj : null);
            if (PLAY_NAME.test(prop) && port) {
              if (Array.isArray(args[0])) port.send(args[0], args[1]);
              else port.send(args);
              return proxy;
            }
            if (LOOKUP_NAME.test(prop) && port) return forgiving(port, 'out', output);
            return proxy;
          };
        },
      });
      forgivingCache.set(target, proxy);
      return proxy;
    }
    const forgivingOut = forgiving(defaultMidiOut, 'out');

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
    // An id one slip from an id on the page ('startbutton' for 'startButton', 'start_btn' for
    // 'start-btn') means that element, not a new empty one
    function sameIdLetters(id) { return id.replace(/[-_]/g, '').toLowerCase(); }
    function oneEditApart(a, b) {
      if (Math.abs(a.length - b.length) > 1) return false;
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) ||
        (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
    }
    function slipOfId(id) {
      const ids = [...document.querySelectorAll('[id]')].map((el) => el.id).filter((other) => other && other !== 'root' && !placeholders.has(other));
      const same = ids.filter((other) => sameIdLetters(other) === sameIdLetters(id));
      if (same.length === 1) return same[0];
      if (id.length < 5) return null;
      const close = ids.filter((other) => oneEditApart(other.toLowerCase(), id.toLowerCase()));
      return close.length === 1 ? close[0] : null;
    }
    document.getElementById = (id) => {
      const found = findElementById(id);
      if (found || typeof id !== 'string' || !id) return found;
      const slip = slipOfId(id);
      if (slip) {
        imagined("getElementById('" + id + "') → '" + slip + "'");
        return findElementById(slip);
      }
      // An id that sounds like a canvas gets a real one, or getContext('2d') would fail on a div
      const isCanvas = /canvas/i.test(id);
      const made = document.createElement(isCanvas ? 'canvas' : 'div');
      if (isCanvas) {
        made.setAttribute('width', '400');
        made.setAttribute('height', '300');
      }
      made.id = id;
      document.body.appendChild(made);
      placeholders.set(id, made);
      return made;
    };

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
    const nativeAddListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
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
      value: (options) =>
        Promise.resolve(window.parent.__chattyMidi(options, () => performance.now())).then((access) => {
          const first = () => access.outputs.values().next().value;
          return forgiving(access, 'midiAccess', first);
        }),
    });

    // Whether the program has put anything on screen (canvas, svg, div, table, etc.)
    function hasVisualNow() {
      const rootEl = document.getElementById('root');
      return Boolean(rootEl && rootEl.childNodes.length > 0 && rootEl.innerHTML.trim().length > 0) ||
        Boolean(document.querySelector('canvas, svg, table, img, video, form, button, input, div:not(#root)')) ||
        Array.from(document.body.children).some(c => c !== rootEl && c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE');
    }

    // clear(): empties the card, so a program can start the screen over
    window.clear = () => {
      window.root.innerHTML = '';
      window.parent.postMessage({ type: 'clear' }, '*');
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
      window.parent.postMessage({ type: 'program_error', message: err ? (err.message || String(err)) : event.message, line: errorLine(err) }, '*');
    });
    window.addEventListener('unhandledrejection', (event) => {
      const err = event.reason;
      window.parent.postMessage({ type: 'program_error', message: err ? (err.message || String(err)) : 'Promise rejected', line: errorLine(err) }, '*');
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

      if (data.type !== 'execute') return;
      const { id, code } = data;
      currentExecId = id;
      // The names the music rule tells programs to declare (bpm, beat, start, out): a program
      // that forgets one gets a default instead of an error. Its own declarations win.
      window.bpm = 100;
      window.beat = 60000 / 100;
      window.start = performance.now() + 100;
      window.out = forgivingOut;
      // Programs that skip requestMIDIAccess and read this.outputs (this is the window) or
      // outputs directly get the synth through any lookup
      window.outputs = Object.assign(new Map([['synth', defaultMidiOut]]), {
        get: () => forgivingOut,
        has: () => true,
        0: forgivingOut,
        length: 1,
      });
      const logs = [];
      const origLog = console.log;
      const origWarn = console.warn;
      const origError = console.error;

      console.log = (...args) => logs.push(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
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

        window.parent.postMessage({
          type: 'result',
          id,
          success: true,
          output: out,
          logs,
          hasVisual: hasVisualElements,
        }, '*');
      } catch (err) {
        window.parent.postMessage({
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
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
        programWork.delete('run');
        workChanged();
      }
    });

    // Notify parent that iframe is ready
    window.parent.postMessage({ type: 'iframe_ready' }, '*');
  </script>
</body>
</html>`;

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

    if (data.type === 'imagined') {
      this.onRunLog?.('imagined', String(data.text ?? ''));
      return;
    }

    if (data.type === 'program_error') {
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
      iframe.contentWindow?.postMessage({ type: 'execute', id: reqId, code }, '*');
    });
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
