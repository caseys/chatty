// A Python-style """…""" string in a reply fenced with ```: the program's own text, not a fence,
// made one template string before running
import { describe, expect, it } from 'vitest';
import { tripleQuotedStrings } from '../src/core/error-hints.ts';
import { inspectExecutableCode, showUnusedMarkup } from '../src/tools/javascript-runtime.ts';

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

  it('runs the function that reads the fields as the user types and sends the form, not at the start', () => {
    const prepared = inspectExecutableCode(REPLY.replace('resultElement.innerHTML = `Total: ${1 + 2}`;', 'resultElement.textContent = document.getElementById("bill").value * 2;'));
    expect(prepared.wired).toEqual(['calculate']);
    expect(prepared.called).toBeUndefined();
    expect(prepared.code).toContain("document.addEventListener('input', () => calculate());");
    expect(prepared.code).toContain("document.addEventListener('submit', (event) => { event.preventDefault(); calculate(); });");
    expect(prepared.code).not.toMatch(/await calculate\(\)/);
  });

  it('puts the markup on the page when nothing else does, right after it is written', () => {
    const prepared = inspectExecutableCode(REPLY);
    expect(prepared.shownMarkup).toEqual(['HTML']);
    expect(prepared.code).toMatch(/<\/html>\n`;?\ndocument\.body\.insertAdjacentHTML\('beforeend', HTML\);\n/);
    expect(parses(prepared.code)).toBe(true);
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

describe('markup written in a string and never used', () => {
  it('goes on the page; markup the program uses, or a string that is no markup, is left alone', () => {
    expect(showUnusedMarkup("const page = '<div id=\"a\">hi</div>';\nspeak('ok');").code).toBe(
      "const page = '<div id=\"a\">hi</div>';\ndocument.body.insertAdjacentHTML('beforeend', page);\nspeak('ok');"
    );
    const used = "const page = '<div>hi</div>';\ndocument.body.innerHTML = page;";
    expect(showUnusedMarkup(used).code).toBe(used);
    const words = "const note = 'a < b';";
    expect(showUnusedMarkup(words).code).toBe(words);
    const placeholder = 'const row = `<div>${name}</div>`;';
    expect(showUnusedMarkup(placeholder).code).toBe(placeholder);
  });

  it('leaves a string inside a function alone (the function decides what to do with it)', () => {
    const inner = "function f() { const page = '<div>hi</div>'; }";
    expect(showUnusedMarkup(inner).names).toEqual([]);
  });
});
