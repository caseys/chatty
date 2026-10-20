/**
 * Fixing a failed program. A fix turn has its own short system prompt (FIX_SYSTEM_PROMPT) and one
 * message, the user's: what the program is for, the error, what to reply, then the whole program
 * in a code fence with the failing line between // >>> ERROR and // <<< ERROR comments. The model
 * replies with a "// Cause:" line and the corrected marked line only, which goes back in its
 * place. Asked for the whole program, models copied the bug back, or kept copying past the code
 * into the instructions and dropped the rest; a line is short and can't lose anything else. A
 * reply that is a whole program, or search/replace blocks, is still taken.
 */

/** The system prompt of a fix turn: only what fixing needs */
export const FIX_SYSTEM_PROMPT = [
  "You fix JavaScript programs that run in the user's browser. Each request gives the error and the program, with the failing line between // >>> ERROR and // <<< ERROR comments.",
  'Reply with one comment line naming the cause (// Cause: ...), then only the corrected line (a few lines if needed): JavaScript, without the ERROR comments, nothing else.',
].join('\n');

const MARK_START = '// >>> ERROR';
const MARK_END = '// <<< ERROR';
/** A line the model copied from the markers */
const MARKER_LINE = /^\s*\/\/\s*(?:>>>|<<<)\s*ERROR\b.*$/;
/** An instruction line the model copied back from the request */
const INSTRUCTION_LINE = /^\s*(?:Reply with|First write|Then write|Second write)\b.*(?:Cause|corrected|program)/i;

export function fixRequest(request: string, code: string, line: number | undefined, error: string): string {
  const task = request.replace(/\s+/g, ' ').trim().replace(/[.!?:,;\s]+$/, '').slice(0, 200);
  const problem = error.trim().replace(/\.+$/, '');
  const lines = code.split('\n');
  const at = line && line >= 1 && line <= lines.length ? line : undefined;
  if (at) {
    const indent = lines[at - 1].match(/^\s*/)?.[0] ?? '';
    lines.splice(at - 1, 1, `${indent}${MARK_START}: ${problem}`, lines[at - 1], `${indent}${MARK_END}`);
  }
  // The instruction comes before the code, so copying the code never runs on into it
  return [
    ...(task ? [`This program was written for: ${task}`] : []),
    at ? `It failed at the marked line: ${problem}` : `It failed: ${problem}`,
    at
      ? 'Reply with one comment line saying what caused the error (// Cause: ...), then only the corrected marked line, without the ERROR comments.'
      : 'Reply with one comment line saying what caused the error (// Cause: ...), then the complete program with it fixed.',
    '```js',
    lines.join('\n'),
    '```',
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

/** The code of a reply: inside its code fence if it has one, without markers or copied instructions */
function replyCode(reply: string): string[] {
  const fenced = reply.match(/```[\w-]*[ \t]*\n([\s\S]*?)(?:```|$)/);
  return (fenced ? fenced[1] : reply)
    .split('\n')
    .filter((l) => !MARKER_LINE.test(l) && !INSTRUCTION_LINE.test(l) && !/^\s*```/.test(l));
}

/**
 * The program after a fix reply: the corrected marked line put back in its place (`line`), or
 * search/replace blocks applied. A reply as long as the program is taken as a whole new program.
 */
export function applyFixReply(program: string, reply: string, line?: number): string {
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
  const code = replyCode(reply);
  while (code.length > 0 && !code[code.length - 1].trim()) code.pop();
  while (code.length > 0 && !code[0].trim()) code.shift();
  const lines = program.split('\n');
  const substantial = code.filter((l) => l.trim() && !/^\s*\/\//.test(l)).length;
  if (!line || line < 1 || line > lines.length || substantial >= Math.max(5, lines.length * 0.6)) {
    return code.join('\n');
  }
  if (substantial === 0) return program;
  // Only talk, or not code at all (chat): that's the reply, not a line (the fix guard sees it)
  const talkOnly = code.every((l) => !l.trim() || /^\s*\/\//.test(l) || /^\s*(?:await\s+)?speak\(.*\);?\s*$/.test(l));
  if (talkOnly || !parses(code.join('\n'))) return code.join('\n');
  // The corrected line, at the failing line's indentation when it came back without one
  const indent = lines[line - 1].match(/^\s*/)?.[0] ?? '';
  const fixed = code.map((l) => (l.trim() && !/^\s/.test(l) ? indent + l : l));
  return [...lines.slice(0, line - 1), ...fixed, ...lines.slice(line)].join('\n');
}
