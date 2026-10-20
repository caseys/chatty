import { describe, expect, it } from 'vitest';
import { applyFixReply, FIX_SYSTEM_PROMPT, fixRequest } from '../src/core/line-fix.ts';

const program = Array.from({ length: 30 }, (_, i) => `  const v${i + 1} = ${i + 1};`).join('\n');

describe('fix requests for failed programs', () => {
  it('hands over the whole program with the failing line marked, and the error', () => {
    const code = 'const a = 1;\nfunction f() {\n  g(t);\n}\nf();';
    expect(fixRequest('Play a song.', code, 3, 't is not defined.')).toBe(
      [
        'This program was written for: Play a song',
        'It failed at the marked line: t is not defined',
        '',
        'const a = 1;',
        'function f() {',
        '  // >>> ERROR: t is not defined',
        '  g(t);',
        '  // <<< ERROR',
        '}',
        'f();',
        '',
        'First write one comment line saying what caused the error (// Cause: ...), then the complete program with it fixed, without the ERROR comments.',
      ].join('\n')
    );
  });

  it('shows the program unmarked when the error has no line', () => {
    const req = fixRequest('', program, undefined, 'boom');
    expect(req.startsWith('It failed: boom\n')).toBe(true);
    expect(req).not.toContain('>>> ERROR');
  });

  it('has its own short system prompt, only about fixing', () => {
    expect(FIX_SYSTEM_PROMPT).toContain('complete fixed program');
    expect(FIX_SYSTEM_PROMPT).not.toMatch(/MIDI|canvas|Wikipedia|<examples>/);
  });
});

describe('applying a fix reply', () => {
  const lines = ['function play() {', '  for (let i = 0; i < 4; i++) {', '    const t = start + i;', '  }', '  setTimeout(() => out.send(x, t), 1000);', '}', 'play();'];
  const failed = lines.join('\n');

  it('takes a whole program as the new program, without copied ERROR markers', () => {
    expect(applyFixReply(failed, '// Cause: t\nspeak("hi");')).toBe('// Cause: t\nspeak("hi");');
    expect(applyFixReply(failed, 'a();\n// >>> ERROR: x\nb();\n// <<< ERROR\nc();')).toBe('a();\nb();\nc();');
  });

  it('still applies search/replace blocks by their text, and skips one that matches nothing', () => {
    const reply = '<<<<<<< SEARCH\n5:   setTimeout(() => out.send(x, t), 1000);\n=======\n  setTimeout(() => out.send(x, start), 1000);\n>>>>>>> REPLACE';
    expect(applyFixReply(failed, reply).split('\n')[4]).toBe('  setTimeout(() => out.send(x, start), 1000);');
    expect(applyFixReply(failed, '<<<<<<< SEARCH\nnope\n=======\nx\n>>>>>>> REPLACE')).toBe(failed);
    // Broken markers: nothing to apply, so the program stays
    expect(applyFixReply(failed, '<<<<<<< SEARCH\nconst t = 1;\n=======')).toBe(failed);
  });
});
