import { describe, expect, it } from 'vitest';
import { applyFixReply, FIX_SYSTEM_PROMPT, fixRequest } from '../src/core/line-fix.ts';

const program = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n');

describe('fix requests for failed programs', () => {
  it('says what the program is for, the error, and shows five numbered lines on each side', () => {
    const req = fixRequest('Make a countdown!', program, 20, 'boom.');
    expect(req.startsWith('Request: Make a countdown\nThe program failed at line 20: boom\n')).toBe(true);
    expect(req).toContain('Lines 15-25 of the program:\n15: const v15 = 15;\n');
    expect(req).toContain('25: const v25 = 25;\n');
    expect(req).not.toContain('26: ');
    expect(req).toContain('Reply with search/replace blocks only:\n<<<<<<< SEARCH');
    expect(req).not.toMatch(/LINES|complete program/);
    // Near the start the lines shown begin at line 1
    expect(fixRequest('Make a countdown', program, 2, 'boom')).toContain('Lines 1-7 of the program:');
  });

  it('shows the whole program when the error has no line, and keeps a long request short', () => {
    const req = fixRequest('', 'const a = 1;\nconst b = a.c.d;', undefined, 'boom');
    expect(req.startsWith('The program failed: boom\nThe program:\n1: const a = 1;\n2: const b = a.c.d;\n')).toBe(true);
    expect(fixRequest('a'.repeat(500), program, undefined, 'boom').split('\n')[0]).toHaveLength('Request: '.length + 200);
  });

  it('starts with the earlier requests, so a follow-up fix knows what the program is for', () => {
    const req = fixRequest('make it faster', program, 20, 'boom', ['Play a song.', 'add drums']);
    expect(req.startsWith('Earlier requests: Play a song / add drums\nRequest: make it faster\n')).toBe(true);
  });

  it('has its own short system prompt, only about fixing', () => {
    expect(FIX_SYSTEM_PROMPT).toContain('Reply ONLY with search/replace blocks');
    expect(FIX_SYSTEM_PROMPT).not.toMatch(/MIDI|canvas|Wikipedia|<examples>/);
  });
});

describe('applying a fix reply', () => {
  const lines = ['function play() {', '  for (let i = 0; i < 4; i++) {', '    const t = start + i;', '  }', '  setTimeout(() => out.send(x, t), 1000);', '}', 'play();'];
  const failed = lines.join('\n');

  it('applies search/replace blocks by their text, whatever the indentation or shown numbers', () => {
    const reply = 'Here is the fix:\n<<<<<<< SEARCH\n5:   setTimeout(() => out.send(x, t), 1000);\n=======\n  setTimeout(() => out.send(x, start), 1000);\n>>>>>>> REPLACE';
    expect(applyFixReply(failed, reply).split('\n')[4]).toBe('  setTimeout(() => out.send(x, start), 1000);');
    const unindented = '<<<<<<< SEARCH\nconst t = start + i;\n=======\nconst t = start + i * 2;\n>>>>>>> REPLACE';
    expect(applyFixReply(failed, unindented).split('\n')[2]).toBe('const t = start + i * 2;');
  });

  it('applies several blocks, and skips one that matches nothing', () => {
    const reply = [
      '<<<<<<< SEARCH', 'const t = start + i;', '=======', 'const t = start + i * 2;', '>>>>>>> REPLACE',
      '<<<<<<< SEARCH', 'not in the program', '=======', 'x', '>>>>>>> REPLACE',
      '<<<<<<< SEARCH', 'play();', '=======', 'await play();', '>>>>>>> REPLACE',
    ].join('\n');
    const out = applyFixReply(failed, reply).split('\n');
    expect(out[2]).toBe('const t = start + i * 2;');
    expect(out[6]).toBe('await play();');
    const missing = '<<<<<<< SEARCH\nnot in the program\n=======\nx\n>>>>>>> REPLACE';
    expect(applyFixReply(failed, missing)).toBe(failed);
  });

  it('takes a reply without blocks as a whole new program', () => {
    expect(applyFixReply(failed, 'speak("hi");\nplay2();')).toBe('speak("hi");\nplay2();');
  });
});
