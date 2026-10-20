/**
 * Fixing a failed program. A fix turn has its own short system prompt (FIX_SYSTEM_PROMPT) and one
 * message, the user's: what the program is for, the error, and the whole program with the failing
 * line marked by ERROR comments. Shown as the model's own earlier reply, a program got copied back
 * bug and all; handed over as the user's code, it's something to fix. The model names the cause
 * (// Cause: ...) and writes the program again; copied markers are dropped, and search/replace
 * blocks are still applied if sent.
 */

/** The system prompt of a fix turn: only what fixing needs */
export const FIX_SYSTEM_PROMPT = [
  "You fix JavaScript programs that run in the user's browser. Each request shows a program, the error it hit, and the failing line between // >>> ERROR and // <<< ERROR comments.",
  'Reply with one comment line naming the cause (// Cause: ...), then the complete fixed program: JavaScript only, without the ERROR comments.',
].join('\n');

const MARK_START = '// >>> ERROR';
const MARK_END = '// <<< ERROR';
/** A line the model copied from the markers */
const MARKER_LINE = /^\s*\/\/\s*(?:>>>|<<<)\s*ERROR\b.*$/;

export function fixRequest(request: string, code: string, line: number | undefined, error: string): string {
  const task = request.replace(/\s+/g, ' ').trim().replace(/[.!?:,;\s]+$/, '').slice(0, 200);
  const problem = error.trim().replace(/\.+$/, '');
  const lines = code.split('\n');
  const at = line && line >= 1 && line <= lines.length ? line : undefined;
  if (at) {
    const indent = lines[at - 1].match(/^\s*/)?.[0] ?? '';
    lines.splice(at - 1, 1, `${indent}${MARK_START}: ${problem}`, lines[at - 1], `${indent}${MARK_END}`);
  }
  return [
    ...(task ? [`This program was written for: ${task}`] : []),
    at ? `It failed at the marked line: ${problem}` : `It failed: ${problem}`,
    '',
    lines.join('\n'),
    '',
    'First write one comment line saying what caused the error (// Cause: ...), then the complete program with it fixed, without the ERROR comments.',
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
export function applyFixReply(program: string, reply: string): string {
  const blocks = [...reply.matchAll(SEARCH_REPLACE)];
  // Edit markers but no edit that can be read: nothing to apply (running it would only fail)
  if (blocks.length === 0 && /^\s*(?:<{5,}|>{5,}|={5,})/m.test(reply)) return program;
  if (blocks.length === 0) return reply.split('\n').filter((l) => !MARKER_LINE.test(l)).join('\n');
  let lines = program.split('\n');
  for (const [, search, replace] of blocks) {
    const wanted = searchLines(search);
    const at = findLines(lines, wanted);
    if (at < 0) continue;
    lines = [...lines.slice(0, at), ...cleanLines(replace), ...lines.slice(at + wanted.length)];
  }
  return lines.join('\n');
}
