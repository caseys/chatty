import { describe, expect, it } from 'vitest';
import { fitCutoffs, RULE_QUESTIONS, ruleQuestion, scoredRules, yesScorer } from '../src/core/rule-filter.ts';
import { promptRules } from '../src/core/orchestrator.ts';

describe('the rule filter', () => {
  it('asks about a rule as a note or as a direct question, with A and B for answers', () => {
    expect(ruleQuestion('ui', 'Make a  dice roller')).toBe(
      `Note: ${RULE_QUESTIONS.ui.note}\nRequest: "Make a dice roller"\nQuestion: Is this note useful for the request?\nA) yes\nB) no\nAnswer:`
    );
    expect(ruleQuestion('music', 'Play a song')).toBe(`Request: "Play a song"\nQuestion: ${RULE_QUESTIONS.music.question}\nA) yes\nB) no\nAnswer:`);
  });

  it('keeps a rule whose yes passes its cutoff, asks only about rules with one, and gives up when a question goes unscored', async () => {
    const asked: string[] = [];
    const high = (question: string) => {
      asked.push(question);
      return Promise.resolve(/something in 3D/.test(question) ? 0.99 : 0.01);
    };
    const cutoffs = { ui: 0.9, canvas: 0.7, three: 0.8 };
    const scored = await scoredRules('Show a 3D cube', high, cutoffs);
    expect([...(scored?.kept ?? [])]).toEqual(['three']);
    expect(asked).toHaveLength(3);
    expect([...(scored?.decided ?? [])]).toEqual(['ui', 'canvas', 'three']);
    expect(await scoredRules('Show a 3D cube', () => Promise.resolve(null), cutoffs)).toBeNull();
    // Only the rules put forward are asked about
    asked.length = 0;
    await scoredRules('Show a 3D cube', high, cutoffs, ['three']);
    expect(asked).toHaveLength(1);
  });

  it('reads yes as the share of A against B, and has no scorer for a runtime that cannot score', async () => {
    const score = yesScorer({ scoreChoices: () => Promise.resolve([0.3, 0.1]) });
    expect(await score?.('q')).toBeCloseTo(0.75);
    expect(yesScorer({})).toBeNull();
  });

  it('fits each cutoff to the fewest wrong calls, and none to a rule no case needs', () => {
    const cases = [{ rules: ['music' as const] }, { rules: [] }, { rules: ['music' as const] }, { rules: [] }];
    const fitted = fitCutoffs(cases, [{ music: 0.9, fx: 0.5 }, { music: 0.7, fx: 0.6 }, { music: 0.8, fx: 0.4 }, { music: 0.2, fx: 0.3 }]);
    expect(fitted.music).toMatchObject({ errors: 0, auc: 1, positives: 2 });
    expect(fitted.music.cutoff).toBeGreaterThanOrEqual(0.7);
    expect(fitted.music.cutoff).toBeLessThan(0.8);
    expect(fitted.fx.cutoff).toBeNull();
  });
});

describe('prompt rules from the model', () => {
  const scored = { kept: new Set(['music' as const]), decided: new Set(['card', 'ui', 'canvas', 'music', 'facts'] as const) };

  it('keeps the decided rules the model kept, and the others by keywords', () => {
    const rules = promptRules('Draw a song', true, scored);
    expect(rules).toContain('For music');
    expect(rules).not.toContain('Use <canvas>');
    expect(promptRules('Show a spinning 3D cube', true, scored)).toContain('For 3D');
  });

  it("keeps a rule the program being changed uses, whatever the model said about the request", () => {
    expect(promptRules('make it red', true, scored, 'const c = document.createElement("canvas")')).toContain('Use <canvas>');
  });
});
