/**
 * Which optional prompt rules a request gets: a rule's keywords (the `when` of its prompt rule)
 * put it forward, and the model confirms it. For each rule put forward, one multiple-choice question
 * ("A) yes / B) no") is scored by the probability the model gives "yes" (LlmRuntimeProvider.scoreChoices:
 * a grammar holds the reply to the two letters, and one pass of one token reads both probabilities),
 * and the rule is kept when that passes the rule's cutoff.
 *
 * Asked as sampled text, a 0.5B model answered every such question "No", or rambled. Scored, it ranks
 * the rules usefully but can't choose them alone; on 34 labeled requests (Qwen2.5 0.5B) it chose 34 rules
 * wrong, keywords alone 10, and keywords confirmed by the model 6: it turns down keyword matches that
 * aren't what was asked (the drawing rule for "Twinkle Twinkle Little Star", the interface rule for
 * "Show a spinning 3D cube", 3D for a tic-tac-toe "game"). Each rule's "yes" sits at its own level, so
 * each has its own cutoff, for each model (RULE_CUTOFFS), fitted on labeled requests (RULE_CASES) by
 * calibrateRules.
 *
 * To teach it a new subject: add the rule to the prompt (orchestrator PROMPT_RULES, with a name and
 * keywords), its question here, and requests labeled with the rules they need to RULE_CASES; run the
 * calibration in the dev page (window.chattyRuleFilter.calibrate()) and copy the cutoffs it prints
 * into RULE_CUTOFFS under the loaded model. Requests it lists as missed by keywords need the keywords widened.
 */

import type { LlmRuntimeProvider } from '../types/index.ts';

export const OPTIONAL_RULES = ['card', 'ui', 'canvas', 'three', 'svg', 'music', 'fx', 'facts'] as const;
export type RuleName = (typeof OPTIONAL_RULES)[number];

/** The system prompt of every question: nothing in it about writing programs, which small models then do */
export const RULE_FILTER_SYSTEM_PROMPT = 'You answer multiple-choice questions about a request for a small program.';

/**
 * How each rule is asked about, and the "yes" probability above which it is kept. Two forms:
 * a note (the rule's own first sentence, no code: code had the model start writing a program)
 * followed by the request and "Is this note useful for the request?", or a direct question about
 * the request. Each rule uses the form that told its requests apart best (Qwen2.5 0.5B, 16 requests:
 * the note for the interface rule ranked every request that needs it above every one that doesn't;
 * the direct question did that for music and facts nearly as well, where the note did worse).
 */
export const RULE_QUESTIONS: Record<RuleName, { note?: string; question?: string }> = {
  card: { note: 'What you add to document.body appears in a card on screen.' },
  ui: { note: 'Use HTML and CSS for interfaces: buttons, forms, tables, dashboards and widgets.' },
  canvas: { note: 'Use <canvas> for visuals: drawings, art, animations, games and simulations.' },
  three: { question: 'Is the request for something in 3D?' },
  svg: { question: 'Will the program draw a diagram, chart or icon?' },
  music: { question: 'Will the program play music, a song, notes or a beat?' },
  fx: { question: 'Will the program make a beep or a sound effect?' },
  facts: { question: 'Is the request a question about a person, place or fact?' },
};

/**
 * Each model's cutoffs (by its app model id), from calibrateRules on RULE_CASES: each model's "yes"
 * sits at its own level. A rule a model has no cutoff for goes by its keywords alone: one whose
 * keywords the cases show no wrong match for yet (asking then can only lose a rule that was needed),
 * or whose question doesn't tell its cases apart (card). A model with no entry goes by keywords.
 */
export const RULE_CUTOFFS: Readonly<Record<string, Partial<Record<RuleName, number>>>> = {
  // 34 cases, keywords with these cutoffs: 31 exact. Its card answers don't tell cases apart (AUC 0.5)
  'qwen3-0.6b': { ui: 0.902, canvas: 0.733, three: 0.807 },
  // 34 cases: 29 exact. Its interface answers don't tell cases apart (AUC 0.48)
  'qwen2.5-0.5b': { card: 0.431, canvas: 0.455, three: 0.615 },
};

const ANSWERS = '\nA) yes\nB) no\nAnswer:';

/** The question about one rule for a request */
export function ruleQuestion(rule: RuleName, request: string): string {
  const { note, question } = RULE_QUESTIONS[rule];
  const asked = request.trim().replace(/\s+/g, ' ');
  return note
    ? `Note: ${note}\nRequest: "${asked}"\nQuestion: Is this note useful for the request?${ANSWERS}`
    : `Request: "${asked}"\nQuestion: ${question}${ANSWERS}`;
}

/** The probability of "yes" to a question, or null (a runtime that can't score, or a pass that gave nothing) */
export type YesScorer = (question: string) => Promise<number | null>;

/** A scorer on a runtime's scoreChoices, or null when the runtime has none */
export function yesScorer(provider: Pick<LlmRuntimeProvider, 'scoreChoices'>, signal?: AbortSignal): YesScorer | null {
  const scoreChoices = provider.scoreChoices?.bind(provider);
  if (!scoreChoices) return null;
  let asked = 0;
  return async (question) => {
    const scores = await scoreChoices(
      {
        turnId: `rules_${Date.now()}_${asked++}`,
        systemPrompt: RULE_FILTER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: question }],
        temperature: 1,
        exact: true,
        fixShape: 'choice',
        choiceCount: 2,
        maxOutputTokens: 1,
        signal,
      },
      ['A', 'B']
    ).catch(() => null);
    if (!scores || scores.length !== 2) return null;
    const total = scores[0] + scores[1];
    return total > 0 ? scores[0] / total : null;
  };
}

/**
 * Which of the rules its keywords put forward (`nominated`) the model confirms for a request: for
 * each with a cutoff, kept when its "yes" passes the cutoff. Rules with no cutoff are left out of the
 * result (they go by keywords). Null when any question went unscored, so the request goes by keywords.
 */
export async function scoredRules(
  request: string,
  score: YesScorer,
  cutoffs: Partial<Record<RuleName, number>>,
  nominated: Iterable<RuleName> = OPTIONAL_RULES
): Promise<{ kept: Set<RuleName>; decided: Set<RuleName>; yes: Partial<Record<RuleName, number>> } | null> {
  const kept = new Set<RuleName>();
  const decided = new Set<RuleName>();
  const yesOf: Partial<Record<RuleName, number>> = {};
  const asked = new Set(nominated);
  for (const rule of OPTIONAL_RULES) {
    const cutoff = cutoffs[rule];
    if (cutoff === undefined || !asked.has(rule)) continue;
    const yes = await score(ruleQuestion(rule, request));
    if (yes === null) return null;
    decided.add(rule);
    yesOf[rule] = yes;
    if (yes > cutoff) kept.add(rule);
  }
  return { kept, decided, yes: yesOf };
}

/**
 * Requests labeled with the optional rules they need: what the cutoffs are fitted on. Add requests
 * on new subjects here (and the rules they need) as they come up, then recalibrate.
 */
export const RULE_CASES: ReadonlyArray<{ request: string; rules: RuleName[] }> = [
  { request: 'Draw a beach sunset with rainbow sky and deep purple ocean', rules: ['card', 'canvas'] },
  { request: 'Play Twinkle Twinkle Little Star on the piano', rules: ['music'] },
  { request: 'Animate 10 colored balls bouncing around the screen', rules: ['card', 'canvas'] },
  { request: 'Code a tip calculator app with a UI for entering the bill and tip %', rules: ['card', 'ui'] },
  { request: 'Show a big ten second countdown on screen', rules: ['card'] },
  { request: 'Make a tic-tac-toe game where two players take turns tapping the squares', rules: ['card', 'ui', 'canvas'] },
  { request: 'Who was Ada Lovelace?', rules: ['facts'] },
  { request: 'What’s 15 percent of 84?', rules: [] },
  { request: 'Make me a stopwatch with start, stop and reset buttons.', rules: ['card', 'ui'] },
  { request: 'Make a little converter from inches to centimeters with a box to type in.', rules: ['card', 'ui'] },
  { request: 'Draw a red barn with a blue sky behind it.', rules: ['card', 'canvas'] },
  { request: 'Play a simple drum beat with kick and snare.', rules: ['music'] },
  { request: 'Play a C minor scale going up and then back down.', rules: ['music'] },
  { request: "What's the capital of Kazakhstan?", rules: ['facts'] },
  { request: 'Convert 72 degrees Fahrenheit to Celsius.', rules: [] },
  { request: 'Tell me a joke about cats.', rules: [] },
  // New subjects
  { request: 'Show a spinning 3D cube', rules: ['card', 'three'] },
  { request: 'Make a 3D solar system with the planets orbiting the sun', rules: ['card', 'three'] },
  { request: 'Make a bar chart of fruit sales: apples 30, bananas 20, cherries 10', rules: ['card', 'svg'] },
  { request: 'Draw a flowchart for making a cup of tea', rules: ['card', 'svg'] },
  { request: 'Design a simple logo icon for a coffee shop', rules: ['card', 'svg'] },
  { request: 'Beep three times', rules: ['fx'] },
  { request: 'Make a button that plays a laser sound effect when I tap it', rules: ['card', 'ui', 'fx'] },
  { request: 'Make a metronome that clicks 100 times a minute with a start button', rules: ['card', 'ui', 'fx'] },
  { request: 'Make a piano keyboard I can play by tapping the keys', rules: ['card', 'ui', 'music'] },
  { request: 'Sing happy birthday on a trumpet', rules: ['music'] },
  { request: 'Who wrote Hamlet?', rules: ['facts'] },
  { request: 'How tall is Mount Everest?', rules: ['facts'] },
  { request: 'Make a quiz app with three questions about space', rules: ['card', 'ui'] },
  { request: 'Make a dice roller with a roll button', rules: ['card', 'ui'] },
  { request: 'Draw a flower with five pink petals', rules: ['card', 'canvas'] },
  { request: 'Show a snowfall animation', rules: ['card', 'canvas'] },
  { request: 'What is 12 times 13?', rules: [] },
  { request: 'Give me a random number between 1 and 100', rules: [] },
];

/**
 * Each rule's fitted cutoff, how many cases it gets wrong there among those its keywords put it
 * forward for, how well its scores rank them (AUC), and the cases its keywords missed (which no
 * cutoff can win back: they need better keywords)
 */
export interface RuleCalibration {
  cutoff: number | null;
  errors: number;
  auc: number | null;
  positives: number;
  missedByKeywords?: string[];
}

/**
 * Fits each rule's cutoff to labeled cases: the one with the fewest wrong calls (the higher one on a
 * tie, so a rule is kept only when the model is surer), among the cases its keywords put it forward
 * for (`nominated[i]`, all cases when left out). A rule those cases all need, or none of them, gets
 * no cutoff: there is nothing to fit it to. `scores[i][rule]` is the "yes" probability for case i.
 */
export function fitCutoffs(
  cases: ReadonlyArray<{ rules: RuleName[] }>,
  scores: ReadonlyArray<Partial<Record<RuleName, number>>>,
  nominated?: ReadonlyArray<ReadonlySet<RuleName>>
): Record<RuleName, RuleCalibration> {
  const out = {} as Record<RuleName, RuleCalibration>;
  for (const rule of OPTIONAL_RULES) {
    const rows = cases
      .map((c, i) => ({ yes: scores[i]?.[rule], needs: c.rules.includes(rule), put: !nominated || nominated[i].has(rule) }))
      .filter((r): r is { yes: number; needs: boolean; put: true } => r.put && typeof r.yes === 'number');
    const positives = rows.filter((r) => r.needs).length;
    if (!positives || positives === rows.length) {
      out[rule] = { cutoff: null, errors: 0, auc: null, positives };
      continue;
    }
    const levels = [...new Set(rows.map((r) => r.yes))].sort((a, b) => a - b);
    let best = { cutoff: 1, errors: Infinity };
    for (const level of levels) {
      const cutoff = level - 0.001;
      const errors = rows.filter((r) => r.yes > cutoff !== r.needs).length;
      if (errors < best.errors || (errors === best.errors && cutoff > best.cutoff)) best = { cutoff, errors };
    }
    const pos = rows.filter((r) => r.needs).map((r) => r.yes);
    const neg = rows.filter((r) => !r.needs).map((r) => r.yes);
    let wins = 0;
    for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
    out[rule] = { cutoff: Math.round(best.cutoff * 1000) / 1000, errors: best.errors, auc: Math.round((wins / (pos.length * neg.length)) * 100) / 100, positives };
  }
  return out;
}

/**
 * Scores every case on every rule and fits the cutoffs (`nominate`: the rules a request's keywords put
 * forward): what the dev page's window.chattyRuleFilter.calibrate() runs. Also reports how many cases
 * keywords with the fitted cutoffs get exactly right.
 */
export async function calibrateRules(
  score: YesScorer,
  nominate: (request: string) => ReadonlySet<RuleName>,
  cases = RULE_CASES
): Promise<{ rules: Record<RuleName, RuleCalibration>; exact: number; cases: number; scores: Array<Partial<Record<RuleName, number>>> }> {
  const scores: Array<Partial<Record<RuleName, number>>> = [];
  for (const c of cases) {
    const row: Partial<Record<RuleName, number>> = {};
    for (const rule of OPTIONAL_RULES) {
      const yes = await score(ruleQuestion(rule, c.request));
      if (yes !== null) row[rule] = Math.round(yes * 1000) / 1000;
    }
    scores.push(row);
  }
  const nominated = cases.map((c) => nominate(c.request));
  const rules = fitCutoffs(cases, scores, nominated);
  for (const rule of OPTIONAL_RULES) {
    const missed = cases.filter((c, i) => c.rules.includes(rule) && !nominated[i].has(rule)).map((c) => c.request);
    if (missed.length) rules[rule].missedByKeywords = missed;
  }
  const exact = cases.filter((c, i) =>
    OPTIONAL_RULES.every((rule) => {
      const { cutoff } = rules[rule];
      const yes = scores[i][rule];
      const kept = nominated[i].has(rule) && (cutoff === null || yes === undefined || yes > cutoff);
      return kept === c.rules.includes(rule);
    })
  ).length;
  return { rules, exact, cases: cases.length, scores };
}
