// A Python-style """…""" string in a reply fenced with ```: the program's own text, not a fence,
// made one template string before running
import { describe, expect, it } from 'vitest';
import { tripleQuotedStrings } from '../src/core/error-hints.ts';
import { inspectExecutableCode } from '../src/tools/javascript-runtime.ts';

const parses = (code: string) => {
  try {
    new (Object.getPrototypeOf(async function () {}).constructor)(code);
    return true;
  } catch {
    return false;
  }
};

// Qwen2.5 0.5B, "Code a tip calculator app with a UI for entering the bill and tip %" (shortened)
const REPLY = [
  '```javascript',
  'const HTML = """',
  '<html>',
  '  <body>',
  '    <form id="calculator">',
  '      <input type="number" id="bill" min="0" required>',
  '      <button type="submit">Calculate</button>',
  '    </form>',
  '    <div id="result"></div>',
  '  </body>',
  '</html>',
  '"""',
  '',
  'function calculate() {',
  '  const resultElement = document.getElementById("result");',
  '  resultElement.innerHTML = `Total: ${1 + 2}`;',
  '}',
  '```',
  '',
  'Please run this code in your browser.',
].join('\n');

describe('a Python-style triple-quoted string', () => {
  it('stays in the program when the reply has ``` fences, and becomes a template string', () => {
    const { code } = inspectExecutableCode(REPLY);
    expect(code).toContain('const HTML = `\n<html>');
    expect(code).toContain('</html>\n`');
    expect(code).toContain('function calculate()');
    expect(code).not.toContain('Please run this code');
    expect(parses(code)).toBe(true);
  });

  it("escapes what a template string would read as its own, and takes ''' too", () => {
    const fixed = tripleQuotedStrings("const a = '''say `hi` for ${name}''';\nspeak(a);");
    expect(fixed?.code).toBe('const a = `say \\`hi\\` for \\${name}`;\nspeak(a);');
    expect(fixed?.notes[0]).toMatch(/line 1/);
  });

  it('leaves a program with none alone', () => {
    expect(tripleQuotedStrings('const a = "x";')).toBeNull();
  });
});
