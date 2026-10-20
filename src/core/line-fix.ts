/**
 * The fix request for a failed program, adapted from coding tools for small models: the model is
 * shown the failing line with the lines around it, numbered, so it looks in the right place, but
 * it rewrites the whole program. Small models get partial edits wrong (they shift the lines and
 * drop braces); a whole rewrite they can do.
 *
 * It reads as a fresh request, led by what the user originally asked for: 0.6B models answer
 * "fix it" like a chat assistant ("Here's the corrected program:" and a bare speak()), which
 * threw the program away.
 */

/** Lines shown on each side of the failing line */
const CONTEXT_LINES = 5;
/** Enough of the original request to say what the program is for */
const MAX_REQUEST_CHARS = 200;

export function fixRequest(request: string, code: string, line: number | undefined, error: string): string {
  const task = request.replace(/\s+/g, ' ').trim().replace(/[.!?:,;\s]+$/, '').slice(0, MAX_REQUEST_CHARS);
  const lead = task ? `${task}. Your last program failed` : 'Your last program failed';
  const problem = error.trim().replace(/\.+$/, '');
  const lines = code.split('\n');
  if (!line || line < 1 || line > lines.length) {
    return `${lead}: ${problem}\nWrite the complete program again with that fixed, JavaScript only.`;
  }
  const start = Math.max(1, line - CONTEXT_LINES);
  const end = Math.min(lines.length, line + CONTEXT_LINES);
  const numbered = lines.slice(start - 1, end).map((text, i) => `${start + i}: ${text}`).join('\n');
  return (
    `${lead} at line ${line}: ${problem}. Lines ${start}-${end} of it:\n${numbered}\n` +
    'Write the complete program again with that fixed, JavaScript only.'
  );
}
