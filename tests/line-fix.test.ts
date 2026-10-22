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

  it('ends a whole-program ask with a "Corrected program:" cue, and drops the label when a reply copies it', () => {
    const code = 'const a = 1;\nb();';
    const ask = fixRequest('Play a song.', code, undefined, 'b is not defined.');
    expect(ask.endsWith('```\nCorrected program:')).toBe(true);
    expect(applyFixReply(code, 'Corrected program:\nconst a = 1;\nconst b = () => {};\nb();', undefined, undefined, true)).toBe('const a = 1;\nconst b = () => {};\nb();');
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

describe('a whole-program reply with several code blocks', () => {
  // The failing program (a Tone.Loop made with options, then asked to play notes) and the reply Qwen3 gave for the whole program:
  // a two-line fragment first, then the complete program
  const failed = [
    'const loop = new Tone.Loop({ duration: 4, tempo: 120 });',
    'loop.triggerAttackRelease("G4", 0.5);',
    'loop.triggerAttackRelease("B4", 0.5);',
    'loop.triggerAttackRelease("D5", 0.5);',
    'loop.start();',
  ].join('\n');
  const complete = [
    'const synth = new Tone.PolySynth().toDestination();',
    'const loop = new Tone.Loop((time) => {',
    '  synth.triggerAttackRelease("G4", 0.5, time);',
    '}, "4n");',
    'loop.start();',
    'Tone.Transport.start();',
  ].join('\n');
  const reply = ['// Cause: loops have no triggerAttackRelease', '```js', 'const synth = new Tone.PolySynth();', 'synth.toDestination();', '```', '', 'The complete program:', '```js', complete, '```'].join('\n');

  it('takes the complete program, not the fragment that came first', () => {
    expect(applyFixReply(failed, reply, undefined, undefined, true)).toBe(complete);
  });

  it('takes a ```js block and an ```html block of only a <script> as one program (a fix Qwen2.5 0.5B wrote for a board game)', () => {
    const page = "document.body.innerHTML = '<div id=\"grid\"></div><button onclick=\"board()\">New game</button>';";
    const board = "function board() {\n  document.getElementById('grid').textContent = 'X';\n}";
    const twoBlocks = ['Here is the fixed program:', '```js', page, '```', '```html', '<script>', board, '</script>', '```'].join('\n');
    expect(applyFixReply(`${page}\nboard();`, twoBlocks, undefined, undefined, true).replace(/\n{2,}/g, "\n")).toBe(`${page}\n${board}`);
    // Not when the HTML block is a page of its own (markup beside the script): one block, as before
    const withMarkup = twoBlocks.replace('<script>', '<div>hi</div>\n<script>');
    expect(applyFixReply(`${page}\nboard();`, withMarkup, undefined, undefined, true)).not.toContain('function board');
    expect(applyFixReply(failed, reply, undefined, undefined, true)).toBe(complete);
  });

  it('takes the block that keeps most of the program’s own lines', () => {
    const own = ['```js', 'loop.start();', '```', '```js', failed.replace('{ duration: 4, tempo: 120 }', '(time) => {}, "4n"'), '```'].join('\n');
    expect(applyFixReply(failed, own, undefined, undefined, true)).toBe(failed.replace('{ duration: 4, tempo: 120 }', '(time) => {}, "4n"'));
  });

  it('does not take the program itself, quoted as "Before it was:", for the fix', () => {
    const fix = 'const synth = new Tone.PolySynth().toDestination();\nsynth.triggerAttackRelease("G4", "8n");\nTone.Transport.start();';
    const quoted = ['Fixed:', '```js', fix, '```', 'Before it was:', '```js', failed, '```'].join('\n');
    expect(applyFixReply(failed, quoted, undefined, undefined, true)).toBe(fix);
    // Quoted first, the fix after it
    const before = ['Before it was:', '```js', failed, '```', 'Now:', '```js', fix, '```'].join('\n');
    expect(applyFixReply(failed, before, undefined, undefined, true)).toBe(fix);
    // Only the program given back: nothing better to take
    expect(applyFixReply(failed, ['```js', failed, '```', '```js', failed, '```'].join('\n'), undefined, undefined, true)).toBe(failed);
  });

  it('is unchanged for a reply with one block, and for a line fix with several (the first is the corrected line)', () => {
    expect(applyFixReply(failed, ['```js', complete, '```'].join('\n'), undefined, undefined, true)).toBe(complete);
    // Not asked for the whole program: the first block, as before
    expect(applyFixReply(failed, reply, 2)).toBe(applyFixReply(failed, reply.split('The complete program:')[0], 2));
  });
});

describe('what a whole-program fix gets back is closed over what it reads', () => {
  // The live Twinkle program from the iPhone run (try 4 put back beat, note and duration, not the tempo that beat reads)
  const program = [
    'const synth = new Tone.PolySynth();',
    'const melody = new Tone.Melody();',
    'const tempo = 60;',
    'const beat = tempo / 12;',
    'const note = "C4";',
    'const duration = 0.5;',
    'synth.triggerAttackRelease(note, duration);',
  ].join('\n');

  it('puts back a declaration a restored one reads, in the program’s order', async () => {
    const { restoreDeclarations } = await import('../src/core/line-fix.ts');
    const reply = 'speak("Ready.");\nsynth.triggerAttackRelease(note, beat);';
    const kept = restoreDeclarations(program, reply);
    expect(kept.restored).toEqual(['synth', 'tempo', 'beat', 'note']);
    expect(kept.code).toBe(['const synth = new Tone.PolySynth();', 'const tempo = 60;', 'const beat = tempo / 12;', 'const note = "C4";', reply].join('\n'));
    // Several steps: a declaration that reads one that reads another
    const chain = 'const a = 1;\nconst b = a + 1;\nconst c = b + 1;\nconst d = c + 1;';
    expect(restoreDeclarations(chain, 'speak(String(d));').code).toBe(`${chain}\nspeak(String(d));`);
  });

  it('keeps nothing it does not need, and leaves a reply that declares what it reads alone', async () => {
    const { restoreDeclarations } = await import('../src/core/line-fix.ts');
    const reply = 'const tempo = 80;\nconst beat = tempo / 12;\nspeak(String(beat));';
    expect(restoreDeclarations(program, reply)).toEqual({ code: reply, restored: [] });
    expect(restoreDeclarations('const x = 1;\nconst unused = 2;', 'speak(String(x));').restored).toEqual(['x']);
  });

  it('does not put lines back into a reply that is prose with its code in backticks (one template string)', async () => {
    const { restoreWhole, isBareText } = await import('../src/core/line-fix.ts');
    const prose = '`The problem is that synth is not connected. Fix: <synth> synth.toDestination(); </synth>`;';
    expect(isBareText(prose)).toBe(true);
    expect(isBareText('"just text";')).toBe(true);
    expect(isBareText(`${prose}\nspeak("x");`)).toBe(false);
    expect(isBareText('const x = `a ${1}`;')).toBe(false);
    expect(isBareText('`a ${x}`;')).toBe(false);
    expect(restoreWhole(program, prose, 2)).toEqual({ code: prose, restored: [], lines: 0 });
  });
});

describe('the statement an error with no line came from', () => {
  // The live PolySynth program: Tone threw inside itself, so its stack held no line of the program
  const program = [
    'var note = "C4"; var duration = 100; var time = 0;',
    'var synth = new Tone.PolySynth(note, duration, time);',
    'synth.toDestination();',
    'synth.triggerAttackRelease(note, 500, 1);',
  ].join('\n');

  it('finds it by running starts of the program, a few runs for many statements', async () => {
    const { failingStatement } = await import('../src/core/line-fix.ts');
    let runs = 0;
    const found = await failingStatement(program, async (start) => {
      runs++;
      return start.includes('new Tone.PolySynth');
    });
    expect(found).toEqual({ line: 2, text: 'var synth = new Tone.PolySynth(note, duration, time);' });
    expect(runs).toBeLessThanOrEqual(4);
    const long = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).concat('boom();', 'const after = 1;').join('\n');
    runs = 0;
    expect(await failingStatement(long, async (start) => {
      runs++;
      return start.includes('boom()');
    })).toEqual({ line: 41, text: 'boom();' });
    expect(runs).toBeLessThanOrEqual(7);
  });

  it('says nothing when the program does not fail the same way, cannot be read, or has nothing in it', async () => {
    const { failingStatement } = await import('../src/core/line-fix.ts');
    expect(await failingStatement(program, async () => false)).toBeNull();
    expect(await failingStatement('const x = (;', async () => true)).toBeNull();
    expect(await failingStatement('// nothing', async () => true)).toBeNull();
    expect(await failingStatement('speak("one");', async () => true)).toEqual({ line: 1, text: 'speak("one");' });
  });
});
