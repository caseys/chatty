import { describe, expect, it } from 'vitest';
import { fixRequest } from '../src/core/line-fix.ts';

const program = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n');

describe('fix requests for failed programs', () => {
  it('shows the failing line with five lines on each side, numbered, and asks for the whole program', () => {
    const req = fixRequest(program, 20, 'boom');
    expect(req).toContain('Your program failed at line 20: boom');
    expect(req).toContain('Lines 15-25 of your program:\n15: const v15 = 15;\n');
    expect(req).toContain('25: const v25 = 25;\n');
    expect(req).not.toContain('26: ');
    expect(req).toContain('complete corrected program');
    // Near the start the lines shown begin at line 1
    expect(fixRequest(program, 2, 'boom')).toContain('Lines 1-7 of your program:');
  });

  it('asks for the whole program without lines when the error has no line', () => {
    expect(fixRequest(program, undefined, 'boom')).toBe(
      'Your program failed: boom\nReply with the complete corrected program, JavaScript only.'
    );
  });
});
