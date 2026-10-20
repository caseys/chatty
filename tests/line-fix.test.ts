import { describe, expect, it } from 'vitest';
import { applyFixReply, FIX_SYSTEM_PROMPT, fixRequest } from '../src/core/line-fix.ts';

const program = Array.from({ length: 30 }, (_, i) => `  const v${i + 1} = ${i + 1};`).join('\n');

describe('fix requests for failed programs', () => {
  it('gives the error and the one line it points at, and asks for a cause and search/replace edits', () => {
    const req = fixRequest(program, 20, 'boom.');
    expect(req.startsWith('Your program failed at line 20: boom\nLine 20: const v20 = 20;\nFirst write one comment line')).toBe(true);
    expect(req).toContain('<<<<<<< SEARCH');
    expect(req.split('\n')).not.toContain('Line 21: const v21 = 21;');
  });

  it('leaves the line out when the error has none', () => {
    expect(fixRequest(program, undefined, 'boom').split('\n')[0]).toBe('Your program failed: boom');
    expect(fixRequest(program, undefined, 'boom')).not.toContain('Line ');
  });

  it('has its own short system prompt, only about fixing', () => {
    expect(FIX_SYSTEM_PROMPT).toContain('search/replace blocks');
    expect(FIX_SYSTEM_PROMPT).not.toMatch(/MIDI|canvas|Wikipedia|<examples>/);
  });
});

describe('applying a fix reply', () => {
  const lines = ['function play() {', '  for (let i = 0; i < 4; i++) {', '    const t = start + i;', '  }', '  setTimeout(() => out.send(x, t), 1000);', '}', 'play();'];
  const failed = lines.join('\n');

  it('takes a whole program as the new program', () => {
    expect(applyFixReply(failed, '// Cause: t\nspeak("hi");')).toBe('// Cause: t\nspeak("hi");');
  });

  it('still applies search/replace blocks by their text, and skips one that matches nothing', () => {
    const reply = '<<<<<<< SEARCH\n5:   setTimeout(() => out.send(x, t), 1000);\n=======\n  setTimeout(() => out.send(x, start), 1000);\n>>>>>>> REPLACE';
    expect(applyFixReply(failed, reply).split('\n')[4]).toBe('  setTimeout(() => out.send(x, start), 1000);');
    expect(applyFixReply(failed, '<<<<<<< SEARCH\nnope\n=======\nx\n>>>>>>> REPLACE')).toBe(failed);
  });
});
