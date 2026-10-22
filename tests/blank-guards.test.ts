import { describe, expect, it } from 'vitest';
import { fillCallsItself, findBlank, standsForMissingFunction } from '../src/core/blank-fix.ts';

describe('what may fill a missing function’s name', () => {
  // The tic-tac-toe Qwen2.5 0.5B wrote: isValidMove() was never declared
  const game = [
    'let player = "X";',
    'function changePlayer() { player = player === "X" ? "O" : "X"; }',
    'function nextTurn(i) {',
    '  if (!isValidMove(i)) return;',
    '  changePlayer();',
    '}',
    'function checkMoves() { return true; }',
    'nextTurn(0);',
  ].join('\n');
  const error = 'isValidMove is not defined';
  const blank = findBlank(game, error, 4)!;

  it('is a name that shares a word with it, or the one the model clearly chose', () => {
    expect(blank.text).toBe('isValidMove');
    expect(standsForMissingFunction(game, blank, error, 'nextTurn', false)).toBe(false);
    expect(standsForMissingFunction(game, blank, error, 'changePlayer', false)).toBe(false);
    expect(standsForMissingFunction(game, blank, error, 'checkMoves', false)).toBe(true);
    expect(standsForMissingFunction(game, blank, error, 'changePlayer', true)).toBe(true);
    // An expression the model wrote is judged by its test run, not here
    expect(standsForMissingFunction(game, blank, error, '(i) => true', false)).toBe(true);
  });

  it('is never the function the call is in, which would only call itself', () => {
    expect(fillCallsItself(game, blank, 'nextTurn')).toBe(true);
    expect(fillCallsItself(game, blank, 'checkMoves')).toBe(false);
    const held = 'const step = (i) => { if (!isValidMove(i)) return; };\nstep(1);';
    expect(fillCallsItself(held, findBlank(held, error, 1)!, 'step')).toBe(true);
  });

  it('leaves a name that is read, not called, alone', () => {
    const read = 'let total = 0;\nspeak(totl + 1);';
    const b = findBlank(read, 'totl is not defined', 2)!;
    expect(standsForMissingFunction(read, b, 'totl is not defined', 'speakers', false)).toBe(true);
  });
});
