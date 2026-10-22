import { describe, expect, it } from 'vitest';
import { CAPABILITY_CARDS } from '../src/core/capability-cards.ts';
import { OPTIONAL_RULES, RULE_CASES } from '../src/core/rule-filter.ts';

const words = (request: string): string[] => request.toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(Boolean);
/** Every run of four words in a row: two requests sharing one are near-copies */
const runsOfFour = (request: string): string[] => {
  const w = words(request);
  return w.slice(0, -3).map((_, i) => w.slice(i, i + 4).join(' '));
};

describe('the capability cards', () => {
  it('has one card for every optional rule, each with a dozen or more examples and some look-alikes', () => {
    expect(CAPABILITY_CARDS.map((card) => card.name).sort()).toEqual([...OPTIONAL_RULES].sort());
    for (const card of CAPABILITY_CARDS) {
      expect(card.examples.length, card.name).toBeGreaterThanOrEqual(12);
      expect(card.notFor.length, card.name).toBeGreaterThanOrEqual(2);
      expect(new Set(card.examples).size, card.name).toBe(card.examples.length);
    }
  });

  it('repeats no labeled rule-filter case, nor shares a run of four words with one', () => {
    const caseRuns = new Map<string, string>();
    for (const c of RULE_CASES) for (const run of runsOfFour(c.request)) caseRuns.set(run, c.request);
    const cases = new Set(RULE_CASES.map((c) => words(c.request).join(' ')));
    const copies = CAPABILITY_CARDS.flatMap((card) =>
      [...card.examples, ...card.notFor].flatMap((request) => {
        if (cases.has(words(request).join(' '))) return [`${request} (a case)`];
        const shared = runsOfFour(request).find((run) => caseRuns.has(run));
        return shared ? [`${request} ~ ${caseRuns.get(shared)}`] : [];
      })
    );
    expect(copies).toEqual([]);
  });
});
