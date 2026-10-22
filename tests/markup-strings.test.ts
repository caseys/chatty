// Markup written across lines inside one quoted string (a small model's document.write('<form>
// with its fields on the lines after it): one template string before running, the cut-off
// close after it, and a fix request that marks the whole string
import { describe, expect, it } from 'vitest';
import { errorHint, markupAcrossLines } from '../src/core/error-hints.ts';
import { brokenLines, fixRequest } from '../src/core/line-fix.ts';
import { inspectExecutableCode } from '../src/tools/javascript-runtime.ts';

const parses = (code: string) => {
  try {
    new (Object.getPrototypeOf(async function () {}).constructor)(code);
    return true;
  } catch {
    return false;
  }
};

// Qwen2.5 0.5B, "Code a tip calculator app with a UI for entering the bill and tip %": the reply,
// stopped for repeating itself while declaring showErrorMsg a third time
const TIP_CALCULATOR = [
  `document.write('<div id="calculator" style="display: flex; align-items: center;">');`,
  `document.write('  <h1>Tip Calculator</h1>');`,
  `document.write('  <form id="calculator-form" onsubmit="return false;">`,
  `    <label for="bill">Bill Amount:</label>`,
  `    <input type="number" id="bill" min="0" max="1000" step="0.01" required><br><br>';`,
  `    <label for="tip">Tip Percentage:</label>`,
  `    <select id="tip-percent">`,
  `        <option value="5%" disabled selected>5%</option>`,
  `        <option value="10%">10%</option>`,
  `        <option value="15%">15%</option>`,
  `        <option value="20%">20%</option>`,
  `    </select><br><br>';`,
  `    <label for="currency">Currency:</label>`,
  `    <select id="currency">`,
  `        <option value="USD">USD</option>`,
  `        <option value="EUR">EUR</option>`,
  `    </select><br><br>';`,
  `    <button type="button" id="calculate-btn" onclick="executeCalc()">Calculate</button>`,
  `  </form>');`,
  `document.write('  <table id="table-container" style="margin-top: 20px;">';`,
  `document.write('  <thead>Table Headers</thead><tbody></tbody>');`,
  `document.write('</table>');`,
  `document.write('<div id="error-message"></div>');`,
  `document.write('<script src="app.js"></script>');`,
  `function executeCalc() {`,
  `  var billAmount = parseFloat(document.getElementById("bill").value);`,
  `  var tipPercent = parseFloat(document.getElementById("tip-percent").value);`,
  `  var errorMessage = document.getElementById("error-message");`,
  `  errorMessage.innerHTML = "";`,
  `  if (isNaN(billAmount)) {`,
  `    errorMessage.innerHTML = "Please enter the bill amount.";`,
  `  }`,
  `  if (errorMessage.innerHTML.length === 0) {`,
  `    var tip = billAmount * tipPercent / 100;`,
  `    document.getElementById("table-container").innerHTML = "<tr><td>" + tip.toFixed(2) + "</td></tr>";`,
  `    function showErrorMsg() {`,
  `      errorMessage.innerHTML = "Something went wrong.";`,
  `    }`,
  `    function showErrorMsg() {`,
  `      errorMessage.innerHTML = "Something went wrong.";`,
  `    }`,
].join('\n');

describe('markup written across lines in one quoted string', () => {
  it('becomes one template string, its stray quotes dropped, and the cut-off reply is closed after it', () => {
    for (const reply of [TIP_CALCULATOR, '```javascript\n' + TIP_CALCULATOR + '\n```']) {
      const inspected = inspectExecutableCode(reply);
      expect(parses(inspected.code)).toBe(true);      expect(inspected.markup).toEqual([
        "markup written over lines 3-19 in one '…' string → one `…` template string",
        'the markup call at line 20 left without its ) → closed',
      ]);
      // closeCutOff ran after it: executeCalc and the if are closed
      expect(inspected.cutOff).toMatchObject({ dropped: 0, closed: 2 });
      expect(inspected.code).toContain(
        [
          'document.write(`  <form id="calculator-form" onsubmit="return false;">',
          '    <label for="bill">Bill Amount:</label>',
          '    <input type="number" id="bill" min="0" max="1000" step="0.01" required><br><br>',
        ].join('\n')
      );
      expect(inspected.code).toContain('    </select><br><br>\n    <label for="currency">');
      expect(inspected.code).toContain('  </form>`);\n');
      expect(inspected.code).toContain(`document.write('  <table id="table-container" style="margin-top: 20px;">');`);
    }
  });

  it('marks the whole string for the fix when it is not repaired', () => {
    // (the region the fix is asked for: from the line the string opens to the line its call ends)
    expect(brokenLines(TIP_CALCULATOR)).toEqual({ start: 3, end: 19 });
    const request = fixRequest('a tip calculator', TIP_CALCULATOR, 3, 'Unexpected EOF', undefined, { start: 3, end: 19, why: 'syntax' });
    const lines = request.split('\n');
    const from = lines.findIndex((l) => l.includes('// >>> ERROR'));
    const to = lines.findIndex((l) => l.includes('// <<< ERROR'));
    expect(lines[from + 1]).toContain(`document.write('  <form`);
    expect(lines[to - 1]).toBe(`  </form>');`);
    expect(errorHint(TIP_CALCULATOR, 'Unexpected EOF', 3)!.text).toBe(
      'The string at line 3 is never closed. A string in quotes must end on the line it starts; text over several lines goes in one `…` template string.'
    );
  });

  it('repairs innerHTML = and insertAdjacentHTML strings too, and escapes what a template would read', () => {
    const assigned = ["out.innerHTML = '<ul>", '  <li>Costs `$5` or ${price}</li>', "</ul>';", 'speak("Shown.");'].join('\n');
    const fixed = markupAcrossLines(assigned)!;
    expect(fixed.code).toBe(['out.innerHTML = `<ul>', '  <li>Costs \\`$5\\` or \\${price}</li>', '</ul>`;', 'speak("Shown.");'].join('\n'));
    expect(parses(fixed.code)).toBe(true);
    const inserted = ["root.insertAdjacentHTML('beforeend', '<p>", 'Hello there', "</p>');"].join('\n');
    expect(markupAcrossLines(inserted)!.code).toBe("root.insertAdjacentHTML('beforeend', `<p>\nHello there\n</p>`);");
  });

  it('closes a markup call left without its ) only when that makes the program parse', () => {
    const code = `document.write('<table id="t">';\ndocument.write('</table>');`;
    expect(markupAcrossLines(code)!.code).toBe(`document.write('<table id="t">');\ndocument.write('</table>');`);
    // Something else broken later: nothing is changed
    expect(markupAcrossLines(`document.write('<table>';\nconst = 3;`)).toBeNull();
  });

  it('leaves correct programs alone', () => {
    const correct = [
      `document.write('<h1>Tip Calculator</h1>');`,
      'root.innerHTML = `<form>\n  <input id="bill">\n</form>`;',
      `speak('First line\\nSecond line');`,
    ].join('\n');
    expect(parses(correct)).toBe(true);
    expect(markupAcrossLines(correct)).toBeNull();
    expect(inspectExecutableCode(correct).code).toContain(correct);
    expect(inspectExecutableCode(correct).markup).toBeUndefined();
  });

  it('leaves code across lines with a missing quote to the fix', () => {
    const code = ["document.write('Total: ", '  + total.toFixed(2));', 'speak("Done.");'].join('\n');
    expect(markupAcrossLines(code)).toBeNull();
    const call = ["speak('The total is", "' + total);"].join('\n');
    expect(markupAcrossLines(call)).toBeNull();
    expect(inspectExecutableCode(code).markup).toBeUndefined();
  });
});
