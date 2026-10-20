import { describe, expect, it } from 'vitest';
import { formatRepairTally, tallyRepairs } from '../src/core/run-log.ts';

describe('tallyRepairs', () => {
  const logs = {
    a: [
      '[10:00:00] imagined: ctx.fillstyle → ctx.fillStyle: corrected before running',
      '[10:00:01] imagined: gfx.strokestyle → gfx.strokeStyle: corrected before running',
      "[10:00:02] imagined: its own playNote → the ready-made one: corrected and run again",
      '[10:00:03] retry: the program failed (Error at line 4: x is not defined): asking the model to fix the marked line',
      '[10:00:04] retry: the fix changed nothing: asking for the whole function go() (lines 1-9)',
      '[10:00:05] discarded:\n// The fix came back as chat, so nothing was run:\nsome reply',
      '[10:00:06] program:\nlet x = 1;',
    ],
    b: [
      '[11:00:00] imagined: p was a promise → await: corrected and run again',
      '[11:00:01] retry: the program failed (Error at line 9: y is not defined): asking the model to fix the marked line',
      '[11:00:02] discarded:\nplain talk',
    ],
  };

  it('groups by kind of change, ignoring names', () => {
    const t = tallyRepairs(logs);
    expect(t.imagined['… → … (before running)']).toBe(2);
    expect(t.imagined['its own … → the ready-made one']).toBe(1);
    expect(t.imagined['… was a promise → await']).toBe(1);
  });

  it('groups retries by reason and discards by why', () => {
    const t = tallyRepairs(logs);
    expect(t.retry).toEqual({ 'the program failed': 2, 'the fix changed nothing': 1 });
    expect(t.discarded).toEqual({ 'The fix came back as chat, so nothing was run': 1, 'a reply thrown away': 1 });
  });

  it('formats one compact line, most frequent first', () => {
    const line = formatRepairTally(tallyRepairs(logs), 2);
    expect(line.startsWith('Repairs across chats: ')).toBe(true);
    expect(line).toContain('×2');
    expect(line).toContain('more');
    expect(formatRepairTally(tallyRepairs({}))).toBe('Repairs across chats: none yet');
  });
});
