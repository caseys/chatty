import { describe, expect, it } from 'vitest';
import { blankChoices, blankRequest, choiceRequest, fillBlank, findBlank, focusedContext } from '../src/core/blank-fix.ts';

const canvas = [
  "const canvas = document.getElementById('stage');",
  "const ctx = canvas.getContext('2d');",
  'function draw(x) {',
  '  ctx.beginPath();',
  '  ctx.fillCircle(x, 40, 10);',
  '}',
  'draw(5);',
].join('\n');

const form = [
  "const button = document.getElementById('go');",
  "button.addEventListener('click', () => {",
  '  const total = bill * 0.15;',
  "  document.getElementById('result').textContent = total.toFixed(2) + ' from ' + bill;",
  '});',
].join('\n');

const text = (code: string, blank: { spans: Array<{ start: number; end: number }> }) => blank.spans.map((s) => code.slice(s.start, s.end));

describe('undefined names', () => {
  it('Chrome: every reference to the undeclared name, not properties or strings', () => {
    const code = form + "\n// bill is here\nconst s = 'bill';\nconst o = { bill: 1 }.bill;";
    const blank = findBlank(code, 'ReferenceError: bill is not defined', 3)!;
    expect(blank.text).toBe('bill');
    expect(blank.line).toBe(3);
    expect(blank.why).toBe('bill is not declared');
    expect(blank.spans).toHaveLength(2);
    expect(blank.spans.every((s) => code.slice(s.start, s.end) === 'bill')).toBe(true);
    expect(blank.spans.map((s) => code.slice(0, s.start).split('\n').length)).toEqual([3, 4]);
  });
  it('Safari: Can\'t find variable', () => {
    expect(findBlank(form, "Can't find variable: bill", 4)?.text).toBe('bill');
  });
  it('leaves a name that another function declares alone', () => {
    const code = ['function a() {', '  const n = 1;', '  return n;', '}', 'function b() {', '  return n + 1;', '}', 'b();'].join('\n');
    const blank = findBlank(code, 'n is not defined', 6)!;
    expect(blank.spans).toHaveLength(1);
    expect(blank.line).toBe(6);
  });
  it('skips typeof and a name that is only in a string or comment', () => {
    expect(findBlank("if (typeof gone === 'undefined') {}\n// gone\nconst s = 'gone';", 'gone is not defined', 1)).toBeNull();
  });
});

describe('missing methods', () => {
  it('Chrome: the receiver of the method', () => {
    const blank = findBlank(canvas, 'TypeError: ctx.fillCircle is not a function', 5)!;
    expect(blank.text).toBe('ctx');
    expect(blank.why).toBe('ctx has no fillCircle()');
    expect(blank.line).toBe(5);
    expect(blank.spans).toHaveLength(2);
  });
  it('Safari: (In …) wording, with a longer path', () => {
    const code = "const audio = { el: document.getElementById('sound') };\nfunction go() {\n  audio.el.play();\n}\ngo();";
    const blank = findBlank(code, "TypeError: (In 'audio.el.play()', 'audio.el.play' is undefined)", 3)!;
    expect(blank.text).toBe('audio.el');
    expect(blank.why).toBe('audio.el has no play()');
  });
  it('Chrome: (...) stands for call arguments', () => {
    const code = "function go() {\n  document.getElementById('sound').play();\n}\ngo();";
    const blank = findBlank(code, 'document.getElementById(...).play is not a function', 2)!;
    expect(blank.text).toBe("document.getElementById('sound')");
  });
  it('Firefox: plain wording; a method on this', () => {
    const code = ['class Timer {', '  start() {', '    this.tick();', '  }', '}', 'new Timer().start();'].join('\n');
    const blank = findBlank(code, 'this.tick is not a function', 3)!;
    expect(blank.text).toBe('this');
    expect(blank.why).toBe('this has no tick()');
  });
  it('a plain function name is the blank itself', () => {
    const code = "const run = 5;\nsetTimeout(() => {\n  run();\n}, 100);";
    expect(findBlank(code, 'run is not a function', 3)?.text).toBe('run');
  });
  it('(intermediate value) matches any receiver', () => {
    const code = "fetch('/a').then((r) => r.json()).then((d) => d.items.forEach(show));\nfunction show(){}";
    expect(findBlank(code, '(intermediate value).items.forEachh is not a function', 1)).toBeNull();
    expect(findBlank(code, 'd.items.forEach is not a function', 1)?.text).toBe('d.items');
  });
});

describe('reading from nothing', () => {
  const fetching = [
    "async function load() {",
    "  const res = await fetch('/data.json');",
    '  const data = await res.json();',
    '  return data.results[0].name;',
    '}',
    'load();',
  ].join('\n');
  it("Chrome: the object of the property it names", () => {
    const blank = findBlank(fetching, "TypeError: Cannot read properties of undefined (reading 'name')", 4)!;
    expect(blank.text).toBe('data.results[0]');
    expect(blank.why).toBe('data.results[0] is undefined');
    const second = findBlank(fetching, "Cannot read properties of undefined (reading '0')", 4)!;
    expect(second.text).toBe('data.results');
  });
  it('Safari: evaluating wording, null', () => {
    const code = "function read() {\n  return document.getElementById('amount').value;\n}\nread();";
    const blank = findBlank(code, "TypeError: null is not an object (evaluating 'document.getElementById('amount').value')", 2)!;
    expect(blank.text).toBe("document.getElementById('amount')");
    expect(blank.why).toBe("document.getElementById('amount') is null");
  });
  it('Firefox: the object is named', () => {
    const code = "const box = document.querySelector('#box');\nbox.style.color = 'red';";
    const blank = findBlank(code, "can't access property \"style\", box is null", 2)!;
    expect(blank.text).toBe('box');
    const call = findBlank("const el = document.getElementById('q');\nconsole.log(el.value);", 'can\'t access property "value", document.getElementById(...) is null', 2);
    expect(call).toBeNull(); // the lookup is on another line, but the member is el.value
    expect(findBlank(code, "Cannot set properties of null (setting 'color')", 2)?.text).toBe('box.style');
  });
  it('Chrome: setting; old wording; destructuring', () => {
    const code = "const cfg = window.config;\nconst { size } = cfg;\ncfg.size = 4;";
    expect(findBlank(code, "Cannot destructure property 'size' of 'cfg' as it is undefined.", 2)?.text).toBe('cfg');
    expect(findBlank(code, "Cannot set properties of undefined (setting 'size')", 3)?.text).toBe('cfg');
    expect(findBlank(code, "Cannot read property 'size' of undefined", 3)?.text).toBe('cfg');
  });
  it('does not choose optional chains, globals or literals', () => {
    expect(findBlank("const a = x?.y;\nconst b = 'abc'.length;", "Cannot read properties of undefined (reading 'y')", 1)).toBeNull();
    expect(findBlank('console.log(document.title);', "Cannot read properties of undefined (reading 'title')", 1)).toBeNull();
  });
});

describe('constructors and iterables', () => {
  it('not a constructor, Chrome / Safari / Firefox', () => {
    const code = "const Audio2 = {};\nfunction go() {\n  const a = new Audio2('x.mp3');\n}\ngo();";
    expect(findBlank(code, 'Audio2 is not a constructor', 3)?.text).toBe('Audio2');
    expect(findBlank(code, "TypeError: undefined is not a constructor (evaluating 'new Audio2('x.mp3')')", 3)?.text).toBe('Audio2');
    expect(findBlank('const m = new window.Maap();', 'window.Maap is not a constructor', 1)?.why).toBe('window.Maap is not a constructor');
  });
  it('not iterable', () => {
    const code = "const scores = {};\nfor (const s of scores) {\n  console.log(s);\n}";
    expect(findBlank(code, 'TypeError: scores is not iterable', 2)?.text).toBe('scores');
    expect(findBlank(code, "undefined is not a function (near '...s of scores...')", 2)?.text).toBe('scores');
    // no name: the single iterable on the line
    expect(findBlank('const q = undefined;\nconst [a, b] = q;', 'undefined is not iterable (cannot read property Symbol(Symbol.iterator))', 2)?.text).toBe('q');
    expect(findBlank('for (const a of x) { for (const b of y) {} }', 'undefined is not iterable', 1)).toBeNull();
  });
});

describe('errors that name nothing', () => {
  it('returns null', () => {
    expect(findBlank('const a = ;', 'SyntaxError: Unexpected token ;', 1)).toBeNull();
    expect(findBlank('throw new Error("bill is not defined");', 'Error: bill is not defined', 1)).toBeNull();
    expect(findBlank('while (true) {}', 'Execution timed out', 1)).toBeNull();
    expect(findBlank('const a = 1;', 'Assignment to constant variable.', 1)).toBeNull();
  });
  it('a program that does not parse gives null even for a named error', () => {
    expect(findBlank('const a = bill + ;', 'bill is not defined', 1)).toBeNull();
  });
  it('a name only in strings and comments is never chosen', () => {
    expect(findBlank("// bill\nconst s = 'bill';\nconst t = `bill`;", 'bill is not defined', 2)).toBeNull();
    expect(findBlank("// ctx.go()\nconst s = 'ctx.go()';", 'ctx.go is not a function', 2)).toBeNull();
  });
});

describe('fillBlank', () => {
  const blank = findBlank(form, 'bill is not defined', 3)!;
  it('replaces every span and nothing else', () => {
    const filled = fillBlank(form, blank, "Number(document.getElementById('billInput').value)")!;
    expect(filled).toBe(form.replace(/\bbill\b/g, "Number(document.getElementById('billInput').value)"));
    let rest = form;
    for (const s of [...blank.spans].reverse()) rest = rest.slice(0, s.start) + '\u0000' + rest.slice(s.end);
    expect(filled.length).toBeGreaterThan(form.length);
    expect(filled.split("Number(document.getElementById('billInput').value)").join('\u0000')).toBe(rest);
  });
  it('brackets an expression that could change meaning, keeps plain ones bare', () => {
    expect(fillBlank(form, blank, 'a || b')).toContain('(a || b) * 0.15');
    expect(fillBlank(form, blank, 'amount')).toContain('amount * 0.15');
  });
  it('is null for something that is not one expression, or does not parse', () => {
    expect(fillBlank(form, blank, 'a; b')).toBeNull();
    expect(fillBlank(form, blank, 'const a = 1')).toBeNull();
    expect(fillBlank(form, blank, '')).toBeNull();
    expect(fillBlank(form, blank, 'a +')).toBeNull();
    expect(fillBlank(form, blank, '1 // x')).toContain('(1 // x\n)'.slice(0, 0) + '1');
    expect(fillBlank('const a = 1;', blank, 'x')).toBeNull(); // spans don't match this program
  });
  it('fills a receiver', () => {
    const b = findBlank(canvas, 'ctx.fillCircle is not a function', 5)!;
    const filled = fillBlank(canvas, b, "canvas.getContext('2d')")!;
    expect(filled.split('\n')[3]).toBe("  canvas.getContext('2d').beginPath();");
    expect(filled.split('\n')[1]).toBe(canvas.split('\n')[1]);
  });
});

describe('blankChoices', () => {
  it('ranks the page element that fits the name, its value as a number in arithmetic', () => {
    const blank = findBlank(form, 'bill is not defined', 3)!;
    const choices = blankChoices(form, blank, { ids: ['go', 'result', 'billInput', 'tipPct'], fields: ['billInput', 'tipPct'] });
    expect(choices[0]).toBe("Number(document.getElementById('billInput').value)");
    expect(choices).toContain("document.getElementById('go')");
    expect(choices.length).toBeLessThanOrEqual(6);
    expect(new Set(choices).size).toBe(choices.length);
  });
  it('offers declared names near a slip, and helpers for Chatty methods', () => {
    const code = "const level = 3;\nspek(level);";
    const blank = findBlank(code, 'spek is not defined', 2)!;
    expect(blankChoices(code, blank, { ids: [] })).toContain('speak');
    const code2 = 'out.send(1);';
    const b2 = findBlank(code2, 'x.send is not a function', 1);
    expect(b2).toBeNull();
    const code3 = 'function f() {\n  player.send({ note: 60 });\n}\nf();';
    const b3 = findBlank(code3, 'player.send is not a function', 2)!;
    expect(blankChoices(code3, b3, { ids: [] })).toContain('out');
  });
  it('lists constructors only for a constructor blank', () => {
    const code = 'class Voice {}\nconst count = 2;\nconst v = new Voise();\nfunction Osc() {}';
    const blank = findBlank(code, 'Voise is not defined', 3)!;
    const choices = blankChoices(code, blank, { ids: ['pad'] });
    expect(choices[0]).toBe('Voice');
    expect(choices).not.toContain("document.getElementById('pad')");
  });
  it('close ids first for a failed lookup', () => {
    const code = "const el = document.getElementById('volumn');\nel.value = 3;";
    const blank = findBlank(code, "Cannot set properties of null (setting 'value')", 2)!;
    expect(blank.text).toBe('el');
    const choices = blankChoices(code, blank, { ids: ['pan', 'volume'], fields: ['volume'] });
    expect(choices).toContain("document.getElementById('volume')");
  });
});

describe('focusedContext', () => {
  const lines = [
    "const canvas = document.getElementById('stage');",
    "const ctx = canvas.getContext('2d');",
    'const unusedA = 1;',
    'const unusedB = [1, 2, 3];',
    'function helper() {',
    '  return 7;',
    '}',
    'function draw(x) {',
    '  ctx.beginPath();',
    '  ctx.fillCircle(x, 40, helper());',
    '}',
    'function other() {',
    '  console.log("elsewhere");',
    '}',
    'draw(5);',
  ];
  const code = lines.join('\n');
  it('keeps the enclosing function and the declarations it uses, drops the rest', () => {
    const { text, lineInContext } = focusedContext(code, 10);
    expect(text).toBe(
      [
        '// …',
        lines[1],
        '// …',
        ...lines.slice(4, 7),
        ...lines.slice(7, 11),
        '// …',
      ].join('\n')
    );
    expect(text.split('\n')[lineInContext - 1]).toBe(lines[9]);
    expect(text).not.toContain('unused');
    expect(text).not.toContain('elsewhere');
    expect(text).not.toContain("getElementById('stage')");
  });
  it('a top-level statement outside any function', () => {
    const { text, lineInContext } = focusedContext(code, 15);
    expect(text.split('\n')[lineInContext - 1]).toBe('draw(5);');
    expect(text).toContain('function draw');
  });
  it('gives back the program when it does not parse', () => {
    expect(focusedContext('const a = ;\nb();', 2)).toEqual({ text: 'const a = ;\nb();', lineInContext: 2 });
  });
});

describe('requests', () => {
  it('blankRequest marks the line and asks for one expression', () => {
    const blank = findBlank(form, 'bill is not defined', 3)!;
    const request = blankRequest('Calculate a tip.', form, blank, 'bill is not defined.');
    expect(request).toBe(
      [
        'This program was written for: Calculate a tip',
        'It failed at the marked line: bill is not defined',
        '```js',
        form.split('\n').slice(0, 2).join('\n'),
        '  // >>> ERROR: bill is not defined',
        '  const total = bill * 0.15;',
        '  // <<< ERROR',
        form.split('\n').slice(3).join('\n'),
        '```',
        'In this line: const total = bill * 0.15;',
        'bill is not declared. Replace `bill` with one JavaScript expression:',
      ].join('\n')
    );
  });
  it('choiceRequest lists lettered options and the reply instruction', () => {
    const blank = findBlank(form, 'bill is not defined', 3)!;
    const request = choiceRequest('', form, blank, 'bill is not defined', ['amount', "document.getElementById('billInput').value"], 'The page has #billInput.');
    expect(request).toContain('The page has #billInput.');
    expect(request).toContain("A. amount\nB. document.getElementById('billInput').value");
    expect(request.endsWith('Reply with the letter of the expression that belongs in place of `bill`.')).toBe(true);
  });
});

describe('blankChoices leaves out names not made yet', () => {
  it('skips a const declared by the failing statement itself', () => {
    const prog = "document.body.innerHTML = '<input id=\"billInput\">';\nconst total = bill + bill * tip / 100;";
    const blank = findBlank(prog, "Can't find variable: bill", 2)!;
    const choices = blankChoices(prog, blank, { ids: ['billInput'], fields: ['billInput'] });
    expect(choices).not.toContain('total');
    expect(choices[0]).toBe("Number(document.getElementById('billInput').value)");
  });

  it('keeps a value used as text as text', () => {
    const prog = "document.body.innerHTML = '<input id=\"nameInput\">';\nconst greeting = 'Hi ' + name;";
    const blank = findBlank(prog, "Can't find variable: name", 2)!;
    expect(blankChoices(prog, blank, { ids: ['nameInput'], fields: ['nameInput'] })[0]).toBe("document.getElementById('nameInput').value");
  });
});

describe('blank choices and spans by scope', () => {
  it("offers a function's parameters as values, not as functions to call", () => {
    const prog = 'function calc(amount) {\n  return bill * 0.15;\n}\ncalc(10);';
    const blank = findBlank(prog, 'bill is not defined', 2)!;
    expect(blankChoices(prog, blank, { ids: [], fields: [] })).toContain('amount');
    const call = 'function calc(amount) {\n  return compute(amount);\n}\ncalc(10);';
    const b2 = findBlank(call, 'compute is not defined', 2)!;
    expect(blankChoices(call, b2, { ids: [], fields: [] })).not.toContain('amount');
  });

  it("fills only the failing function's references", () => {
    const prog = 'function calc(amount) {\n  return bill * 0.15;\n}\nfunction show() {\n  speak(bill);\n}\ncalc(10);';
    const blank = findBlank(prog, 'bill is not defined', 2)!;
    expect(blank.spans.length).toBe(1);
    expect(fillBlank(prog, blank, 'amount')).toContain('speak(bill)');
  });
});
