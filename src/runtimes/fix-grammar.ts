// ============================================================================
// EBNF grammars (XGrammar syntax, via WebLLM's response_format "grammar") for fix turns: one
// `// Cause: ...` line, then only code. Deliberately loose: it rules out markdown fences, echoed
// ERROR markers and further comment lines, nothing more, so a tiny model can't be boxed in.
// ============================================================================

export type FixShape = 'line' | 'function' | 'program' | 'expression' | 'choice';

/** Rules shared by every shape. A code line starts with anything but ` or / (or a single /).
 *  The ">>> ERROR" / "<<< ERROR" markers are not blocked here: a model that wants to write one,
 *  held to "<<" plus anything else, wrote "<< << << …" until it ran out of tokens. replyCode
 *  strips them instead.
 *  Lines after the first in a function or program (bodyline) may be // comments or start with a
 *  template literal's backtick; only a ``` fence is ruled out there. */
const COMMON = String.raw`
cause ::= "// Cause: " [^\n]+ "\n"
start ::= [^\x60/\n] | "/" [^/\x60\n]
rest ::= [^\n]*
codeline ::= start rest
bstart ::= [^\x60\n] | "\x60" [^\x60\n] | "\x60\x60" [^\x60\n]
bodyline ::= bstart rest
`;

const FUNCTION_HEAD = String.raw`
head ::= ("function " | "async function " | ("const " | "let ") [A-Za-z_$] [A-Za-z0-9_$]* " = " ("async ")? ("function" | "(")) rest
`;

/** The letters of `count` options: A, B, C, … (at most 26) */
const letters = (count: number) => Array.from({ length: Math.max(1, Math.min(26, count)) }, (_, i) => String.fromCharCode(65 + i));

export function fixGrammar(shape: FixShape, choiceCount = 0): string {
  switch (shape) {
    // One JavaScript expression on one line: what goes in the blank (see blank-fix.ts)
    case 'expression':
      return `root ::= start rest${COMMON}`;
    // One option's letter, nothing else
    case 'choice':
      return `root ::= ${letters(choiceCount).map((l) => `"${l}"`).join(' | ')}`;
    case 'line':
      return `root ::= cause codeline ("\\n" codeline ("\\n" codeline)?)? "\\n"?${COMMON}`;
    case 'function':
      return `root ::= cause head ("\\n" bodyline?)* "\\n"?${COMMON}${FUNCTION_HEAD}`;
    case 'program':
      return `root ::= cause codeline ("\\n" bodyline?)* "\\n"?${COMMON}`;
  }
}
