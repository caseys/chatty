/**
 * Smarter answers to the errors programs hit most. For each, either a correction Chatty can make
 * itself (exactly one clear match: a typo of a declared name, an element id one slip away from
 * an id on the page, a method's wrong case) or the facts the model is missing, for the fix
 * request: where a name really is declared, which ids the page has, what a value came from,
 * what was left open. Method names are in method-hints.ts.
 */
import { parse, tokenizer, type Node } from 'acorn';
import { applyCorrection, methodHint } from './method-hints.ts';

export interface ErrorHint {
  /** Facts for the fix request */
  text?: string;
  /** The program corrected without the model, and what was changed (for the run log) */
  correction?: { code: string; note: string };
}

/** What the live page holds, read from the sandbox when the program failed */
export interface PageFacts {
  ids: string[];
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

/** The one name a missing one is surely a slip of, or null */
function slipOf(missing: string, names: string[]): string | null {
  const unique = [...new Set(names)].filter((name) => name !== missing);
  const sameLetters = unique.filter((name) => name.toLowerCase() === missing.toLowerCase());
  if (sameLetters.length === 1) return sameLetters[0];
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

const list = (names: string[], max = 10) => names.slice(0, max).join(', ') + (names.length > max ? ', …' : '');

/** 1. "x is not defined" */
function notDefined(code: string, error: string, errorLine?: number): ErrorHint | null {
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
  const topLevel = declared.filter((d) => !d.inside || d.kind === 'function');
  // A slip of a declared name, or of a browser global (requestAnimationFrme)
  const slip = slipOf(name, declared.map((d) => d.name)) ?? slipOf(name, Object.getOwnPropertyNames(globalThis));
  if (slip) return { correction: { code: renameIdentifier(code, ast, name, slip), note: `${name} → ${slip}` } };
  const functions = topLevel.filter((d) => d.kind === 'function').map((d) => `${d.name}()`);
  const variables = topLevel.filter((d) => d.kind === 'variable').map((d) => d.name);
  return {
    text: `Nothing named ${name} is declared.${functions.length ? ` The program's functions: ${list(functions)}.` : ''}${variables.length ? ` Its variables: ${list(variables)}.` : ''}`,
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

/** Help for a failed program: a correction, or facts for the fix request */
export function errorHint(code: string, error: string, errorLine?: number, page?: PageFacts): ErrorHint | null {
  const method = methodHint(code, error);
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
  return notDefined(code, error, errorLine) ?? nothingThere(code, error, errorLine, page) ?? leftOpen(code, error) ?? tooEarly(code, error, errorLine);
}
