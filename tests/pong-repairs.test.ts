// From a real Pong log: a variable declared in one function and used in another, a blank filled
// with something lacking what the program reads on it, and a markdown summary turned into speech
import { describe, expect, it } from 'vitest';
import { shareDeclarations } from '../src/core/error-hints.ts';
import { blankChoices, findBlank } from '../src/core/blank-fix.ts';
import { inspectExecutableCode } from '../src/tools/javascript-runtime.ts';

describe('a variable declared in one function and used in another', () => {
  const pong = [
    'const paddle = { x: 1, y: 2 };',
    'function checkCollision() {',
    '  const ball = { x: 100, y: 100 };',
    '  if (ball.x <= paddle.x) ball.x -= 5;',
    '}',
    'function checkWallCollision() {',
    '  if (ball.y > 10) ball.y = 10;',
    '}',
    'checkCollision();',
    'checkWallCollision();',
  ].join('\n');

  it('is declared for the whole program and still set where it was', () => {
    const r = shareDeclarations(pong);
    expect(r.shared).toEqual([{ name: 'ball', from: 'checkCollision', line: 2 }]);
    expect(r.code).toContain('let ball;\nfunction checkCollision() {\n  ball = { x: 100, y: 100 };');
  });

  it('is left alone where a shared variable would act differently, or the name is unclear', () => {
    const cases = [
      // two runs at once
      pong.replace('function checkCollision', 'async function checkCollision'),
      // a function that calls itself
      pong.replace("  if (ball.x <= paddle.x) ball.x -= 5;", '  if (ball.x <= paddle.x) checkCollision();'),
      // a closure keeping its own copy
      pong.replace("  if (ball.x <= paddle.x) ball.x -= 5;", '  setTimeout(() => ball.x++, 10);'),
      // asked whether it exists
      pong.replace('  if (ball.y > 10) ball.y = 10;', "  if (typeof ball !== 'undefined' && ball.y > 10) ball.y = 10;"),
      // another variable of that name elsewhere
      pong.replace('function checkWallCollision() {', 'function other(ball) { return ball; }\nfunction checkWallCollision() {'),
    ];
    for (const code of cases) expect(shareDeclarations(code).shared).toEqual([]);
  });
});

describe('a blank candidate', () => {
  it('has every member the program reads on the blank', () => {
    const code = [
      'const canvas = document.createElement("canvas");',
      'document.body.appendChild(canvas);',
      'const ctx = canvas.getContext("2d");',
      'const paddle = { x: 100, y: 10, width: 10, height: 10 };',
      'function checkWallCollision() {',
      '  if (ball.y > canvas.height - 50) {',
      '    ball.y = canvas.height - 50;',
      '  }',
      '}',
      'checkWallCollision();',
    ].join('\n');
    const blank = findBlank(code, "Can't find variable: ball", 6)!;
    const choices = blankChoices(code, blank, { ids: [] });
    // The drawing context and the canvas have no y: never offered
    expect(choices).not.toContain('ctx');
    expect(choices).not.toContain('canvas');
    expect(choices).toContain('paddle');
  });
});

describe('a markdown summary after the program', () => {
  it('is said as plain sentences, without its heading or list marks', () => {
    const reply = '```javascript\nconst c = document.createElement("canvas");\ndocument.body.appendChild(c);\n```\n\n### What It Does:\n- Creates a `<canvas>` for drawing the game.\n- Initializes a `Paddle` object for moving by mouse or touch.';
    const said = inspectExecutableCode(reply).code.split('\n').filter((l) => l.startsWith('speak'));
    expect(said).toEqual(['speak("Creates a canvas for drawing the game. Initializes a Paddle object for moving by mouse or touch.");']);
  });
});
