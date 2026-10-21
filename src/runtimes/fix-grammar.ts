// ============================================================================
// EBNF grammars (XGrammar syntax, via WebLLM's response_format "grammar") for fix turns: one
// `// Cause: ...` line, then only code. Deliberately loose: it rules out markdown fences, echoed
// ERROR markers and further comment lines, nothing more, so a tiny model can't be boxed in.
// ============================================================================

export type FixShape = 'line' | 'function' | 'program' | 'expression' | 'choice';

/**
 * The characters a reply may use: English. Printable ASCII and tab, plus what programs often put
 * in strings: accented Latin letters, °, ×, dashes and curly quotes, arrows, ★, ♪ and smileys.
 * Other scripts are left out: a small model sampled hot drifts into them mid-name
 * (outerLeftGlobal彼方形يتها). The ranges are narrow on purpose: WebLLM's XGrammar let Japanese
 * through a wide one (\u2000-\u2BFF, or all emoji). ch: any of them; nb: but a backtick; nbs:
 * but a backtick or slash.
 */
const EXTRA = String.raw`\u00A0-\u024F\u2010-\u2027\u2030-\u203A\u2190-\u2193\u2605-\u2606\u266A-\u266B\U0001F600-\U0001F64F`;
const ENGLISH = String.raw`
ch ::= [\x09\x20-\x7E${EXTRA}]
nb ::= [\x09\x20-\x5F\x61-\x7E${EXTRA}]
nbs ::= [\x09\x20-\x2E\x30-\x5F\x61-\x7E${EXTRA}]
`;

/**
 * Any reply, in English characters. One character class repeated: XGrammar masks that at full
 * speed (an alternation of two rules ran 6x slower in WebLLM)
 */
export const ENGLISH_GRAMMAR = String.raw`root ::= [\x09\x0A\x0D\x20-\x7E${EXTRA}]*`;

/** Rules shared by every shape. A code line starts with anything but ` or / (or a single /).
 *  The ">>> ERROR" / "<<< ERROR" markers are not blocked here: a model that wants to write one,
 *  held to "<<" plus anything else, wrote "<< << << …" until it ran out of tokens. replyCode
 *  strips them instead.
 *  Lines after the first in a function or program (bodyline) may be // comments or start with a
 *  template literal's backtick; only a ``` fence is ruled out there. */
const COMMON = String.raw`
cause ::= "// Cause: " ch+ "\n"
start ::= nbs | "/" nbs
rest ::= ch*
codeline ::= start rest
bstart ::= nb | "\x60" nb | "\x60\x60" nb
bodyline ::= bstart rest
` + ENGLISH;

const FUNCTION_HEAD = String.raw`
head ::= ("function " | "async function " | ("const " | "let ") [A-Za-z_$] [A-Za-z0-9_$]* " = " ("async ")? ("function" | "(")) rest
`;

/** The letters of `count` options: A, B, C, … (at most 26) */
export const letters = (count: number) => Array.from({ length: Math.max(1, Math.min(26, count)) }, (_, i) => String.fromCharCode(65 + i));

/** A reply of exactly one of the labels, nothing else */
export const choiceGrammar = (labels: string[]) => `root ::= ${labels.map((l) => JSON.stringify(l)).join(' | ')}`;

export function fixGrammar(shape: FixShape, choiceCount = 0): string {
  switch (shape) {
    // One JavaScript expression on one line: what goes in the blank (see blank-fix.ts)
    case 'expression':
      return `root ::= start rest${COMMON}`;
    // One option's letter, nothing else
    case 'choice':
      return choiceGrammar(letters(choiceCount));
    case 'line':
      return `root ::= cause codeline ("\\n" codeline ("\\n" codeline)?)? "\\n"?${COMMON}`;
    case 'function':
      return `root ::= cause head ("\\n" bodyline?)* "\\n"?${COMMON}${FUNCTION_HEAD}`;
    case 'program':
      return `root ::= cause codeline ("\\n" bodyline?)* "\\n"?${COMMON}`;
  }
}
