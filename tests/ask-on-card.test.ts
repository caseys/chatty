import { describe, expect, it } from 'vitest';
import { parse } from 'acorn';
import { askOnCard, detectRecommendedMode } from '../src/tools/javascript-runtime.ts';

const parses = (code: string) => {
  try {
    parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true });
    return true;
  } catch {
    return false;
  }
};

describe('prompt(), which the card cannot open, asked on the card', () => {
  it('waits for the answer at the top level: the name Qwen3.5 2B asked for to say backwards', () => {
    const code = 'const name = prompt("Type your name:");\nconst reversed = name.split(\'\').reverse().join(\'\');\nspeak("Your name backwards is: " + reversed);';
    const asked = askOnCard(code)!;
    expect(asked.calls).toBe(1);
    expect(asked.code).toBe('const name = (await __chattyAsk("Type your name:"));\nconst reversed = name.split(\'\').reverse().join(\'\');\nspeak("Your name backwards is: " + reversed);');
    // A member read off the answer still reads the answer
    expect(askOnCard('speak(prompt("Word?").length);')!.code).toBe('speak((await __chattyAsk("Word?")).length);');
    expect(askOnCard('const n = window.prompt("n", "5");')!.code).toBe('const n = (await __chattyAsk("n", "5"));');
  });

  it('makes a function async for it when nothing reads its result: a statement call, a listener, a handler', () => {
    const game = 'function startGame() {\n  const g = prompt("Enter your guess: ");\n  speak(g);\n}\nstartGame();';
    expect(askOnCard(game)!.code).toBe('async function startGame() {\n  const g = (await __chattyAsk("Enter your guess: "));\n  speak(g);\n}\nstartGame();');
    // Awaited as a statement (Qwen3.5 2B, "ask me my name and then greet me by name"), but not where its value is used
    const greet = 'function greetUser() {\n  const name = prompt("What is your name?");\n  console.log(name);\n}\nawait greetUser();';
    expect(askOnCard(greet)!.code).toBe('async function greetUser() {\n  const name = (await __chattyAsk("What is your name?"));\n  console.log(name);\n}\nawait greetUser();');
    expect(askOnCard('function f() { return prompt("x"); }\nconst v = (await f()).trim();')).toBeNull();
    // The temperature converter Qwen2.5 0.5B asked in a click listener
    const click = 'document.getElementById("convert").addEventListener("click", function() {\n  let c = prompt("Enter temperature in Celsius: ");\n  speak(c * 9 / 5 + 32);\n});';
    expect(askOnCard(click)!.code).toContain('addEventListener("click", async function() {\n  let c = (await __chattyAsk("Enter temperature in Celsius: "));');
    expect(askOnCard('const ask = () => speak(prompt("Hi?"));\nbutton.onclick = ask;')!.code).toBe('const ask = async () => speak((await __chattyAsk("Hi?")));\nbutton.onclick = ask;');
    expect(askOnCard('async function go() { return prompt("x"); }\nconst v = await go();')!.code).toBe('async function go() { return (await __chattyAsk("x")); }\nconst v = await go();');
    for (const code of [game, click]) expect(parses(askOnCard(code)!.code)).toBe(true);
  });

  it('runs on the card, where the box is, even with nothing else of the page in it (a guessing game that only logs)', () => {
    const loop = 'let num = 5;\nlet guess;\nwhile (guess !== num) {\n  guess = parseInt(prompt("Enter your guess:"));\n  console.log(guess > num ? "lower" : "higher");\n}';
    expect(detectRecommendedMode(askOnCard(loop)!.code)).toBe('iframe');
  });

  it('leaves a call whose function result is used, a method, the program’s own prompt, and no prompt at all', () => {
    expect(askOnCard('function ask() { return prompt("x"); }\nconst v = ask();\nspeak(v);')).toBeNull();
    expect(askOnCard('const game = { ask() { return prompt("x"); } };\ngame.ask();')).toBeNull();
    expect(askOnCard('function prompt(q) { return q; }\nspeak(prompt("x"));')).toBeNull();
    expect(askOnCard('const prompt = (q) => q;\nspeak(prompt("x"));')).toBeNull();
    expect(askOnCard('ai.prompt("write");\nspeak("a prompt(");')).toBeNull();
    expect(askOnCard('const v = await prompt("x");')).toBeNull();
    expect(askOnCard('speak("hi")')).toBeNull();
  });
});
