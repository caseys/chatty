import { parse } from 'acorn';
import { parse as parseLoose } from 'acorn-loose';
import { focusedContext } from './blank-fix.ts';
/**
 * Fixing a failed program. A fix turn has its own short system prompt (FIX_SYSTEM_PROMPT) and one
 * message, the user's: what the program is for, the error, what to reply, then the whole program
 * in a code fence with the failing line between // >>> ERROR and // <<< ERROR comments. The model
 * replies with a "// Cause:" line and the corrected marked line only, which goes back in its
 * place. Asked for the whole program, models copied the bug back, or kept copying past the code
 * into the instructions and dropped the rest; a line is short and can't lose anything else. A
 * reply that is a whole program, or search/replace blocks, is still taken.
 */

/** The function (declaration, expression or arrow with a body) around a line: its first and last line */
export function enclosingFunction(code: string, line: number | undefined): { start: number; end: number; name: string } | null {
  if (!line) return null;
  let ast: unknown;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, locations: true });
  } catch {
    return null;
  }
  // The innermost named function around the line (an anonymous callback is a poor unit to ask
  // for: models answer with the named function around it); the innermost one when none is named
  let best: { start: number; end: number; name: string } | null = null;
  let named: { start: number; end: number; name: string } | null = null;
  const visit = (node: Record<string, unknown>) => {
    const loc = node.loc as { start: { line: number }; end: { line: number } } | undefined;
    if (/Function/.test(String(node.type)) && loc && loc.start.line <= line && loc.end.line >= line && loc.end.line > loc.start.line) {
      const id = node.id as { name?: string } | null;
      const found = { start: loc.start.line, end: loc.end.line, name: id?.name ?? '' };
      if (!best || found.end - found.start < best.end - best.start) best = found;
      if (found.name && (!named || found.end - found.start < named.end - named.start)) named = found;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => child && typeof child.type === 'string' && visit(child));
      else if (value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string') visit(value as Record<string, unknown>);
    }
  };
  visit(ast as Record<string, unknown>);
  return named ?? best;
}

const STRICT = { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true } as const;

/**
 * The lines of a program that don't parse: the forgiving parser (acorn-loose) splits even a
 * broken program into its statements, and each is checked on its own with the strict one. The
 * span from the first broken statement to the last, or null when the program parses (or the
 * span is too long to ask for).
 */
export function brokenLines(code: string): { start: number; end: number } | null {
  try {
    parse(code, STRICT);
    return null;
  } catch {
    // Broken: find where
  }
  let program: { body: Array<{ start: number; end: number; loc: { start: { line: number }; end: { line: number } } }> };
  try {
    // (the same options as the strict parse: without them a top-level await splits its statement
    // in two, and a program's `const midi = await …` is marked as the line that doesn't parse)
    program = parseLoose(code, { ...STRICT, locations: true }) as unknown as typeof program;
  } catch {
    return null;
  }
  const broken = program.body.filter((statement) => {
    try {
      parse(code.slice(statement.start, statement.end), STRICT);
      return false;
    } catch {
      return true;
    }
  });
  if (broken.length === 0) return null;
  const start = broken[0].loc.start.line;
  const end = broken[broken.length - 1].loc.end.line;
  return end - start < 60 ? { start, end } : null;
}

/** The system prompt of a fix turn: only what fixing needs */
export const FIX_SYSTEM_PROMPT = [
  "You fix JavaScript programs that run in the user's browser. Each request gives the error and the program, with the failing code between // >>> ERROR and // <<< ERROR comments.",
  'Reply with one comment line naming the cause (// Cause: ...), then only the corrected marked code (the line, or the whole function when one is marked), without the ERROR comments.',
].join('\n');

const MARK_START = '// >>> ERROR';
const MARK_END = '// <<< ERROR';
/** A line the model copied from the markers */
const MARKER_LINE = /^\s*\/\/\s*(?:>>>|<<<)\s*ERROR\b.*$/;
/** An instruction line the model copied back from the request */
const INSTRUCTION_LINE =
  /^\s*(?:(?:Reply with|First write|Then write|Second write)\b.*(?:Cause|corrected|program)|(?:Marked line|Corrected line):?\s*$)/i;

/**
 * The fix request. With `block` (a second try, after a fix that changed nothing), the whole
 * function around the failing line is marked and asked for instead of the one line.
 */
export function fixRequest(
  request: string,
  code: string,
  line: number | undefined,
  error: string,
  hint?: string,
  block?: { start: number; end: number; why?: 'unchanged' | 'syntax' }
): string {
  const task = request.replace(/\s+/g, ' ').trim().replace(/[.!?:,;\s]+$/, '').slice(0, 200);
  const problem = error.trim().replace(/\.+$/, '');
  let lines = code.split('\n');
  const at = line && line >= 1 && line <= lines.length ? line : undefined;
  const failing = at ? lines[at - 1].trim() : '';
  // A long program shows only the function around the line and the declarations it uses
  // (the reply is still applied to the whole program, by its own line numbers)
  const SHORT = 25;
  let markAt = at;
  if (lines.length > SHORT && at) {
    const first = focusedContext(code, block ? block.start : at);
    const last = block ? focusedContext(code, block.end) : first;
    // A block must come out the same length, or the whole program is shown
    if (!block || last.lineInContext - first.lineInContext === block.end - block.start) {
      lines = first.text.split('\n');
      const shift = first.lineInContext - (block ? block.start : at);
      if (markAt) markAt += shift;
      if (block) block = { ...block, start: block.start + shift, end: block.end + shift };
    }
  }
  if (block && block.start >= 1 && block.end <= lines.length && block.start <= block.end) {
    const indent = lines[block.start - 1].match(/^\s*/)?.[0] ?? '';
    lines.splice(block.end, 0, `${indent}${MARK_END}`);
    lines.splice(block.start - 1, 0, `${indent}${MARK_START}: ${problem}${at ? ` (at line ${at})` : ''}`);
    return [
      ...(task ? [`This program was written for: ${task}`] : []),
      block.why === 'syntax' ? `The marked lines don't parse: ${problem}` : `It failed in the marked function: ${problem}`,
      ...(hint ? [hint] : []),
      block.why === 'syntax'
        ? 'Reply with one comment line saying what is wrong (// Cause: ...), then the marked lines rewritten as valid JavaScript, without the ERROR comments.'
        : 'Changing only the failing line did not fix it. Reply with one comment line saying what caused the error (// Cause: ...), then the whole marked function, corrected, without the ERROR comments.',
      '```js',
      lines.join('\n'),
      '```',
    ].join('\n');
  }
  if (at && markAt) {
    const indent = lines[markAt! - 1].match(/^\s*/)?.[0] ?? '';
    lines.splice(markAt - 1, 1, `${indent}${MARK_START}: ${problem}`, lines[markAt! - 1], `${indent}${MARK_END}`);
  }
  // The instruction comes before the code, so copying the code never runs on into it
  return [
    ...(task ? [`This program was written for: ${task}`] : []),
    at ? `It failed at the marked line: ${problem}` : `It failed: ${problem}`,
    // What the object really has, when the error is a missing method (see method-hints.ts)
    ...(hint ? [hint] : []),
    at
      ? 'Reply with one comment line saying what caused the error (// Cause: ...), then only the corrected marked line, without the ERROR comments.'
      : 'Reply with one comment line saying what caused the error (// Cause: ...), then the complete program with it fixed.',
    '```js',
    lines.join('\n'),
    '```',
    // The reply starts right after the label, so it is the line and not talk
    ...(at ? ['Marked line:', failing, 'Corrected line:'] : []),
  ].join('\n');
}

const SEARCH_REPLACE = /<{5,}\s*SEARCH[^\n]*\n([\s\S]*?)\n?={5,}[^\n]*\n([\s\S]*?)\n?>{5,}\s*REPLACE/gi;

/** Lines without code fences or the line numbers the model was shown ("30: ...") */
function cleanLines(text: string): string[] {
  const lines = text.split('\n').filter((line) => !/^\s*```/.test(line));
  const numbered = /^\s*\d+\s*[:|]\s?/;
  const nonEmpty = lines.filter((line) => line.trim());
  if (nonEmpty.length > 0 && nonEmpty.every((line) => numbered.test(line))) {
    return lines.map((line) => line.replace(numbered, ''));
  }
  return lines;
}

/** The lines a search block looks for: trimmed (indentation may differ), no blank lines at its ends */
function searchLines(search: string): string[] {
  const lines = cleanLines(search).map((line) => line.trim());
  while (lines.length > 0 && !lines[0]) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
  return lines;
}

/** Where the wanted lines sit in the program's lines, or -1 */
function findLines(lines: string[], wanted: string[]): number {
  if (wanted.length === 0) return -1;
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    if (wanted.every((line, j) => lines[i + j].trim() === line)) return i;
  }
  return -1;
}

/**
 * The program after a fix reply: its search/replace blocks applied (blocks that don't match are
 * skipped). A reply without blocks is taken as a whole new program, so a model that rewrites it
 * anyway still gets its program run.
 */
const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor;

function parses(code: string): boolean {
  try {
    new AsyncFunctionCtor(code);
    return true;
  } catch {
    return false;
  }
}

/** A reply's lines without our ERROR markers, copied instructions, fence lines and the "// Cause:" line */
function keepCodeLines(text: string): string[] {
  return (
    text
      .split('\n')
      // "Corrected line: foo();" copied the label the request ended with
      .map((l) => l.replace(/^\s*Corrected line:[ \t]*/i, ''))
      // Code written as inline markdown (`foo();`) would run as a string that does nothing
      .map((l) => l.replace(/^(\s*)`([^`]+)`\s*$/, '$1$2'))
      // …nor the "// Cause:" line, which explains the fix and isn't part of it
      .filter((l) => !MARKER_LINE.test(l) && !INSTRUCTION_LINE.test(l) && !/^\s*```/.test(l) && !/^\s*(?:\/\/\s*)?Cause\s*:/i.test(l))
  );
}

/**
 * The code of a reply: inside its code fence if it has one (prose and comments around the fence
 * are not code), else all of it. A fence that holds nothing (a trailing "```js" after a whole
 * program) or code before the fence that makes the whole reply a program: the whole reply,
 * fence lines dropped.
 */
function replyCode(reply: string, wholeFor?: string): string[] {
  const fences = [...reply.matchAll(/```[\w-]*[ \t]*\n([\s\S]*?)(?:```|$)/g)].filter((m) => m[1].trim());
  // Asked for the whole program, a reply with several code blocks gives the complete one, not the
  // fragment that came first: the block that keeps the most of the program's own lines (then the
  // longer, then the first)
  if (wholeFor !== undefined && fences.length > 1) {
    const own = new Set(wholeFor.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')));
    // (a block that is the program itself is "Before it was:", not the fix)
    const squash = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    const others = fences.filter((m) => squash(m[1]) !== squash(wholeFor));
    const scored = (others.length > 0 ? others : fences).map((m) => {
      const order = fences.indexOf(m);
      const lines = m[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
      return { m, order, kept: lines.filter((l) => own.has(l)).length, length: lines.length };
    });
    scored.sort((a, b) => b.kept - a.kept || b.length - a.length || a.order - b.order);
    if (scored[0].order !== 0) return keepCodeLines(scored[0].m[1]);
  }
  const fenced = reply.match(/```[\w-]*[ \t]*\n([\s\S]*?)(?:```|$)/);
  if (!fenced || !fenced[1].trim()) return keepCodeLines(reply);
  const before = keepCodeLines(reply.slice(0, fenced.index)).filter((l) => l.trim() && !/^\s*\/\//.test(l));
  if (before.length > 0 && !bareStatements(before.join('\n'))) {
    const whole = keepCodeLines(reply);
    if (parses(whole.join('\n'))) return whole;
  }
  return keepCodeLines(fenced[1]);
}

/** Only lone names or literals ("Fixed", "Done", "42"): prose that happens to parse, not code */
function bareStatements(text: string): boolean {
  try {
    const body = (parse(text, STRICT) as unknown as { body: Array<{ type: string; expression?: { type: string } }> }).body;
    return body.every((n) => n.type === 'EmptyStatement' || (n.type === 'ExpressionStatement' && ['Identifier', 'Literal'].includes(n.expression?.type ?? '')));
  } catch {
    return false;
  }
}

/**
 * The code a reply gave only inside a comment ("// <<< corrected line: foo();"): the text after a
 * "corrected …:" label that parses as JavaScript, when exactly one comment line has such text.
 * Prose ("Fix the time declaration") doesn't parse; a lone name or literal isn't taken as code.
 */
function commentedCode(lines: string[]): string | null {
  const found: string[] = [];
  for (const l of lines) {
    const m = l.match(/^\s*\/\/\s*(?:(?:<<<|>>>|\+\+\+)\s*)?(?:the\s+)?corrected\b[^:\n]{0,30}:\s*(\S.*)$/i);
    if (!m) continue;
    try {
      const body = (parse(m[1], STRICT) as unknown as { body: unknown[] }).body;
      if (body.length > 0 && !bareStatements(m[1])) found.push(m[1].trim());
    } catch {
      // prose
    }
  }
  return found.length === 1 ? found[0] : null;
}

/**
 * The program after a fix reply: the corrected marked line put back in its place (`line`), or
 * search/replace blocks applied. A reply as long as the program is taken as a whole new program.
 */
/** The program with its declaration of the reply's one function swapped for the reply, or null */
function replaceDeclaredFunction(program: string, reply: string): string | null {
  type Node = { type: string; start: number; end: number; id?: { name?: string } | null };
  let replyBody: Node[];
  let programAst: unknown;
  try {
    replyBody = (parse(reply, STRICT) as unknown as { body: Node[] }).body;
    programAst = parse(program, STRICT);
  } catch {
    return null;
  }
  if (replyBody.length !== 1) return null;
  // A function declaration, or one const/let/var holding an arrow or function expression
  let name: string | undefined;
  const statement = replyBody[0] as Node & { declarations?: Array<{ id: { type: string; name?: string }; init?: { type: string } | null }> };
  if (statement.type === 'FunctionDeclaration') name = statement.id?.name;
  else if (statement.type === 'VariableDeclaration' && statement.declarations?.length === 1) {
    const d = statement.declarations[0];
    if (d.id.type === 'Identifier' && d.init && ['ArrowFunctionExpression', 'FunctionExpression'].includes(d.init.type)) name = d.id.name;
  }
  if (!name) return null;
  const viaVariable = statement.type === 'VariableDeclaration';
  const found: Node[] = [];
  const visit = (node: Record<string, unknown>) => {
    if (node.type === 'FunctionDeclaration' && (node.id as { name?: string } | null)?.name === name) found.push(node as unknown as Node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => child && typeof child.type === 'string' && visit(child));
      else if (value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string') visit(value as Record<string, unknown>);
    }
  };
  visit(programAst as Record<string, unknown>);
  if (found.length !== 1) return null;
  let fn = reply.slice(replyBody[0].start, replyBody[0].end);
  // An arrow or function expression goes back in as a declaration: a declaration can be called
  // before its line, a const can't (it would throw "Cannot access … before initialization")
  if (viaVariable) {
    const init = statement.declarations![0].init as unknown as {
      async?: boolean;
      params: Node[];
      body: Node;
      expression?: boolean;
    };
    const params = init.params.length ? reply.slice(init.params[0].start, init.params[init.params.length - 1].end) : '';
    const body = reply.slice(init.body.start, init.body.end);
    fn = `${init.async ? 'async ' : ''}function ${name}(${params}) ${init.body.type === 'BlockStatement' ? body : `{\n  return ${body};\n}`}`;
  }
  const result = program.slice(0, found[0].start) + fn + program.slice(found[0].end);
  // An arrow in place of a declaration: only when no other binding of the name exists and it parses
  if (viaVariable) {
    if (new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(program)) return null;
    try {
      parse(result, STRICT);
    } catch {
      return null;
    }
  }
  return result;
}

export function applyFixReply(program: string, reply: string, line?: number, endLine?: number, whole = false): string {
  const blocks = [...reply.matchAll(SEARCH_REPLACE)];
  // Edit markers but no edit that can be read: nothing to apply (running it would only fail)
  if (blocks.length === 0 && /^\s*(?:<{5,}|>{5,}|={5,})/m.test(reply)) return program;
  if (blocks.length > 0) {
    let lines = program.split('\n');
    for (const [, search, replace] of blocks) {
      const wanted = searchLines(search);
      const at = findLines(lines, wanted);
      if (at < 0) continue;
      lines = [...lines.slice(0, at), ...cleanLines(replace), ...lines.slice(at + wanted.length)];
    }
    return lines.join('\n');
  }
  const code = replyCode(reply, whole ? program : undefined);
  while (code.length > 0 && !code[code.length - 1].trim()) code.pop();
  while (code.length > 0 && !code[0].trim()) code.shift();
  // No code lines, but a comment that holds the corrected code ("// corrected line: foo();")
  if (code.every((l) => !l.trim() || /^\s*\/\//.test(l))) {
    const commented = commentedCode(code);
    if (commented) code.splice(0, code.length, commented);
  }
  // One function, and the program declares exactly one function of that name: that one is
  // replaced, wherever the marked lines were (a reply often brings the named function around them)
  const sameFunction = replaceDeclaredFunction(program, code.join('\n'));
  if (sameFunction) return sameFunction;
  const lines = program.split('\n');
  const substantial = code.filter((l) => l.trim() && !/^\s*\/\//.test(l)).length;
  const last = endLine && endLine >= (line ?? 0) && endLine <= lines.length ? endLine : line;
  const replaced = line && last ? last - line + 1 : 1;
  // As long as the program (and clearly longer than what it replaces): a whole new program
  if (!line || !last || line < 1 || line > lines.length || substantial >= Math.max(5, replaced + 5, lines.length * 0.6)) {
    return code.join('\n');
  }
  if (substantial === 0) return program;
  // Only talk, or not code at all (chat): that's the reply, not a line (the fix guard sees it)
  const talkOnly = code.every((l) => !l.trim() || /^\s*\/\//.test(l) || /^\s*(?:await\s+)?speak\(.*\);?\s*$/.test(l));
  if (talkOnly || !parses(code.join('\n'))) return code.join('\n');
  // The corrected line, at the failing line's indentation when it came back without one
  const indent = lines[line - 1].match(/^\s*/)?.[0] ?? '';
  const fixed = code.map((l) => (l.trim() && !/^\s/.test(l) ? indent + l : l));
  return [...lines.slice(0, line - 1), ...fixed, ...lines.slice(last)].join('\n');
}

/**
 * A whole-program fix that still uses names the program declared at its top level but left their
 * declarations out (`sounds.piano` with `const sounds = …` gone): those declarations come back
 * from the program, in its order, ahead of the reply. Only names nothing in the reply declares.
 */
export function restoreDeclarations(original: string, fixed: string): { code: string; restored: string[] } {
  type N = { type: string; start: number; end: number; [k: string]: unknown };
  let before: N;
  let after: N;
  try {
    before = parse(original, STRICT) as unknown as N;
    after = parse(fixed, STRICT) as unknown as N;
  } catch {
    return { code: fixed, restored: [] };
  }
  const names = (pattern: N | null | undefined, into: Set<string>) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') into.add(pattern.name as string);
    else if (pattern.type === 'ObjectPattern') for (const p of pattern.properties as N[]) names((p.value ?? p.argument) as N, into);
    else if (pattern.type === 'ArrayPattern') for (const e of pattern.elements as N[]) names(e, into);
    else if (pattern.type === 'RestElement') names(pattern.argument as N, into);
    else if (pattern.type === 'AssignmentPattern') names(pattern.left as N, into);
  };
  // The names a tree declares, and the names it uses (not as a property name)
  const scan = (tree: N) => {
    const declared = new Set<string>();
    const used = new Set<string>();
    const visit = (node: N, parent: N | null) => {
      if (node.type === 'VariableDeclarator') names(node.id as N, declared);
      if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) names(node.id as N, declared);
      if (/Function/.test(node.type)) for (const p of (node.params as N[]) ?? []) names(p, declared);
      if (node.type === 'CatchClause' && node.param) names(node.param as N, declared);
      if (node.type === 'Identifier') {
        const isProperty =
          (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
          (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand);
        if (!isProperty) used.add(node.name as string);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && visit(child as N, node);
        else if (value && typeof value === 'object' && typeof (value as N).type === 'string') visit(value as N, node);
      }
    };
    visit(tree, null);
    return { declared, used };
  };
  const reply = scan(after);
  const statements = (before.body as N[]).map((statement) => {
    const own = new Set<string>();
    if (statement.type === 'VariableDeclaration') for (const d of statement.declarations as N[]) names(d.id as N, own);
    if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && statement.id) names(statement.id as N, own);
    // What the statement itself reads of the program (a declaration reading another: const beat = tempo / 12)
    const reads = scan(statement);
    return { statement, own, reads: [...reads.used].filter((n) => !reads.declared.has(n)) };
  });
  // The declarations that come back are the ones the reply needs, and then the ones those need, and so on
  const declared = new Set(reply.declared);
  let missing = [...reply.used].filter((n) => !declared.has(n));
  const chosen = new Set<N>();
  for (let round = 0; round < 8 && missing.length > 0; round++) {
    let grew = false;
    for (const { statement, own, reads } of statements) {
      if (chosen.has(statement) || ![...own].some((n) => missing.includes(n))) continue;
      chosen.add(statement);
      own.forEach((n) => declared.add(n));
      for (const read of reads) if (!declared.has(read) && !missing.includes(read)) missing.push(read);
      grew = true;
    }
    missing = missing.filter((n) => !declared.has(n));
    if (!grew) break;
  }
  const restored: string[] = [];
  const parts: string[] = [];
  for (const { statement, own } of statements) {
    if (!chosen.has(statement)) continue;
    restored.push(...own);
    parts.push(original.slice(statement.start, statement.end));
  }
  return restored.length ? { code: `${parts.join('\n')}\n${fixed}`, restored } : { code: fixed, restored };
}

/**
 * Whether a program is only text: statements that are strings or template literals with nothing in them to run (a
 * reply that was prose with its code in backticks parses as one template literal). Nothing to restore lines into.
 */
export function isBareText(code: string): boolean {
  try {
    const program = parse(code, STRICT) as unknown as { body: Array<{ type: string; expression?: { type: string; expressions?: unknown[] } }> };
    return program.body.length > 0 && program.body.every((statement) => statement.type === 'ExpressionStatement' && (statement.expression?.type === 'Literal' || (statement.expression?.type === 'TemplateLiteral' && (statement.expression.expressions ?? []).length === 0)));
  } catch {
    return false;
  }
}

/**
 * The top-level statement an error comes from when it carries no line of the program's (it was thrown inside a
 * library, whose own frames hold the stack): the shortest start of the program that already fails the same way.
 * `fails` runs a start of the program (a test run) and says whether it throws that error; a failing start stays
 * failing when it grows, so the statement is found by halving. At most six runs for sixty-four statements. Null
 * when the whole program does not fail, or has no statements.
 */
export async function failingStatement(code: string, fails: (start: string) => Promise<boolean>): Promise<{ line: number; text: string } | null> {
  let body: Array<{ start: number; end: number; loc: { start: { line: number } } }>;
  try {
    body = (parse(code, { ...STRICT, locations: true }) as unknown as { body: typeof body }).body;
  } catch {
    return null;
  }
  if (body.length === 0 || body.length > 64) return null;
  const upTo = (k: number) => code.slice(0, body[k - 1].end);
  if (body.length > 1 && !(await fails(code))) return null;
  let low = 1;
  let high = body.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (await fails(upTo(middle))) high = middle;
    else low = middle + 1;
  }
  const statement = body[low - 1];
  const text = code.slice(statement.start, statement.end).split('\n')[0].trim();
  return { line: statement.loc.start.line, text: text.length > 90 ? `${text.slice(0, 87)}...` : text };
}

/**
 * The lines a fix for this error may change: the top-level statement that holds the failing line
 * (a function or class whole, since a fix of its body may rewrite it), or the statements that
 * don't parse, when the program doesn't. Null when the line isn't known or isn't inside any.
 */
export function errorRegion(code: string, errorLine: number | undefined): { start: number; end: number } | null {
  if (!errorLine) return null;
  const broken = brokenLines(code);
  if (broken) return broken;
  try {
    const program = parse(code, { ...STRICT, locations: true }) as unknown as { body: Array<{ loc: { start: { line: number }; end: { line: number } } }> };
    const holder = program.body.find((statement) => statement.loc.start.line <= errorLine && errorLine <= statement.loc.end.line);
    return holder ? { start: holder.loc.start.line, end: holder.loc.end.line } : null;
  } catch {
    return null;
  }
}

/**
 * A whole-program fix that only deleted parts of the program (a reply of just the class, so that
 * every other line is "gone") has fixed nothing by that: the lines it deleted outside the error's
 * own region come back, in their places, and what it changed inside the region stays. Judged by
 * lines: the lines of the program that the reply has none like, between two lines it kept, and
 * nothing of its own there. A change (the reply has other lines in the place) is left as the reply
 * made it. Kept only when the result parses where the reply did. Null when nothing came back.
 */
export function restoreDeleted(original: string, fixed: string, region: { start: number; end: number } | null): { code: string; restored: number } | null {
  if (!region) return null;
  const o = original.split('\n');
  const f = fixed.split('\n');
  const key = (line: string) => line.trim();
  const oi = o.map((l, i) => (key(l) ? i : -1)).filter((i) => i >= 0);
  const fi = f.map((l, i) => (key(l) ? i : -1)).filter((i) => i >= 0);
  // The longest run of lines both have, in order
  const table: number[][] = Array.from({ length: oi.length + 1 }, () => new Array<number>(fi.length + 1).fill(0));
  for (let a = oi.length - 1; a >= 0; a--) {
    for (let b = fi.length - 1; b >= 0; b--) {
      table[a][b] = key(o[oi[a]]) === key(f[fi[b]]) ? table[a + 1][b + 1] + 1 : Math.max(table[a + 1][b], table[a][b + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let a = 0, b = 0; a < oi.length && b < fi.length; ) {
    if (key(o[oi[a]]) === key(f[fi[b]])) {
      pairs.push([oi[a], fi[b]]);
      a++;
      b++;
    } else if (table[a + 1][b] >= table[a][b + 1]) a++;
    else b++;
  }
  if (pairs.length === 0) return null;
  const out: string[] = [];
  let restored = 0;
  let previousO = -1;
  let previousF = -1;
  for (const [po, pf] of [...pairs, [o.length, f.length] as [number, number]]) {
    const gapO = o.slice(previousO + 1, po);
    const gapF = f.slice(previousF + 1, pf);
    if (gapO.some((l) => key(l)) && !gapF.some((l) => key(l))) {
      // Deleted: what is outside the region comes back
      gapO.forEach((line, n) => {
        const number = previousO + 1 + n + 1;
        if (number >= region.start && number <= region.end) return;
        out.push(line);
        if (key(line)) restored++;
      });
    } else {
      out.push(...gapF);
    }
    if (pf < f.length) out.push(f[pf]);
    previousO = po;
    previousF = pf;
  }
  if (restored === 0) return null;
  const code = out.join('\n');
  try {
    parse(fixed, STRICT);
  } catch {
    return null;
  }
  try {
    parse(code, STRICT);
  } catch {
    return null;
  }
  return { code, restored };
}

/**
 * What a whole-program fix keeps of the program it fixes: the lines it deleted outside the error
 * come back (restoreDeleted), and so do the declarations it still uses but left out
 * (restoreDeclarations).
 */
export function restoreWhole(original: string, fixed: string, errorLine: number | undefined): { code: string; restored: string[]; lines: number } {
  // A reply that is prose (its code in backticks is one template string) is not a program to put lines back into
  if (isBareText(fixed)) return { code: fixed, restored: [], lines: 0 };
  const deleted = restoreDeleted(original, fixed, errorRegion(original, errorLine));
  const declared = restoreDeclarations(original, deleted?.code ?? fixed);
  return { code: declared.code, restored: declared.restored, lines: deleted?.restored ?? 0 };
}
