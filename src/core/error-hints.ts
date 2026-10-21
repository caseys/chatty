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
import { sureMatch } from './fuzzy-match.ts';
import { analyse, isReference, resolve } from './blank-fix.ts';
import { applyCorrection, argumentCountFact, methodHint, missingMethod, objectType } from './method-hints.ts';

export interface ErrorHint {
  /** Facts for the fix request */
  text?: string;
  /** The program corrected without the model, and what was changed (for the run log) */
  correction?: { code: string; note: string };
}

/** What the live page holds, read from the sandbox when the program failed */
export interface PageFacts {
  ids: string[];
  /** Ids the program looked up that never existed, and what stood in for each */
  standIns?: StandIn[];
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

function tryParse(code: string): AnyNode | null {
  try {
    return parse(code, PARSE_OPTIONS) as unknown as AnyNode;
  } catch {
    return null;
  }
}

/**
 * A reply cut off before its end (stopped for repeating itself, or at the output limit): the
 * unfinished last lines go and the blocks still open are closed, when that makes it parse. Only
 * for a program that fails in its last line; anything else is the fix's to judge.
 */
export function closeCutOff(code: string): { code: string; dropped: number; closed: number } | null {
  try {
    parse(code, PARSE_OPTIONS);
    return null;
  } catch (err) {
    const pos = (err as { pos?: number }).pos;
    // At the end, or inside its last line (a string or comment cut off there)
    if (typeof pos !== 'number' || code.slice(pos).trim().includes('\n')) return null;
  }
  const lines = code.replace(/\s+$/, '').split('\n');
  for (let dropped = 0; dropped <= 8 && dropped < lines.length; dropped++) {
    const kept = lines.slice(0, lines.length - dropped).join('\n');
    const open: string[] = [];
    try {
      for (const token of tokenizer(kept, PARSE_OPTIONS)) {
        const label = token.type.label;
        if (label === '{' || label === '(' || label === '[' || label === '${') open.push(label);
        else if (label === '}' || label === ')' || label === ']') open.pop();
      }
    } catch {
      continue; // cut inside a string or comment: drop another line
    }
    // Only blocks are closed: a cut call or array (`ctx.arc(100, 100`) loses its line instead
    if (open.length === 0 || open.some((o) => o !== '{')) continue;
    const closed = `${kept}\n${open.map(() => '}').join('\n')}`;
    if (tryParse(closed)) return { code: closed, dropped, closed: open.length };
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

/** The program with every use of the identifier `from` renamed to `to` (by position, not text) */
function renameIdentifier(code: string, ast: AnyNode, from: string, to: string): string {
  const spots: number[] = [];
  walk(ast, (node) => {
    if (node.type === 'Identifier' && node.name === from) spots.push(node.start);
  });
  let out = code;
  for (const at of spots.sort((a, b) => b - a)) out = out.slice(0, at) + to + out.slice(at + from.length);
  return out;
}

const list = (all: string[], max = 10, names = [...new Set(all)]) => names.slice(0, max).join(', ') + (names.length > max ? ', …' : '');

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
  // A slip of a declared name, or of a browser global (requestAnimationFrme)
  const slip = slipOf(name, declared.map((d) => d.name)) ?? slipOf(name, Object.getOwnPropertyNames(globalThis));
  if (slip) return { correction: { code: renameIdentifier(code, ast, name, slip), note: `${name} → ${slip}` } };
  const functions = topLevel.filter((d) => d.kind === 'function').map((d) => `${d.name}()`);
  const variables = topLevel.filter((d) => d.kind === 'variable').map((d) => d.name);
  // An element on the page named like it (bill → #billInput): where its value is
  const standIns = new Set((page?.standIns ?? []).map((s) => s.id));
  const fields = (page?.ids ?? []).filter((id) => !standIns.has(id) && id.toLowerCase().replace(/[-_]/g, '').includes(name.toLowerCase()));
  const onPage = fields.length
    ? ` The page has ${fields.slice(0, 3).map((id) => `#${id} (document.getElementById('${id}').value)`).join(', ')}.`
    : '';
  return {
    text: `Nothing named ${name} is declared.${functions.length ? ` The program's functions: ${list(functions)}.` : ''}${variables.length ? ` Its variables: ${list(variables)}.` : ''}${onPage}`,
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
      const corrected = code.replace(new RegExp(`(['"\`])#?${id.replace(/[-]/g, '\\-')}\\1`, 'g'), (m) => m.replace(id, slip));
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
 * A program that doesn't parse only because one line ends in a stray quote or backtick (a reply's
 * `speak("Done.");` with markdown's closing backtick kept): that character goes, when removing it
 * alone makes the whole program parse. Lines are tried from the end; the first that works wins.
 */
export function dropStrayQuote(code: string): { code: string; line: number } | null {
  if (tryParse(code)) return null;
  const lines = code.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].replace(/\s+$/, '');
    const last = text.slice(-1);
    if (!/[`'"]/.test(last) || (text.split(last).length - 1) % 2 === 0) continue;
    const candidate = [...lines.slice(0, i), text.slice(0, -1), ...lines.slice(i + 1)].join('\n');
    if (tryParse(candidate)) return { code: candidate, line: i + 1 };
  }
  return null;
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
  const stray = dropStrayQuote(code);
  if (stray) return { correction: { code: stray.code, note: `a stray quote at the end of line ${stray.line} → removed` } };
  const twice = error.match(/Identifier '([^']+)' has already been declared/) ?? error.match(/Cannot declare a (?:const|let) variable twice: '([^']+)'/);
  if (twice) {
    const name = twice[1].replace(/\$/g, '\\$');
    let seen = 0;
    const repaired = code
      .replace(new RegExp(`\\b(const|let|var)(\\s+)${name}\\b`, 'g'), (_match, _kind, space) => (seen++ === 0 ? `let${space}${twice[1]}` : twice[1]));
    if (seen > 1 && parseErrorLine(repaired) === 0) {
      return { correction: { code: repaired, note: `${twice[1]} declared twice → assigned the second time` } };
    }
  }
  return null;
}

/** Helpers every program already has, ready to use */
const HELPERS = ['out', 'speak', 'clear', 'root'];
/** Names the sandbox provides besides the browser's own */
const SANDBOX_NAMES = [...HELPERS, 'playNotes', 'searchWikipedia'];

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
    if (resolve(tree, node, name) || name in globalThis || SANDBOX_NAMES.includes(name)) continue;
    const to = caseSlip(name, visibleFrom(node));
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
  // A copy that takes nothing and holds several statements is the program itself, written as
  // `const speak = () => { … }`: it is renamed (and its calls without arguments with it), not
  // dropped; calls that pass something go to the real helper
  const holdsProgram = (fn: AnyNode | null | undefined) =>
    !!fn && /Function/.test(fn.type) && ((fn.params as AnyNode[]) ?? []).length === 0 && (fn.body as AnyNode)?.type === 'BlockStatement' && ((fn.body as AnyNode).body as AnyNode[]).length >= 3;
  for (const statement of ast.body as AnyNode[]) {
    const declared = statement.type === 'FunctionDeclaration' ? statement : statement.type === 'VariableDeclaration' ? ((statement.declarations as AnyNode[])[0] as AnyNode) : null;
    const id = declared ? ((declared.id as AnyNode | undefined) ?? null) : null;
    const fn = statement.type === 'FunctionDeclaration' ? statement : ((declared?.init as AnyNode | undefined) ?? null);
    if (!id || id.type !== 'Identifier' || !HELPERS.includes(id.name as string) || !holdsProgram(fn)) continue;
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

/**
 * Imports of three.js, which Chatty provides as THREE (javascript-runtime.ts): `import * as T
 * from 'three'` becomes `const T = THREE;`, `import { Scene, Mesh as M } from 'three'` becomes
 * `const { Scene, Mesh: M } = THREE;`. Programs run as scripts, where an import can't stand.
 */
export function provideThree(code: string): { code: string; changed: boolean } {
  let changed = false;
  const out = code.replace(/^[ \t]*import\s+([^;\n]+?)\s+from\s+(['"])three\2[ \t]*;?[ \t]*$/gm, (line, clause: string) => {
    const star = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (star) {
      changed = true;
      return star[1] === 'THREE' ? '' : `const ${star[1]} = THREE;`;
    }
    const named = clause.match(/^\{([^}]*)\}$/);
    if (named) {
      changed = true;
      const parts = named[1].split(',').map((p) => p.trim()).filter(Boolean).map((p) => p.replace(/\s+as\s+/, ': '));
      return `const { ${parts.join(', ')} } = THREE;`;
    }
    const def = clause.match(/^([A-Za-z_$][\w$]*)$/);
    if (def) {
      changed = true;
      return def[1] === 'THREE' ? '' : `const ${def[1]} = THREE;`;
    }
    return line;
  });
  return { code: out, changed };
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
function argumentCountFacts(code: string, error: string, errorLine?: number): ErrorHint | null {
  const text = argumentCountFact(code, error, errorLine);
  return text ? { text } : null;
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
    let text = `#${id} was never created: the program has no element with that id, so ${stoodIn}${member ? ` (a <${tag}> has no ${member}${call ? '()' : ''})` : ''}. Create the element it needs with document.createElement and give it id "${id}".`;
    if (member && SOUND_MEMBER.test(member)) text += ' Notes play through a Web MIDI output: output.send([0x90 + channel, note, velocity], time), from (await navigator.requestMIDIAccess()).outputs.';
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
 * browser's CanvasRenderingContext2D properties, and the element properties programs set most
 */
const SETTABLE = new Set([
  'fillStyle', 'strokeStyle', 'font', 'lineWidth', 'globalAlpha', 'textAlign', 'textBaseline', 'lineCap', 'lineJoin',
  'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY', 'globalCompositeOperation', 'filter', 'imageSmoothingEnabled',
  'textContent', 'innerText', 'innerHTML', 'value', 'src', 'className', 'title', 'placeholder', 'disabled', 'checked',
]);

/** `x.fillStyle is not a function`: each `x.fillStyle(value)` statement becomes `x.fillStyle = value` */
function propertyCalled(code: string, error: string): ErrorHint | null {
  const missing = missingMethod(error);
  if (!missing || !SETTABLE.has(missing.method)) return null;
  const { object, method: prop } = missing;
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

/** `setValueAtTime(value)` without its time (the browser needs two): 0, a time already past, sets it now */
function audioParamTime(code: string, error: string): ErrorHint | null {
  if (!/'setValueAtTime' on 'AudioParam': 2 arguments required/.test(error)) return null;
  const ast = tryParse(code);
  if (!ast) return null;
  const ends: number[] = [];
  walk(ast, (node) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = node as any;
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.property.name === 'setValueAtTime' && n.arguments.length === 1) {
      ends.push(n.arguments[0].end);
    }
  });
  if (ends.length === 0) return null;
  let fixed = code;
  for (const at of ends.sort((a, b) => b - a)) fixed = `${fixed.slice(0, at)}, 0${fixed.slice(at)}`;
  return tryParse(fixed) ? { correction: { code: fixed, note: 'setValueAtTime(value) → setValueAtTime(value, 0): a time already past sets it now' } } : null;
}

/**
 * A method called on undefined, in a statement of its own (`p.stop()` when p is undefined):
 * when the value comes from the program's own function that returns nothing but ends in a call
 * (`notes.map((n) => play(n))`, `const p = play(n)`), that call is returned; otherwise the call
 * is made only if there is something to call (`p?.stop?.()`). Only the failing statement.
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
  const fn = maker ? nodes.find((n) => n.type === 'FunctionDeclaration' && n.id?.name === maker) : null;
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
  const edits: Array<{ at: number; text: string; name: string }> = [];
  for (const name of requested) {
    const fn = functions.get(name);
    if (!fn) continue;
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

/**
 * Before a program runs: `const output = midi.outputs.values().next()` keeps the iterator's
 * result ({ value, done }), not the item. Used for anything but its value and done (output.send),
 * it was meant to be the item: `.next().value`.
 */
export function fixIteratorResults(code: string): { code: string; fixed: string[] } {
  const ast = tryParse(code);
  if (!ast) return { code, fixed: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const declarators: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const members = new Map<string, Set<string>>();
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
  });
  const edits: Array<{ at: number; name: string }> = [];
  for (const d of declarators) {
    const used = members.get(d.id.name);
    if (!used || used.has('value') || used.has('done')) continue;
    edits.push({ at: d.init.end, name: d.id.name });
  }
  if (edits.length === 0) return { code, fixed: [] };
  let out = code;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = `${out.slice(0, e.at)}.value${out.slice(e.at)}`;
  return tryParse(out) ? { code: out, fixed: edits.map((e) => e.name) } : { code, fixed: [] };
}

/** The audio nodes an AudioContext makes with create…() (for where the browser's own type isn't there) */
const AUDIO_NODE_MAKERS = ['createOscillator', 'createGain', 'createAnalyser', 'createBufferSource', 'createBiquadFilter', 'createDelay', 'createConvolver', 'createStereoPanner', 'createDynamicsCompressor', 'createWaveShaper', 'createPanner', 'createBuffer'];

/**
 * Before a program runs: an audio node read as a property of an AudioContext (`ctx.oscillator`,
 * `new AudioContext().gain`), which has none: AudioContext makes them with create…(), so it
 * becomes `ctx.createOscillator()` (`ctx.oscillator()` too)
 */
export function fixAudioNodeProperties(code: string): { code: string; fixed: string[] } {
  const ast = tryParse(code);
  if (!ast) return { code, fixed: [] };
  const proto = (globalThis as unknown as { AudioContext?: { prototype: object } }).AudioContext?.prototype;
  const makers = proto ? Object.getOwnPropertyNames(Object.getPrototypeOf(proto) ?? {}).concat(Object.getOwnPropertyNames(proto)).filter((k) => /^create[A-Z]/.test(k)) : AUDIO_NODE_MAKERS;
  const isNewAudioContext = (n: AnyNode | null | undefined) =>
    !!n && n.type === 'NewExpression' && /AudioContext/.test(code.slice((n.callee as AnyNode).start, (n.callee as AnyNode).end));
  // Names that hold an AudioContext the program made
  const contexts = new Set<string>();
  walk(ast, (node) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = node as any;
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isNewAudioContext(n.init)) contexts.add(n.id.name);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onContext = (n: any) => n.type === 'MemberExpression' && !n.computed && (isNewAudioContext(n.object) || (n.object.type === 'Identifier' && contexts.has(n.object.name)));
  // A property the program sets on the context itself (ctx.analyser = ctx.createAnalyser()) is
  // its own: every read of it is that node, not a new one
  const assigned = new Set<string>();
  walk(ast, (node) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = node as any;
    if (n.type === 'AssignmentExpression' && onContext(n.left)) assigned.add(n.left.property.name);
  });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const fixed: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visit = (n: any, parent: any, key: string) => {
    if (!n || typeof n.type !== 'string') return;
    if (onContext(n)) {
      const prop: string = n.property.name;
      const maker = `create${prop[0].toUpperCase()}${prop.slice(1)}`;
      const written = parent?.type === 'AssignmentExpression' && key === 'left';
      if (!written && !assigned.has(prop) && !(proto && prop in proto) && makers.includes(maker)) {
        const called = parent?.type === 'CallExpression' && key === 'callee';
        edits.push({ start: n.property.start, end: n.property.end, text: called ? maker : `${maker}()` });
        fixed.push(`${prop} → ${maker}()`);
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, n, k));
      else if (v && typeof v.type === 'string') visit(v, n, k);
    }
  };
  visit(ast, null, '');
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
  // Corrections by rule first: they need no model
  const rule =
    redeclaredHelper(code, error) ??
    missingAwait(code, error, errorLine) ??
    syntaxSlip(code, error, errorLine) ??
    propertyCalled(code, error) ??
    audioParamTime(code, error);
  if (rule) return rule;
  const helper = helperDeclared(code, error);
  if (helper) return helper;
  const method = methodHint(code, error);
  // A sure slip of a real member (getcontext) is corrected; otherwise a stand-in explains the error
  const standIn = method?.correction ? null : standInElement(code, error, errorLine, page);
  if (standIn) return standIn;
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
  const found = argumentCountFacts(code, error, errorLine) ?? notDefined(code, error, errorLine, page) ?? nothingThere(code, error, errorLine, page) ?? leftOpen(code, error) ?? tooEarly(code, error, errorLine);
  if (found?.correction) return found;
  // A method called on undefined (not on a missing element, which is null): its maker returns,
  // or the call is made only when there is something to call
  const nothingToCall = callOnUndefined(code, error, errorLine);
  if (nothingToCall) return nothingToCall;
  // Calls of the failing function that pass too few values, added to whatever else was found
  const calls = shortCalls(code, errorLine);
  const text = [found?.text, calls].filter(Boolean).join(' ');
  return text ? { text } : null;
}
