/**
 * Admission rule for everything here (and in method-hints.ts / property-check.ts): a repair or a
 * fact must be grounded in the language (the parser, scopes), the browser (its own names and
 * types) or Chatty's own helpers, never in what particular requests or test cases say. A
 * correction is made only when there is exactly one clear answer, and is logged; otherwise the
 * model gets the facts. Repairs that never fire on real failures (tests/replay) are removed.
 *
 * Smarter answers to the errors programs hit most. For each, either a correction Chatty can make
 * itself (exactly one clear match: a typo of a declared name, an element id one slip away from
 * an id on the page, a method's wrong case) or the facts the model is missing, for the fix
 * request: where a name really is declared, which ids the page has, what a value came from,
 * what was left open. Method names are in method-hints.ts.
 */
import { parse, tokenizer, type Node } from 'acorn';
import { parse as parseLoose } from 'acorn-loose';
import { sureMatch } from './fuzzy-match.ts';
import { analyse, bindingTypeOf, isReference, resolve } from './blank-fix.ts';
import { browserTypeWith, onlySendsLists, usedAs, valueUse } from './value-use.ts';
import { applyCorrection, argumentCountFact, memberKind, memberList, methodHint, missingConstructor, missingMethod, objectType, realMembers, relatedness, valueOfPath } from './method-hints.ts';
import { memberNames, writability } from './property-check.ts';
import { toneStepsOnly, withTransportStart } from './sound-setup.ts';

export interface ErrorHint {
  /** Facts for the fix request */
  text?: string;
  /** The program corrected without the model, and what was changed (for the run log). With `mustRunClean`, a test run must also pass without any error (the error being fixed was no thrown one, so "failed the same way" can't tell) */
  correction?: { code: string; note: string; mustRunClean?: boolean };
}

/** What the live page holds, read from the sandbox when the program failed */
export interface PageFacts {
  ids: string[];
  /** Ids the program looked up that never existed, and what stood in for each */
  standIns?: StandIn[];
  /** The page's own window: where the browser's types, and Tone and THREE when the page has them, are read from */
  scope?: Record<string, unknown>;
}

/** An id that never existed: an empty <div> made for it, or the element the program made last */
export interface StandIn {
  id: string;
  tag: string;
  made: 'empty' | 'last';
}

type AnyNode = Node & Record<string, unknown>;

const PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  locations: true,
} as const;

/** Whether a program parses as the page will read it */
export const parsesAsProgram = (code: string): boolean => tryParse(code) !== null;

function tryParse(code: string): AnyNode | null {
  try {
    return parse(code, PARSE_OPTIONS) as unknown as AnyNode;
  } catch {
    return null;
  }
}

/** Whether a line is a statement of JavaScript that does something (a call, an assignment, a declaration), not markup or words that happen to parse */
function looksLikeCode(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  const ast = tryParse(text);
  return !!ast && (ast.body as AnyNode[]).some((statement) => (statement.type === 'ExpressionStatement' ? /^(?:Call|Assignment|Update|Await)Expression$/.test((statement.expression as AnyNode).type) : !/^(?:Empty|Block)Statement$/.test(statement.type)));
}

/**
 * A reply cut off before its end (stopped for repeating itself, or at the output limit): the
 * unfinished last lines go and the blocks still open are closed, when that makes it parse. A
 * template string left open (markup the program was writing into the page) is closed first: it can
 * only run to the end of the program. Only for a program that fails in its last line, or inside such
 * a template; anything else is the fix's to judge.
 */
export function closeCutOff(code: string): { code: string; dropped: number; closed: number; template: boolean } | null {
  let inTemplate = false;
  try {
    parse(code, PARSE_OPTIONS);
    return null;
  } catch (err) {
    const pos = (err as { pos?: number }).pos;
    inTemplate = /^Unterminated template/.test((err as Error).message);
    // At the end, or inside its last line (a string or comment cut off there)
    if (!inTemplate && (typeof pos !== 'number' || code.slice(pos).trim().includes('\n'))) return null;
    // A template that runs on past lines of code (a closing backtick missing in the middle of the
    // program, not a reply cut off) can't be told from one cut off: the closing is the fix's to find
    if (inTemplate && typeof pos === 'number' && code.slice(pos).split('\n').slice(1).some(looksLikeCode)) return null;
  }
  const lines = code.replace(/\s+$/, '').split('\n');
  for (let dropped = 0; dropped <= 8 && dropped < lines.length; dropped++) {
    const kept = lines.slice(0, lines.length - dropped).join('\n');
    // (the template, when that is where it was cut: closed on a line of its own)
    for (const [ending, template] of [['', false], ['\n`;', true]] as const) {
      if (template && !inTemplate) continue;
      const text = kept + ending;
      const open: Array<{ label: string; callback: boolean }> = [];
      try {
        for (const token of tokenizer(text, PARSE_OPTIONS)) {
          const label = token.type.label;
          // A bracket that opens a call's callback (`setTimeout(() => {`, `list.forEach(function (x) {`) is closed
          // with its block: the cut was inside the function it holds
          if (label === '{' || label === '(' || label === '[' || label === '${') {
            const rest = text.slice(token.start);
            open.push({ label, callback: label === '(' && (/^\(\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/.test(rest) || /^\(\s*(?:async\s+)?function\b[^(){]*\([^()]*\)\s*\{/.test(rest)) });
          } else if (label === '}' || label === ')' || label === ']') open.pop();
        }
      } catch {
        continue; // cut inside a string or comment: another line goes, or the template is closed
      }
      // Only blocks (and the calls that hold a callback's block) are closed: a cut call or array
      // (`ctx.arc(100, 100`) loses its line instead
      if (open.some((o) => o.label !== '{' && !o.callback) || (open.length === 0 && !template)) continue;
      const closed = open.length ? `${text}\n${[...open].reverse().map((o) => (o.label === '{' ? '}' : ')')).join('\n')}` : text;
      if (tryParse(closed)) return { code: closed, dropped, closed: open.filter((o) => o.label === '{').length, template };
    }
  }
  return null;
}

/** Every node, with the functions it is inside (innermost last) */
function walk(node: AnyNode, visit: (node: AnyNode, functions: AnyNode[]) => void, functions: AnyNode[] = []): void {
  visit(node, functions);
  const inner = /Function/.test(node.type) ? [...functions, node] : functions;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child, visit, inner);
    } else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') {
      walk(value as AnyNode, visit, inner);
    }
  }
}

const lineOf = (node: AnyNode) => (node.loc as { start: { line: number } } | undefined)?.start.line ?? 0;
const nameOf = (fn: AnyNode | undefined) => ((fn?.id as AnyNode | undefined)?.name as string | undefined) ?? 'a function';

interface Declaration {
  name: string;
  line: number;
  /** The function it is declared in, or undefined for the program's top level */
  inside?: AnyNode;
  kind: 'function' | 'class' | 'variable' | 'parameter';
}

/** Every name the program declares: functions, classes, variables and parameters (catch's too) */
function declarations(ast: AnyNode): Declaration[] {
  const found: Declaration[] = [];
  const addPattern = (pattern: AnyNode, inside: AnyNode | undefined, kind: Declaration['kind']) => {
    walk(pattern, (node) => {
      if (node.type === 'Identifier') found.push({ name: node.name as string, line: lineOf(node), inside, kind });
    });
  };
  walk(ast, (node, functions) => {
    const inside = functions[functions.length - 1];
    if (node.type === 'FunctionDeclaration' && node.id) {
      found.push({ name: (node.id as AnyNode).name as string, line: lineOf(node), inside, kind: 'function' });
    }
    if (node.type === 'ClassDeclaration' && node.id) {
      found.push({ name: (node.id as AnyNode).name as string, line: lineOf(node), inside, kind: 'class' });
    }
    if (node.type === 'VariableDeclarator') addPattern(node.id as AnyNode, inside, 'variable');
    if (/Function/.test(node.type)) for (const param of node.params as AnyNode[]) addPattern(param, node, 'parameter');
    if (node.type === 'CatchClause' && node.param) addPattern(node.param as AnyNode, inside, 'parameter');
  });
  return found;
}

/** The one name that differs from the missing one only in letter case, or null */
function caseSlip(missing: string, names: string[]): string | null {
  const sameLetters = [...new Set(names)].filter((name) => name !== missing && name.toLowerCase() === missing.toLowerCase());
  return sameLetters.length === 1 ? sameLetters[0] : null;
}

/** The one name a missing one is surely a slip of, or null (a plural and its singular are a list and one of its items, not a slip: see fuzzy-match.ts) */
function slipOf(missing: string, names: string[]): string | null {
  return sureMatch(missing, names);
}

/**
 * The program with every reference to `from` that nothing declares renamed to `to` (by scope: a
 * property or key of that name, `ball.color`, and a declared `from` of another scope stay), or
 * null when the result doesn't parse
 */
function renameUndeclared(code: string, from: string, to: string): string | null {
  const tree = analyse(code);
  if (!tree) return null;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const node of tree.nodes as AnyNode[]) {
    if (node.type !== 'Identifier' || node.name !== from) continue;
    const parent = tree.parent.get(node);
    const shorthand = parent?.type === 'Property' && parent.shorthand && tree.key.get(node) === 'value' && !tree.bindings.has(node);
    if (!shorthand && !isReference(tree, node)) continue;
    if (resolve(tree, node, from)) continue;
    edits.push({ start: node.start, end: node.end, text: shorthand ? `${from}: ${to}` : to });
  }
  if (edits.length === 0) return null;
  let out = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return tryParse(out) ? out : null;
}

/** The references to `name` that nothing declares, each with every name its scope can see */
function undeclaredUses(tree: NonNullable<ReturnType<typeof analyse>>, name: string): Array<{ node: AnyNode; visible: string[] }> {
  const uses: Array<{ node: AnyNode; visible: string[] }> = [];
  for (const node of tree.nodes as AnyNode[]) {
    if (node.type !== 'Identifier' || node.name !== name || !isReference(tree, node) || resolve(tree, node, name)) continue;
    const visible: string[] = [];
    for (let at: AnyNode | undefined = node; at; at = tree.parent.get(at)) visible.push(...(tree.scopes.get(at) ?? []));
    uses.push({ node, visible });
  }
  return uses;
}

/**
 * Whether the program uses the missing name as the browser global `candidate` can be used: called
 * or constructed, it must be a function; a member read on it must be one the global has (for a
 * function, not one every function has: `data.length` is no use of Date). A `data` that is one
 * letter from `Date` is a name the program forgot to declare, not a slip of the global.
 */
function fitsGlobal(uses: Array<{ node: AnyNode }>, tree: NonNullable<ReturnType<typeof analyse>>, candidate: string): boolean {
  let value: unknown;
  try {
    value = (globalThis as unknown as Record<string, unknown>)[candidate];
  } catch {
    return false;
  }
  for (const { node } of uses) {
    const parent = tree.parent.get(node);
    const key = tree.key.get(node);
    if ((parent?.type === 'CallExpression' || parent?.type === 'NewExpression') && key === 'callee') {
      if (typeof value !== 'function') return false;
    } else if (parent?.type === 'MemberExpression' && key === 'object' && !parent.computed) {
      const member = (parent.property as AnyNode).name as string;
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
      try {
        if (!(member in (value as object)) || (typeof value === 'function' && member in Function.prototype)) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

const list = (all: string[], max = 10, names = [...new Set(all)]) => names.slice(0, max).join(', ') + (names.length > max ? ', …' : '');

/** The library the page has that a name is the file-ending form of (ToneJS, Tone.js, THREEjs), or undefined */
function libraryNamed(name: string, scope?: Record<string, unknown>): string | undefined {
  return ['Tone', 'THREE'].find((lib) => !!scope?.[lib] && name !== lib && name.replace(/\.?js$/i, '').toLowerCase() === lib.toLowerCase());
}

/**
 * The same name read off the window (`window.ToneJS.PolySynth`, `globalThis.THREEjs`), where it is
 * undefined and the read of what is inside it fails: the library the page has, by its name.
 */
function libraryOnWindow(code: string, error: string, page?: PageFacts): ErrorHint | null {
  if (!/Cannot read propert|is not a constructor|is not a function|is not an object/.test(error)) return null;
  const scope = page?.scope as Record<string, unknown> | undefined;
  const ast = tryParse(code);
  if (!scope || !ast) return null;
  const spans: Array<{ start: number; end: number; from: string; to: string }> = [];
  const declared = new Set(declarations(ast).map((d) => d.name));
  walk(ast, (node) => {
    if (node.type !== 'MemberExpression' || node.computed) return;
    const object = node.object as AnyNode;
    const name = (node.property as AnyNode).name as string | undefined;
    if (object.type !== 'Identifier' || !['window', 'globalThis', 'self'].includes(object.name as string) || !name) return;
    const library = libraryNamed(name, scope);
    if (library && scope[name] === undefined && !declared.has(object.name as string)) spans.push({ start: node.start, end: node.end, from: `${object.name}.${name}`, to: library });
  });
  if (spans.length === 0) return null;
  let out = code;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) out = out.slice(0, span.start) + span.to + out.slice(span.end);
  return tryParse(out) ? { correction: { code: out, note: `${[...new Set(spans.map((span) => `${span.from} → ${span.to}`))].join(', ')}: the library the page has` } } : null;
}

/** 1. "x is not defined" */
function notDefined(code: string, error: string, errorLine?: number, page?: PageFacts): ErrorHint | null {
  const name = error.match(/([A-Za-z_$][\w$]*) is not defined/)?.[1] ?? error.match(/Can't find variable: ([A-Za-z_$][\w$]*)/)?.[1];
  if (!name) return null;
  const ast = tryParse(code);
  if (!ast) return null;
  const declared = declarations(ast);
  const here = declared.filter((d) => d.name === name);
  if (here.length > 0) {
    const d = here[0];
    const where = d.inside ? `inside ${nameOf(d.inside)}() at line ${d.line}` : `at line ${d.line}`;
    return {
      text: `${name} is ${d.kind === 'parameter' ? 'a parameter' : 'declared'} ${where}${errorLine ? `, but line ${errorLine} is outside it` : ', but it is used outside it'}.`,
    };
  }
  if (name === 'require') {
    return { text: "require() loads Node packages, which the browser doesn't have: do what the package did with browser features and the ready-made helpers." };
  }
  const topLevel = declared.filter((d) => !d.inside || d.kind === 'function');
  // A slip of a declared name that the failing uses can see (not one inside another function),
  // or of a browser global (requestAnimationFrme) used as that global can be
  const tree = analyse(code);
  const uses = tree ? undeclaredUses(tree, name) : [];
  // A library's name with its file's ending (ToneJS, Tone.js, THREEjs): the library the page has, by that name
  const scope = page?.scope as Record<string, unknown> | undefined;
  const library = libraryNamed(name, scope);
  if (tree && uses.length > 0 && library) {
    const renamed = renameUndeclared(code, name, library);
    if (renamed) return { correction: { code: renamed, note: `${name} → ${library}: the library the page has` } };
  }
  if (tree && uses.length > 0) {
    const visible = [...new Set(uses.flatMap((use) => use.visible))];
    const slip = slipOf(name, visible) ?? [slipOf(name, Object.getOwnPropertyNames(globalThis))].find((global) => global && fitsGlobal(uses, tree, global));
    const renamed = slip ? renameUndeclared(code, name, slip) : null;
    if (slip && renamed) return { correction: { code: renamed, note: `${name} → ${slip}` } };
  }
  // What really exists to be meant: the program's own top-level functions, classes and variables from
  // its scopes, closest to the missing name first (then in the order declared), and Chatty's helpers
  const defined = topLevel
    .filter((d) => d.kind === 'function' || d.kind === 'class' || d.kind === 'variable')
    .map((d, order) => ({ label: d.kind === 'function' ? `${d.name}()` : d.name, name: d.name, order, score: relatedness(name, d.name) }))
    .filter((entry, i, all) => all.findIndex((other) => other.name === entry.name) === i)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const helpers = Object.entries(((page?.scope as { __chattyHelpers?: Record<string, unknown> } | undefined)?.__chattyHelpers ?? {}))
    .filter(([helper]) => !declared.some((d) => d.name === helper))
    .map(([helper, value]) => ({ label: typeof value === 'function' ? `${helper}()` : helper, score: relatedness(name, helper) }))
    .sort((a, b) => b.score - a.score);
  // An element on the page named like it (bill → #billInput): where its value is
  const standIns = new Set((page?.standIns ?? []).map((s) => s.id));
  const fields = (page?.ids ?? []).filter((id) => !standIns.has(id) && id.toLowerCase().replace(/[-_]/g, '').includes(name.toLowerCase()));
  const onPage = fields.length
    ? ` The page has ${fields.slice(0, 3).map((id) => `#${id} (document.getElementById('${id}').value)`).join(', ')}.`
    : '';
  // The fallback when no single name is meant: what the program defines, and what Chatty provides
  const shown = defined.slice(0, 8).map((d) => d.label);
  return {
    text: `${name} isn't defined${shown.length ? `; the program defines ${shown.join(', ')}${defined.length > 8 ? ', …' : ''}` : ''}.${helpers.length ? ` Chatty provides ${helpers.slice(0, 8).map((h) => h.label).join(', ')}.` : ''}${onPage}`,
  };
}

/** The ids a lookup asks for: getElementById('x'), querySelector('#x') */
const LOOKUP = /(?:getElementById\(\s*(['"`])([^'"`]+)\1|querySelector(?:All)?\(\s*(['"`])#([\w-]+)\3)/g;

/** 2. Reading a property of null or undefined */
function nothingThere(code: string, error: string, errorLine: number | undefined, page?: PageFacts): ErrorHint | null {
  const nullish =
    error.match(/Cannot read propert(?:y|ies) of (null|undefined)(?: \(reading '([^']+)'\))?/) ??
    error.match(/(null|undefined) is not an object \(evaluating '([^']+)'\)/) ??
    error.match(/Cannot set propert(?:y|ies) of (null|undefined)/);
  if (!nullish) return null;
  const lines = code.split('\n');
  const line = errorLine && errorLine <= lines.length ? lines[errorLine - 1] : '';
  // The value on that line, and the code that made it (its declaration)
  const evaluated = nullish[2] && nullish[2].includes('.') ? nullish[2].split('.').slice(0, -1).join('.') : '';
  const candidates = [evaluated, ...[...line.matchAll(/([A-Za-z_$][\w$]*)\s*(?:\.|\?\.)\s*[A-Za-z_$]/g)].map((m) => m[1])].filter(Boolean);
  const made = (name: string) => code.match(new RegExp(`(?:const|let|var)?\\s*\\b${name.replace(/\$/g, '\\$')}\\s*=(?![=>])\\s*([^;\\n]+)`))?.[1] ?? '';
  // Element lookups that found nothing: compare with the ids on the page
  const lookups = [line, ...candidates.map(made)].flatMap((text) => [...text.matchAll(LOOKUP)].map((m) => m[2] ?? m[4]));
  const ids = page?.ids ?? [];
  for (const id of lookups) {
    if (ids.includes(id)) continue;
    const slip = slipOf(id, ids);
    if (slip) {
      // Only where the id is looked up (not the same word in a class name or a message)
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const corrected = code.replace(new RegExp(`((?:getElementById\\(\\s*['"\`]|querySelector(?:All)?\\(\\s*['"\`]#))${escaped}(?=['"\`])`, 'g'), `$1${slip}`);
      if (corrected !== code) return { correction: { code: corrected, note: `id '${id}' → '${slip}'` } };
    }
    return {
      text: `No element has the id '${id}'${ids.length ? `: the page's ids are ${list(ids.map((i) => `'${i}'`))}` : ' (the page has no elements with ids)'}.`,
    };
  }
  // Otherwise: where the empty value came from
  for (const name of candidates) {
    const source = made(name);
    // A callback's parameter: plays.forEach(p => …) takes its values from plays
    const from = source || line.match(new RegExp(`([A-Za-z_$][\\w$.]*)\\.(?:forEach|map|filter|find)\\(\\s*\\(?\\s*${name}\\b`))?.[1] || '';
    if (!from) continue;
    const origin = source ? source : made(from) || from;
    const calls = [...origin.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
    for (const fn of calls) {
      const body = code.match(new RegExp(`function\\s+${fn}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
      if (body !== undefined && !/\breturn\s+[^;\s]/.test(body)) {
        return { text: `${name} is ${nullish[1]}: it comes from ${fn}(), which returns nothing.` };
      }
    }
    return { text: `${name} is ${nullish[1]} at line ${errorLine ?? '?'}: it comes from ${origin.trim().slice(0, 120)}.` };
  }
  return null;
}

/** 3. A syntax error at the end: what was left open */
function leftOpen(code: string, error: string): ErrorHint | null {
  if (!/Unexpected end of input|Unexpected EOF|Unterminated|missing \} |expected expression, got end of script/i.test(error)) return null;
  const stack: Array<{ char: string; line: number }> = [];
  const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
  try {
    for (const token of tokenizer(code, PARSE_OPTIONS)) {
      const label = token.type.label;
      const line = token.loc?.start.line ?? 0;
      if (label === '{' || label === '(' || label === '[' || label === '${') stack.push({ char: label === '${' ? '{' : label, line });
      else if (label === '}' || label === ')' || label === ']') {
        if (stack.length && stack[stack.length - 1].char === pairs[label]) stack.pop();
      }
    }
  } catch (err) {
    const message = String((err as Error).message);
    const line = (err as { loc?: { line?: number } }).loc?.line;
    if (/Unterminated template/.test(message)) return { text: `The \` template string opened at line ${line} is never closed.` };
    if (/Unterminated string/.test(message)) return { text: `The string at line ${line} is never closed.` };
    if (/Unterminated comment/.test(message)) return { text: `The /* comment at line ${line} is never closed.` };
  }
  const open = stack[stack.length - 1];
  if (!open) return null;
  return { text: `The ${open.char} opened at line ${open.line} is never closed: the program ends before it.` };
}

/** 4. A name used before its declaration (let/const/class) */
function tooEarly(code: string, error: string, errorLine?: number): ErrorHint | null {
  if (!/before initialization|uninitialized variable/i.test(error)) return null;
  const ast = tryParse(code);
  if (!ast) return null;
  const named = error.match(/access '([^']+)' before initialization/)?.[1];
  const declared = declarations(ast).filter((d) => d.kind === 'variable' || d.kind === 'class');
  const line = errorLine ? code.split('\n')[errorLine - 1] ?? '' : '';
  const suspects = named ? declared.filter((d) => d.name === named) : declared.filter((d) => errorLine && d.line > errorLine && new RegExp(`\\b${d.name}\\b`).test(line));
  const d = suspects[0];
  if (!d) return null;
  return { text: `${d.name} is declared at line ${d.line} but used${errorLine ? ` at line ${errorLine}` : ''}, before it.` };
}

/** The line the parser stops at, or 0 when the program parses */
function parseErrorLine(code: string): number {
  try {
    parse(code, PARSE_OPTIONS);
    return 0;
  } catch (err) {
    return (err as { loc?: { line?: number } }).loc?.line ?? -1;
  }
}

/** A repair of one line that gets the parser past it */
function repairLine(code: string, line: number, repair: (text: string) => string, note: string): ErrorHint | null {
  const lines = code.split('\n');
  if (!line || line > lines.length) return null;
  const fixed = repair(lines[line - 1]);
  if (fixed === lines[line - 1]) return null;
  const repaired = [...lines.slice(0, line - 1), fixed, ...lines.slice(line)].join('\n');
  const stop = parseErrorLine(repaired);
  return stop === 0 || stop > line ? { correction: { code: repaired, note } } : null;
}

/**
 * Object and declaration slips small models make, repaired by rule: `{ notes = 'C4' }` (= for :),
 * `{ notes: G major }` (words left unquoted), and a name declared twice
 */
/**
 * A program that doesn't parse only because one line ends in a stray character: a quote or
 * backtick (a reply's `speak("Done.");` with markdown's closing backtick kept), or a closing
 * ) or ] nothing opened (`speak("Done.");)`, or `colors[Math.floor(r * 5))]`, where the parser stops
 * at it). That character goes, when removing it alone makes the whole program parse. Quotes are tried
 * from the last line up, the first that works wins; a bracket is the one the parser itself stopped at.
 */
export function dropStrayCharacter(code: string): { code: string; line: number; removed: string } | null {
  let stopped: number | null = null;
  try {
    parse(code, PARSE_OPTIONS);
    return null;
  } catch (error) {
    stopped = typeof (error as { pos?: unknown }).pos === 'number' ? (error as { pos: number }).pos : null;
  }
  const lines = code.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].replace(/\s+$/, '');
    const last = text.slice(-1);
    if (!/[`'"]/.test(last) || (text.split(last).length - 1) % 2 === 0) continue;
    const candidate = [...lines.slice(0, i), text.slice(0, -1), ...lines.slice(i + 1)].join('\n');
    if (tryParse(candidate)) return { code: candidate, line: i + 1, removed: last };
  }
  // A closing ) or ] the parser met with nothing open, last on its line and right after a statement that is
  // complete (`speak("Done.");)`), or a ) typed twice (`colors[Math.floor(r * 5))]`: either one goes, and the
  // text is the same). A closer alone in the middle of a line may be a missing opener elsewhere (`a + b) * c`),
  // and a } is not taken: a missing { is as good an answer (a loop body without braces, its last line cut
  // loose), so there is no one answer
  const lineStart = stopped === null ? 0 : code.lastIndexOf('\n', stopped - 1) + 1;
  const typedTwice = stopped !== null && code[stopped] === ')' && code[stopped - 1] === ')';
  const endsStatement = stopped !== null && /;\s*$/.test(code.slice(lineStart, stopped)) && /^[ \t]*(?:\r?\n|$)/.test(code.slice(stopped + 1));
  if (stopped !== null && /[)\]]/.test(code[stopped] ?? '') && (typedTwice || endsStatement)) {
    const candidate = code.slice(0, stopped) + code.slice(stopped + 1);
    if (tryParse(candidate)) return { code: candidate, line: code.slice(0, stopped).split('\n').length, removed: code[stopped] };
  }
  return null;
}

/**
 * Statements written where an arrow function's body is an expression
 * (`items.map((item) => ctx.beginPath(); ctx.arc(…); ctx.fill();)`): the parser stops at the first
 * `;`. The statements are the body the model meant, so they go in braces, up to the bracket that
 * closes the call. Only where that bracket is a `)` with no comma of its own before it (a second
 * argument would be unclear), one arrow at a time until the program parses; a program that still
 * doesn't parse is left as it was. The lines of the arrows wrapped are returned.
 */
export function wrapBracelessArrows(code: string): { code: string; lines: number[] } | null {
  let current = code;
  const lines: number[] = [];
  for (let pass = 0; pass < 12; pass++) {
    let stopped: number | null = null;
    try {
      parse(current, PARSE_OPTIONS);
      return lines.length ? { code: current, lines } : null;
    } catch (error) {
      stopped = typeof (error as { pos?: unknown }).pos === 'number' ? (error as { pos: number }).pos : null;
    }
    if (stopped === null || current[stopped] !== ';') return null;
    let tokens: Array<{ type: { label: string }; start: number; end: number }>;
    try {
      tokens = [...tokenizer(current, { ecmaVersion: 'latest' })] as unknown as typeof tokens;
    } catch {
      return null;
    }
    // The last arrow before the stop, whose body does not begin with a block
    let arrow = -1;
    for (let i = 0; i < tokens.length && tokens[i].end <= stopped; i++) if (tokens[i].type.label === '=>') arrow = i;
    if (arrow < 0 || !tokens[arrow + 1] || tokens[arrow + 1].type.label === '{' || tokens[arrow + 1].start > stopped) return null;
    let depth = 0;
    let close = -1;
    for (let i = arrow + 1; i < tokens.length; i++) {
      const label = tokens[i].type.label;
      if (label === '(' || label === '[' || label === '{' || label === '${') depth++;
      else if (label === ')' || label === ']' || label === '}') {
        if (depth === 0) {
          close = label === ')' ? tokens[i].start : -1;
          break;
        }
        depth--;
      } else if (label === ',' && depth === 0) return null;
    }
    if (close < 0 || close < stopped) return null;
    const body = current.slice(tokens[arrow].end, close);
    // A statement that is only a number, a string or a name is a comma that became a semicolon
    // (`setTimeout(() => speak("hi"); 1000)`: the 1000 was the delay): the arrow is not the slip
    const statements = (tryParse(body) as unknown as { body?: AnyNode[] } | null)?.body ?? [];
    if (statements.some((statement) => statement.type === 'ExpressionStatement' && ['Literal', 'Identifier'].includes((statement.expression as AnyNode).type))) return null;
    const tail = body.match(/\s*$/)![0];
    lines.push(current.slice(0, tokens[arrow].end).split('\n').length);
    current = `${current.slice(0, tokens[arrow].end)} {${body.slice(0, body.length - tail.length)} }${tail}${current.slice(close)}`;
  }
  return null;
}

/**
 * A statement that is only a template literal with no placeholder (`` `ctx.fillStyle = "red";` ``)
 * does nothing, whatever it says: a line of code written inside backticks, as markdown's inline
 * code is. When its text is code (it parses and has an assignment or a call in it), the backticks
 * go and it is the statement it was meant to be. The lines of the statements unwrapped are
 * returned; the result must parse.
 */
export function unwrapBackticks(code: string): { code: string; lines: number[] } | null {
  const ast = tryParse(code);
  if (!ast) return null;
  // The literals of a statement made only of them: one, or several on lines after each other with no
  // semicolon, which the parser reads as one tagged template (`a` `b` calls "a" with "b")
  const literals = (expression: AnyNode): AnyNode[] | null => {
    if (expression.type === 'TemplateLiteral') return (expression.expressions as AnyNode[]).length === 0 ? [expression] : null;
    if (expression.type !== 'TaggedTemplateExpression') return null;
    const before = literals(expression.tag as AnyNode);
    const quasi = literals(expression.quasi as AnyNode);
    return before && quasi ? [...before, ...quasi] : null;
  };
  const edits: Array<{ start: number; end: number; text: string; lines: number[] }> = [];
  walk(ast, (node) => {
    if (node.type !== 'ExpressionStatement') return;
    const found = literals(node.expression as AnyNode);
    if (!found) return;
    // Each as written between its backticks (an escape stays as it was): code, or the statement is left alone
    const texts = found.map((literal) => code.slice(literal.start + 1, literal.end - 1).trim());
    // (text that parses only as a label, `Example: greet("Bob")`, is a sentence with a colon, not code)
    const code_ = (text: string) => {
      const parsed = text && /[=(]/.test(text) ? (tryParse(text) as unknown as { body?: AnyNode[] } | null) : null;
      return !!parsed && !(parsed.body ?? []).some((statement) => statement.type === 'LabeledStatement');
    };
    if (!texts.every(code_)) return;
    edits.push({
      start: node.start,
      end: node.end,
      text: texts.map((text) => (/[;}]\s*$/.test(text) ? text : `${text};`)).join(`\n${code.slice(code.lastIndexOf('\n', node.start - 1) + 1, node.start).match(/^\s*/)![0]}`),
      lines: found.map(lineOf),
    });
  });
  if (edits.length === 0) return null;
  let fixed = code;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) fixed = fixed.slice(0, edit.start) + edit.text + fixed.slice(edit.end);
  return tryParse(fixed) ? { code: fixed, lines: edits.flatMap((edit) => edit.lines).sort((a, b) => a - b) } : null;
}

/**
 * Tone's note values written without quotes: `8n` is a BigInt literal (it parses, and Tone gets a BigInt
 * where it wants the text "8n"), and `1m`, `4t` and the dotted `8n.` are syntax errors. In a program that
 * uses Tone, such a number in code (not in a string or a comment) becomes the string: "8n", "1m", "4t",
 * "8n.". A plain `n` only for the note values a BigInt is never meant for (1, 2, 4, 8, 16, 32, 64), so a real
 * BigInt (`10n ** 20n`) stays. The result must parse.
 */
export function quoteToneTimes(code: string): { code: string; quoted: string[] } | null {
  if (!/\bTone\b/.test(code) || !/\d[nmt]/.test(code)) return null;
  // Which characters are code: not inside a string, a template's text, a comment
  const inCode = new Array<boolean>(code.length).fill(true);
  const mark = (from: number, to: number) => inCode.fill(false, from, to);
  const braces: number[] = [];
  let at = 0;
  while (at < code.length) {
    const c = code[at];
    if (c === '/' && code[at + 1] === '/') {
      const end = code.indexOf('\n', at);
      const stop = end < 0 ? code.length : end;
      mark(at, stop);
      at = stop;
    } else if (c === '/' && code[at + 1] === '*') {
      const end = code.indexOf('*/', at + 2);
      const stop = end < 0 ? code.length : end + 2;
      mark(at, stop);
      at = stop;
    } else if (c === '"' || c === "'") {
      let i = at + 1;
      while (i < code.length && code[i] !== c && code[i] !== '\n') i += code[i] === '\\' ? 2 : 1;
      mark(at, Math.min(i + 1, code.length));
      at = i + 1;
    } else if (c === '`' || (c === '}' && braces.length && braces[braces.length - 1] === 0)) {
      // A template's text, up to its closing backtick or the next ${
      if (c === '}') braces.pop();
      let i = at + 1;
      while (i < code.length && code[i] !== '`' && !(code[i] === '$' && code[i + 1] === '{')) i += code[i] === '\\' ? 2 : 1;
      if (code[i] === '$') {
        mark(at, i + 2);
        braces.push(0);
        at = i + 2;
      } else {
        mark(at, Math.min(i + 1, code.length));
        at = i + 1;
      }
    } else {
      if (c === '{' && braces.length) braces.push(1);
      else if (c === '}' && braces.length) braces.pop();
      at++;
    }
  }
  const quoted: string[] = [];
  const fixed = code.replace(/(?<![\w$.])(\d+)([nmt])(\.)?(?![\w$])/g, (whole, digits: string, unit: string, dot: string | undefined, offset: number) => {
    if (!inCode[offset]) return whole;
    if (unit === 'n' && !dot && !['1', '2', '4', '8', '16', '32', '64'].includes(digits)) return whole;
    if (unit !== 'n' && dot) return whole;
    quoted.push(whole);
    return JSON.stringify(whole);
  });
  return quoted.length > 0 && fixed !== code && tryParse(fixed) ? { code: fixed, quoted: [...new Set(quoted)] } : null;
}

/**
 * A declaration whose value nothing reads, made with new by a class the library does not have
 * (`const melody = new Tone.Melody();` where Tone has no Melody and `melody` is named nowhere else): its
 * only effect is to throw, so it is taken out. The error names the member; the object is one the page really
 * has, without that member; the arguments make nothing happen (no calls, no assignments); and the name is
 * in the program nowhere but the declaration. The result must parse.
 */
export function dropUnusedFailingDeclaration(code: string, error: string, scope?: Record<string, unknown>): ErrorHint | null {
  const missing = missingConstructor(error) ?? missingMethod(error);
  if (!missing || !scope) return null;
  const real = realMembers(code, missing.object, scope);
  if (!real || real.members.some((m) => m.name === missing.method)) return null;
  // (a slip of a real member is corrected, not cut out)
  if (methodHint(code, error, scope)?.correction) return null;
  const ast = tryParse(code);
  if (!ast) return null;
  const pure = (node: AnyNode): boolean => {
    let ok = true;
    walk(node, (inner) => {
      if (/^(?:CallExpression|NewExpression|AssignmentExpression|UpdateExpression|AwaitExpression|YieldExpression|TaggedTemplateExpression)$/.test(inner.type)) ok = false;
    });
    return ok;
  };
  const cuts: Array<{ start: number; end: number; name: string }> = [];
  walk(ast, (node) => {
    if (node.type !== 'VariableDeclaration' || (node.declarations as AnyNode[]).length !== 1) return;
    const declarator = (node.declarations as AnyNode[])[0];
    const init = declarator.init as AnyNode | null;
    // (a `new` only makes an object that does nothing until it is used; a call may be the very thing asked for)
    if ((declarator.id as AnyNode).type !== 'Identifier' || init?.type !== 'NewExpression') return;
    const callee = init.callee as AnyNode;
    if (callee.type !== 'MemberExpression' || callee.computed || code.slice((callee.object as AnyNode).start, (callee.object as AnyNode).end) !== missing.object || (callee.property as AnyNode).name !== missing.method) return;
    if (!(init.arguments as AnyNode[]).every(pure)) return;
    cuts.push({ start: node.start, end: node.end, name: (declarator.id as AnyNode).name as string });
  });
  if (cuts.length === 0) return null;
  let fixed = code;
  const removed: string[] = [];
  for (const cut of cuts.sort((a, b) => b.start - a.start)) {
    const rest = fixed.slice(0, cut.start) + fixed.slice(cut.end);
    // Named anywhere else (a read, a handler string, a shadowing name): not unused
    if (new RegExp(`(?<![\\w$.])${cut.name.replace(/\$/g, '\\$')}(?![\\w$])`).test(rest)) continue;
    const lineStart = fixed.lastIndexOf('\n', cut.start - 1) + 1;
    const alone = /^[ \t]*$/.test(fixed.slice(lineStart, cut.start)) ? lineStart : cut.start;
    fixed = fixed.slice(0, alone) + fixed.slice(cut.end).replace(/^[ \t]*\n?/, alone === lineStart ? '' : '$&');
    removed.push(cut.name);
  }
  return removed.length > 0 && fixed.trim() && tryParse(fixed) ? { correction: { code: fixed, note: `${removed.join(', ')} (made by ${missing.object}.${missing.method}, which ${missing.object} does not have, and read nowhere) → declaration removed` } } : null;
}

/**
 * Values a program sets and never reads, that look like input to a drawing: a color (`oceanColor = '#4b0082'`, when the
 * browser says it is one), a number, or a list of points. From the parser's scopes: a name that is only ever written
 * (declared with the value, or assigned it) and named nowhere else in the program. At most three, in the order set.
 */
export function unusedDrawingValues(code: string, isColor: (value: string) => boolean): string[] {
  const tree = analyse(code);
  if (!tree) return [];
  const looksLikeDrawingInput = (value: AnyNode | null | undefined): boolean => {
    if (!value) return false;
    if (value.type === 'Literal') return (typeof value.value === 'string' && isColor(value.value as string)) || (typeof value.value === 'number' && Number.isFinite(value.value));
    if (value.type === 'UnaryExpression' && value.operator === '-') return looksLikeDrawingInput(value.argument as AnyNode);
    if (value.type === 'ArrayExpression') {
      const items = (value.elements as Array<AnyNode | null>).filter(Boolean) as AnyNode[];
      return items.length > 0 && items.every((item) => item.type === 'ArrayExpression' || item.type === 'ObjectExpression' || looksLikeDrawingInput(item));
    }
    return false;
  };
  const set = new Map<string, number>();
  for (const node of tree.nodes) {
    if (node.type === 'VariableDeclarator' && (node.id as AnyNode).type === 'Identifier' && looksLikeDrawingInput(node.init as AnyNode | null)) {
      if (!set.has((node.id as AnyNode).name as string)) set.set((node.id as AnyNode).name as string, node.start);
    } else if (node.type === 'AssignmentExpression' && node.operator === '=' && (node.left as AnyNode).type === 'Identifier' && looksLikeDrawingInput(node.right as AnyNode)) {
      if (!set.has((node.left as AnyNode).name as string)) set.set((node.left as AnyNode).name as string, node.start);
    }
  }
  const unused: string[] = [];
  for (const [name] of [...set].sort((a, b) => a[1] - b[1])) {
    const read = tree.nodes.some((node) => {
      if (node.type !== 'Identifier' || node.name !== name) return false;
      const parent = tree.parent.get(node);
      // The declaration's own name, and the left of a plain assignment, only write it
      if (tree.bindings.has(node)) return false;
      if (parent?.type === 'AssignmentExpression' && parent.left === node && parent.operator === '=') return false;
      return isReference(tree, node) || (parent?.type === 'Property' && !!parent.shorthand);
    });
    // (named in a string, a handler or a template)
    const written = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
    const mentions = [...code.matchAll(written)].length;
    const writes = tree.nodes.filter((node) => node.type === 'Identifier' && node.name === name && (tree.bindings.has(node) || (tree.parent.get(node)?.type === 'AssignmentExpression' && (tree.parent.get(node) as AnyNode).left === node))).length;
    if (!read && mentions <= writes) unused.push(name);
  }
  return unused.slice(0, 3);
}

/** Canvas 2D (and renderer) calls that put something on screen: a function making them is a frame's drawing */
const DRAWING_CALLS = new Set(['clearRect', 'fillRect', 'strokeRect', 'arc', 'ellipse', 'fillText', 'strokeText', 'drawImage', 'fill', 'stroke', 'render']);

/**
 * A frame loop that does no work beside the one drawing function nothing calls:
 * `function start() { if (ok) requestAnimationFrame(start); }` next to `function animate() { ctx.clearRect(…);
 * … }` runs every frame and shows the screen as it was. The loop was meant to run the drawing: its call is
 * put first in the loop, so each frame draws. Only with exactly one such loop (a top-level function whose
 * only calls are the request for its own next frame) and exactly one top-level function with no parameters
 * that makes drawing calls and is mentioned nowhere else (not called, passed, or named in a handler string);
 * anything else is the program's own plan. Kept only when the result parses.
 */
export function callFromFrameLoop(code: string): { code: string; loop: string; called: string } | null {
  const ast = tryParse(code);
  if (!ast) return null;
  const functions = new Map<string, AnyNode>();
  for (const statement of ast.body as AnyNode[]) {
    if (statement.type === 'FunctionDeclaration' && statement.id) functions.set((statement.id as AnyNode).name as string, statement);
    if (statement.type === 'VariableDeclaration') {
      for (const d of statement.declarations as AnyNode[]) {
        const init = d.init as AnyNode | null;
        if ((d.id as AnyNode).type === 'Identifier' && (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression')) functions.set((d.id as AnyNode).name as string, init);
      }
    }
  }
  const calls = (fn: AnyNode) => {
    const found: AnyNode[] = [];
    walk(fn.body as AnyNode, (node) => node.type === 'CallExpression' && found.push(node));
    return found;
  };
  const calleeName = (call: AnyNode) => {
    const callee = call.callee as AnyNode;
    return callee.type === 'Identifier' ? (callee.name as string) : callee.type === 'MemberExpression' && !callee.computed ? ((callee.property as AnyNode).name as string) : '';
  };
  const loops: string[] = [];
  const drawers: string[] = [];
  for (const [name, fn] of functions) {
    if ((fn.body as AnyNode).type !== 'BlockStatement') continue;
    const made = calls(fn);
    const nextFrame = (call: AnyNode) => calleeName(call) === 'requestAnimationFrame' && (call.arguments as AnyNode[])[0]?.type === 'Identifier' && ((call.arguments as AnyNode[])[0].name as string) === name;
    if (made.length > 0 && made.every(nextFrame)) loops.push(name);
    else if ((fn.params as AnyNode[]).length === 0 && made.some((call) => DRAWING_CALLS.has(calleeName(call)))) drawers.push(name);
  }
  if (loops.length !== 1) return null;
  const mentioned = (name: string) => {
    let count = 0;
    const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`);
    walk(ast, (node) => {
      if (node.type === 'Identifier' && node.name === name) count++;
      else if (node.type === 'Literal' && typeof node.value === 'string' && call.test(node.value)) count++;
      else if (node.type === 'TemplateElement' && call.test(String((node.value as { raw?: string }).raw ?? ''))) count++;
    });
    return count;
  };
  // (the declaration names it once: any other mention is a call or a handing over)
  const orphans = drawers.filter((name) => mentioned(name) === 1);
  if (orphans.length !== 1) return null;
  const loop = functions.get(loops[0])!;
  const body = loop.body as AnyNode;
  const fixed = `${code.slice(0, body.start + 1)} ${orphans[0]}();${code.slice(body.start + 1)}`;
  return tryParse(fixed) ? { code: fixed, loop: loops[0], called: orphans[0] } : null;
}

/**
 * A function that calls itself as a plain statement, with nothing before it that can leave the
 * function (no return or throw in it), recurses until the stack is gone. When it also hands
 * itself to requestAnimationFrame, setTimeout or setInterval (an animation loop), that call
 * already repeats it, and the direct call is the slip: `function animate() { …;
 * requestAnimationFrame(animate); … animate(); }` made thousands of elements before the browser
 * stopped it. The direct call goes. Kept only when the result parses.
 */
export function dropEndlessSelfCalls(code: string): { code: string; dropped: string[] } {
  const ast = tryParse(code);
  if (!ast) return { code, dropped: [] };
  const cuts: Array<{ start: number; end: number }> = [];
  const dropped: string[] = [];
  // The function's own statements, not those of the functions inside it
  const within = (node: AnyNode, visit: (node: AnyNode) => void) => {
    visit(node);
    for (const value of Object.values(node)) {
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (child && typeof child === 'object' && typeof (child as AnyNode).type === 'string' && !/Function/.test((child as AnyNode).type)) within(child as AnyNode, visit);
      }
    }
  };
  const check = (name: string, fn: AnyNode) => {
    const body = fn.body as AnyNode;
    if (body.type !== 'BlockStatement') return;
    let leaves = false;
    let scheduled = false;
    within(body, (node) => {
      if (node.type === 'ReturnStatement' || node.type === 'ThrowStatement') leaves = true;
    });
    // (the scheduling call may sit in a callback inside it: setTimeout(() => loop(), 10) is not what is looked for, only the function itself handed over)
    walk(body, (node) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as AnyNode;
      const scheduler = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' && !callee.computed ? (callee.property as AnyNode).name : null;
      if (['requestAnimationFrame', 'setTimeout', 'setInterval'].includes(scheduler as string) && (node.arguments as AnyNode[])[0]?.type === 'Identifier' && ((node.arguments as AnyNode[])[0].name as string) === name) scheduled = true;
    });
    if (leaves || !scheduled) return;
    for (const statement of body.body as AnyNode[]) {
      const call = statement.type === 'ExpressionStatement' ? (statement.expression as AnyNode) : null;
      if (call?.type === 'CallExpression' && (call.callee as AnyNode).type === 'Identifier' && (call.callee as AnyNode).name === name) {
        cuts.push({ start: statement.start, end: statement.end });
        dropped.push(name);
      }
    }
  };
  walk(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) check((node.id as AnyNode).name as string, node);
    if (node.type === 'VariableDeclarator' && (node.id as AnyNode).type === 'Identifier' && /^(?:Arrow)?FunctionExpression$/.test(((node.init as AnyNode | null)?.type as string) ?? '')) {
      check((node.id as AnyNode).name as string, node.init as AnyNode);
    }
  });
  if (cuts.length === 0) return { code, dropped: [] };
  let fixed = code;
  for (const cut of cuts.sort((a, b) => b.start - a.start)) fixed = fixed.slice(0, cut.start) + fixed.slice(cut.end);
  return tryParse(fixed) ? { code: fixed, dropped: [...new Set(dropped)] } : { code, dropped: [] };
}

/**
 * A language label left in the code (`javascript` on a line of its own, from a fence's ```javascript
 * once the fence was taken away): a statement that is only that name reads a variable nobody made,
 * which stops the program. When nothing in the program declares it, the line goes. Lines of the
 * statement are kept (it is replaced by nothing, not removed), so line numbers hold.
 */
export function dropFenceLabels(code: string): { code: string; labels: string[] } {
  const tree = analyse(code);
  if (!tree) return { code, labels: [] };
  const cuts: Array<{ start: number; end: number }> = [];
  const labels: string[] = [];
  for (const statement of (tree.ast.body as AnyNode[]) ?? []) {
    const expression = statement.type === 'ExpressionStatement' ? (statement.expression as AnyNode) : null;
    if (expression?.type !== 'Identifier' || !/^(?:javascript|js|jsx|typescript|ts|html|css|json)$/.test(expression.name as string)) continue;
    if (resolve(tree, expression, expression.name as string) !== null || (expression.name as string) in globalThis) continue;
    cuts.push({ start: statement.start, end: statement.end });
    labels.push(expression.name as string);
  }
  if (cuts.length === 0) return { code, labels: [] };
  let fixed = code;
  for (const cut of cuts.sort((a, b) => b.start - a.start)) fixed = fixed.slice(0, cut.start) + fixed.slice(cut.end);
  return tryParse(fixed) ? { code: fixed, labels } : { code, labels: [] };
}

/**
 * A speak() that says the user's own request back (speak("Hi! Show a big ten second countdown on
 * screen.") for that request), in a program that does something else too: it tells the user what
 * they just said, and the page reads it aloud (once for every run of the program). Taken out when
 * the words of its text are the request's words (a greeting in front aside), the request is three
 * words or more (a greeting answered with a greeting is an answer), nothing declares speak itself,
 * and something else is left in the program. Lines of the statement are kept (replaced by nothing),
 * so line numbers hold.
 */
export function dropRequestEcho(code: string, request: string): { code: string; dropped: number } {
  const words = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/^(?:(?:hi|hello|hey|sure|okay|ok|alright|certainly|of course)\b\s*)+/, '');
  const asked = words(request);
  if (asked.split(' ').length < 3) return { code, dropped: 0 };
  const tree = analyse(code);
  if (!tree) return { code, dropped: 0 };
  const cuts: Array<{ start: number; end: number }> = [];
  walk(tree.ast, (node) => {
    if (node.type !== 'Program' && node.type !== 'BlockStatement') return;
    for (const statement of node.body as AnyNode[]) {
      const call = statement.type === 'ExpressionStatement' ? (statement.expression as AnyNode) : null;
      const callee = call?.type === 'CallExpression' ? (call.callee as AnyNode) : null;
      const args = (call?.arguments as AnyNode[] | undefined) ?? [];
      if (callee?.type !== 'Identifier' || callee.name !== 'speak' || args.length !== 1 || resolve(tree, callee, 'speak') !== null) continue;
      const arg = args[0];
      const text = arg.type === 'Literal' && typeof arg.value === 'string' ? arg.value : arg.type === 'TemplateLiteral' && (arg.expressions as AnyNode[]).length === 0 ? ((arg.quasis as AnyNode[])[0].value as { cooked: string }).cooked : null;
      if (text !== null && words(text) === asked) cuts.push({ start: statement.start, end: statement.end });
    }
  });
  if (cuts.length === 0) return { code, dropped: 0 };
  let fixed = code;
  for (const cut of cuts.sort((a, b) => b.start - a.start)) fixed = fixed.slice(0, cut.start) + fixed.slice(cut.end);
  const rest = tryParse(fixed);
  return rest && (rest.body as AnyNode[]).length > 0 ? { code: fixed, dropped: cuts.length } : { code, dropped: 0 };
}

/**
 * `a && b = c` (and `||`, `??`): a logical expression cannot be assigned to, and the browser stops
 * the whole program with "Invalid left-hand side in assignment". There is one reading that parses:
 * the assignment is the last operand's, `a && (b = c)`. Only when the parser's own error names that
 * left side, its last operand is something that can be assigned to (a name or a member), and the
 * program parses once the assignment is wrapped. Repeated for every such statement.
 */
export function wrapLogicalAssignment(code: string): { code: string; lines: number[] } | null {
  let current = code;
  const lines: number[] = [];
  for (let round = 0; round < 8; round++) {
    let failure: { pos?: number; raisedAt?: number; message: string } | null = null;
    try {
      parse(current, PARSE_OPTIONS);
      break;
    } catch (err) {
      failure = err as { pos?: number; raisedAt?: number; message: string };
    }
    if (!/^Assigning to rvalue/.test(failure.message) || typeof failure.pos !== 'number' || typeof failure.raisedAt !== 'number') break;
    // The left side runs from where the error starts to the `=` it stopped after
    const start = failure.pos;
    const equals = failure.raisedAt - 1;
    if (current[equals] !== '=') break;
    let left: AnyNode;
    try {
      left = (parse(`(${current.slice(start, equals)})`, PARSE_OPTIONS) as unknown as { body: AnyNode[] }).body[0].expression as AnyNode;
    } catch {
      break;
    }
    if (left.type !== 'LogicalExpression') break;
    let target = left;
    while (target.type === 'LogicalExpression') target = target.right as AnyNode;
    if (target.type !== 'Identifier' && !(target.type === 'MemberExpression' && !target.optional)) break;
    const targetStart = start + (target.start - 1);
    // The right side of the `=` ends at the statement's `;`, at the bracket that closes the block it is in,
    // or at the end of its line: the first of these that makes the program parse
    const ends: number[] = [];
    let depth = 0;
    let previousLine = -1;
    let previousEnd = equals + 1;
    try {
      for (const token of tokenizer(current.slice(equals + 1), { ...PARSE_OPTIONS, locations: true })) {
        const label = token.type.label;
        const at = equals + 1 + token.start;
        if (label === 'eof') {
          if (!ends.includes(previousEnd)) ends.push(previousEnd);
          break;
        }
        if (previousLine !== -1 && token.loc && token.loc.start.line > previousLine && depth === 0 && !ends.includes(previousEnd)) ends.push(previousEnd);
        if (label === ';' && depth === 0) {
          ends.push(equals + 1 + token.start);
          break;
        }
        if (/^[{([]$|^\$\{$/.test(label)) depth++;
        else if (/^[})\]]$/.test(label)) {
          depth--;
          if (depth < 0) {
            ends.push(at);
            break;
          }
        }
        previousLine = token.loc ? token.loc.end.line : -1;
        previousEnd = equals + 1 + token.end;
      }
      // (the program ended with it: no `;` and no closing bracket came)
      if (ends.length === 0 && previousEnd > equals + 1) ends.push(previousEnd);
    } catch {
      // the rest of the program doesn't tokenize
    }
    let wrapped: string | null = null;
    for (const raw of ends) {
      let end = raw;
      while (end > equals + 1 && /\s/.test(current[end - 1])) end--;
      const candidate = `${current.slice(0, targetStart)}(${current.slice(targetStart, end)})${current.slice(end)}`;
      try {
        parse(candidate, PARSE_OPTIONS);
        wrapped = candidate;
        break;
      } catch (err) {
        // (a later statement with the same slip is the next round's: only an error past this one is let through)
        const later = err as { message: string; pos?: number };
        if (/^Assigning to rvalue/.test(later.message) && typeof later.pos === 'number' && later.pos > end) {
          wrapped = candidate;
          break;
        }
      }
    }
    // (a later statement may still have its own slip: the program as it is now goes on being read)
    if (wrapped === null) {
      if (lines.length === 0) return null;
      break;
    }
    lines.push(current.slice(0, start).split('\n').length);
    current = wrapped;
  }
  return lines.length > 0 && tryParse(current) ? { code: current, lines } : null;
}

/**
 * `return` alone on its line, the value on the lines after it: the browser ends the statement after
 * `return` (automatic semicolon insertion), so the function returns nothing and the value is dead
 * code. A `return` with no semicolon and no value that is directly followed, in the same block, by
 * an expression statement is `return (` that expression `)`, on the lines it was on. A `return;` (the
 * author ended it), and a `return` followed by anything that can still run (a declaration, a
 * function, a statement), are left as they are. Kept only when the result parses.
 */
export function joinSplitReturn(code: string): { code: string; lines: number[] } | null {
  const ast = tryParse(code);
  if (!ast) return null;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const lines: number[] = [];
  walk(ast, (node) => {
    if (node.type !== 'Program' && node.type !== 'BlockStatement') return;
    const body = node.body as AnyNode[];
    body.forEach((statement, i) => {
      const next = body[i + 1];
      if (statement.type !== 'ReturnStatement' || statement.argument || !next || next.type !== 'ExpressionStatement') return;
      // Only the bare keyword (an ASI return): `return;` was written on purpose
      if (code.slice(statement.start, statement.end).trim() !== 'return') return;
      const value = code.slice(next.start, next.end).replace(/;\s*$/, '');
      edits.push({ start: statement.start, end: next.end, text: `return (${code.slice(statement.end, next.start)}${value})${/;\s*$/.test(code.slice(next.start, next.end)) ? ';' : ''}` });
      lines.push(lineOf(statement));
    });
  });
  if (edits.length === 0) return null;
  let fixed = code;
  for (const edit of edits.sort((a, b) => b.start - a.start)) fixed = fixed.slice(0, edit.start) + edit.text + fixed.slice(edit.end);
  return tryParse(fixed) ? { code: fixed, lines: lines.sort((a, b) => a - b) } : null;
}

/**
 * A class used before its declaration at the top of the program: `const game = new Game();` above
 * `class Game {…}` stops with "Cannot access 'Game' before initialization", since classes (unlike
 * functions) are not hoisted. The top-level class declaration moves above the first top-level
 * statement that uses it (a use inside a function runs later and is no reason). Only when what runs
 * as soon as the class is made or first constructed (its extends clause, static blocks, field
 * initializers, computed keys and constructor) reads no name declared between the new place and the
 * old one: the move could not be told from the author's own order, and would only move the error.
 * Kept only when the result parses.
 */
export function moveClassesUp(code: string): { code: string; names: string[] } | null {
  let current = code;
  const names: string[] = [];
  for (let round = 0; round < 6; round++) {
    const moved = moveOneClassUp(current);
    if (!moved) break;
    current = moved.code;
    names.push(moved.name);
  }
  return names.length > 0 ? { code: current, names } : null;
}

function moveOneClassUp(code: string): { code: string; name: string } | null {
  const tree = analyse(code);
  if (!tree) return null;
  const body = tree.ast.body as AnyNode[];
  for (let j = 0; j < body.length; j++) {
    const declaration = body[j];
    if (declaration.type !== 'ClassDeclaration' || !declaration.id) continue;
    const name = (declaration.id as AnyNode).name as string;
    // The first top-level statement before it that uses the class as it runs (not inside a function)
    let first = -1;
    for (let i = 0; i < j && first < 0; i++) {
      walk(body[i], (node, functions) => {
        if (first >= 0 || functions.length > 0 || node.type !== 'Identifier' || node.name !== name || !isReference(tree, node)) return;
        if (resolve(tree, node, name) === tree.ast) first = i;
      });
    }
    if (first < 0) continue;
    // What runs when the class is made or first constructed, and the names it reads
    const eager: AnyNode[] = [];
    if (declaration.superClass) eager.push(declaration.superClass as AnyNode);
    for (const member of ((declaration.body as AnyNode).body as AnyNode[]) ?? []) {
      if (member.type === 'StaticBlock') eager.push(member);
      else if (member.type === 'PropertyDefinition' && member.value) eager.push(member.value as AnyNode);
      else if (member.type === 'MethodDefinition' && member.kind === 'constructor') eager.push(member.value as AnyNode);
      if ((member.type === 'MethodDefinition' || member.type === 'PropertyDefinition') && member.computed) eager.push(member.key as AnyNode);
    }
    const read = new Set<string>();
    for (const part of eager) walk(part, (node) => { if (node.type === 'Identifier' && isReference(tree, node)) read.add(node.name as string); });
    const between = new Set<string>();
    for (const statement of body.slice(first, j)) {
      if (statement.type === 'ClassDeclaration' && statement.id) between.add((statement.id as AnyNode).name as string);
      if (statement.type === 'VariableDeclaration') for (const d of statement.declarations as AnyNode[]) for (const n of tree.nodes) if (n.type === 'Identifier' && tree.bindings.has(n) && n.start >= (d.id as AnyNode).start && n.end <= (d.id as AnyNode).end) between.add(n.name as string);
    }
    if ([...read].some((n) => between.has(n))) continue;
    // Moved as the lines it was on, ahead of the statement that uses it
    const classEnd = declaration.end;
    const lineStartOf = (offset: number) => code.lastIndexOf('\n', offset - 1) + 1;
    const classStart = lineStartOf(declaration.start) === declaration.start || /^\s*$/.test(code.slice(lineStartOf(declaration.start), declaration.start)) ? lineStartOf(declaration.start) : declaration.start;
    const text = code.slice(classStart, classEnd).replace(/^\n+/, '');
    const removeTo = code[classEnd] === '\n' ? classEnd + 1 : classEnd;
    // (a class that ended the program leaves no blank lines at its end)
    const without = code.slice(0, classStart) + (removeTo >= code.length ? '' : code.slice(removeTo));
    const tidy = removeTo >= code.length && !/\n$/.test(code) ? without.replace(/\s+$/, '') : without;
    const useStart = body[first].start;
    const at = /^\s*$/.test(code.slice(lineStartOf(useStart), useStart)) ? lineStartOf(useStart) : useStart;
    // (the removal is after the insertion point, so the point is still where it was)
    const moved = `${tidy.slice(0, at)}${text}\n\n${tidy.slice(at)}`;
    if (tryParse(moved)) return { code: moved, name };
  }
  return null;
}

/**
 * A method of the program's own read in a condition without being called (`game.isGameOver &&
 * …`, `if (done.check)`): a method is always there, so the condition is always true. Said once for
 * each, for an object made with `new` of a class the program declares or written as an object
 * with methods. (A browser object's method read in a condition may be a feature test: not said.)
 */
export function methodReadFacts(code: string): string | null {
  const tree = analyse(code);
  if (!tree) return null;
  const methods = new Map<string, Set<string>>();
  const getters = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, name: string, member: string) => map.set(name, (map.get(name) ?? new Set()).add(member));
  for (const node of tree.nodes) {
    if (node.type === 'ClassDeclaration' && node.id) {
      for (const member of ((node.body as AnyNode).body as AnyNode[]) ?? []) {
        if (member.type !== 'MethodDefinition' || member.computed || member.static || (member.key as AnyNode).type !== 'Identifier') continue;
        const keyName = (member.key as AnyNode).name as string;
        if (member.kind === 'method') add(methods, `class ${(node.id as AnyNode).name as string}`, keyName);
        else if (member.kind === 'get') add(getters, `class ${(node.id as AnyNode).name as string}`, keyName);
      }
    }
  }
  // What each name holds: `const game = new Game()`, or an object written out with methods
  const kindOf = new Map<string, string>();
  for (const node of tree.nodes) {
    if (node.type !== 'VariableDeclarator' || (node.id as AnyNode).type !== 'Identifier' || !node.init) continue;
    const name = (node.id as AnyNode).name as string;
    const init = node.init as AnyNode;
    if (init.type === 'NewExpression' && (init.callee as AnyNode).type === 'Identifier' && methods.has(`class ${(init.callee as AnyNode).name as string}`)) kindOf.set(name, `class ${(init.callee as AnyNode).name as string}`);
    if (init.type === 'ObjectExpression') {
      for (const property of init.properties as AnyNode[]) {
        if (property.type !== 'Property' || property.computed || (property.key as AnyNode).type !== 'Identifier') continue;
        const value = property.value as AnyNode;
        if (property.kind === 'init' && (property.method || /^(?:Arrow)?FunctionExpression$/.test(value.type))) add(methods, `object ${name}`, (property.key as AnyNode).name as string);
        else if (property.kind !== 'init') add(getters, `object ${name}`, (property.key as AnyNode).name as string);
      }
      if (methods.has(`object ${name}`)) kindOf.set(name, `object ${name}`);
    }
  }
  const said = new Set<string>();
  const facts: string[] = [];
  for (const node of tree.nodes) {
    if (node.type !== 'MemberExpression' || node.computed || (node.property as AnyNode).type !== 'Identifier' || (node.object as AnyNode).type !== 'Identifier') continue;
    const parent = tree.parent.get(node);
    const key = tree.key.get(node);
    if (!parent) continue;
    // Read as a condition: the test of an if, a loop or ?:, the left of && || ??, or under !
    const test =
      ((parent.type === 'IfStatement' || parent.type === 'WhileStatement' || parent.type === 'DoWhileStatement' || parent.type === 'ForStatement' || parent.type === 'ConditionalExpression') && key === 'test') ||
      (parent.type === 'LogicalExpression' && key === 'left') ||
      (parent.type === 'UnaryExpression' && parent.operator === '!' && key === 'argument');
    if (!test) continue;
    const owner = kindOf.get((node.object as AnyNode).name as string);
    const member = (node.property as AnyNode).name as string;
    if (!owner || !methods.get(owner)?.has(member) || getters.get(owner)?.has(member)) continue;
    // (a name the program also declares elsewhere, or sets again, may hold something else)
    const text = `${(node.object as AnyNode).name as string}.${member}`;
    if (said.has(text)) continue;
    said.add(text);
    facts.push(`${text} is a method, so it is always true here; call it as ${text}().`);
  }
  return facts.length ? facts.join(' ') : null;
}

/**
 * What a test run saw the program read from an element or an event that the object doesn't have
 * (`input.val`, which is undefined and no error), as facts: "input.val isn't a member of an <input>
 * (line 7); its settings: value, valueAsNumber, …". A read the program guards is a feature check and is
 * not reported: the test of an if, a loop or ?:, the left of && || ??, under ! or typeof, or the
 * object of an optional chain. Only a read the code at that line has (a name and a line the parser finds).
 */
export function missingReadFacts(code: string, reads: Array<{ name: string; type: string; line: number }>, scope?: Record<string, unknown>): string[] {
  const tree = analyse(code);
  if (!tree || reads.length === 0) return [];
  const facts: string[] = [];
  for (const read of reads) {
    const nodes = tree.nodes.filter((n) => n.type === 'MemberExpression' && lineOf(n.property as AnyNode) === read.line && (n.computed ? (n.property as AnyNode).value === read.name : (n.property as AnyNode).name === read.name));
    if (nodes.length === 0) continue;
    const guarded = (n: AnyNode): boolean => {
      const parent = tree.parent.get(n);
      const key = tree.key.get(n);
      if (!parent) return false;
      if ((/^(?:IfStatement|WhileStatement|DoWhileStatement|ForStatement|ConditionalExpression)$/.test(parent.type) && key === 'test') || (parent.type === 'LogicalExpression' && key === 'left')) return true;
      if (parent.type === 'UnaryExpression' && (parent.operator === '!' || parent.operator === 'typeof')) return true;
      return parent.type === 'MemberExpression' && key === 'object' && !!parent.optional;
    };
    const open = nodes.filter((n) => !guarded(n));
    if (open.length === 0) continue;
    const n = open[0];
    const text = `${code.slice((n.object as AnyNode).start, (n.object as AnyNode).end)}.${read.name}`;
    const element = read.type.startsWith('element:');
    const tag = read.type.slice(8);
    const label = element ? `${/^[aeiou]/.test(tag) ? 'an' : 'a'} <${tag}>` : `a ${read.type.slice(6)}`;
    const list = scope ? memberList(element ? read.type : read.type.slice(6), read.name, scope) : null;
    const settings = list?.settings.length ? `; its settings: ${list.settings.map((s) => s.name).join(', ')}${list.more ? ', …' : ''}` : list?.methods.length ? `; its methods: ${list.methods.map((m) => `${m}()`).join(', ')}${list.more ? ', …' : ''}` : '';
    facts.push(`${text} isn't a member of ${label} (line ${read.line})${settings}.`);
    if (facts.length >= 3) break;
  }
  return facts;
}

/** What a stray character is called in the run log */
export function strayName(removed: string): string {
  return /[`'"]/.test(removed) ? 'a stray quote' : `a stray ${removed}`;
}

function syntaxSlip(code: string, error: string, errorLine?: number): ErrorHint | null {
  const line = errorLine ?? 0;
  if (/shorthand property initializer|Expected a ':' following the property name/i.test(error)) {
    return repairLine(code, line, (text) => text.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*=(?![=>])\s*/g, '$1$2: '), '= in an object → :');
  }
  if (/Unexpected identifier|Unexpected token|missing } after property list/i.test(error)) {
    const quoted = repairLine(
      code,
      line,
      (text) => text.replace(/(:\s*)([A-Za-z][\w#]*(?:[ \t]+[A-Za-z0-9#][\w#]*)+)(?=\s*[,}]|\s*$)/g, "$1'$2'"),
      'unquoted words in an object → quoted'
    );
    if (quoted) return quoted;
  }
  const stray = dropStrayCharacter(code);
  if (stray) return { correction: { code: stray.code, note: `${strayName(stray.removed)} on line ${stray.line} → removed` } };
  const braceless = wrapBracelessArrows(code);
  if (braceless) return { correction: { code: braceless.code, note: `statements as an arrow function's body (line${braceless.lines.length > 1 ? 's' : ''} ${braceless.lines.join(', ')}) → wrapped in { }` } };
  const twice = error.match(/Identifier '([^']+)' has already been declared/) ?? error.match(/Cannot declare a (?:const|let) variable twice: '([^']+)'/);
  if (twice) {
    // Only the declarations in one block (declareOnce, by the parser): the same name declared
    // in another function is that function's own, and stays as it is
    const once = declareOnce(code);
    if (once && once.names.includes(twice[1])) {
      return { correction: { code: once.code, note: `${once.names.join(', ')} declared twice → assigned the second time` } };
    }
  }
  return null;
}

/** Helpers every program already has, ready to use */
const HELPERS = ['out', 'speak', 'clear', 'root'];
/** Names the sandbox provides besides the browser's own */
const SANDBOX_NAMES = [...HELPERS, 'playNotes', 'searchWikipedia'];
/**
 * Every name the sandbox gives a program (javascript-runtime.ts): the helpers, three.js, Tone.js, and
 * the Web MIDI program's defaults. None is in this window's globalThis, so a rename of one of them would be
 * a rename of something that exists.
 */
const PROVIDED_NAMES = [...SANDBOX_NAMES, 'THREE', 'Tone', 'bpm', 'beat', 'start'];

/** Whether the use sits in the initializer of the declaration of `name` itself, with no function between (a closure reads it later, when it is made) */
function readsItsOwnDeclaration(tree: NonNullable<ReturnType<typeof analyse>>, node: AnyNode, name: string): boolean {
  for (let at: AnyNode | undefined = node; at; at = tree.parent.get(at)) {
    if (/Function/.test(at.type) || at.type === 'ClassBody') return false;
    const parent = tree.parent.get(at);
    if (parent?.type === 'VariableDeclarator' && tree.key.get(at) === 'init' && (parent.id as AnyNode).type === 'Identifier' && (parent.id as AnyNode).name === name) return true;
  }
  return false;
}

/**
 * Before a program runs: a name used but declared nowhere it can be seen from, that differs from
 * exactly one name that can (by scope: classes, catch parameters and named function expressions
 * count) only in letter case (`mycount` for `myCount`, `drawscene()` for `drawScene()`), is
 * renamed. The error-time version is notDefined(); both use caseSlip(). Browser globals and the
 * sandbox's own names are never renamed, and a result that doesn't parse is not kept.
 */
export function fixCaseSlips(code: string): { code: string; fixed: Array<{ from: string; to: string }> } {
  const tree = analyse(code);
  if (!tree) return { code, fixed: [] };
  /** Every name declared in a scope `node` sees */
  const visibleFrom = (node: AnyNode): string[] => {
    const names: string[] = [];
    for (let at: AnyNode | undefined = node; at; at = tree.parent.get(at)) names.push(...(tree.scopes.get(at) ?? []));
    return names;
  };
  const edits = new Map<number, { end: number; text: string; from: string; to: string }>();
  for (const node of tree.nodes as AnyNode[]) {
    // `{ bill }` names its key too: it becomes `{ bill: Bill }`
    const parent = tree.parent.get(node);
    const shorthand = parent?.type === 'Property' && parent.shorthand && tree.key.get(node) === 'value' && node.type === 'Identifier' && !tree.bindings.has(node);
    if (!shorthand && !isReference(tree, node)) continue;
    // typeof of an undeclared name is allowed (it's how a program asks whether it exists)
    if (parent?.type === 'UnaryExpression' && parent.operator === 'typeof') continue;
    if (parent?.type === 'MetaProperty') continue;
    const name = node.name as string;
    if (resolve(tree, node, name) || name in globalThis || PROVIDED_NAMES.includes(name)) continue;
    const to = caseSlip(name, visibleFrom(node));
    // Not the name a declaration is still making: `const oscillator = new Oscillator()` is not
    // `new oscillator()` (the name can't be read in its own initializer)
    if (to && readsItsOwnDeclaration(tree, node, to)) continue;
    if (to && !edits.has(node.start)) edits.set(node.start, { end: node.end, text: shorthand ? `${name}: ${to}` : to, from: name, to });
  }
  let out = code;
  for (const [start, edit] of [...edits].sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + edit.text + out.slice(edit.end);
  if (edits.size > 0 && !tryParse(out)) return { code, fixed: [] };
  const fixed = [...new Map([...edits.values()].map((e) => [`${e.from}→${e.to}`, { from: e.from, to: e.to }])).values()];
  return { code: out, fixed };
}

/** Web MIDI's interfaces: the spec gives them no constructor (`new MIDIOutput()` throws) */
const NOT_CONSTRUCTIBLE = new Set(['MIDIAccess', 'MIDIInput', 'MIDIOutput', 'MIDIPort', 'MIDIInputMap', 'MIDIOutputMap']);

/**
 * A definition that stands in for a helper rather than doing anything of its own: a function
 * that does nothing or only logs (`function speak(t) { console.log(t) }`), an empty class, or a
 * `new` of something that can't be made (undeclared, or an interface without a constructor)
 */
function standsIn(init: AnyNode | null | undefined, declared: Set<string>): boolean {
  if (!init) return false;
  if (/Function/.test(init.type)) {
    const body = init.body as AnyNode;
    if (body.type !== 'BlockStatement') return isLogCall(body);
    return (body.body as AnyNode[]).every((st) => (st.type === 'ExpressionStatement' && isLogCall(st.expression as AnyNode)) || (st.type === 'ReturnStatement' && (!st.argument || ['Identifier', 'Literal'].includes((st.argument as AnyNode).type))));
  }
  if (init.type === 'ClassDeclaration' || init.type === 'ClassExpression') return ((init.body as AnyNode).body as AnyNode[]).length === 0;
  if (init.type === 'NewExpression') {
    const made = init.callee as AnyNode;
    const name = made.name as string;
    return made.type === 'Identifier' && !declared.has(name) && (!(name in globalThis) || NOT_CONSTRUCTIBLE.has(name));
  }
  return false;
}

/** console.log(…), console.info(…), alert(…) */
function isLogCall(node: AnyNode): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee as AnyNode;
  return (callee.type === 'Identifier' && callee.name === 'alert') || (callee.type === 'MemberExpression' && (callee.object as AnyNode).type === 'Identifier' && (callee.object as AnyNode).name === 'console');
}

/** The program with its top-level `name` and every reference to it (by scope) renamed to `to`, or null */
function renameTopLevel(code: string, name: string, to: string): string | null {
  const tree = analyse(code);
  if (!tree) return null;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const node of tree.nodes as AnyNode[]) {
    if (node.type !== 'Identifier' || node.name !== name) continue;
    const parent = tree.parent.get(node);
    const shorthand = parent?.type === 'Property' && parent.shorthand && tree.key.get(node) === 'value' && !tree.bindings.has(node);
    const declaresIt = tree.bindings.has(node) && resolve(tree, node, name) === tree.ast;
    if (!declaresIt && !shorthand && !isReference(tree, node)) continue;
    if (resolve(tree, node, name) !== tree.ast) continue;
    if (!edits.some((e) => e.start === node.start)) edits.push({ start: node.start, end: node.end, text: shorthand ? `${name}: ${to}` : to });
  }
  let out = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return tryParse(out) ? out : null;
}

/**
 * Before a program runs: its own definitions of a ready-made helper (speak, out, clear, root).
 *  - A copy of speak() is taken out, so the real one says the words (in the chat and aloud).
 *  - A stand-in for another helper (one that does nothing, or a `new` of something that can't be
 *    made: see standsIn) is taken out, so the real helper is used.
 *  - A definition of its own (`function clear() { ctx.clearRect(…) }`, `const root = new
 *    TreeNode(50)`, `const out = new Float32Array(n)`) is the program's: it is kept, renamed with
 *    every reference to it (clear_), so it can't be mistaken for the helper or collide with it.
 * A real value given to a helper name (const out = a MIDI output) stays as it is.
 */
export function dropHelperCopies(code: string): { code: string; dropped: string[]; renamed: string[]; kept: string[] } {
  const ast = tryParse(code);
  if (!ast) return { code, dropped: [], renamed: [], kept: [] };
  // A speak() that takes nothing and holds several statements is the program itself, written as
  // `const speak = () => { … }`: it is renamed (and its calls without arguments with it), not
  // dropped; calls that pass something go to the real helper. Only speak: its copies are
  // otherwise dropped, while a clear() or out of the program's own is kept under another name
  // below, with every reference to it (a handler set to it, a timer given it) renamed by scope
  const holdsProgram = (fn: AnyNode | null | undefined) =>
    !!fn && /Function/.test(fn.type) && ((fn.params as AnyNode[]) ?? []).length === 0 && (fn.body as AnyNode)?.type === 'BlockStatement' && ((fn.body as AnyNode).body as AnyNode[]).length >= 3;
  for (const statement of ast.body as AnyNode[]) {
    const declared = statement.type === 'FunctionDeclaration' ? statement : statement.type === 'VariableDeclaration' ? ((statement.declarations as AnyNode[])[0] as AnyNode) : null;
    const id = declared ? ((declared.id as AnyNode | undefined) ?? null) : null;
    const fn = statement.type === 'FunctionDeclaration' ? statement : ((declared?.init as AnyNode | undefined) ?? null);
    if (!id || id.type !== 'Identifier' || id.name !== 'speak' || !holdsProgram(fn)) continue;
    const name = id.name as string;
    let main = 'main';
    for (let i = 2; new RegExp(`(?<![\\w$])${main}(?![\\w$])`).test(code); i++) main = `main${i}`;
    const edits: Array<{ start: number; end: number }> = [{ start: id.start, end: id.end }];
    walk(ast, (node) => {
      const callee = node.callee as AnyNode | undefined;
      if (node.type === 'CallExpression' && callee?.type === 'Identifier' && callee.name === name && ((node.arguments as AnyNode[]) ?? []).length === 0) edits.push({ start: callee.start, end: callee.end });
    });
    let out = code;
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + main + out.slice(e.end);
    if (!tryParse(out)) break;
    const rest = dropHelperCopies(out);
    return { code: rest.code, dropped: rest.dropped, renamed: [`${name} → ${main}`, ...rest.renamed], kept: rest.kept };
  }
  const own = new Set(declarations(ast).map((d) => d.name));
  const spans: Array<{ start: number; end: number; name: string }> = [];
  const keep: string[] = [];
  for (const statement of ast.body as AnyNode[]) {
    let name: string | null = null;
    let made: AnyNode | null | undefined = null;
    if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && HELPERS.includes(((statement.id as AnyNode)?.name as string) ?? '')) {
      name = (statement.id as AnyNode).name as string;
      made = statement;
    }
    if (statement.type === 'VariableDeclaration') {
      const declarations = statement.declarations as AnyNode[];
      const id = declarations[0]?.id as AnyNode | undefined;
      const init = declarations[0]?.init as AnyNode | null | undefined;
      // Only something made for the name (a function, a class, a `new …`); a real value it was
      // given (const out = MIDI output) stays
      const makes = !!init && /^(?:FunctionExpression|ArrowFunctionExpression|ClassExpression|NewExpression)$/.test(init.type);
      if (declarations.length === 1 && makes && id?.type === 'Identifier' && HELPERS.includes(id.name as string)) {
        name = id.name as string;
        made = init;
      }
    }
    if (!name) continue;
    const copiesSpeak = name === 'speak' && /Function/.test(made?.type ?? '');
    if (copiesSpeak || standsIn(made, own)) spans.push({ start: statement.start, end: statement.end, name });
    else keep.push(name);
  }
  let out = code;
  for (const { start, end } of [...spans].reverse()) {
    const after = out.slice(end).match(/^[ \t]*\n?/)?.[0].length ?? 0;
    out = out.slice(0, start) + out.slice(end + after);
  }
  const kept: string[] = [];
  for (const name of new Set(keep)) {
    let to = `${name}_`;
    while (new RegExp(`(?<![\\w$])${to.replace(/\$/g, '\\$')}(?![\\w$])`).test(out)) to += '_';
    const renamed = renameTopLevel(out, name, to);
    if (renamed) {
      out = renamed;
      kept.push(`${name} → ${to}`);
    }
  }
  return { code: out, dropped: spans.map((s) => s.name), renamed: [], kept };
}

/** Names a declaration binds (`x`, `{ a, b: c }` → a, c, `[d, ...e]`) */
function boundNames(pattern: AnyNode | null | undefined): string[] {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [pattern.name as string];
  if (pattern.type === 'ObjectPattern') return (pattern.properties as AnyNode[]).flatMap((p) => boundNames((p.value ?? p.argument) as AnyNode));
  if (pattern.type === 'ArrayPattern') return (pattern.elements as AnyNode[]).flatMap((e) => boundNames(e));
  if (pattern.type === 'RestElement') return boundNames(pattern.argument as AnyNode);
  if (pattern.type === 'AssignmentPattern') return boundNames(pattern.left as AnyNode);
  return [];
}

/** require('x'), or a member or call of one (require('x').y, require('x')()) */
function isRequire(node: AnyNode | null | undefined): boolean {
  if (!node) return false;
  if (node.type === 'CallExpression') {
    const callee = node.callee as AnyNode;
    return (callee.type === 'Identifier' && callee.name === 'require') || isRequire(callee);
  }
  if (node.type === 'MemberExpression') return isRequire(node.object as AnyNode);
  return false;
}

/** The libraries Chatty provides in a program's page, by the package name a program imports them by (also with the file's ending: 'tone.js', 'threejs') */
const PROVIDED_LIBRARIES: Record<string, string> = { three: 'THREE', tone: 'Tone' };

/**
 * Imports of a library Chatty provides (three.js as THREE, Tone.js as Tone: javascript-runtime.ts):
 * `import * as T from 'three'` becomes `const T = THREE;`, `import { Scene, Mesh as M } from
 * 'three'` becomes `const { Scene, Mesh: M } = THREE;`, and the same for 'tone'. Programs run as
 * scripts, where an import can't stand. `provided` lists the globals they now read.
 */
export function provideThree(code: string): { code: string; changed: boolean; provided: string[] } {
  const provided = new Set<string>();
  // What a binding of the package becomes: the names it takes from the ready-made global. A name
  // that is the global itself ({ Tone } from 'tone') is that global already, so it takes nothing
  const bind = (clause: string, global: string, line: string): string => {
    const star = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    const def = clause.match(/^([A-Za-z_$][\w$]*)$/);
    const alias = star?.[1] ?? def?.[1];
    if (alias) {
      provided.add(global);
      return alias === global ? '' : `const ${alias} = ${global};`;
    }
    const named = clause.match(/^\{([^}]*)\}$/);
    if (named) {
      provided.add(global);
      const parts = named[1].split(',').map((p) => p.trim()).filter(Boolean).filter((p) => p !== global).map((p) => p.replace(/\s+as\s+/, ': '));
      return parts.length ? `const { ${parts.join(', ')} } = ${global};` : '';
    }
    return line;
  };
  let out = code.replace(/^[ \t]*import\s+([^;\n]+?)\s+from\s+(['"])(three|tone)(?:\.?js)?\2[ \t]*;?[ \t]*$/gm, (line, clause: string, _q: string, pkg: string) => bind(clause, PROVIDED_LIBRARIES[pkg], line));
  // The same in CommonJS: const Tone = require('tone'), const { Synth } = require('tone')
  out = out.replace(/^[ \t]*(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])(three|tone)(?:\.?js)?\2\s*\)[ \t]*;?[ \t]*$/gm, (line, clause: string, _q: string, pkg: string) =>
    bind(clause, PROVIDED_LIBRARIES[pkg], line)
  );
  return { code: out, changed: provided.size > 0, provided: [...provided] };
}

/**
 * Packages a program loads that the browser doesn't have (`const { x } = require('shelljs')`,
 * `import x from 'lodash'`): a top-level statement whose names nothing else uses is taken out,
 * since it can only fail. One whose names are used stays, and its error goes to the model.
 */
export function dropUnusedPackages(code: string): { code: string; dropped: string[] } {
  const dropped: string[] = [];
  const unused = (rest: string, names: string[]) => {
    const ast = tryParse(rest);
    const used = new Set<string>();
    if (ast) walk(ast, (n) => n.type === 'Identifier' && used.add(n.name as string));
    return names.every((name) => (ast ? !used.has(name) : !new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(rest)));
  };
  // import lines (a script can't parse them, so they are found by their shape)
  let out = code.replace(/^[ \t]*import\s+(?:([\w$\s{},*]+?)\s+from\s+)?(['"])([^'"\n]+)\2[ \t]*;?[ \t]*(?:\n|$)/gm, (line, clause: string | undefined, _q, from: string, offset: number, all: string) => {
    const names = (clause ?? '')
      .replace(/[{}]/g, ' ')
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/).pop()!.replace(/^\*\s*/, '').trim())
      .filter(Boolean);
    const rest = all.slice(0, offset) + all.slice(offset + line.length);
    if (!unused(rest, names)) return line;
    dropped.push(from);
    return '';
  });
  const ast = tryParse(out);
  if (!ast) return { code: out, dropped };
  const spans: Array<{ start: number; end: number; from: string }> = [];
  for (const statement of ast.body as AnyNode[]) {
    let names: string[] | null = null;
    let call: AnyNode | undefined;
    if (statement.type === 'VariableDeclaration') {
      const declarations = statement.declarations as AnyNode[];
      if (declarations.every((d) => isRequire(d.init as AnyNode))) {
        names = declarations.flatMap((d) => boundNames(d.id as AnyNode));
        call = declarations[0].init as AnyNode;
      }
    } else if (statement.type === 'ExpressionStatement' && isRequire(statement.expression as AnyNode)) {
      names = [];
      call = statement.expression as AnyNode;
    }
    if (!names) continue;
    if (!unused(out.slice(0, statement.start) + out.slice(statement.end), names)) continue;
    let inner = call;
    while (inner && !(inner.type === 'CallExpression' && (inner.callee as AnyNode).type === 'Identifier')) inner = (inner.callee ?? inner.object) as AnyNode;
    const arg = (inner?.arguments as AnyNode[] | undefined)?.[0];
    spans.push({ start: statement.start, end: statement.end, from: typeof arg?.value === 'string' ? (arg.value as string) : 'a package' });
  }
  for (const { start, end } of [...spans].reverse()) {
    const after = out.slice(end).match(/^[ \t]*\n?/)?.[0].length ?? 0;
    out = out.slice(0, start) + out.slice(end + after);
  }
  return { code: out, dropped: [...dropped, ...spans.map((s) => s.from)] };
}

/**
 * A program that makes its own copy of a ready-made helper (`const out = new Out({…})`,
 * `const speak = speak.bind(…)`): the declaration goes, so the real helper is used
 */
function redeclaredHelper(code: string, error: string): ErrorHint | null {
  if (!/is not defined|Can't find variable|before initialization|uninitialized variable|is not a constructor/i.test(error)) return null;
  for (const helper of HELPERS) {
    // Only the helper the error is about: an error elsewhere (`bpm is not defined`) is not this
    // declaration's, and taking it out would be an edit the error gives no reason for
    if (!new RegExp(`(?<![\\w$])${helper}(?![\\w$])`, 'i').test(error)) continue;
    const declaration = new RegExp(`^[ \\t]*(?:const|let|var)\\s+${helper}\\s*=\\s*(?:new\\s+)?${helper}\\b[^\\n]*\\n?`, 'im');
    if (declaration.test(code)) {
      return { correction: { code: code.replace(declaration, ''), note: `its own ${helper} → the ready-made one` } };
    }
  }
  return null;
}

/** Calls whose value is a promise: await them to get the thing itself */
const PROMISE_CALL = /\b(?:fetch|requestMIDIAccess|getUserMedia|requestPermission|json|text|blob|arrayBuffer|decodeAudioData|resume|requestFullscreen|play)\s*\(/;

/** The name a call goes by (`fetch`, or `json` for `res.json()`), or null */
function calleeName(call: AnyNode): string | null {
  const callee = call.callee as AnyNode;
  if (callee.type === 'Identifier') return callee.name as string;
  if (callee.type === 'MemberExpression' && !callee.computed) return (callee.property as AnyNode).name as string;
  return null;
}

/**
 * A promise used as the value it promises (`const res = fetch(url); res.json()`, or
 * `res.json().title`): the call that made it gets an await (an enclosing function is made async
 * before it runs). The failing value is named by "x.m is not a function", or found on the
 * failing line when the error is a property read of undefined and exactly one name there is
 * assigned from an un-awaited promise call.
 */
function missingAwait(code: string, error: string, errorLine?: number): ErrorHint | null {
  const notFunction =
    error.match(/([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]* is not a function/)?.[1] ??
    error.match(/undefined is not an object \(evaluating '([A-Za-z_$][\w$]*)\./)?.[1];
  const ofUndefined = /Cannot read propert(?:y|ies) of undefined|undefined is not an object/.test(error);
  if (!notFunction && !ofUndefined) return null;
  const asyncFunctions = [...code.matchAll(/async\s+function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const promiseAssignment = (name: string) => {
    const assignment = new RegExp(`((?<![\\w$.])(?:(?:const|let|var)\\s+)?${name.replace(/\$/g, '\\$')}\\s*=(?![=>])(?!\\s*await\\b)\\s*)([^;\\n]+)`);
    const found = code.match(assignment);
    if (!found) return null;
    const init = found[2];
    const promises = PROMISE_CALL.test(init) || asyncFunctions.some((fn) => new RegExp(`^\\s*${fn}\\s*\\(`).test(init));
    return promises ? assignment : null;
  };
  const lines = code.split('\n');
  const line = errorLine && errorLine <= lines.length ? lines[errorLine - 1] : '';
  const candidates = notFunction ? [notFunction] : [...new Set([...line.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\./g)].map((m) => m[1]))];
  const made = candidates.map((name) => ({ name, assignment: promiseAssignment(name) })).filter((c) => c.assignment);
  if (made.length === 1) {
    const { name, assignment } = made[0];
    return { correction: { code: code.replace(assignment!, '$1await $2'), note: `${name} was a promise → await` } };
  }
  // The value used right where the call is: res.json().title, fetch(url).json()
  if (errorLine && made.length === 0) {
    const ast = tryParse(code);
    if (!ast) return null;
    const own = new Set(declarations(ast).map((d) => d.name));
    const spots: AnyNode[] = [];
    const visit = (node: AnyNode, parent: AnyNode | null) => {
      if (node.type === 'CallExpression' && parent?.type === 'MemberExpression' && parent.object === node && lineOf(node) === errorLine) {
        const name = calleeName(node);
        const member = parent.computed ? '' : ((parent.property as AnyNode).name as string);
        if (name && !own.has(name) && PROMISE_CALL.test(`${name}(`) && !/^(?:then|catch|finally)$/.test(member)) spots.push(node);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && visit(child, node);
        else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') visit(value as AnyNode, node);
      }
    };
    visit(ast, null);
    // The outermost such call, when only one chain on the line is a candidate
    const outer = spots.filter((spot) => !spots.some((other) => other !== spot && other.start <= spot.start && other.end >= spot.end));
    if (outer.length === 1) {
      const spot = outer[0];
      const text = code.slice(spot.start, spot.end);
      return { correction: { code: `${code.slice(0, spot.start)}(await ${text})${code.slice(spot.end)}`, note: `${text} was a promise → await` } };
    }
  }
  return null;
}

/**
 * When the failing line is inside a function: the calls of that function that pass fewer values
 * than it needs, where a missing value turns up as NaN, undefined or a wrong type inside it
 * (`playNote(kick, start, 'kick')` for playNote(frequency, duration, startTime, type))
 */
function shortCalls(code: string, errorLine?: number): string | null {
  if (!errorLine) return null;
  const ast = tryParse(code);
  if (!ast) return null;
  let inside: AnyNode | null = null;
  walk(ast, (node) => {
    const loc = node.loc as { start: { line: number }; end: { line: number } } | undefined;
    if (node.type === 'FunctionDeclaration' && node.id && loc && loc.start.line <= errorLine && loc.end.line >= errorLine) {
      if (!inside || lineOf(node) > lineOf(inside)) inside = node;
    }
  });
  if (!inside) return null;
  const fn = inside as AnyNode;
  const name = (fn.id as AnyNode).name as string;
  const params = fn.params as AnyNode[];
  const needed = params.filter((p) => p.type === 'Identifier').length;
  const signature = `${name}(${params.map((p) => code.slice(p.start, p.end).split('=')[0].trim()).join(', ')})`;
  const calls: AnyNode[] = [];
  walk(ast, (node) => {
    const callee = node.callee as AnyNode | undefined;
    if (node.type === 'CallExpression' && callee?.type === 'Identifier' && callee.name === name) calls.push(node);
  });
  // Short: fewer values than it needs, or than its other calls pass (a value left out in between
  // shifts the rest: playNote(kick, start, 'kick') puts 'kick' where the start time goes)
  const most = Math.max(needed, ...calls.map((call) => (call.arguments as AnyNode[]).length));
  const short = calls.filter((call) => (call.arguments as AnyNode[]).length < most);
  if (short.length === 0 || short.length === calls.length) return null;
  const listed = short.slice(0, 4).map((call) => `line ${lineOf(call)}: ${code.slice(call.start, call.end)}`);
  return `${signature} is called with ${most} values elsewhere, but with fewer here: ${listed.join('; ')}.`;
}

/** Facts for a browser method called with too few arguments (method-hints.ts) */
function argumentCountFacts(code: string, error: string, errorLine?: number, scope?: Record<string, unknown>): ErrorHint | null {
  const text = argumentCountFact(code, error, errorLine, scope);
  return text ? { text } : null;
}

/** Browser errors that name nothing about the values (Safari's bare "Type error"; Chrome's overloads) */
const VAGUE_ERROR = /^(?:TypeError:\s*)?Type error\.?$|Overload resolution failed|is not of type '|could not be converted|The provided value is not of type/i;

/**
 * For an error that names nothing: what each value in the failing call is, from where the
 * program made it ("Line 40 calls gain.connect(output): output is a page element
 * (document.getElementById('output')), which never existed")
 */
function vagueCallFacts(code: string, error: string, errorLine?: number, page?: PageFacts): string | null {
  if (!errorLine || !VAGUE_ERROR.test(error)) return null;
  const ast = tryParse(code);
  if (!ast) return null;
  const inits = new Map<string, AnyNode[]>();
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && (node.id as AnyNode).type === 'Identifier' && node.init) {
      const name = (node.id as AnyNode).name as string;
      inits.set(name, [...(inits.get(name) ?? []), node.init as AnyNode]);
    }
  });
  const missingIds = new Set((page?.standIns ?? []).map((s) => s.id));
  const describe = (init: AnyNode): string | null => {
    const text = code.slice(init.start, init.end);
    const lookup = text.match(/(?:getElementById\(\s*['"`]([^'"`]+)|querySelector\(\s*['"`]#([^'"`]+))/);
    if (lookup && init.type === 'CallExpression') {
      const id = lookup[1] ?? lookup[2];
      return `a page element (${text})${missingIds.has(id) ? ', which never existed' : ''}`;
    }
    if (init.type === 'NewExpression') return `a new ${code.slice((init.callee as AnyNode).start, (init.callee as AnyNode).end)}`;
    if (init.type === 'CallExpression') return `what ${text.length > 60 ? `${text.slice(0, 57)}…` : text} returns`;
    if (init.type === 'Literal') return `${text} (a ${typeof (init as AnyNode).value})`;
    if (init.type === 'ArrayExpression') return 'a list';
    if (init.type === 'ObjectExpression') return 'a plain object';
    if (/Function/.test(init.type)) return 'a function';
    return null;
  };
  let found: string | null = null;
  walk(ast, (node) => {
    if (found || node.type !== 'CallExpression' || lineOf(node) !== errorLine || (node.callee as AnyNode).type !== 'MemberExpression') return;
    const parts: string[] = [];
    for (const arg of node.arguments as AnyNode[]) {
      if (arg.type !== 'Identifier') continue;
      const made = inits.get(arg.name as string) ?? [];
      const kinds = [...new Set(made.map(describe))];
      if (kinds.length === 1 && kinds[0]) parts.push(`${arg.name} is ${kinds[0]}`);
    }
    if (parts.length > 0) found = `Line ${errorLine} calls ${code.slice(node.start, node.end)}: ${parts.join('; ')}.`;
  });
  return found;
}

/** Help for a failed program: a correction, or facts for the fix request */
/** Media members: a program reaching for them wanted sound */
const SOUND_MEMBER = /^(?:play|pause|load|volume|currentTime|src|muted|loop)$/;

/**
 * An error on an element the program never made: the sandbox gave it an empty <div> for the id
 * (rather than null), so the error names a missing method and hides the real cause
 */
function standInElement(code: string, error: string, errorLine: number | undefined, page?: PageFacts): ErrorHint | null {
  const lineText = errorLine ? (code.split('\n')[errorLine - 1] ?? '') : '';
  for (const { id, tag, made } of page?.standIns ?? []) {
    const name = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lookup = `(?:getElementById\\(\\s*['"\`]${name}['"\`]\\s*\\)|querySelector\\(\\s*['"\`]#${name}['"\`]\\s*\\))`;
    const holders = [...code.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:document\\s*\\.\\s*)?${lookup}`, 'g'))].map((m) => m[1]);
    const onLine =
      new RegExp(lookup).test(lineText) || holders.some((h) => new RegExp(`(?<![\\w$.])${h}\\b`).test(lineText)) || error.includes(`'${id}'`);
    if (!onLine) continue;
    const member = error.match(/\.([A-Za-z_$][\w$]*)'? is (?:not a function|undefined)/)?.[1];
    const call = !!member && /is not a function/.test(error);
    const stoodIn = made === 'empty' ? `an empty <${tag}> stood in for it` : `the <${tag}> it made last stood in for it`;
    const missing = `#${id} was never created: the program has no element with that id, so ${stoodIn}${member ? ` (a <${tag}> has no ${member}${call ? '()' : ''})` : ''}.`;
    // Looked up as an element but used as something else (a MIDI output, an audio node, a
    // drawing context): that is the mistake, not a missing element (value-use.ts)
    const uses = holders.map((h) => usedAs(code, h)).filter((u): u is NonNullable<typeof u> => !!u);
    // The members it is used with (on the lookup itself or on a name that holds it) belong to one browser type that the
    // program already has a value of (a 2D context for clearRect and translate): that value is the one to use
    const reached = [
      ...new Set([
        ...[...code.matchAll(new RegExp(`${lookup}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'))].map((m) => m[1]),
        ...holders.flatMap((h) => valueUse(code, h)?.members ?? []),
      ]),
    ];
    const kind = reached.length > 0 ? browserTypeWith(reached, page?.scope) : null;
    const tree = kind ? analyse(code) : null;
    const mine = tree ? [...new Set(tree.nodes.filter((n) => n.type === 'VariableDeclarator' && (n.id as AnyNode).type === 'Identifier').map((n) => (n.id as AnyNode).name as string))].filter((name) => !holders.includes(name) && bindingTypeOf(code, tree, name) === kind) : [];
    if (kind && mine.length === 1) {
      return { text: `${missing} ${reached.slice(0, 3).map((m) => `${m}()`).join(' and ')} ${reached.length > 1 ? 'are' : 'is'} used on it, but ${reached.length > 1 ? 'they belong' : 'it belongs'} to a ${kind}, and the program already has one: ${mine[0]}. Use ${mine[0]}.${reached[0]}(…) and leave the page element out.` };
    }
    if (uses.length > 0) {
      // Used only as send([…]): surely the MIDI output, and Chatty has one ready (out)
      if (holders.length > 0 && holders.every((h) => onlySendsLists(code, h))) {
        const swapped = code.replace(
          new RegExp(`((?:const|let|var)\\s+(?:${holders.join('|')})\\s*=\\s*)(?:document\\s*\\.\\s*)?${lookup}`, 'g'),
          '$1out'
        );
        if (swapped !== code && parseErrorLine(swapped) === 0) {
          return { correction: { code: swapped, note: `#${id} was used only as a MIDI output (send) → the ready MIDI output, out` } };
        }
      }
      return { text: `${missing} ${uses[0].text}` };
    }
    let text = `${missing} Create the element it needs with document.createElement and give it id "${id}".`;
    if (member && SOUND_MEMBER.test(member)) text += ' Notes play through Tone: a synth such as Tone.PolySynth connected with .toDestination(), played with synth.triggerAttackRelease(note, duration, time).';
    return { text };
  }
  return null;
}

/** What each ready-made helper is, for a program that declares its own of the same name */
const HELPER_ROLES: Record<string, string> = {
  speak: 'speak(text) says text to the user',
  clear: 'clear() empties the card',
  out: 'out.send({ notes, … }) plays notes',
  root: 'root is the card element',
};

/**
 * A program that declares a name Chatty already provides (`const speak = () => { …the whole
 * program… }`): the browser says it is declared twice, which doesn't tell the model why. Works on
 * programs that don't parse too, since the declaration is found by its shape.
 */
function helperDeclared(code: string, error: string): ErrorHint | null {
  const named = error.match(/(?:already been declared|declare a const variable twice|redeclaration of|Cannot redeclare|duplicate)[^'"]*['"]?([A-Za-z_$][\w$]*)/i)?.[1]
    ?? error.match(/['"]([A-Za-z_$][\w$]*)['"] has already been declared/)?.[1];
  const declared = HELPERS.filter((h) => new RegExp(`\\b(?:const|let|var|function|class)\\s+${h}\\b`).test(code));
  const helper = named && HELPERS.includes(named) ? named : declared.length === 1 && /declared|declare|redeclar/i.test(error) ? declared[0] : null;
  if (!helper) return null;
  return {
    text: `${helper} is ready-made in Chatty: ${HELPER_ROLES[helper]}. Use it as it is, and give the program's own functions and variables other names (for example main).`,
  };
}

/**
 * Properties a program sets, that small models call like methods (ctx.fillStyle("red")): the
 * browser's CanvasRenderingContext2D properties, and the element properties programs set most.
 * For an object whose type can't be told; a known type answers from its own descriptors.
 */
const SETTABLE = new Set([
  'fillStyle', 'strokeStyle', 'font', 'lineWidth', 'globalAlpha', 'textAlign', 'textBaseline', 'lineCap', 'lineJoin',
  'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY', 'globalCompositeOperation', 'filter', 'imageSmoothingEnabled',
  'textContent', 'innerText', 'innerHTML', 'value', 'src', 'className', 'title', 'placeholder', 'disabled', 'checked',
]);

/**
 * `x.fillStyle is not a function`: each `x.fillStyle(value)` statement becomes `x.fillStyle = value`.
 * Which names are properties, the browser's own descriptors say when the object's type is known
 * (any property that can be set, on any type: el.hidden(true), input.value(5); not one with only
 * a getter, el.children(…)); the list above is for an object whose type can't be told.
 */
function propertyCalled(code: string, error: string): ErrorHint | null {
  const missing = missingMethod(error);
  if (!missing) return null;
  const { object, method: prop } = missing;
  const type = objectType(code, object);
  const kind = type && !type.startsWith('@') ? memberKind(type, prop) : null;
  const settable = kind === 'property' ? memberNames(type!).includes(prop) && writability(type!, prop) !== 'read-only' : kind === null && SETTABLE.has(prop);
  if (!settable) return null;
  const ast = tryParse(code);
  if (!ast) return null;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  walk(ast, (node) => {
    if (node.type !== 'ExpressionStatement') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = node.expression as any;
    if (call.type !== 'CallExpression' || call.arguments.length !== 1 || call.callee.type !== 'MemberExpression' || call.callee.computed) return;
    if (call.callee.property.name !== prop || code.slice(call.callee.object.start, call.callee.object.end) !== object) return;
    const arg = call.arguments[0] as AnyNode;
    edits.push({ start: call.start, end: call.end, text: `${object}.${prop} = ${code.slice(arg.start, arg.end)}` });
  });
  if (edits.length === 0) return null;
  let fixed = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) fixed = fixed.slice(0, e.start) + e.text + fixed.slice(e.end);
  return tryParse(fixed) ? { correction: { code: fixed, note: `${object}.${prop}(value) → ${object}.${prop} = value` } } : null;
}

/**
 * A method a browser type doesn't have, with no real method close to it, named like a property
 * (`gl.shaderType()`), in a statement whose result is unused: it can never do anything, so it is
 * taken out and the rest runs
 */
function unknownCallDropped(code: string, error: string, errorLine?: number): ErrorHint | null {
  const missing = missingMethod(error);
  if (!missing || !errorLine) return null;
  // Only a name that reads like a property (shaderType, getSize, isReady), not like an action
  // (fillCircle, vanish): an action was meant to happen, and is the model's to fix
  if (!/^(?:get|is|has)[A-Z]|(?:Type|Name|Size|Count|Length|Id|Value|Data|Info|Mode|State|Status|Index|Width|Height|Color|Format|Kind)$/.test(missing.method)) return null;
  const type = objectType(code, missing.object);
  if (!type || type.startsWith('@')) return null;
  const ast = tryParse(code);
  if (!ast) return null;
  let target: AnyNode | null = null;
  walk(ast, (node) => {
    if (target || node.type !== 'ExpressionStatement' || (node.loc as { start: { line: number } } | undefined)?.start.line !== errorLine) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = node.expression as any;
    if (call.type !== 'CallExpression' || call.callee.type !== 'MemberExpression' || call.callee.computed) return;
    if (call.callee.property.name !== missing.method || code.slice(call.callee.object.start, call.callee.object.end) !== missing.object) return;
    target = node;
  });
  if (!target) return null;
  const { start, end } = target as AnyNode;
  const fixed = code.slice(0, start) + code.slice(end);
  return tryParse(fixed)
    ? { correction: { code: fixed, note: `${missing.object}.${missing.method}() doesn't exist and its result isn't used → taken out` } }
    : null;
}

/** AudioParam's methods that take a value and the time it is reached: at 0, a time already past, the value is set now */
const TIMED_PARAM_METHODS = ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime'];

/**
 * A timed AudioParam call without its time (the browser needs two values; Chrome and Firefox
 * name the method): every one-value call of that method gets 0, a time already past, which sets
 * the value now
 */
function audioParamTime(code: string, error: string): ErrorHint | null {
  const methods = TIMED_PARAM_METHODS.join('|');
  const named =
    error.match(new RegExp(`'(${methods})' on 'AudioParam': 2 arguments required`))?.[1] ??
    error.match(new RegExp(`AudioParam\\.(${methods}): At least 2 arguments?`))?.[1];
  if (!named) return null;
  const ast = tryParse(code);
  if (!ast) return null;
  const ends: number[] = [];
  walk(ast, (node) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = node as any;
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.property.name === named && n.arguments.length === 1) {
      ends.push(n.arguments[0].end);
    }
  });
  if (ends.length === 0) return null;
  let fixed = code;
  for (const at of ends.sort((a, b) => b - a)) fixed = `${fixed.slice(0, at)}, 0${fixed.slice(at)}`;
  return tryParse(fixed) ? { correction: { code: fixed, note: `${named}(value) → ${named}(value, 0): a time already past sets it now` } } : null;
}

/** Whether a value is a function made with `class` (its source says so) */
function isEsClass(value: unknown): boolean {
  if (typeof value !== 'function') return false;
  try {
    return /^class\b/.test(Function.prototype.toString.call(value));
  } catch {
    return false;
  }
}

/**
 * `new` in front of every call of a class: a class called as a function (`Tone.PolySynth()`,
 * `THREE.Mesh(…)`, the program's own `Ball()`) always throws, in every browser, and made with new
 * is the one way it works. Every call whose callee is a plain name or a chain of names (a call in
 * the chain, `make().Ball()`, would change what `new` applies to) and resolves to a real `class`: in
 * the page (Tone, THREE, whatever the page has: `scope`), or declared by the program itself. A native
 * function (Number, String, Date, Symbol) and a function written to work without `new` are not
 * classes, and stay. All of them at once; the result must parse. Null when no call needs it.
 */
export function addNewToClasses(code: string, scope?: Record<string, unknown>, onlyNamed?: string): { code: string; count: number; names: string[] } | null {
  const tree = analyse(code);
  if (!tree) return null;
  const chainOfNames = (node: AnyNode): boolean =>
    node.type === 'Identifier' || node.type === 'ThisExpression' || (node.type === 'MemberExpression' && !node.computed && chainOfNames(node.object as AnyNode));
  const starts: number[] = [];
  const names = new Set<string>();
  for (const node of tree.nodes) {
    if (node.type !== 'CallExpression') continue;
    const callee = node.callee as AnyNode;
    if (!chainOfNames(callee)) continue;
    const last = callee.type === 'Identifier' ? (callee.name as string) : callee.type === 'MemberExpression' ? ((callee.property as AnyNode).name as string) : null;
    if (!last) continue;
    const text = code.slice(callee.start, callee.end).replace(/\s+/g, '');
    let isClass = !!scope && isEsClass(valueOfPath(code, text, scope));
    // A class the program declares (`class Ball {}`, `const Ball = class {}`), called by its name
    if (!isClass && callee.type === 'Identifier') {
      const home = resolve(tree, callee, last);
      if (home) {
        const declaration = tree.nodes.find((n) => (n.type === 'ClassDeclaration' && (n.id as AnyNode | null)?.name === last && resolve(tree, n.id as AnyNode, last) === home) || (n.type === 'VariableDeclarator' && (n.id as AnyNode).type === 'Identifier' && (n.id as AnyNode).name === last && (n.init as AnyNode | null)?.type === 'ClassExpression' && resolve(tree, n.id as AnyNode, last) === home));
        isClass = !!declaration;
      }
    }
    // (or a class the error named, when the page can't say: the Chrome wording)
    if (!isClass && onlyNamed !== undefined && last === onlyNamed) isClass = true;
    if (!isClass) continue;
    starts.push(callee.start);
    names.add(last);
  }
  if (starts.length === 0) return null;
  let fixed = code;
  for (const at of [...new Set(starts)].sort((a, b) => b - a)) fixed = `${fixed.slice(0, at)}new ${fixed.slice(at)}`;
  return tryParse(fixed) ? { code: fixed, count: new Set(starts).size, names: [...names] } : null;
}

/**
 * A class called as a function, after the error: "Class constructor PolySynth cannot be invoked
 * without 'new'" (Chrome), "Cannot call a class constructor e without |new|" (Safari), "Cannot call
 * a class as a function" and "Class constructors must be invoked with 'new'" (Firefox and others).
 * The error may not name the class, or may name one the bundle shortened ("e"), and its line may be
 * inside the library: none of that matters, since every call of a class gets `new` (addNewToClasses).
 */
function classCalledWithoutNew(code: string, error: string, _errorLine?: number, scope?: Record<string, unknown>): ErrorHint | null {
  // (the library's own name for the class, "Tone.PolySynth", when the error was given it: the last part is the class)
  const named = error.match(/^Class constructor ([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*) cannot be invoked without 'new'/)?.[1]?.split('.').pop();
  const anyClass = /Cannot call a class constructor \S+ without \|new\||Cannot call a class as a function|class constructors must be invoked with 'new'|^Class constructor/i.test(error);
  if (!named && !anyClass) return null;
  const added = addNewToClasses(code, scope, named);
  if (!added) return null;
  const label = added.names.join(', ');
  return { correction: { code: added.code, note: `${label}() → new ${label}(): a class is made with new` } };
}

/**
 * A factory called on a class that has none (`Tone.Loop.create(cb, "4n")`, `Ball.make(1)`): a class is
 * made with new, and its arguments are the same. The class is a real `class` the page or the program
 * has, the method is a factory by its name (create, make, new, build, construct), and the class has no
 * such member; every such call becomes `new Class(args)`. The result must parse.
 */
function classFactory(code: string, error: string, scope?: Record<string, unknown>): ErrorHint | null {
  const missing = missingMethod(error);
  if (!missing || !/^(?:create|make|new|build|construct|instance)$/.test(missing.method)) return null;
  const value = scope ? valueOfPath(code, missing.object, scope) : undefined;
  const own = !value && /^[A-Za-z_$][\w$]*$/.test(missing.object) && new RegExp(`\\bclass\\s+${missing.object.replace(/\$/g, '\\$')}\\b`).test(code);
  if (!isEsClass(value) && !own) return null;
  if (isEsClass(value) && typeof (value as Record<string, unknown>)[missing.method] === 'function') return null;
  const ast = tryParse(code);
  if (!ast) return null;
  const edits: Array<{ start: number; end: number }> = [];
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as AnyNode;
    if (callee.type !== 'MemberExpression' || callee.computed || (callee.property as AnyNode).name !== missing.method) return;
    if (code.slice((callee.object as AnyNode).start, (callee.object as AnyNode).end).replace(/\s+/g, '') !== missing.object) return;
    edits.push({ start: callee.start, end: callee.end });
  });
  if (edits.length === 0) return null;
  let fixed = code;
  for (const edit of edits.sort((a, b) => b.start - a.start)) fixed = `${fixed.slice(0, edit.start)}new ${missing.object}${fixed.slice(edit.end)}`;
  return tryParse(fixed) ? { correction: { code: fixed, note: `${missing.object}.${missing.method}(…) → new ${missing.object}(…): a class is made with new` } } : null;
}

/**
 * A page written inside a template literal that has a script in it, with template literals of its own
 * (`document.body.innerHTML = \`<script> … cell.innerHTML = \`<span>${x}</span>\` … </script>\``): the first backtick in
 * the script ends the outer string and the program stops with "Unexpected token". Inside each `<script>` of the
 * program the backticks and `${` are escaped, so they are the script's own. Only when the program does not
 * parse as it is and parses so; null otherwise.
 */
export function escapeScriptBackticks(code: string): { code: string; scripts: number } | null {
  if (tryParse(code) || !/<script\b/i.test(code) || !/`/.test(code)) return null;
  let scripts = 0;
  const fixed = code.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (whole, open: string, body: string, close: string) => {
    if (!/`|\$\{/.test(body)) return whole;
    scripts++;
    return `${open}${body.replace(/\\?`/g, '\\`').replace(/\\?\$\{/g, '\\${')}${close}`;
  });
  return scripts > 0 && fixed !== code && tryParse(fixed) ? { code: fixed, scripts } : null;
}

/**
 * A factory the object doesn't have, handed the class it should make (`Tone.create(Tone.PolySynth)`,
 * `Tone.make("Synth")`): the object has no such function, but it has the class named in the first
 * argument, and a class is made with new, so the call becomes `new Tone.PolySynth(rest)`. The
 * object is a real one the page has (not one the program declared), the member is missing from
 * it, and every such call names a class; the result must parse.
 */
function factoryOfClass(code: string, error: string, scope?: Record<string, unknown>): ErrorHint | null {
  const missing = missingMethod(error);
  if (!missing || !scope) return null;
  // Only a method that is a factory by its name (create, make, new, build): `Tone.play(Tone.Synth, "C4")`
  // plays something, and is not a way of making a Synth
  if (!/^(?:create|make|new|build)(?![a-z])/.test(missing.method)) return null;
  const real = realMembers(code, missing.object, scope);
  if (!real || real.members.some((m) => m.name === missing.method)) return null;
  const classes = new Set(real.members.filter((m) => m.kind === 'class').map((m) => m.name));
  const suffix = missing.method.match(/^(?:create|make|new|build)([A-Z]\w*)$/)?.[1];
  const madeOf = suffix && classes.has(suffix) ? suffix : null;
  const ast = tryParse(code);
  if (!ast) return null;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let others = false;
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as AnyNode;
    if (callee.type !== 'MemberExpression' || callee.computed || (callee.property as AnyNode).name !== missing.method || code.slice((callee.object as AnyNode).start, (callee.object as AnyNode).end) !== missing.object) return;
    const args = node.arguments as AnyNode[];
    const first = args[0];
    const named =
      first?.type === 'MemberExpression' && !first.computed && code.slice((first.object as AnyNode).start, (first.object as AnyNode).end) === missing.object
        ? ((first.property as AnyNode).name as string)
        : first?.type === 'Literal' && typeof first.value === 'string'
          ? first.value
          : null;
    // No class handed over, but the method's own name has one (Tone.createPolySynth(…)): all its arguments are the class's
    if ((!named || !classes.has(named)) && madeOf) {
      edits.push({ start: node.start, end: node.end, text: `new ${missing.object}.${madeOf}(${args.map((arg) => code.slice(arg.start, arg.end)).join(', ')})` });
      return;
    }
    if (!named || !classes.has(named)) {
      others = true;
      return;
    }
    const rest = args.slice(1).map((arg) => code.slice(arg.start, arg.end)).join(', ');
    edits.push({ start: node.start, end: node.end, text: `new ${missing.object}.${named}(${rest})` });
  });
  if (edits.length === 0 || others) return null;
  let fixed = code;
  for (const edit of edits.sort((a, b) => b.start - a.start)) fixed = fixed.slice(0, edit.start) + edit.text + fixed.slice(edit.end);
  return tryParse(fixed) ? { correction: { code: fixed, note: `${missing.object}.${missing.method}(…) → ${edits.length > 1 ? 'new …' : edits[0].text.replace(/\(.*$/, '(…)')}: a class is made with new` } } : null;
}

/**
 * `new` on a real object that is no class (`new Tone.Transport()`, `new Math()`): the browser says
 * "X is not a constructor". X, found in the page, is an object (not a function, not undefined),
 * and the new takes no arguments: the object itself is meant, so `new X()` becomes `X`. With
 * arguments, or any other X, nothing is changed. The result must parse.
 */
function newOnObject(code: string, error: string, scope?: Record<string, unknown>): ErrorHint | null {
  const named =
    error.match(/\(evaluating 'new ((?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*)\(/)?.[1] ??
    error.match(/(?:^|\s)((?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*) is not a constructor/)?.[1];
  if (!named || !scope) return null;
  const value = valueOfPath(code, named, scope);
  if (value === null || typeof value !== 'object') return null;
  const ast = tryParse(code);
  if (!ast) return null;
  const cuts: Array<{ start: number; end: number }> = [];
  walk(ast, (node) => {
    if (node.type !== 'NewExpression' || (node.arguments as AnyNode[]).length > 0) return;
    const callee = node.callee as AnyNode;
    if (code.slice(callee.start, callee.end).replace(/\s+/g, '') === named) cuts.push({ start: node.start, end: node.end });
  });
  if (cuts.length === 0) return null;
  let fixed = code;
  for (const cut of cuts.sort((a, b) => b.start - a.start)) fixed = fixed.slice(0, cut.start) + named + fixed.slice(cut.end);
  return tryParse(fixed) ? { correction: { code: fixed, note: `new ${named}() → ${named}: ${named} is an object, not a class` } } : null;
}

/**
 * Whether a name stands for a value the program hasn't made yet where it is used: a `let`/`var`
 * declared with nothing to start it (or only null/undefined), a parameter, or a loop's item. A
 * const, or a variable an expression made, got its value from that expression: when it came out
 * undefined the expression is the mistake, and calling through `?.` would only hide it. Every
 * declaration of the name has to be of the first kind.
 */
function notMadeYet(code: string, name: string): boolean {
  const tree = analyse(code);
  if (!tree) return false;
  const sites = [...tree.bindings].filter((id) => id.name === name);
  return (
    sites.length > 0 &&
    sites.every((id) => {
      // Up out of a destructuring pattern to what declares it
      let at = id;
      for (let up = tree.parent.get(at); up && /^(?:ObjectPattern|ArrayPattern|RestElement|AssignmentPattern|Property)$/.test(up.type); up = tree.parent.get(at)) at = up;
      const owner = tree.parent.get(at);
      if (!owner) return false;
      if (/Function/.test(owner.type) && tree.key.get(at) === 'params') return true;
      if (owner.type !== 'VariableDeclarator' || tree.key.get(at) !== 'id') return false;
      const declaration = tree.parent.get(owner)!;
      const loop = tree.parent.get(declaration);
      if ((loop?.type === 'ForOfStatement' || loop?.type === 'ForInStatement') && tree.key.get(declaration) === 'left') return true;
      if (at !== id || declaration.kind === 'const') return false;
      const init = owner.init;
      return !init || (init.type === 'Literal' && init.value === null) || (init.type === 'Identifier' && init.name === 'undefined') || (init.type === 'UnaryExpression' && init.operator === 'void');
    })
  );
}

/**
 * A method called on undefined, in a statement of its own (`p.stop()` when p is undefined):
 * when the value comes from the program's own function that returns nothing but ends in a call
 * (`notes.map((n) => play(n))`, `const p = play(n)`), that call is returned; otherwise, for a
 * value the program hasn't made yet (`let osc; … osc.stop()`, a callback's item), the call is made
 * only if there is something to call (`p?.stop?.()`). A const or a variable an expression made is
 * left to the other hints: its expression is what gave undefined. Only the failing statement.
 */
function callOnUndefined(code: string, error: string, errorLine?: number): ErrorHint | null {
  const safari = error.match(/undefined is not an object \(evaluating '([\w$.]+)\.([\w$]+)'\)/);
  const chrome = error.match(/Cannot read propert(?:y|ies) of undefined \(reading '([\w$]+)'\)/);
  if ((!safari && !chrome) || !errorLine) return null;
  const method = safari ? safari[2] : chrome![1];
  const ast = tryParse(code);
  if (!ast) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let call: any = null;
  walk(ast, (node) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = node as any;
    if (call || n.type !== 'ExpressionStatement' || n.loc?.start.line !== errorLine) return;
    const c = n.expression;
    if (c.type !== 'CallExpression' || c.callee.type !== 'MemberExpression' || c.callee.computed || c.callee.property.name !== method) return;
    if (c.callee.object.type !== 'Identifier' || (safari && safari[1] !== c.callee.object.name)) return;
    call = c;
  });
  if (!call) return null;
  const receiver: string = call.callee.object.name;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes: any[] = [];
  walk(ast, (node) => nodes.push(node));
  const source = (n: { start: number; end: number }) => code.slice(n.start, n.end);
  // The function whose call made the value: `const p = f(…)`, or `xs.forEach((p) => …)` / a
  // callback over `xs` where `xs = ys.map((n) => f(…))`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calledIn = (expr: any): string | null => (expr?.type === 'CallExpression' && expr.callee.type === 'Identifier' ? expr.callee.name : null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapped = (expr: any): string | null => {
    if (expr?.type !== 'CallExpression' || expr.callee.type !== 'MemberExpression' || expr.callee.property?.name !== 'map') return null;
    const cb = expr.arguments[0];
    return cb && /Function/.test(cb.type) && cb.body.type !== 'BlockStatement' ? calledIn(cb.body) : null;
  };
  let maker: string | null = null;
  for (const n of nodes) {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === receiver) maker = calledIn(n.init);
    // A callback whose first parameter is the receiver, over a list made by mapping
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && /^(?:forEach|map|filter|some|every)$/.test(n.callee.property?.name ?? '')) {
      const cb = n.arguments[0];
      if (!cb || !/Function/.test(cb.type) || cb.params[0]?.type !== 'Identifier' || cb.params[0].name !== receiver) continue;
      const list = n.callee.object;
      maker =
        mapped(list) ??
        (list.type === 'Identifier' ? mapped(nodes.find((d) => d.type === 'VariableDeclarator' && d.id.type === 'Identifier' && d.id.name === list.name)?.init) : null) ??
        maker;
    }
  }
  // The program's function of that name: declared, or a function or arrow with a block body held
  // in a const/let/var (the parser's other shapes of the same thing)
  const functionNamed = (name: string) =>
    nodes.find((n) => n.type === 'FunctionDeclaration' && n.id?.name === name) ??
    nodes.find((n) => n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === name && /Function/.test(n.init?.type ?? '') && n.init.body?.type === 'BlockStatement')?.init;
  const fn = maker ? functionNamed(maker) : null;
  if (fn) {
    let returns = false;
    walk(fn.body, (n) => {
      if (n.type === 'ReturnStatement' && (n as AnyNode).argument) returns = true;
    });
    const last = fn.body.body[fn.body.body.length - 1];
    if (!returns && last?.type === 'ExpressionStatement' && /^(?:Call|New)Expression$/.test(last.expression.type)) {
      const fixed = `${code.slice(0, last.start)}return ${code.slice(last.start)}`;
      if (tryParse(fixed)) return { correction: { code: fixed, note: `${maker}() returns nothing, so ${receiver}.${method}() had nothing to call → it returns its last call` } };
    }
  }
  if (!notMadeYet(code, receiver)) return null;
  const optional = `${source(call.callee.object)}?.${method}?.${code.slice(call.callee.end, call.end).trimStart()}`;
  const fixed = `${code.slice(0, call.start)}${optional}${code.slice(call.end)}`;
  return tryParse(fixed) ? { correction: { code: fixed, note: `${receiver}.${method}() on nothing → ${receiver}?.${method}?.(): called only when there is something to call` } } : null;
}

/**
 * Before a program runs: a key read from the program's own object literal that the literal
 * doesn't have, with exactly one close key it does (`sounds.drum` for `drums`, `notes['boom_kick']`
 * for `boomKick`), is renamed to that key. Only for a literal declared once and never changed or
 * handed elsewhere, so its keys are all it will ever have.
 */
export function fixKeySlips(code: string): { code: string; fixed: Array<{ object: string; from: string; to: string }> } {
  const ast = tryParse(code);
  if (!ast) return { code, fixed: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes: Array<{ node: any; parent: any; key: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visit = (node: any, parent: any, key: string) => {
    if (!node || typeof node.type !== 'string') return;
    nodes.push({ node, parent, key });
    for (const k of Object.keys(node)) {
      if (k === 'loc') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, node, k));
      else if (v && typeof v.type === 'string') visit(v, node, k);
    }
  };
  visit(ast, null, '');
  const keyOf = (p: { type: string; key?: { type: string; name?: string; value?: unknown }; computed?: boolean }) =>
    p.type === 'Property' && !p.computed ? (p.key!.type === 'Identifier' ? p.key!.name! : typeof p.key!.value === 'string' ? (p.key!.value as string) : null) : null;
  // An object's keys: a plural for its singular counts as a slip (sounds.drum for drums)
  const close = (wanted: string, keys: string[]) => {
    const match = sureMatch(wanted, keys, { plural: true });
    return match ? [match] : [];
  };
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const fixed: Array<{ object: string; from: string; to: string }> = [];
  for (const { node: decl } of nodes) {
    if (decl.type !== 'VariableDeclarator' || decl.id.type !== 'Identifier' || decl.init?.type !== 'ObjectExpression') continue;
    const name: string = decl.id.name;
    const keys = decl.init.properties.map(keyOf);
    if (keys.some((k: string | null) => k === null)) continue; // spread or computed keys
    // Declared once, with no other binding of the name anywhere
    const bindings = nodes.filter(
      ({ node, parent, key }) =>
        node.type === 'Identifier' &&
        node.name === name &&
        ((parent?.type === 'VariableDeclarator' && key === 'id') || key === 'params' || (/Function/.test(parent?.type ?? '') && key === 'id'))
    );
    if (bindings.length !== 1) continue;
    // Its own methods add to it (init() { this.balls = […] }): its keys aren't all in the literal
    let addsToItself = false;
    walk(decl.init, (node) => {
      const target = node.type === 'AssignmentExpression' ? (node.left as AnyNode) : node.type === 'UpdateExpression' ? (node.argument as AnyNode) : null;
      if (target?.type === 'MemberExpression' && (target.object as AnyNode).type === 'ThisExpression') addsToItself = true;
    });
    if (addsToItself) continue;
    const reads: Array<{ member: any; wanted: string }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let safe = true;
    for (const { node, parent, key } of nodes) {
      if (node.type !== 'Identifier' || node.name !== name || node === decl.id) continue;
      if ((parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) || (parent?.type === 'Property' && key === 'key' && !parent.computed)) continue;
      if (parent?.type === 'MemberExpression' && key === 'object') {
        const grand = nodes.find((n) => n.node === parent);
        const written = (grand?.parent?.type === 'AssignmentExpression' && grand.key === 'left') || grand?.parent?.type === 'UpdateExpression' || (grand?.parent?.type === 'UnaryExpression' && grand.parent.operator === 'delete');
        if (written) {
          safe = false;
          break;
        }
        const wanted = !parent.computed ? parent.property.name : parent.property.type === 'Literal' && typeof parent.property.value === 'string' ? parent.property.value : null;
        if (wanted !== null) reads.push({ member: parent, wanted });
        continue;
      }
      // Read whole: its keys listed, or looped over
      const keysCall = parent?.type === 'CallExpression' && key === 'arguments' && /^Object\.(?:keys|values|entries)$|^JSON\.stringify$/.test(code.slice(parent.callee.start, parent.callee.end));
      if (keysCall || ((parent?.type === 'ForInStatement' || parent?.type === 'ForOfStatement') && key === 'right')) continue;
      safe = false; // handed elsewhere: it may be changed there
      break;
    }
    if (!safe) continue;
    for (const { member, wanted } of reads) {
      if (keys.includes(wanted) || wanted in Object.prototype) continue;
      const near = close(wanted, keys);
      if (near.length !== 1) continue;
      const to = near[0];
      if (!member.computed) edits.push({ start: member.property.start, end: member.property.end, text: to });
      else edits.push({ start: member.property.start + 1, end: member.property.end - 1, text: to });
      if (!fixed.some((f) => f.object === name && f.from === wanted)) fixed.push({ object: name, from: wanted, to });
    }
  }
  if (edits.length === 0) return { code, fixed: [] };
  let out = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return tryParse(out) ? { code: out, fixed } : { code, fixed: [] };
}

/**
 * Before a program runs: a function handed to requestAnimationFrame that moves things (changes
 * state kept outside it: `ball.x += 5`) but never asks for another frame runs once, since a
 * frame request is good for one frame. It gets `requestAnimationFrame(itself)` at its end, so the
 * motion goes on.
 */
export function loopOneFrameAnimations(code: string): { code: string; looped: string[]; atLines: number[] } {
  const tree = analyse(code);
  if (!tree) return { code, looped: [], atLines: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const functions = new Map<string, any>();
  for (const n of tree.nodes as AnyNode[]) {
    if (n.type === 'FunctionDeclaration' && n.id) functions.set((n.id as AnyNode).name as string, n);
    if (n.type === 'VariableDeclarator' && (n.id as AnyNode).type === 'Identifier' && /^(?:Arrow)?FunctionExpression$/.test((n.init as AnyNode | null)?.type ?? '') && ((n.init as AnyNode).body as AnyNode).type === 'BlockStatement') functions.set((n.id as AnyNode).name as string, n.init);
  }
  // requestAnimationFrame, setTimeout, setInterval, called bare or on window (window.requestAnimationFrame)
  const calledName = (callee: AnyNode): string | null =>
    callee.type === 'Identifier' ? (callee.name as string) : callee.type === 'MemberExpression' && !callee.computed ? (((callee.property as AnyNode).name as string) ?? null) : null;
  const SCHEDULERS = /^(?:requestAnimationFrame|setTimeout|setInterval)$/;
  // A function a handler runs (a click, a key: a Step button asking for one frame per press)
  const inHandler = (node: AnyNode): boolean => {
    for (let at = tree.parent.get(node); at; at = tree.parent.get(at)) {
      if (!/Function/.test(at.type)) continue;
      const up = tree.parent.get(at);
      if (up?.type === 'CallExpression' && calledName(up.callee as AnyNode) === 'addEventListener' && (up.arguments as AnyNode[]).includes(at)) return true;
      if (up?.type === 'AssignmentExpression' && up.right === at && (up.left as AnyNode).type === 'MemberExpression' && /^on[a-z]+$/.test(String(((up.left as AnyNode).property as AnyNode)?.name ?? ''))) return true;
    }
    return false;
  };
  const requested = new Set<string>();
  for (const n of tree.nodes as AnyNode[]) {
    if (n.type === 'CallExpression' && calledName(n.callee as AnyNode) === 'requestAnimationFrame' && (n.arguments as AnyNode[])[0]?.type === 'Identifier' && !inHandler(n)) {
      requested.add((n.arguments as AnyNode[])[0].name as string);
    }
  }
  /** Whether a function asks for its next step itself, or through a function it calls (scheduleNext()) */
  const scheduling = (fn: AnyNode, seen = new Set<AnyNode>()): boolean => {
    if (seen.has(fn)) return false;
    seen.add(fn);
    let found = false;
    walk(fn.body as AnyNode, (node) => {
      if (found || node.type !== 'CallExpression') return;
      const name = calledName(node.callee as AnyNode);
      if (!name) return;
      if (SCHEDULERS.test(name)) found = true;
      else if ((node.callee as AnyNode).type === 'Identifier' && functions.has(name) && scheduling(functions.get(name), seen)) found = true;
    });
    return found;
  };
  // A function something else keeps going (setInterval(update, 50), or a loop that calls it and
  // asks for its own next frame) has its pace: the one frame asked for it is its first step only
  const driven = new Set<string>();
  for (const n of tree.nodes as AnyNode[]) {
    if (n.type !== 'CallExpression') continue;
    const name = calledName(n.callee as AnyNode);
    const first = (n.arguments as AnyNode[])[0];
    if (name && /^(?:setTimeout|setInterval)$/.test(name) && first?.type === 'Identifier') driven.add(first.name as string);
  }
  for (const [name, fn] of functions) {
    if (!scheduling(fn)) continue;
    walk(fn.body as AnyNode, (node) => {
      const callee = node.callee as AnyNode | undefined;
      if (node.type === 'CallExpression' && callee?.type === 'Identifier' && callee.name !== name) driven.add(callee.name as string);
    });
  }
  const edits: Array<{ at: number; text: string; name: string }> = [];
  for (const name of requested) {
    const fn = functions.get(name);
    if (!fn || driven.has(name)) continue;
    const own = new Set<string>();
    let schedules = false;
    let moves = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root = (target: any): string | null => {
      while (target?.type === 'MemberExpression') target = target.object;
      return target?.type === 'Identifier' ? target.name : null;
    };
    for (const p of fn.params) if (p.type === 'Identifier') own.add(p.name);
    walk(fn.body, (node) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = node as any;
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') own.add(n.id.name);
    });
    if (scheduling(fn)) schedules = true;
    walk(fn.body, (node) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = node as any;
      const target = n.type === 'AssignmentExpression' && n.operator !== '=' ? n.left : n.type === 'UpdateExpression' ? n.argument : null;
      const name = target ? root(target) : null;
      if (name && !own.has(name)) moves = true;
    });
    if (schedules || !moves) continue;
    const statements = fn.body.body;
    const first = statements[0];
    const indent = first ? code.slice(code.lastIndexOf('\n', first.start - 1) + 1, first.start).match(/^\s*/)?.[0] ?? '  ' : '  ';
    edits.push({ at: fn.body.end - 1, text: `${indent}requestAnimationFrame(${name});\n`, name });
  }
  if (edits.length === 0) return { code, looped: [], atLines: [] };
  // (the lines, in the program as it was, that the new lines go after: later lines move down one)
  const atLines = edits.map((e) => code.slice(0, e.at).split('\n').length - 1);
  let out = code;
  for (const e of edits.sort((a, b) => b.at - a.at)) {
    const before = out.slice(0, e.at).replace(/[ \t]*$/, '');
    out = `${before}${before.endsWith('\n') ? '' : '\n'}${e.text}${out.slice(e.at)}`;
  }
  return tryParse(out) ? { code: out, looped: edits.map((e) => e.name), atLines } : { code, looped: [], atLines: [] };
}

/** Methods that give an iterator (which has next(), not an index) */
const ITERATOR_MAKERS = /^(?:values|keys|entries)$/;

/**
 * Before a program runs: an iterator read as if it were the item or a list.
 * - `const output = midi.outputs.values().next()` keeps the iterator's result ({ value, done }),
 *   not the item. Used for anything but its value and done (output.send), it was meant to be the
 *   item: `.next().value`.
 * - `midi.outputs.values()[0]` is always undefined, whatever the receiver: an iterator has no index
 *   properties. It was meant to index the items: `[...midi.outputs.values()][0]`. Left alone: one
 *   already spread, a `?.` chain (a spread of nothing throws where the chain gives undefined), a
 *   string or Symbol key (`it.values()['next']`), and a values()/keys()/entries() the program
 *   defines itself (it may return a list).
 * `fixed` names the declaration for the first, and says `from → to` for the second.
 */
export function fixIteratorResults(code: string): { code: string; fixed: string[] } {
  const ast = tryParse(code);
  if (!ast) return { code, fixed: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const declarators: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const indexed: any[] = [];
  const own = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const members = new Map<string, Set<string>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const optional = (e: any): boolean => {
    for (let at = e; at; at = at.type === 'CallExpression' ? at.callee : at.type === 'MemberExpression' ? at.object : at.type === 'ChainExpression' ? at.expression : null) if (at.optional) return true;
    return false;
  };
  walk(ast, (node) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = node as any;
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init?.type === 'CallExpression') {
      const callee = n.init.callee;
      const iterator = callee.type === 'MemberExpression' && !callee.computed && callee.property.name === 'next' && n.init.arguments.length === 0 && callee.object.type === 'CallExpression' && callee.object.callee.type === 'MemberExpression' && /^(?:values|keys|entries)$/.test(callee.object.callee.property?.name ?? '');
      if (iterator) declarators.push(n);
    }
    if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier') {
      if (!members.has(n.object.name)) members.set(n.object.name, new Set());
      members.get(n.object.name)!.add(n.property.name);
    }
    if (n.type === 'MemberExpression' && n.computed && n.object.type === 'CallExpression') {
      const call = n.object;
      const maker = call.arguments.length === 0 && call.callee.type === 'MemberExpression' && !call.callee.computed && call.callee.property.type === 'Identifier' ? call.callee.property.name : '';
      const key = n.property;
      const named = (key.type === 'Literal' && typeof key.value === 'string') || key.type === 'TemplateLiteral' || (key.type === 'MemberExpression' && key.object.type === 'Identifier' && key.object.name === 'Symbol');
      if (ITERATOR_MAKERS.test(maker) && !named && !optional(n)) indexed.push(n);
    }
    // A method of that name the program defines itself
    const defines = n.type === 'Property' || n.type === 'MethodDefinition' || n.type === 'PropertyDefinition' ? (n.computed ? null : n.key) : n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed ? n.left.property : null;
    const defined = defines ? String(defines.name ?? defines.value) : '';
    if (ITERATOR_MAKERS.test(defined)) own.add(defined);
  });
  const edits: Array<{ at: number; text: string }> = [];
  const labels: Array<{ at: number; label: string }> = [];
  for (const d of declarators) {
    const used = members.get(d.id.name);
    if (!used || used.has('value') || used.has('done')) continue;
    edits.push({ at: d.init.end, text: '.value' });
    labels.push({ at: d.start, label: d.id.name });
  }
  const brief = (text: string) => {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > 60 ? `${one.slice(0, 59)}…` : one;
  };
  for (const n of indexed) {
    if (own.has(n.object.callee.property.name)) continue;
    edits.push({ at: n.object.start, text: '[...' }, { at: n.object.end, text: ']' });
    labels.push({ at: n.start, label: `${brief(code.slice(n.start, n.end))} → [...${brief(code.slice(n.object.start, n.object.end))}]${brief(code.slice(n.object.end, n.end))}` });
  }
  if (edits.length === 0) return { code, fixed: [] };
  let out = code;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = `${out.slice(0, e.at)}${e.text}${out.slice(e.at)}`;
  const fixed = [...new Set(labels.sort((a, b) => a.at - b.at).map((e) => e.label))];
  return tryParse(out) ? { code: out, fixed } : { code, fixed: [] };
}

/** The audio nodes an AudioContext makes with create…() (for where the browser's own type isn't there) */
const AUDIO_NODE_MAKERS = ['createOscillator', 'createGain', 'createAnalyser', 'createBufferSource', 'createBiquadFilter', 'createDelay', 'createConvolver', 'createStereoPanner', 'createDynamicsCompressor', 'createWaveShaper', 'createPanner', 'createBuffer'];

/**
 * Before a program runs: an audio node read as a property of an AudioContext (`ctx.oscillator`,
 * `new AudioContext().gain`), which has none: AudioContext makes them with create…(), so it
 * becomes `ctx.createOscillator()` (`ctx.oscillator()` too)
 */
export function fixAudioNodeProperties(code: string): { code: string; fixed: string[] } {
  const tree = analyse(code);
  if (!tree) return { code, fixed: [] };
  const proto = (globalThis as unknown as { AudioContext?: { prototype: object } }).AudioContext?.prototype;
  const makers = proto ? Object.getOwnPropertyNames(Object.getPrototypeOf(proto) ?? {}).concat(Object.getOwnPropertyNames(proto)).filter((k) => /^create[A-Z]/.test(k)) : AUDIO_NODE_MAKERS;
  const isNewAudioContext = (n: AnyNode | null | undefined) =>
    !!n && n.type === 'NewExpression' && /AudioContext/.test(code.slice((n.callee as AnyNode).start, (n.callee as AnyNode).end));
  // The variables that hold an AudioContext the program made, by the scope that declares each
  // (a parameter or variable of the same name in another function, a gain node called ctx, is
  // something else), and that nothing assigns again
  const held = new Map<AnyNode, Set<string>>();
  for (const n of tree.nodes as AnyNode[]) {
    if (n.type !== 'VariableDeclarator' || (n.id as AnyNode).type !== 'Identifier' || !isNewAudioContext(n.init as AnyNode)) continue;
    const name = (n.id as AnyNode).name as string;
    const scope = resolve(tree, n.id as AnyNode, name);
    if (!scope) continue;
    if (!held.has(scope)) held.set(scope, new Set());
    held.get(scope)!.add(name);
  }
  for (const n of tree.nodes as AnyNode[]) {
    if (n.type !== 'AssignmentExpression' || (n.left as AnyNode).type !== 'Identifier') continue;
    const name = (n.left as AnyNode).name as string;
    const scope = resolve(tree, n.left as AnyNode, name);
    if (scope) held.get(scope)?.delete(name);
  }
  const holdsContext = (n: AnyNode) => {
    if (n.type !== 'Identifier' || !isReference(tree, n)) return false;
    const scope = resolve(tree, n, n.name as string);
    return !!scope && !!held.get(scope)?.has(n.name as string);
  };
  const onContext = (n: AnyNode) => n.type === 'MemberExpression' && !n.computed && (isNewAudioContext(n.object as AnyNode) || holdsContext(n.object as AnyNode));
  // A property the program sets on the context itself (ctx.analyser = ctx.createAnalyser()) is
  // its own: every read of it is that node, not a new one
  const assigned = new Set<string>();
  for (const n of tree.nodes as AnyNode[]) {
    if (n.type === 'AssignmentExpression' && onContext(n.left as AnyNode)) assigned.add(((n.left as AnyNode).property as AnyNode).name as string);
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const fixed: string[] = [];
  for (const n of tree.nodes as AnyNode[]) {
    if (!onContext(n)) continue;
    const parent = tree.parent.get(n);
    const key = tree.key.get(n);
    const property = n.property as AnyNode;
    const prop = property.name as string;
    const maker = `create${prop[0].toUpperCase()}${prop.slice(1)}`;
    const written = parent?.type === 'AssignmentExpression' && key === 'left';
    if (written || assigned.has(prop) || (proto && prop in proto) || !makers.includes(maker)) continue;
    const called = parent?.type === 'CallExpression' && key === 'callee';
    edits.push({ start: property.start, end: property.end, text: called ? maker : `${maker}()` });
    fixed.push(`${prop} → ${maker}()`);
  }
  if (edits.length === 0) return { code, fixed: [] };
  let out = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return tryParse(out) ? { code: out, fixed: [...new Set(fixed)] } : { code, fixed: [] };
}

/** The browser's timing and loading functions: a program's own function of that name hides the real one */
const BROWSER_FUNCTIONS = ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch'];

/**
 * Before a program runs: its own function named like one of the browser's (BROWSER_FUNCTIONS),
 * anywhere in it, is taken out, so its calls reach the real one. Only one that does nothing (an
 * empty body) or names itself (returns itself, or calls itself and never ends): a stand-in that
 * works (a fetch() giving test data) stays.
 */
export function dropBrowserCopies(code: string): { code: string; dropped: string[] } {
  const ast = tryParse(code);
  if (!ast) return { code, dropped: [] };
  const spans: Array<{ start: number; end: number; name: string }> = [];
  walk(ast, (node) => {
    const name = node.type === 'FunctionDeclaration' ? ((node.id as AnyNode | null)?.name as string | undefined) : undefined;
    if (!name || !BROWSER_FUNCTIONS.includes(name)) return;
    const body = node.body as AnyNode;
    const inside = code.slice(body.start + 1, body.end - 1);
    const empty = ((body.body as AnyNode[]) ?? []).length === 0;
    if (empty || new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(inside)) spans.push({ start: node.start, end: node.end, name });
  });
  if (spans.length === 0) return { code, dropped: [] };
  let out = code;
  for (const span of spans.sort((a, b) => b.start - a.start)) out = out.slice(0, span.start) + out.slice(span.end);
  return tryParse(out) ? { code: out, dropped: [...new Set(spans.map((span) => span.name))] } : { code, dropped: [] };
}

export function errorHint(code: string, error: string, errorLine?: number, page?: PageFacts): ErrorHint | null {
  const hint = generalErrorHint(code, error, errorLine, page);
  if (hint?.correction) return hint;
  // A method read as a condition (it is always true): said with the error, whatever the error was
  const methods = methodReadFacts(code);
  const withMethods = methods ? { ...hint, text: [hint?.text, methods].filter(Boolean).join(' ') } : hint;
  // The library's own facts come last, after whatever the general rules found
  const facts = [toneOptionFacts(code, page?.scope), toneConnectFacts(code, error, errorLine, page?.scope), toneValueFacts(code, error), toneArgumentFacts(code, page?.scope)].filter(Boolean).join(' ');
  return facts ? { ...withMethods, text: [withMethods?.text, facts].filter(Boolean).join(' ') } : withMethods;
}

function generalErrorHint(code: string, error: string, errorLine?: number, page?: PageFacts): ErrorHint | null {
  // Corrections by rule first: they need no model
  const rule =
    redeclaredHelper(code, error) ??
    missingAwait(code, error, errorLine) ??
    syntaxSlip(code, error, errorLine) ??
    propertyCalled(code, error) ??
    audioParamTime(code, error) ??
    classCalledWithoutNew(code, error, errorLine, page?.scope) ??
    newOnObject(code, error, page?.scope) ??
    factoryOfClass(code, error, page?.scope) ??
    classFactory(code, error, page?.scope) ??
    dropUnusedFailingDeclaration(code, error, page?.scope) ??
    (looksThrown(error) ? dropMismatchedArguments(code, errorLine, page?.scope) : null);
  if (rule) return rule;
  const helper = helperDeclared(code, error);
  if (helper) return helper;
  const method = methodHint(code, error, page?.scope, errorLine);
  // A sure slip of a real member (getcontext) is corrected; otherwise a stand-in explains the error
  const standIn = method?.correction ? null : standInElement(code, error, errorLine, page);
  // An error that names nothing gets what the failing call was given
  const vague = vagueCallFacts(code, error, errorLine, page);
  if (standIn) return standIn.text && vague ? { text: `${standIn.text} ${vague}` } : standIn;
  if (method) {
    return method.correction
      ? {
          correction: {
            code: applyCorrection(code, method.correction),
            note: `${method.correction.object}.${method.correction.from}() → ${method.correction.object}.${method.correction.to}()`,
          },
        }
      : (unknownCallDropped(code, error, errorLine) ?? { text: method.text });
  }
  const found = argumentCountFacts(code, error, errorLine, page?.scope) ?? notDefined(code, error, errorLine, page) ?? libraryOnWindow(code, error, page) ?? nothingThere(code, error, errorLine, page) ?? leftOpen(code, error) ?? tooEarly(code, error, errorLine);
  if (found?.correction) return found;
  // A method called on undefined (not on a missing element, which is null): its maker returns,
  // or the call is made only when there is something to call
  const nothingToCall = callOnUndefined(code, error, errorLine);
  if (nothingToCall) return nothingToCall;
  // Calls of the failing function that pass too few values, added to whatever else was found
  const calls = shortCalls(code, errorLine);
  const text = [found?.text, vague, calls].filter(Boolean).join(' ');
  if (text) return { text };
  return libraryRepairAfterError(code, error);
}

// ============================================================================
// Library-specific repairs (Tone.js). Their own group, after every general repair: a general
// correction or hint always gets the first look, and these run only when none applies. Each is
// grounded in the library's documented API, only for a program that uses the library, and logged
// like the rest.
// ============================================================================

// The program's nodes as the scope analysis hands them out: any field may be read
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Node & Record<string, any>;

/** Tone's note values ("4n", "8n.", "4t", "1m"): times a program may write where a number of seconds is needed */
const TONE_NOTE_VALUE = /^\d+[nmt]\.?$/;
/** A pitch: "C4", "D#4", "Bb3" */
const TONE_NOTE_NAME = /^[A-Ga-g][#b]?-?\d$/;
/** Tone methods that give back the object they were called on, so a chain of them still ends in the made object */
const TONE_CHAINABLE = new Set(['toDestination', 'toMaster', 'connect', 'chain', 'fan', 'sync']);
/** The Tone classes whose first argument is a callback called with the time it plays at */
const TONE_TIMED_CALLBACKS = new Set(['Loop', 'Part', 'Sequence', 'Pattern', 'ToneEvent', 'Event']);

/**
 * Before a program runs, in programs that use Tone, by Tone's documented API:
 *  - a note value added to a time (`time += "8n"`, `time + "4n"`) joins text to a number of
 *    seconds: it becomes Tone.Time("8n").toSeconds(). The time is a number only where the program
 *    says so: the first argument of a Loop, Part, Sequence or Transport.schedule callback, or a
 *    variable made from a number or Tone.now() (and only that once).
 *  - a pitch given to a NoiseSynth ("D#4", which has none: triggerAttackRelease(duration, time,
 *    velocity), triggerAttack(time, velocity)) is dropped. The object is a NoiseSynth only where
 *    its one declaration says so (`new Tone.NoiseSynth()`, a chain of toDestination() and the like).
 * Each is kept only when the result parses.
 */
export function fixToneCalls(code: string): { code: string; fixed: string[] } {
  const none = { code, fixed: [] as string[] };
  if (!/\bTone\b/.test(code)) return none;
  const tree = analyse(code);
  if (!tree) return none;
  const isMember = (node: Loose | undefined, object: string, property: string): boolean =>
    node?.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === object && node.property.name === property;
  const text = (node: Loose) => code.slice(node.start, node.end);
  const numeric = (node: Loose): boolean =>
    (node.type === 'Literal' && typeof node.value === 'number') ||
    (node.type === 'CallExpression' && node.arguments.length === 0 && (isMember(node.callee, 'Tone', 'now') || isMember(node.callee, 'Tone', 'immediate'))) ||
    (node.type === 'MemberExpression' && !node.computed && isMember(node.object, 'Tone', 'Transport') && node.property.name === 'seconds') ||
    (node.type === 'UnaryExpression' && node.operator === '-' && numeric(node.argument)) ||
    (node.type === 'BinaryExpression' && /^[-+*/]$/.test(node.operator) && numeric(node.left) && numeric(node.right));
  // What a name stands for where it is used: its one declaration (and nothing else assigns it)
  const declarators = (scope: Loose, name: string) =>
    tree.nodes.filter((n) => n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === name && resolve(tree, n.id, name) === scope);
  const reassigned = (scope: Loose, name: string) =>
    tree.nodes.some((n) => n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'Identifier' && n.left.name === name && resolve(tree, n.left, name) === scope);
  const timedCallback = (fn: Loose): boolean => {
    const call = tree.parent.get(fn);
    if (!call || (call.type !== 'NewExpression' && call.type !== 'CallExpression') || call.arguments[0] !== fn) return false;
    const callee = call.callee as Loose;
    if (callee.type !== 'MemberExpression' || callee.computed) return false;
    if (callee.object.type === 'Identifier' && callee.object.name === 'Tone') return TONE_TIMED_CALLBACKS.has(callee.property.name);
    return call.type === 'CallExpression' && /^schedule(?:Repeat|Once)?$/.test(callee.property.name) && (isMember(callee.object, 'Tone', 'Transport') || (callee.object.type === 'Identifier' && callee.object.name === 'Transport'));
  };
  const seconds = (id: Loose): boolean => {
    const scope = resolve(tree, id, id.name);
    if (!scope) return false;
    if (/Function/.test(scope.type) && scope.params[0]?.type === 'Identifier' && scope.params[0].name === id.name) return timedCallback(scope);
    const made = declarators(scope, id.name);
    return made.length === 1 && !!made[0].init && numeric(made[0].init) && !reassigned(scope, id.name);
  };
  const edits: Array<{ start: number; end: number; text: string; note: string }> = [];
  const noteValue = (node: Loose) => node.type === 'Literal' && typeof node.value === 'string' && TONE_NOTE_VALUE.test(node.value);
  const noiseSynths = new Map<Loose, Set<string>>();
  for (const node of tree.nodes) {
    // time += "8n", time + "4n"
    const isSum = (node.type === 'AssignmentExpression' && /^[-+]=$/.test(node.operator)) || (node.type === 'BinaryExpression' && /^[-+]$/.test(node.operator));
    if (isSum && noteValue(node.right) && (node.left.type === 'Identifier' ? seconds(node.left) : node.type === 'BinaryExpression' && numeric(node.left))) {
      const value = text(node.right);
      edits.push({ start: node.right.start, end: node.right.end, text: `Tone.Time(${value}).toSeconds()`, note: `${text(node.left)} ${node.operator} ${value} → ${text(node.left)} ${node.operator} Tone.Time(${value}).toSeconds()` });
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      let made: Loose = node.init;
      while (made.type === 'CallExpression' && made.callee.type === 'MemberExpression' && !made.callee.computed && TONE_CHAINABLE.has(made.callee.property.name)) made = made.callee.object;
      const scope = resolve(tree, node.id, node.id.name);
      if (made.type === 'NewExpression' && isMember(made.callee, 'Tone', 'NoiseSynth') && scope) {
        const names = noiseSynths.get(scope) ?? new Set<string>();
        noiseSynths.set(scope, names.add(node.id.name));
      }
    }
  }
  // A pitch given to a NoiseSynth
  for (const node of tree.nodes) {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.object.type !== 'Identifier') continue;
    const method = node.callee.property.name as string;
    const first = node.arguments[0] as Loose | undefined;
    if (!first || first.type !== 'Literal' || typeof first.value !== 'string' || !TONE_NOTE_NAME.test(first.value)) continue;
    if (!((method === 'triggerAttackRelease' && node.arguments.length >= 2) || method === 'triggerAttack')) continue;
    const name = node.callee.object.name as string;
    const scope = resolve(tree, node.callee.object, name);
    if (!scope || !noiseSynths.get(scope)?.has(name) || declarators(scope, name).length !== 1 || reassigned(scope, name)) continue;
    const next = node.arguments[1] as Loose | undefined;
    edits.push({ start: first.start, end: next ? next.start : first.end, text: '', note: `${name}.${method}(${text(first)}, …): a Tone.NoiseSynth has no pitch → ${text(first)} dropped` });
  }
  if (edits.length === 0) return none;
  let fixed = code;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) fixed = fixed.slice(0, edit.start) + edit.text + fixed.slice(edit.end);
  return tryParse(fixed) ? { code: fixed, fixed: edits.sort((a, b) => a.start - b.start).map((edit) => edit.note) } : none;
}

/**
 * Facts, not a repair (Tone.js): an option a Tone class is made with that the class does not have,
 * by its own static getDefaults() (every Tone class lists its options there): `new Tone.Loop({
 * duration: 4, tempo: 120 })` gives a Loop options it has no use for. Only for a class the page
 * has, made with an object of plain keys.
 */
/**
 * "Cannot connect to node with no inputs" (Tone): something was connected into a sound source, which has
 * none (Tone.PluckSynth, Tone.Synth, Tone.Player, Tone.Noise, any instrument). The calls on the failing
 * line (every one, when the line isn't known) whose argument is a name made with `new` of such a class, from
 * the page's own classes (an instrument or source: Tone.Instrument, Tone.Source and what extends them).
 */
export function toneConnectFacts(code: string, error: string, errorLine: number | undefined, scope?: Record<string, unknown>): string | null {
  if (!/Cannot connect to node with no inputs/i.test(error)) return null;
  const tone = scope?.Tone as Record<string, unknown> | undefined;
  const ast = tryParse(code);
  if (!tone || !ast) return null;
  const sources = ['Instrument', 'Source'].map((name) => (tone[name] as { prototype?: object } | undefined)?.prototype).filter((proto): proto is object => !!proto);
  const facts: string[] = [];
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as AnyNode;
    if (callee.type !== 'MemberExpression' || callee.computed || (callee.property as AnyNode).name !== 'connect') return;
    if (errorLine && lineOf(node) !== errorLine) return;
    const target = (node.arguments as AnyNode[])[0];
    if (target?.type !== 'Identifier') return;
    const name = target.name as string;
    const type = objectType(code, name);
    const ctor = type && /^Tone\./.test(type) ? (tone[type.slice(5)] as { prototype?: object } | undefined) : undefined;
    if (!ctor?.prototype || !sources.some((proto) => proto.isPrototypeOf(ctor.prototype!))) return;
    facts.push(`${name} is a ${type}, a sound source with no inputs: nothing can be connected into it. It sends sound onward: ${name}.toDestination(), or ${name}.connect(an effect that has inputs, such as a Tone.Reverb or Tone.Filter).`);
  });
  return facts.length ? [...new Set(facts)].slice(0, 3).join(' ') : null;
}

/**
 * "Invalid argument(s) to setValueAtTime: "Twinkle", 0.5" (Tone, from a note, a level or a time that is a
 * word): the arguments the library printed that are not numbers, and where the program has that text. Tone
 * takes a pitch as a note name ("C4", "F#3": letter, optional # or b, octave) or a frequency in Hz, a
 * time in seconds or as a Tone time ("8n", "+0.5").
 */
export function toneValueFacts(code: string, error: string): string | null {
  const printed = error.match(/Invalid argument\(s\) to \w+: (.+)$/m)?.[1];
  if (!printed) return null;
  let values: unknown[];
  try {
    values = JSON.parse(`[${printed}]`);
  } catch {
    return null;
  }
  const words = values.filter((value): value is string => typeof value === 'string' && !!value.trim() && !Number.isFinite(Number(value)));
  if (words.length === 0) return null;
  const lines = code.split('\n');
  const facts = words.slice(0, 2).map((word) => {
    const at = lines.findIndex((line) => line.includes(JSON.stringify(word)) || line.includes(`'${word}'`));
    return `${JSON.stringify(word)}${at >= 0 ? ` (line ${at + 1})` : ''} is not a number Tone can use there.`;
  });
  return `${facts.join(' ')} A pitch is a note name such as "C4" or "F#3" (a letter, an optional # or b, an octave number) or a frequency in Hz such as 261.63; a time is seconds such as 0.5 or a Tone time such as "8n".`;
}

/**
 * The parameter names of a Tone class's constructor, in order, read from the class itself: Tone's constructors
 * hand their arguments to optionsFromArguments(Class.getDefaults(), arguments, ["voice", "options"]), and the
 * list of names survives the bundle (its function name does not). Null for a class that lists none.
 */
export function constructorParameters(cls: unknown): string[] | null {
  if (typeof cls !== 'function') return null;
  let source = '';
  try {
    source = Function.prototype.toString.call(cls);
  } catch {
    return null;
  }
  const list = source.match(/\barguments\s*,\s*(\[\s*(?:["'][\w$]+["']\s*,?\s*)+\])/)?.[1];
  if (!list) return null;
  try {
    const names = JSON.parse(list.replace(/'/g, '"').replace(/,\s*\]/, ']')) as unknown;
    return Array.isArray(names) && names.every((name) => typeof name === 'string') ? (names as string[]) : null;
  } catch {
    return null;
  }
}

/** What an argument is, where the program says: a string, number, boolean, object, array, or function; null when it can't be told */
type ArgKind = 'string' | 'number' | 'boolean' | 'object' | 'function';

function argumentKind(code: string, ast: AnyNode, arg: AnyNode, scope: Record<string, unknown>): ArgKind | null {
  const kindOf = (node: AnyNode, depth: number): ArgKind | null => {
    switch (node.type) {
      case 'Literal':
        return typeof node.value === 'string' ? 'string' : typeof node.value === 'number' ? 'number' : typeof node.value === 'boolean' ? 'boolean' : null;
      case 'TemplateLiteral':
        return 'string';
      case 'ObjectExpression':
      case 'ArrayExpression':
        return 'object';
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return 'function';
      case 'UnaryExpression':
        return (node.operator === '-' || node.operator === '+') && kindOf(node.argument as AnyNode, depth) === 'number' ? 'number' : null;
      case 'MemberExpression': {
        const path = code.slice(node.start, node.end);
        return typeof valueOfPath(code, path, scope) === 'function' ? 'function' : null;
      }
      case 'Identifier': {
        if (depth > 2) return null;
        // A name declared once, never assigned again: what it was set to
        let found: AnyNode | null = null;
        let declared = 0;
        let assigned = false;
        walk(ast, (n) => {
          if (n.type === 'VariableDeclarator' && (n.id as AnyNode).type === 'Identifier' && (n.id as AnyNode).name === node.name) {
            declared++;
            found = n.init as AnyNode | null;
          } else if (n.type === 'FunctionDeclaration' && n.id && (n.id as AnyNode).name === node.name) {
            declared++;
            found = n;
          } else if (n.type === 'AssignmentExpression' && (n.left as AnyNode).type === 'Identifier' && (n.left as AnyNode).name === node.name) assigned = true;
          else if (n.type === 'UpdateExpression' && (n.argument as AnyNode).type === 'Identifier' && (n.argument as AnyNode).name === node.name) assigned = true;
        });
        const only = found as AnyNode | null;
        if (declared !== 1 || assigned || !only) return null;
        return only.type === 'FunctionDeclaration' ? 'function' : kindOf(only, depth + 1);
      }
      default:
        return null;
    }
  };
  return kindOf(arg, 0);
}

/** Whether a value of this kind can stand where the class's default for the parameter is: Tone reads a time or a frequency from a number or a text */
function fitsDefault(kind: ArgKind, fallback: unknown): boolean {
  if (fallback === undefined || fallback === null) return true;
  const expected = typeof fallback;
  if (expected === 'function') return kind === 'function';
  if (expected === 'object') return kind === 'object';
  if (expected === 'string' || expected === 'number') return kind === 'string' || kind === 'number';
  if (expected === 'boolean') return kind === 'boolean';
  return true;
}

interface ConstructorCall {
  node: AnyNode;
  name: string;
  params: string[];
  /** The first argument that cannot be what its parameter takes, with what the parameter is */
  first: { index: number; param: string; kind: ArgKind; expected: string } | null;
  /** The arguments past the parameters the constructor lists (it ignores them) */
  extra: number;
}

/** The `new Tone.Class(…)` calls whose class lists its parameters, with any argument that cannot be what its parameter takes */
function constructorCalls(code: string, scope?: Record<string, unknown>): ConstructorCall[] {
  const tone = scope?.Tone as Record<string, unknown> | undefined;
  const ast = tone ? tryParse(code) : null;
  if (!tone || !ast || new RegExp('(?:const|let|var|function|class)\\s+Tone\\b').test(code)) return [];
  const calls: ConstructorCall[] = [];
  walk(ast, (node) => {
    if (node.type !== 'NewExpression') return;
    const callee = node.callee as AnyNode;
    if (callee.type !== 'MemberExpression' || callee.computed || (callee.object as AnyNode).type !== 'Identifier' || (callee.object as AnyNode).name !== 'Tone') return;
    const name = (callee.property as AnyNode).name as string;
    const cls = tone[name];
    const params = constructorParameters(cls);
    if (!params) return;
    let defaults: Record<string, unknown> = {};
    try {
      defaults = (cls as { getDefaults?: () => Record<string, unknown> }).getDefaults?.() ?? {};
    } catch {
      defaults = {};
    }
    const args = node.arguments as AnyNode[];
    let first: ConstructorCall['first'] = null;
    // (one object alone is Tone's named form: new Tone.PolySynth({ volume: -8 }))
    const named = args.length === 1 && argumentKind(code, ast, args[0], scope!) === 'object';
    for (let index = 0; index < Math.min(args.length, params.length) && !first && !named; index++) {
      const kind = argumentKind(code, ast, args[index], scope!);
      if (kind && !fitsDefault(kind, defaults[params[index]])) {
        const fallback = defaults[params[index]];
        first = { index, param: params[index], kind, expected: typeof fallback === 'function' ? (params[index] === 'voice' ? 'an instrument class such as Tone.Synth' : 'a function') : typeof fallback === 'object' ? 'an object of options' : typeof fallback };
      }
    }
    const extra = Math.max(0, args.length - params.length);
    if (first || extra > 0) calls.push({ node, name, params, first, extra });
  });
  return calls;
}

/** Whether an error is one a program threw (a TypeError, a missing name, a library's refusal), not a check on what it did */
export function looksThrown(error: string): boolean {
  return /\b(?:is not a function|is not a constructor|is not defined|is not an object|is not iterable|Cannot read propert|Cannot set propert|Cannot access|Cannot destructure|Invalid argument|Failed to execute|Illegal invocation|Maximum call stack|Can't find variable|before initialization|TypeError|RangeError|ReferenceError|Error:)/.test(error) && !/^(?:The (?:program|page|screen)|Nothing the program|sound:)/.test(error);
}

/**
 * What a Tone constructor takes, said for each `new Tone.Class(…)` that hands it something its parameter
 * cannot be (read from the real class, see constructorParameters): `new Tone.Loop(callback, interval)`: the first
 * argument is a function; here it is a string. Nothing where the arguments could fit.
 */
export function toneArgumentFacts(code: string, scope?: Record<string, unknown>): string | null {
  const facts = constructorCalls(code, scope)
    .filter((call) => call.first)
    .map((call) => {
      const { index, param, kind, expected } = call.first!;
      const ordinal = ['first', 'second', 'third', 'fourth'][index] ?? `#${index + 1}`;
      return `new Tone.${call.name}(${call.params.join(', ')}): the ${ordinal} argument is ${param}, ${/^(?:a|an) /.test(expected) ? expected : `a ${expected}`}; here it is ${kind === 'object' ? 'an object' : `a ${kind}`}.`;
    });
  return facts.length ? [...new Set(facts)].slice(0, 2).join(' ') : null;
}

/**
 * A Tone constructor handed arguments that cannot be what its parameters take (`new Tone.PolySynth("C4", 100, 0)`:
 * voice is a class and options an object), failing inside the library: from the first argument that cannot fit on,
 * the arguments go (the later ones would take the place of the earlier), and so do those past the parameters the
 * constructor lists. For a call on the failing line, or when the error has no line of the program's (it was thrown
 * inside Tone). The correction is made only if a test run of the program changes the error (mustRunClean is not asked:
 * the rest of the program may have its own).
 */
export function dropMismatchedArguments(code: string, errorLine: number | undefined, scope?: Record<string, unknown>): ErrorHint | null {
  const calls = constructorCalls(code, scope).filter((call) => call.first && (!errorLine || lineOf(call.node) === errorLine));
  if (calls.length === 0) return null;
  let fixed = code;
  const dropped: string[] = [];
  for (const call of [...calls].sort((a, b) => b.node.start - a.node.start)) {
    const args = call.node.arguments as AnyNode[];
    const from = call.first!.index;
    fixed = fixed.slice(0, from === 0 ? (call.node.callee as AnyNode).end : args[from - 1].end) + `${from === 0 ? '()' : ')'}${fixed.slice(call.node.end)}`;
    dropped.push(`new Tone.${call.name}(${args.slice(from).map((arg) => code.slice(arg.start, arg.end)).join(', ')})`);
  }
  return tryParse(fixed) && fixed !== code ? { correction: { code: fixed, note: `${dropped.join('; ')}: arguments that its parameters (${calls[0].params.join(', ')}) cannot take → left out` } } : null;
}

export function toneOptionFacts(code: string, scope?: Record<string, unknown>): string | null {
  const tone = scope?.Tone as Record<string, { getDefaults?: () => Record<string, unknown> }> | undefined;
  if (!tone || !/\bTone\b/.test(code)) return null;
  const ast = tryParse(code);
  if (!ast) return null;
  const facts: string[] = [];
  walk(ast, (node) => {
    if (node.type !== 'NewExpression') return;
    const callee = node.callee as AnyNode;
    if (callee.type !== 'MemberExpression' || callee.computed || (callee.object as AnyNode).type !== 'Identifier' || (callee.object as AnyNode).name !== 'Tone') return;
    const name = (callee.property as AnyNode).name as string;
    const first = (node.arguments as AnyNode[])[0];
    if (first?.type !== 'ObjectExpression') return;
    let defaults: Record<string, unknown> | null = null;
    try {
      defaults = typeof tone[name]?.getDefaults === 'function' ? tone[name].getDefaults!() : null;
    } catch {
      defaults = null;
    }
    if (!defaults) return;
    const given: string[] = [];
    for (const property of first.properties as AnyNode[]) {
      if (property.type !== 'Property' || property.computed) return;
      const key = property.key as AnyNode;
      given.push((key.type === 'Identifier' ? key.name : key.value) as string);
    }
    const unknown = given.filter((key) => !(key in defaults!));
    if (unknown.length === 0) return;
    const options = Object.keys(defaults).filter((key) => key !== 'context');
    facts.push(`Tone.${name} has no option ${unknown.join(' or ')} (its options: ${options.slice(0, 8).join(', ')}${options.length > 8 ? ', …' : ''}).`);
  });
  return facts.length ? [...new Set(facts)].slice(0, 3).join(' ') : null;
}

/** Tone objects that are scheduled, started at a time (a loop, a part) rather than playing at once */
const TONE_SCHEDULED = new Set(['Tone.Loop', 'Tone.Part', 'Tone.Sequence', 'Tone.Pattern', 'Tone.ToneEvent']);

/**
 * The Tone steps a silent program was missing (see toneStepsOnly), as code: `.toDestination()` on
 * each `new Tone.X(…)` of a kind that was never connected, `name.start(0);` after each scheduled
 * object that was never started (a loop, a part), and Tone.Transport.start() at the end. Only
 * objects the program made in a declaration of their own, whose start it never names; kept only
 * when the result parses. Null when nothing could be added.
 */
function addToneSteps(code: string, steps: { transport: boolean; unconnected: string[]; unstarted: string[] }): { code: string; notes: string[] } | null {
  const ast = tryParse(code);
  if (!ast || !/\bTone\b/.test(code)) return null;
  const edits: Array<{ at: number; text: string }> = [];
  const notes: string[] = [];
  const kindOf = (init: AnyNode | null | undefined): string | null => {
    if (init?.type !== 'NewExpression') return null;
    const callee = init.callee as AnyNode;
    return callee.type === 'MemberExpression' && !callee.computed && (callee.object as AnyNode).type === 'Identifier' && (callee.object as AnyNode).name === 'Tone' ? `Tone.${(callee.property as AnyNode).name as string}` : null;
  };
  // Whether a name is used as a value anywhere (handed to a call, put in a list, assigned, returned):
  // `[pad, lead].forEach((s) => s.connect(reverb))` and `Tone.connect(synth, reverb)` route a part
  // through code this can't follow, so a part like that is the program's to connect, not a guess. Only
  // `name.member` and `name.method()` leave it where it is.
  const usedAsValue = (name: string): boolean => {
    let found = false;
    const visit = (node: AnyNode, parent: AnyNode | null): void => {
      if (found) return;
      if (node.type === 'Identifier' && node.name === name && parent) {
        const own = parent.type === 'VariableDeclarator' && parent.id === node;
        const object = parent.type === 'MemberExpression' && parent.object === node;
        const property = parent.type === 'MemberExpression' && parent.property === node && !parent.computed;
        const key = parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand;
        if (!own && !object && !property && !key) found = true;
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const child of value) if (child && typeof (child as AnyNode).type === 'string') visit(child as AnyNode, node);
        } else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') {
          visit(value as AnyNode, node);
        }
      }
    };
    visit(ast, null);
    return found;
  };
  walk(ast, (node, functions) => {
    if (node.type !== 'VariableDeclaration' || functions.length > 0) return;
    for (const declarator of node.declarations as AnyNode[]) {
      const kind = kindOf(declarator.init as AnyNode);
      if (!kind || (declarator.id as AnyNode).type !== 'Identifier') continue;
      const name = (declarator.id as AnyNode).name as string;
      const used = (pattern: string) => new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\.\\s*(?:${pattern})\\s*\\(`).test(code);
      if (steps.unconnected.includes(kind) && !TONE_SCHEDULED.has(kind) && !used('toDestination|toMaster|connect|chain|fan') && !usedAsValue(name)) {
        edits.push({ at: (declarator.init as AnyNode).end, text: '.toDestination()' });
        notes.push(`${name} = new ${kind}(…) → .toDestination()`);
      }
      if (steps.unstarted.includes(kind) && TONE_SCHEDULED.has(kind) && !used('start') && !usedAsValue(name)) {
        edits.push({ at: node.end, text: `\n${name}.start(0);` });
        notes.push(`${name}.start(0) added after it (a ${kind} plays only once started)`);
      }
    }
  });
  let fixed = code;
  for (const edit of edits.sort((a, b) => b.at - a.at)) fixed = fixed.slice(0, edit.at) + edit.text + fixed.slice(edit.at);
  if (steps.transport) {
    const started = withTransportStart(fixed, (candidate) => tryParse(candidate) !== null);
    if (started) {
      fixed = started;
      notes.push('Tone.Transport.start() added at the end');
    }
  }
  return notes.length > 0 && fixed !== code && tryParse(fixed) ? { code: fixed, notes } : null;
}

/** After an error: the one step a library program is missing, when the error names it */
function libraryRepairAfterError(code: string, error: string): ErrorHint | null {
  // A Tone program whose silence has only Tone steps missing (the page says which): each is the one
  // call that sets it right. Tone.Transport started at the end (nothing plays until it is), an
  // instrument or source connected with .toDestination(), a loop or part started at 0
  const steps = toneStepsOnly(error);
  if (steps) {
    const set = addToneSteps(code, steps);
    if (set) return { correction: { code: set.code, note: `${set.notes.join(', ')}: the steps its sound was missing`, mustRunClean: true } };
  }
  // The notation repairs of fixToneCalls, for a program that got past them before it ran (a fix's)
  const tone = fixToneCalls(code);
  if (tone.fixed.length) return { correction: { code: tone.code, note: tone.fixed.join('; ') } };
  return null;
}

/**
 * Before a program runs: a name declared again with const or let in the same block (`const
 * velocity = 100;` three times, or a program written out twice) stops the whole program before
 * it starts. The first declaration becomes let and each later one a plain assignment, so every
 * line still sets the value where it did. The same for a const or let that repeats a name the
 * block already has from elsewhere: a parameter of its function (`function play(note) { const
 * note = note * 0.8 }` becomes `note = note * 0.8`, what it meant), a catch's parameter, a
 * function declared in the block, or an earlier var (and a var after a let or const). Every such
 * name at once (the error names only the first); only single-name declarations; kept only when
 * the result parses. Null when there is nothing to do.
 */
export function declareOnce(code: string): { code: string; names: string[] } | null {
  if (tryParse(code)) return null;
  let ast: AnyNode;
  try {
    ast = parseLoose(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as unknown as AnyNode;
  } catch {
    return null;
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const names = new Set<string>();
  const madeLet = new Set<AnyNode>();
  // The names a block has before its own statements: its function's parameters, or its catch's
  const given = new Map<AnyNode, string[]>();
  walk(ast, (node) => {
    if (/Function/.test(node.type) && (node.body as AnyNode)?.type === 'BlockStatement') {
      given.set(node.body as AnyNode, (node.params as AnyNode[]).flatMap((p) => boundNames(p)));
    }
    if (node.type === 'CatchClause' && node.param && node.body) given.set(node.body as AnyNode, boundNames(node.param as AnyNode));
  });
  const elsewhere = (kind: string) => ({ kind }) as unknown as AnyNode;
  walk(ast, (node) => {
    if (node.type !== 'Program' && node.type !== 'BlockStatement' && node.type !== 'StaticBlock') return;
    const first = new Map<string, AnyNode>();
    for (const name of given.get(node) ?? []) first.set(name, elsewhere('param'));
    // (a function declaration counts from the top of its block: it is hoisted)
    for (const statement of node.body as AnyNode[]) {
      if (statement.type === 'FunctionDeclaration' && (statement.id as AnyNode | null)?.name && !first.has((statement.id as AnyNode).name as string)) {
        first.set((statement.id as AnyNode).name as string, elsewhere('function'));
      }
    }
    for (const statement of node.body as AnyNode[]) {
      if (statement.type !== 'VariableDeclaration') continue;
      const declarators = statement.declarations as AnyNode[];
      // A const with no value (`const x;`) can't stand: it is a let, set later
      if (statement.kind === 'const' && declarators.some((d) => !d.init) && !madeLet.has(statement)) {
        madeLet.add(statement);
        names.add(declarators.flatMap((d) => boundNames(d.id as AnyNode)).join(', '));
        edits.push({ start: statement.start, end: statement.start + 'const'.length, text: 'let' });
      }
      const id = declarators[0]?.id as AnyNode | undefined;
      if (declarators.length !== 1) continue;
      // A pattern (`const { C4, D5 } = scale;`) written again: when every name in it is one the block
      // already has, it sets them again (an object pattern as an assignment needs its parentheses)
      if (id?.type === 'ObjectPattern' || id?.type === 'ArrayPattern') {
        const bound = boundNames(id);
        const repeated = bound.filter((n) => first.has(n));
        if (repeated.length === 0) {
          for (const n of bound) first.set(n, statement);
          continue;
        }
        const init = declarators[0].init as AnyNode | null;
        if (repeated.length !== bound.length || !init) continue;
        const earlierOnes = bound.map((n) => first.get(n)!);
        if (statement.kind === 'var' && earlierOnes.every((e) => e.kind !== 'let' && e.kind !== 'const')) continue;
        names.add(bound.join(', '));
        // (a line that starts with ( or [ continues the one before unless that ended: `;` first)
        const before = code.slice(0, statement.start).trimEnd();
        const guard = before === '' || /[;{}]$/.test(before) ? '' : ';';
        edits.push(id.type === 'ObjectPattern' ? { start: statement.start, end: id.start, text: `${guard}(` } : { start: statement.start, end: id.start, text: guard });
        if (id.type === 'ObjectPattern') edits.push({ start: init.end, end: init.end, text: ')' });
        for (const earlierOne of new Set(earlierOnes)) {
          if (earlierOne.kind === 'const' && !madeLet.has(earlierOne)) {
            madeLet.add(earlierOne);
            edits.push({ start: earlierOne.start, end: earlierOne.start + 'const'.length, text: 'let' });
          }
        }
        continue;
      }
      if (id?.type !== 'Identifier') continue;
      const name = id.name as string;
      const earlier = first.get(name);
      if (!earlier) {
        first.set(name, statement);
        continue;
      }
      // A var may repeat a var, a parameter or a function: only a let or const before it conflicts
      if (statement.kind === 'var' && earlier.kind !== 'let' && earlier.kind !== 'const') continue;
      names.add(name);
      // The later one sets the value (or, without one, goes)
      const init = declarators[0].init as AnyNode | null;
      edits.push(init ? { start: statement.start, end: id.start, text: '' } : { start: statement.start, end: statement.end, text: '' });
      if (earlier.kind === 'const' && !madeLet.has(earlier)) {
        madeLet.add(earlier);
        edits.push({ start: earlier.start, end: earlier.start + 'const'.length, text: 'let' });
      }
    }
  });
  if (edits.length === 0) return null;
  let out = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  // A reply also cut off before its end parses only once closed (closeCutOff, which runs after
  // this and needs the names sorted out first to close it)
  return tryParse(out) || closeCutOff(out) ? { code: out, names: [...names] } : null;
}

/**
 * Before a program runs: a name used where it isn't visible, that the program declares exactly
 * once, inside one of its top-level functions (`const ball = {…}` in checkCollision(), used in
 * checkWallCollision()), is declared for the whole program: `let ball;` goes before that
 * function, and its declaration becomes an assignment. The function still sets the value each
 * time it runs, and every other part of the program now reaches it. A name read with typeof (a
 * program asking whether it exists) is left alone, and the result must parse.
 */
export function shareDeclarations(code: string): { code: string; shared: Array<{ name: string; from: string; line: number }> } {
  const tree = analyse(code);
  if (!tree) return { code, shared: [] };
  const unresolved = new Set<string>();
  const asked = new Set<string>();
  for (const n of tree.nodes as AnyNode[]) {
    if (n.type !== 'Identifier' || !isReference(tree, n)) continue;
    const name = n.name as string;
    if (resolve(tree, n, name) || name in globalThis || SANDBOX_NAMES.includes(name)) continue;
    const parent = tree.parent.get(n);
    if (parent?.type === 'UnaryExpression' && parent.operator === 'typeof') asked.add(name);
    unresolved.add(name);
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const shared: Array<{ name: string; from: string; line: number }> = [];
  for (const name of unresolved) {
    if (asked.has(name)) continue;
    // Declared exactly once in the whole program (no parameter, function or other variable of that name)
    const bindings = [...tree.bindings].filter((b) => b.name === name);
    if (bindings.length !== 1) continue;
    const declarator = tree.parent.get(bindings[0]);
    if (declarator?.type !== 'VariableDeclarator' || declarator.id !== bindings[0] || !declarator.init) continue;
    const statement = tree.parent.get(declarator);
    if (statement?.type !== 'VariableDeclaration' || statement.declarations.length !== 1) continue;
    const body = tree.parent.get(statement);
    const fn = body ? tree.parent.get(body) : undefined;
    if (body?.type !== 'BlockStatement' || !fn || !/Function/.test(fn.type)) continue;
    // A top-level function: declared, or a function or arrow held in a top-level const/let/var
    // (the parser's other shapes of the same thing); the shared declaration goes before that statement
    let top: AnyNode | undefined;
    let fnName: string | undefined;
    if (fn.type === 'FunctionDeclaration') {
      if (fn.id && tree.parent.get(fn)?.type === 'Program') [top, fnName] = [fn, fn.id.name as string];
    } else {
      const declarator = tree.parent.get(fn);
      const declaration = declarator ? tree.parent.get(declarator) : undefined;
      if (declarator?.type === 'VariableDeclarator' && tree.key.get(fn) === 'init' && declarator.id.type === 'Identifier' && declaration?.type === 'VariableDeclaration' && tree.parent.get(declaration)?.type === 'Program') {
        [top, fnName] = [declaration, declarator.id.name as string];
      }
    }
    if (!top || !fnName) continue;
    // Where a shared variable would act differently from the function's own: two runs of it at
    // once (async, a generator, a function that calls itself), or a function inside it that
    // keeps its own copy (a closure over the name)
    if (fn.async || fn.generator) continue;
    let differs = false;
    walk(fn.body as AnyNode, (node) => {
      if (differs) return;
      if (node.type === 'CallExpression' && (node.callee as AnyNode).type === 'Identifier' && (node.callee as AnyNode).name === fnName) differs = true;
      if (/Function/.test(node.type)) walk(node.body as AnyNode, (inner) => {
        if (inner.type === 'Identifier' && inner.name === name) differs = true;
      });
    });
    if (differs) continue;
    edits.push({ start: top.start, end: top.start, text: `let ${name};\n` });
    edits.push({ start: statement.start, end: declarator.start, text: '' });
    shared.push({ name, from: fnName, line: lineOf(top) });
  }
  if (edits.length === 0) return { code, shared: [] };
  let out = code;
  for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return tryParse(out) ? { code: out, shared } : { code, shared: [] };
}
