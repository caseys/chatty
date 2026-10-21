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
import { applyCorrection, argumentCountFact, methodHint } from './method-hints.ts';

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
  kind: 'function' | 'variable' | 'parameter';
}

/** Every name the program declares: functions, variables and parameters */
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
    if (node.type === 'VariableDeclarator') addPattern(node.id as AnyNode, inside, 'variable');
    if (/Function/.test(node.type)) for (const param of node.params as AnyNode[]) addPattern(param, node, 'parameter');
  });
  return found;
}

function distance(a: string, b: string): number {
  // Edits between two names, a swap of neighbours counting as one (totla → total)
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The one name that differs from the missing one only in letter case, or null */
function caseSlip(missing: string, names: string[]): string | null {
  const sameLetters = [...new Set(names)].filter((name) => name !== missing && name.toLowerCase() === missing.toLowerCase());
  return sameLetters.length === 1 ? sameLetters[0] : null;
}

/** The one name a missing one is surely a slip of, or null */
function slipOf(missing: string, names: string[]): string | null {
  // A plural and its singular (balls, ball) are a list and one of its items, not a slip
  const plural = (a: string, b: string) => a.toLowerCase() === `${b.toLowerCase()}s` || a.toLowerCase() === `${b.toLowerCase()}es`;
  const unique = [...new Set(names)].filter((name) => name !== missing && !plural(missing, name) && !plural(name, missing));
  const sameCase = caseSlip(missing, unique);
  if (sameCase) return sameCase;
  if (missing.length < 4) return null;
  const close = unique.filter((name) => distance(missing.toLowerCase(), name.toLowerCase()) <= (missing.length >= 7 ? 2 : 1));
  return close.length === 1 ? close[0] : null;
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
    const slip = slipOf(id, ids) ?? (ids.find((other) => other.replace(/[-_]/g, '').toLowerCase() === id.replace(/[-_]/g, '').toLowerCase()) || null);
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
  const declared = declarations(ast).filter((d) => d.kind === 'variable');
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
 * Before a program runs: a name used but never declared, that differs from exactly one declared
 * name (visible from where it is used) only in letter case (`mycount` for `myCount`,
 * `drawscene()` for `drawScene()`), is renamed. The error-time version is notDefined(); both
 * use caseSlip(). Browser globals and the sandbox's own names are never renamed.
 */
export function fixCaseSlips(code: string): { code: string; fixed: Array<{ from: string; to: string }> } {
  const ast = tryParse(code);
  if (!ast) return { code, fixed: [] };
  const declared = declarations(ast);
  const declaredNames = new Set(declared.map((d) => d.name));
  const edits = new Map<number, { end: number; text: string; from: string; to: string }>();
  const visit = (node: AnyNode, parent: AnyNode | null, functions: AnyNode[]) => {
    if (node.type === 'Identifier') {
      const name = node.name as string;
      const p = parent;
      const isName =
        (p?.type === 'MemberExpression' && p.property === node && !p.computed) ||
        (p?.type === 'Property' && p.key === node && !p.computed && !p.shorthand) ||
        ((p?.type === 'MethodDefinition' || p?.type === 'PropertyDefinition') && p.key === node && !p.computed) ||
        ((p?.type === 'LabeledStatement' || p?.type === 'BreakStatement' || p?.type === 'ContinueStatement') && p.label === node) ||
        (p?.type === 'UnaryExpression' && p.operator === 'typeof');
      if (!isName && !declaredNames.has(name) && !(name in globalThis) && !SANDBOX_NAMES.includes(name)) {
        const visible = declared.filter((d) => !d.inside || functions.includes(d.inside)).map((d) => d.name);
        const to = caseSlip(name, visible);
        if (to && !edits.has(node.start)) {
          const shorthand = p?.type === 'Property' && p.shorthand;
          edits.set(node.start, { end: node.end, text: shorthand ? `${name}: ${to}` : to, from: name, to });
        }
      }
    }
    const inner = /Function/.test(node.type) ? [...functions, node] : functions;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && visit(child, node, inner);
      else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') visit(value as AnyNode, node, inner);
    }
  };
  visit(ast, null, []);
  let out = code;
  for (const [start, edit] of [...edits].sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + edit.text + out.slice(edit.end);
  const fixed = [...new Map([...edits.values()].map((e) => [`${e.from}→${e.to}`, { from: e.from, to: e.to }])).values()];
  return { code: out, fixed };
}

/**
 * Before a program runs: its own definitions of a ready-made helper (`function speak(text) {
 * console.log(text) }`, `const out = …`) are taken out, so the real helper is used. A function
 * declaration applies to the whole program, so one such definition silently swallows every call.
 */
export function dropHelperCopies(code: string): { code: string; dropped: string[] } {
  const ast = tryParse(code);
  if (!ast) return { code, dropped: [] };
  const spans: Array<{ start: number; end: number; name: string }> = [];
  for (const statement of ast.body as AnyNode[]) {
    if (statement.type === 'FunctionDeclaration' && HELPERS.includes(((statement.id as AnyNode)?.name as string) ?? '')) {
      spans.push({ start: statement.start, end: statement.end, name: (statement.id as AnyNode).name as string });
    }
    if (statement.type === 'VariableDeclaration') {
      const declarations = statement.declarations as AnyNode[];
      const id = declarations[0]?.id as AnyNode | undefined;
      const init = declarations[0]?.init as AnyNode | null | undefined;
      // Only a stand-in for the helper (a function, a class, a `new …`); a real value it was given
      // (const out = MIDI output) stays
      const standIn = !!init && /^(?:FunctionExpression|ArrowFunctionExpression|ClassExpression|NewExpression)$/.test(init.type);
      if (declarations.length === 1 && standIn && id?.type === 'Identifier' && HELPERS.includes(id.name as string)) {
        spans.push({ start: statement.start, end: statement.end, name: id.name as string });
      }
    }
  }
  let out = code;
  for (const { start, end } of spans.reverse()) {
    const after = out.slice(end).match(/^[ \t]*\n?/)?.[0].length ?? 0;
    out = out.slice(0, start) + out.slice(end + after);
  }
  return { code: out, dropped: spans.map((s) => s.name).reverse() };
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
    if (member && SOUND_MEMBER.test(member)) text += ' Notes, chords and drums play through out.send({ notes, instrument, time, duration }).';
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

export function errorHint(code: string, error: string, errorLine?: number, page?: PageFacts): ErrorHint | null {
  // Corrections by rule first: they need no model
  const rule = redeclaredHelper(code, error) ?? missingAwait(code, error, errorLine) ?? syntaxSlip(code, error, errorLine);
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
      : { text: method.text };
  }
  const found = argumentCountFacts(code, error, errorLine) ?? notDefined(code, error, errorLine, page) ?? nothingThere(code, error, errorLine, page) ?? leftOpen(code, error) ?? tooEarly(code, error, errorLine);
  if (found?.correction) return found;
  // Calls of the failing function that pass too few values, added to whatever else was found
  const calls = shortCalls(code, errorLine);
  const text = [found?.text, calls].filter(Boolean).join(' ');
  return text ? { text } : null;
}
