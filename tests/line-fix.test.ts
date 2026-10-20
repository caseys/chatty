import { describe, expect, it } from 'vitest';
import { fixRequest } from '../src/core/line-fix.ts';

const program = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n');

describe('fix requests for failed programs', () => {
  it('leads with the original request, as a fresh request rather than "fix it"', () => {
    const req = fixRequest('Show a seven second launch timer.', program, 20, 'boom');
    expect(req.startsWith('Show a seven second launch timer. Your last program failed at line 20: boom.')).toBe(true);
    // No trailing punctuation doubled up where the request ends
    expect(fixRequest('Make a countdown!', program, 20, 'boom')).toContain('Make a countdown. Your last program failed');
  });

  it('shows the failing line with five lines on each side, numbered, and asks for the whole program', () => {
    const req = fixRequest('Make a countdown', program, 20, 'boom');
    expect(req).toContain('Lines 15-25 of it:\n15: const v15 = 15;\n');
    expect(req).toContain('25: const v25 = 25;\n');
    expect(req).not.toContain('26: ');
    expect(req).toContain('Write the complete program again');
    expect(req).toContain('JavaScript only');
    // Near the start the lines shown begin at line 1
    expect(fixRequest('Make a countdown', program, 2, 'boom')).toContain('Lines 1-7 of it:');
  });

  it('asks for the whole program without lines when the error has no line', () => {
    expect(fixRequest('Make a countdown', program, undefined, 'boom')).toBe(
      'Make a countdown. Your last program failed: boom\nWrite the complete program again with that fixed, JavaScript only.'
    );
  });

  it('still reads as a request when the original request is unknown, and keeps a long one short', () => {
    expect(fixRequest('', program, undefined, 'boom')).toBe(
      'Your last program failed: boom\nWrite the complete program again with that fixed, JavaScript only.'
    );
    const long = fixRequest('a'.repeat(500), program, undefined, 'boom');
    expect(long.indexOf('. Your last program failed')).toBe(200);
  });
});
