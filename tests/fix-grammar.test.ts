import { describe, expect, it } from 'vitest';
import { fixGrammar, type FixShape } from '../src/runtimes/fix-grammar.ts';

describe('fixGrammar', () => {
  for (const shape of ['line', 'function', 'program'] as FixShape[]) {
    it(`builds for ${shape}`, () => {
      const g = fixGrammar(shape);
      expect(g.length).toBeGreaterThan(50);
      expect(g).toMatch(/^root ::= cause /);
      expect(g).toContain('// Cause: ');
    });
  }
  it('function requires a function head', () => {
    expect(fixGrammar('function')).toContain('"async function "');
    expect(fixGrammar('line')).not.toContain('head');
  });
});
