# Everyday evaluation

24 fixed requests (6 classes x 4: small apps, drawing/games, music, facts, math/conversions, chat) run against the real engine and models in the browser. Code: `src/evaluation/everyday-eval.ts`; pure parts are unit tested in `tests/everyday-eval.test.ts`.

## Run it
1. `npm run dev`, open http://localhost:5174/chatty/, and **click the page once** (audio only starts after a tap).
2. In the console:
```js
const { runEverydayEval, formatEvalReport } = await import('/chatty/src/evaluation/everyday-eval.ts');
const r = await runEverydayEval(window.chattyEngine, { models: ['<chat model id>'], onProgress: console.log });
console.log(formatEvalReport(r));
```
Options: `classes` (subset of `app drawing music facts math chat`), `perRequestTimeoutMs` (default 120000). Models run one at a time (switched with `updateSettings`; it waits for `llmProvider.modelId` to match). Each request gets a new conversation, speech output off, MIDI muted (the synth output's `send` is replaced by a counter), and the screen is reset afterwards. Keep the tab in front and do not touch it while it runs.

## What passes
All classes need a program to have run and no error after the last program (an error fixed by a later program passes, but is counted).
- app: at least one button/input/select/link/onclick in the card.
- drawing: a painted canvas, or an svg shape, or 3+ elements in the card.
- music: at least one call to the synth output's `send`.
- facts: the spoken answer contains the expected word (e.g. 1989, Astana, Bell), whether the model knew it or looked it up.
- math: the spoken text contains the expected number (1% tolerance, or the case's own).
- chat: something was spoken.

Also reported per model: total errors, fix turns (run-log `retry` entries), corrections (`imagined` entries), mean seconds per request.

## Do not tune against it
It measures changes. Prompts, repairs and hints must never be adjusted to pass these specific requests; if a request fails, look for the general cause or leave it. Changing the list invalidates comparisons with earlier results.
