import { describe, expect, it } from 'vitest';
import { applyFixReply, enclosingFunction, FIX_SYSTEM_PROMPT, fixRequest } from '../src/core/line-fix.ts';

const program = Array.from({ length: 30 }, (_, i) => `  const v${i + 1} = ${i + 1};`).join('\n');

describe('fix requests for failed programs', () => {
  it('puts the instruction first, then the program in a fence with the failing line marked', () => {
    const code = 'const a = 1;\nfunction f() {\n  g(t);\n}\nf();';
    expect(fixRequest('Play a song.', code, 3, 't is not defined.')).toBe(
      [
        'This program was written for: Play a song',
        'It failed at the marked line: t is not defined',
        'Reply with one comment line saying what caused the error (// Cause: ...), then only the corrected marked line, without the ERROR comments.',
        '```js',
        'const a = 1;',
        'function f() {',
        '  // >>> ERROR: t is not defined',
        '  g(t);',
        '  // <<< ERROR',
        '}',
        'f();',
        '```',
        'Marked line:',
        'g(t);',
        'Corrected line:',
      ].join('\n')
    );
  });

  it('drops copied labels, and a leading "Corrected line:" label', () => {
    const failed = 'a();\n  g(t);\nb();';
    expect(applyFixReply(failed, 'Corrected line: g(1);', 2).split('\n')[1]).toBe('  g(1);');
    expect(applyFixReply(failed, 'Marked line:\nCorrected line:\ng(2);', 2).split('\n')[1]).toBe('  g(2);');
  });

  it('asks for the whole program when the error has no line', () => {
    const req = fixRequest('', 'const a = 1;', undefined, 'boom');
    expect(req.startsWith('It failed: boom\nReply with')).toBe(true);
    expect(req).toContain('the complete program with it fixed');
    expect(req).not.toContain('>>> ERROR');
  });

  it('has its own short system prompt, only about fixing', () => {
    expect(FIX_SYSTEM_PROMPT).toContain('only the corrected marked code');
    expect(FIX_SYSTEM_PROMPT).not.toMatch(/MIDI|canvas|Wikipedia|<examples>/);
  });
});

describe('applying a fix reply', () => {
  const lines = ['function play() {', '  for (let i = 0; i < 4; i++) {', '    const t = start + i;', '  }', '  setTimeout(() => out.send(x, t), 1000);', '}', 'play();'];
  const failed = lines.join('\n');

  it('puts the corrected line back in place of the marked one, indented like it, without the cause', () => {
    const reply = '```js\n// Cause: t only exists in the loop\nsetTimeout(() => out.send(x, start), 1000);\n```';
    expect(applyFixReply(failed, reply, 5).split('\n')).toEqual([
      ...lines.slice(0, 4),
      '  setTimeout(() => out.send(x, start), 1000);',
      ...lines.slice(5),
    ]);
  });

  it('drops copied markers and instructions, and keeps the program when nothing is left', () => {
    expect(applyFixReply(failed, '// >>> ERROR: x\nsetTimeout(() => go(), 1);\n// <<< ERROR', 5).split('\n')[4]).toBe('  setTimeout(() => go(), 1);');
    expect(applyFixReply(failed, 'Reply with only the corrected marked line, then the Cause', 5)).toBe(failed);
  });

  it('takes a reply as long as the program as a whole new program', () => {
    const whole = Array.from({ length: 7 }, (_, i) => `step${i}();`).join('\n');
    expect(applyFixReply(failed, whole, 5)).toBe(whole);
  });

  it('still applies search/replace blocks, and skips broken or unmatched ones', () => {
    const reply = '<<<<<<< SEARCH\n5:   setTimeout(() => out.send(x, t), 1000);\n=======\n  setTimeout(() => out.send(x, start), 1000);\n>>>>>>> REPLACE';
    expect(applyFixReply(failed, reply, 5).split('\n')[4]).toBe('  setTimeout(() => out.send(x, start), 1000);');
    expect(applyFixReply(failed, '<<<<<<< SEARCH\nnope\n=======\nx\n>>>>>>> REPLACE', 5)).toBe(failed);
    expect(applyFixReply(failed, '<<<<<<< SEARCH\nconst t = 1;\n=======', 5)).toBe(failed);
  });
});

describe('finding what does not parse', () => {
  it('marks the statements that do not parse, from the first to the last', async () => {
    const { brokenLines } = await import('../src/core/line-fix.ts');
    const code = 'const a = 1;\nout.send({ notes: G major });\nconst b = 2;\nfunction f() {\n  play(\n}\nspeak("hi");';
    expect(brokenLines(code)).toEqual({ start: 2, end: 6 });
    expect(brokenLines('const a = 1;\nspeak(a);')).toBeNull();
  });

  it('asks for the marked lines rewritten when they do not parse', async () => {
    const { fixRequest } = await import('../src/core/line-fix.ts');
    const request = fixRequest('play a song', 'const a = 1;\nout.send({ notes: G major });', 2, "Unexpected identifier 'major'", undefined, { start: 2, end: 2, why: 'syntax' });
    expect(request).toContain("The marked lines don't parse");
    expect(request).toContain('// >>> ERROR');
    expect(request).toContain('rewritten as valid JavaScript');
  });
});

describe('a reply that brings the named function around the marked lines', () => {
  const program = [
    'function play(t) {',
    '  const { time } = t;',
    '}',
    'function loop() {',
    '  for (const t of tracks) {',
    '    setTimeout(() => {',
    '      play(t);',
    '    }, time * 1000);',
    '  }',
    '}',
    'loop();',
  ].join('\n');

  it('asks for the named function, not the anonymous callback inside it', () => {
    expect(enclosingFunction(program, 8)).toEqual({ start: 4, end: 10, name: 'loop' });
  });

  it('replaces that function wherever the marked lines were, instead of nesting it', () => {
    const reply = '// Cause: time\nfunction loop() {\n  for (const t of tracks) {\n    setTimeout(() => play(t), t.time * 1000);\n  }\n}';
    const fixed = applyFixReply(program, reply, 6, 8);
    expect(fixed.match(/function loop/g)?.length).toBe(1);
    expect(fixed).toContain('t.time * 1000');
    expect(fixed).toContain('function play(t)');
    expect(fixed.trim().endsWith('loop();')).toBe(true);
  });
});

describe('reading the reply shapes small models produce', () => {
  const prog = ['const a = 1;', 'function playSound(a, b) {', '  return a + b;', '}', 'document.getElementById("sound").play();', 'playSound(1, 2);', 'const z = 3;'].join('\n');

  it('strips echoed ERROR marker lines, also inside a returned program', () => {
    const reply = '// Cause: ...\n// <<< ERROR\nconst a = 1;\n// >>> ERROR: x is not defined (at line 12)\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;\nconst g = 7;\nconst h = 8;';
    const out = applyFixReply(prog, reply, 5);
    expect(out).not.toMatch(/ERROR|Cause/);
    expect(out.split('\n')[0]).toBe('const a = 1;');
  });

  it('takes code from a "corrected line:" comment when it parses', () => {
    const reply = "// Cause: ...\n// <<< corrected line: document.getElementById('sound').play()";
    expect(applyFixReply(prog, reply, 5).split('\n')[4]).toBe("document.getElementById('sound').play()");
  });

  it('ignores a "corrected:" comment that is prose', () => {
    const reply = '// Cause: ...\n// corrected: Fix the time declaration';
    expect(applyFixReply(prog, reply, 5)).toBe(prog);
  });

  it('ignores code-looking comments when the reply has real code lines', () => {
    const reply = '// corrected: foo();\nbar();';
    const out = applyFixReply(prog, reply, 5).split('\n');
    expect(out).toContain('bar();');
    expect(out).not.toContain('foo();');
  });

  it('takes the fenced code when prose and comments surround the fence', () => {
    const reply = '// Cause: ...\n// corrected: ...\n```js\nbar();\n```\n// +++ The marked function corrected: it fixes the call';
    expect(applyFixReply(prog, reply, 5).split('\n')[4]).toBe('bar();');
  });

  it('replaces a declared function with a same-named arrow, as a declaration (callable before its line)', () => {
    const reply = '// Cause: ...\nconst playSound = (a, b) => {\n  return a * b;\n};';
    const out = applyFixReply(prog, reply, 3);
    expect(out).toBe(prog.replace(/function playSound[\s\S]*?\n}/, 'function playSound(a, b) {\n  return a * b;\n}'));
    const short = applyFixReply(prog, 'const playSound = async (a) => a * 2;', 3);
    expect(short).toContain('async function playSound(a) {\n  return a * 2;\n}');
  });

  it('does not swap an arrow in when another binding of the name exists', () => {
    const two = 'var playSound = 1;\n' + prog;
    const out = applyFixReply(two, 'const playSound = (a, b) => a * b;', 4);
    expect(out).not.toBe(two.replace(/function playSound[\s\S]*?\n}/, 'const playSound = (a, b) => a * b;'));
  });

  it('drops a stray unterminated or trailing fence after a whole program', () => {
    const body = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;', 'const f = 6;', 'const g = 7;'].join('\n');
    expect(applyFixReply(prog, body + '\n```js', 5)).toBe(body);
    expect(applyFixReply(prog, '```js\n' + body, 5)).toBe(body);
    expect(applyFixReply(prog, body + '\n```', 5)).toBe(body);
  });
});

describe('code written as inline markdown', () => {
  it('unwraps it, so it does not run as a string that does nothing', () => {
    const prog = 'const a = 1;\nboom();\nconst b = 2;';
    const fixed = applyFixReply(prog, "// Cause: x\nCorrected line: `bang();`", 2);
    expect(fixed.split('\n')[1]).toBe('bang();');
  });
});

describe('one-word prose before a code fence', () => {
  it('is not taken as code', () => {
    const prog = 'const a = 1;\nboom();\nconst b = 2;';
    const fixed = applyFixReply(prog, '// Cause: x\nFixed\n```js\nbar();\n```', 2);
    expect(fixed).not.toContain('Fixed');
    expect(fixed.split('\n')[1]).toBe('bar();');
  });
});

describe('fix requests for long programs show a short context', () => {
  const filler = Array.from({ length: 20 }, (_, i) => `const filler${i} = ${i};`);
  const long = ['const rate = 0.2;', ...filler, 'function tip(bill) {', '  const extra = bill * rate;', '  return extra + tip2;', '}', ...filler.map((l) => l.replace('filler', 'later')), 'tip(10);'];
  const line = long.indexOf('  return extra + tip2;') + 1;

  it('keeps the function and what it uses, with the markers around the failing line', () => {
    const req = fixRequest('Tips.', long.join('\n'), line, 'tip2 is not defined.');
    expect(req).toContain('// >>> ERROR: tip2 is not defined\n  return extra + tip2;\n// <<< ERROR'.replace('\n// <<<', '\n  // <<<').replace('// >>>', '  // >>>'));
    expect(req).toContain('const rate = 0.2;');
    expect(req).toContain('function tip(bill) {');
    expect(req).not.toContain('filler7');
    expect(req).not.toContain('later7');
    expect(req).toContain('// …');
    expect(req.split('\n').length).toBeLessThan(25);
    expect(req).toContain('Marked line:\nreturn extra + tip2;');
  });

  it('marks a whole function for a second try, and shows the whole program when it does not parse', () => {
    const block = fixRequest('', long.join('\n'), line, 'boom', undefined, { start: line - 2, end: line + 1 });
    expect(block).toContain('// >>> ERROR: boom (at line ' + line + ')');
    expect(block).not.toContain('filler7');
    const broken = [...long, 'const x = ;'].join('\n');
    expect(fixRequest('', broken, line, 'boom')).toContain('filler7');
  });

  it('still applies a reply to the full program by its own line numbers', () => {
    const fixed = applyFixReply(long.join('\n'), '// Cause: typo\nreturn extra + rate;', line).split('\n');
    expect(fixed[line - 1]).toBe('  return extra + rate;');
    expect(fixed).toHaveLength(long.length);
    expect(fixed[0]).toBe('const rate = 0.2;');
  });
});

describe('a whole-program fix that drops declarations it still uses', () => {
  it('gets them back from the program, and leaves alone what the reply declares itself', async () => {
    const { restoreDeclarations } = await import('../src/core/line-fix.ts');
    const original = "const bpm = 100;\nconst sounds = { piano: { notes: [] } };\nconst play = () => sounds.piano.notes.length;\nplay();";
    const fixed = "const play = () => sounds.piano.notes.length + bpm;\nconst bpm = 120;\nplay();";
    const out = restoreDeclarations(original, fixed);
    expect(out.restored).toEqual(['sounds']);
    expect(out.code.startsWith('const sounds = { piano: { notes: [] } };\n')).toBe(true);
    expect(out.code).not.toContain('const bpm = 100');
  });

  it('drops a stray "Cause:" line without the comment marks', () => {
    const fixed = applyFixReply('const a = 1;\nboom();', '// Cause: x\nCause: the call is wrong\nbang();', 2);
    expect(fixed).not.toContain('Cause');
    expect(fixed).toContain('bang();');
  });
});
