import { describe, expect, it } from 'vitest';
import { errorHint } from '../src/core/error-hints.ts';
import { blankChoices, findBlank } from '../src/core/blank-fix.ts';

describe('repairs that would change what a program means', () => {
  it('does not take a plural for a slip of its singular (a list is not one of its items)', () => {
    const code = 'const ball = { x: 1 };\nfor (let i = 0; i < balls.length; i++) balls[i].x++;';
    const hint = errorHint(code, "Can't find variable: balls", 2);
    expect(hint?.correction).toBeUndefined();
  });

  it('still corrects a real slip of a declared name', () => {
    const code = 'const total = 5;\nspeak(`${totl}`);';
    expect(errorHint(code, "Can't find variable: totl", 2)?.correction?.note).toBe('totl → total');
  });

  it('offers no loop counter for a blank whose member a number lacks', () => {
    const code = 'const ball = { color: "red" };\nfor (var i = 0; i < 3; i++) {}\nctx.fillStyle = ball[i].color;';
    const blank = findBlank(code, "undefined is not an object (evaluating 'ball[i].color')", 3);
    expect(blank).not.toBeNull();
    expect(blankChoices(code, blank!, { ids: [] })).not.toContain('i');
  });
});

describe('fix sampling for small models', async () => {
  const { forModel } = await import('../src/core/orchestrator.ts');
  it('scales temperatures down for models under about 1.5B (hottest 1), and leaves larger ones alone', () => {
    expect(forModel({ temperature: 1.3, topP: 0.95 }, 'qwen2.5-0.5b').temperature).toBe(1);
    expect(forModel({ temperature: 1, topP: 0.99 }, 'qwen2.5-0.5b').temperature).toBe(0.77);
    expect(forModel({ temperature: 1.3, topP: 0.95 }, 'gemma-4-e2b-it-web').temperature).toBe(1.3);
  });
});
