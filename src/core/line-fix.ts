/**
 * Fixing a failed program. A fix turn has its own short system prompt (FIX_SYSTEM_PROMPT); its
 * messages are the request, the failed program as the model's reply, and the fix request: the
 * error and the one line it points at. The model names the cause in a "// Cause:" line, then
 * writes search/replace blocks, applied by matching their text. Tested on Gemma, naming the cause
 * first and then editing fixed the most bugs: rewriting the whole program copied the bug back in,
 * and edits without a cause changed nothing. A whole program sent instead is still taken.
 */

/** The system prompt of a fix turn: only what fixing needs */
export const FIX_SYSTEM_PROMPT = [
  "You fix JavaScript programs that run in the user's browser. Each request gives the error a program hit and the line it points at.",
  'Reply with a comment line naming the cause (// Cause: ...), then search/replace blocks that fix it, nothing else.',
].join('\n');

const FIX_FORMAT = [
  'First write one comment line saying what caused the error (// Cause: ...), then fix it with search/replace blocks:',
  '<<<<<<< SEARCH',
  '(the lines to change, copied exactly)',
  '=======',
  '(the fixed lines)',
  '>>>>>>> REPLACE',
].join('\n');

/**
 * The fix request: the error and the one line it points at. The program itself is in the
 * conversation just before it (the model's own last reply), so the model can write it again.
 */
export function fixRequest(code: string, line: number | undefined, error: string): string {
  const problem = error.trim().replace(/\.+$/, '');
  const lines = code.split('\n');
  const at = line && line >= 1 && line <= lines.length ? line : undefined;
  return [
    at ? `Your program failed at line ${at}: ${problem}` : `Your program failed: ${problem}`,
    ...(at ? [`Line ${at}: ${lines[at - 1].trim()}`] : []),
    FIX_FORMAT,
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
  if (blocks.length === 0) return reply;
  let lines = program.split('\n');
  for (const [, search, replace] of blocks) {
    const wanted = searchLines(search);
    const at = findLines(lines, wanted);
    if (at < 0) continue;
    lines = [...lines.slice(0, at), ...cleanLines(replace), ...lines.slice(at + wanted.length)];
  }
  return lines.join('\n');
}
