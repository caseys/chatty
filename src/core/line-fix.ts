/**
 * The fix request for a failed program, adapted from coding tools for small models: the model is
 * shown the failing line with the lines around it, numbered, so it looks in the right place, but
 * it rewrites the whole program. Small models get partial edits wrong (they shift the lines and
 * drop braces); a whole rewrite they can do.
 */

/** Lines shown on each side of the failing line */
const CONTEXT_LINES = 5;

export function fixRequest(code: string, line: number | undefined, error: string): string {
  const lines = code.split('\n');
  if (!line || line < 1 || line > lines.length) {
    return `Your program failed: ${error}\nReply with the complete corrected program, JavaScript only.`;
  }
  const start = Math.max(1, line - CONTEXT_LINES);
  const end = Math.min(lines.length, line + CONTEXT_LINES);
  const numbered = lines.slice(start - 1, end).map((text, i) => `${start + i}: ${text}`).join('\n');
  return (
    `Your program failed at line ${line}: ${error}\n` +
    `Lines ${start}-${end} of your program:\n${numbered}\n` +
    'Fix the problem there and reply with the complete corrected program, JavaScript only.'
  );
}
