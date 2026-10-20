import { describe, expect, it } from 'vitest';
import { applyFixReply, FIX_SYSTEM_PROMPT, fixRequest } from '../src/core/line-fix.ts';

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
