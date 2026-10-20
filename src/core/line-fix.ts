/**
 * Fixing a failed program the way coding tools do, kept small for small models: a fix turn has
 * its own short system prompt (FIX_SYSTEM_PROMPT) and only the fix request, which shows the error
 * and the numbered lines around it. The model answers with search/replace blocks, matched by
 * their text (so indentation and the shown line numbers don't matter), and they're applied to the
 * program. Asked to rewrite the whole program instead, small models copied it back, bug and all.
 */

/** Lines shown on each side of the failing line */
const CONTEXT_LINES = 5;
/** Enough of the original request to say what the program is for */
const MAX_REQUEST_CHARS = 200;

const SEARCH_REPLACE_FORMAT = ['<<<<<<< SEARCH', '(the lines to change)', '=======', '(the new lines)', '>>>>>>> REPLACE'];

/** The system prompt of a fix turn: only what fixing needs */
export const FIX_SYSTEM_PROMPT = [
  "You fix JavaScript programs that run in the user's browser. Each request shows what the program is for, its error and the lines around it.",
  'Reply ONLY with search/replace blocks, nothing else:',
  '<<<<<<< SEARCH',
  '(lines copied exactly from the program)',
  '=======',
  '(the fixed lines)',
  '>>>>>>> REPLACE',
  'Use one block per change, and change only what the fix needs.',
  'Example, for "prise is not defined":',
  '<<<<<<< SEARCH',
  'const total = prise * 2;',
  '=======',
  'const total = price * 2;',
  '>>>>>>> REPLACE',
].join('\n');

const numberedLines = (lines: string[], start: number) => lines.map((text, i) => `${start + i}: ${text}`).join('\n');

const shortRequest = (request: string) =>
  request.replace(/\s+/g, ' ').trim().replace(/[.!?:,;\s]+$/, '').slice(0, MAX_REQUEST_CHARS);

/**
 * `earlier`: the conversation's requests before this one, so the fix knows what the program is
 * for when the request was a follow-up ("make it faster" on a song)
 */
export function fixRequest(
  request: string,
  code: string,
  line: number | undefined,
  error: string,
  earlier: string[] = []
): string {
  const task = shortRequest(request);
  const problem = error.trim().replace(/\.+$/, '');
  const lines = code.split('\n');
  const before = earlier.map(shortRequest).filter(Boolean);
  const parts = [
    ...(before.length > 0 ? [`Earlier requests: ${before.join(' / ')}`] : []),
    ...(task ? [`Request: ${task}`] : []),
  ];
  if (!line || line < 1 || line > lines.length) {
    // No line to point at: the whole program
    parts.push(`The program failed: ${problem}`, `The program:\n${numberedLines(lines, 1)}`);
  } else {
    const start = Math.max(1, line - CONTEXT_LINES);
    const end = Math.min(lines.length, line + CONTEXT_LINES);
    parts.push(
      `The program failed at line ${line}: ${problem}`,
      `Lines ${start}-${end} of the program:\n${numberedLines(lines.slice(start - 1, end), start)}`
    );
  }
  parts.push(`Reply with search/replace blocks only:\n${SEARCH_REPLACE_FORMAT.join('\n')}`);
  return parts.join('\n');
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
