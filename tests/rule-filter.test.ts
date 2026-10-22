import { describe, expect, it } from 'vitest';
import { fitCutoffs, RULE_CUTOFFS, RULE_QUESTIONS, ruleQuestion, scoredRules, yesScorer } from '../src/core/rule-filter.ts';
import { promptRules, rulesNamedBy } from '../src/core/orchestrator.ts';

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

describe('the text rule', () => {
  it('is put forward for text to count, reverse or change, and only then', () => {
    expect(rulesNamedBy('Count the words in this sentence: the cat sat').has('text')).toBe(true);
    expect(rulesNamedBy('Reverse the word "pineapple"').has('text')).toBe(true);
    expect(rulesNamedBy("Change every 'a' to 'o' in 'banana'").has('text')).toBe(true);
    expect(rulesNamedBy('Who was Ada Lovelace?').has('text')).toBe(false);
    expect(promptRules('Make it all uppercase', true)).toContain('For text tools');
    expect(promptRules('Tell me a joke about cats', true)).not.toContain('For text tools');
  });

  it('is kept on Qwen3 when its yes passes the cutoff, and goes by keywords on Qwen2.5', async () => {
    const yes = (p: number) => () => Promise.resolve(p);
    expect([...((await scoredRules('Reverse "abc"', yes(0.6), RULE_CUTOFFS['qwen3-0.6b'], ['text']))?.kept ?? [])]).toEqual(['text']);
    expect((await scoredRules('Play it backwards', yes(0.2), RULE_CUTOFFS['qwen3-0.6b'], ['text']))?.kept.has('text')).toBe(false);
    expect(RULE_CUTOFFS['qwen2.5-0.5b'].text).toBeUndefined();
  });
});

describe('keyboard and CSS motion rules', () => {
  const named = (request: string) => [...rulesNamedBy(request)].filter((rule) => ['keys', 'css'].includes(rule));

  it('are put forward by their keywords', () => {
    expect(named('Move a square with the arrow keys')).toEqual(['keys']);
    expect(named('Show the name of whichever key I press')).toEqual(['keys']);
    expect(named('Fade a word in and out')).toEqual(['css']);
  });

  it('are not put forward by the look-alikes the model could not turn down', () => {
    expect(named('Make a piano keyboard I can play by tapping the keys')).toEqual([]);
    expect(named('Play a short tune in the key of G major')).toEqual([]);
    expect(named('Give me three keys to staying productive')).toEqual([]);
    expect(named('Animate 10 colored balls bouncing around the screen')).toEqual([]);
  });

  it('put the card rule forward for what is played with keys or dragged', () => {
    expect(rulesNamedBy('Let me steer a little car around with WASD').has('card')).toBe(true);
    expect(rulesNamedBy('Make a box I can drag around').has('card')).toBe(true);
  });
});

describe('saving and the weather', () => {
  it('put forward by what the request asks for, not by look-alike words', () => {
    const named = (request: string) => [...rulesNamedBy(request)].filter((r) => r === 'save' || r === 'weather');
    expect(named('Save my notes so they are there next time')).toEqual(['save']);
    expect(named("What's the weather like here?")).toEqual(['weather']);
    for (const request of ['Play the notes C, E and G', 'Keep the ball bouncing', 'Now make the ball red', 'Count to 10 one at a time', 'Make a rainbow button', 'Draw rain on a street', 'Sing happy birthday', 'Make a snake game that remembers my high score'])
      expect(named(request)).toEqual([]);
    // The weather has its own rule, but its history and causes are facts
    expect(rulesNamedBy("What's the weather in Paris?").has('facts')).toBe(false);
    expect(rulesNamedBy('Who invented the weather forecast?').has('facts')).toBe(true);
  });

  it('take a program being changed by what it uses, not by its words (window, ctx.save())', () => {
    const program = 'window.addEventListener("click", () => { ctx.save(); const notes = [60, 62]; performance.now(); });';
    const rules = promptRules(`make it blue\n${program}`, true, undefined, program);
    expect(rules).not.toContain('For weather');
    expect(rules).not.toContain('To keep what the user types between visits');
    const saving = 'let value = JSON.parse(localStorage.getItem("notes"));';
    expect(promptRules(`make it blue\n${saving}`, true, undefined, saving)).toContain('To keep what the user types between visits');
  });

  it('show each value to fill in as an empty slot with what goes there', () => {
    const rules = promptRules('', false);
    expect(rules).toContain('const place = ""; // the city asked about');
    expect(rules).toContain('const key = ""; // what is kept');
    expect(rules).not.toContain('<lat>');
  });
});
