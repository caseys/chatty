import { describe, expect, it } from 'vitest';
import { restoreDeleted, restoreWhole, errorRegion } from '../src/core/line-fix.ts';
import { errorHint, joinSplitReturn, methodReadFacts, moveClassesUp, wrapLogicalAssignment } from '../src/core/error-hints.ts';

// The shape of the program Qwen3 0.6B wrote for the tic-tac-toe pill on iPhone (live log, build 71a80f8):
// the request said back, markup, `new Game()` above the class, and a statement that assigns inside &&
const SECOND = [
  'speak("Hi! Make a tic-tac-toe game where two players take turns tapping the squares");',
  'document.body.innerHTML = `<div id="game"></div><div id="results"></div>`;',
  'const game = new Game();',
  'const board = document.getElementById("game");',
  'board.addEventListener("click", () => { game.play(); });',
  'document.getElementById("game").addEventListener("keydown", () => {',
  '  game.isGameOver && results.textContent = "Game Over";',
  '});',
  '',
  'class Game {',
  '  constructor() {',
  '    this.turn = "X";',
  '  }',
  '  play() {',
  '    this.turn = this.turn === "X" ? "O" : "X";',
  '  }',
  '  isGameOver() {',
  '    return false;',
  '  }',
  '}',
].join('\n');

describe('a logical expression assigned to (a && b = c)', () => {
  it('is read as a && (b = c), as in the tic-tac-toe program', () => {
    const fixed = wrapLogicalAssignment(SECOND)!;
    expect(fixed.lines).toEqual([7]);
    expect(fixed.code).toContain('game.isGameOver && (results.textContent = "Game Over");');
    expect(fixed.code.split('\n')).toHaveLength(SECOND.split('\n').length);
    // Every other line is as it was
    expect(fixed.code.replace('(results.textContent = "Game Over")', 'results.textContent = "Game Over"')).toBe(SECOND);
  });

  it('works for ||, ??, a call before it, no semicolon, and several statements', () => {
    expect(wrapLogicalAssignment('a || b = 1;')!.code).toBe('a || (b = 1);');
    expect(wrapLogicalAssignment('a ?? b.c = d + 1;')!.code).toBe('a ?? (b.c = d + 1);');
    expect(wrapLogicalAssignment('ready() && el.textContent = "go"')!.code).toBe('ready() && (el.textContent = "go")');
    expect(wrapLogicalAssignment('x(() => { a && b.c = 1 })')!.code).toBe('x(() => { a && (b.c = 1) })');
    expect(wrapLogicalAssignment('a && b = 1;\nc || d = 2;')!.code).toBe('a && (b = 1);\nc || (d = 2);');
    expect(wrapLogicalAssignment('a && b = 1\nspeak("x");')!.code).toBe('a && (b = 1)\nspeak("x");');
  });

  it('leaves what already parses, and what has no single reading, alone', () => {
    for (const code of ['a && (b = c);', 'if (a) b = c;', 'a && b();', 'const x = a && b;', 'a && f() = 1;', 'a && 1 = 2;']) {
      expect(wrapLogicalAssignment(code), code).toBeNull();
    }
  });
});

describe('return alone on its line, the value on the next', () => {
  const checkWin = 'function checkWin(b) {\n  return\n    b[0] === b[1] &&\n    b[1] === b[2];\n}\nspeak(String(checkWin(["x", "x", "x"])));';

  it('returns the value, on the lines it was on', () => {
    const fixed = joinSplitReturn(checkWin)!;
    expect(fixed.code).toBe('function checkWin(b) {\n  return (\n    b[0] === b[1] &&\n    b[1] === b[2]);\n}\nspeak(String(checkWin(["x", "x", "x"])));');
    expect(fixed.lines).toEqual([2]);
    // It runs, and returns
    expect(new Function(`${fixed.code.replace('speak(String(checkWin(["x", "x", "x"])));', '')}\nreturn checkWin(["x", "x", "x"]);`)()).toBe(true);
  });

  it('leaves a return that is followed by something that can still run, an explicit return;, and a return with a value', () => {
    for (const code of [
      'function f() {\n  return\n  function g() {}\n}',
      'function f() {\n  return\n  var x = 1;\n}',
      'function f(a) {\n  return;\n  a && b;\n}',
      'function f(a) {\n  if (a) return\n  g();\n}',
      'function f(a) {\n  return a &&\n    b;\n}',
      'function f(a) {\n  return\n}',
    ]) {
      expect(joinSplitReturn(code), code).toBeNull();
    }
  });
});

describe('a class used above its declaration', () => {
  it('moves the class above the first statement that uses it, as in the tic-tac-toe program', () => {
    // (after the && assignment is wrapped: the program has to parse)
    const moved = moveClassesUp(wrapLogicalAssignment(SECOND)!.code)!;
    expect(moved.names).toEqual(['Game']);
    const lines = moved.code.split('\n');
    expect(lines.findIndex((l) => l.startsWith('class Game'))).toBeLessThan(lines.findIndex((l) => l.startsWith('const game = new Game()')));
    // The class is once, whole, and nothing else changed
    expect(moved.code.match(/class Game/g)).toHaveLength(1);
    expect(moved.code.replace(/\n+/g, '\n').split('\n').sort()).toEqual(wrapLogicalAssignment(SECOND)!.code.replace(/\n+/g, '\n').split('\n').sort());
  });

  it('leaves a class used only inside functions, one declared first, and one whose start-up reads what is declared in between', () => {
    expect(moveClassesUp('function start() { return new Game(); }\nclass Game {}\nstart();')).toBeNull();
    expect(moveClassesUp('class Game {}\nconst game = new Game();')).toBeNull();
    // `size` is made between the use and the class, and the field reads it as the object is made
    expect(moveClassesUp('const game = new Game();\nconst size = 3;\nclass Game { cells = size * size; }')).toBeNull();
    expect(moveClassesUp('const game = new Game();\nconst size = 3;\nclass Game extends size {}')).toBeNull();
    expect(moveClassesUp('const game = new Game();\nconst size = 3;\nclass Game { constructor() { this.n = size; } }')).toBeNull();
    // A method reads it later: fine
    expect(moveClassesUp('const game = new Game();\nconst size = 3;\nclass Game { cells() { return size; } }')!.names).toEqual(['Game']);
    // A function declared after is hoisted: no reason to move
    expect(moveClassesUp('start();\nfunction start() {}')).toBeNull();
  });

  it('moves a class that reads only what is declared above the use, and extends order is kept', () => {
    const code = 'const size = 3;\nconst game = new Game();\nclass Game { cells = size * size; }';
    expect(moveClassesUp(code)!.code).toBe('const size = 3;\nclass Game { cells = size * size; }\n\nconst game = new Game();');
  });
});

describe('a method read as a condition without being called', () => {
  it('is said once, as in the tic-tac-toe program', () => {
    expect(methodReadFacts(SECOND.replace('results.textContent = "Game Over"', 'results.textContent == "Game Over"'))).toBe('game.isGameOver is a method, so it is always true here; call it as game.isGameOver().');
    expect(methodReadFacts('class A { done() { return true; } }\nconst a = new A();\nif (a.done) speak("x");\nwhile (!a.done) {}\nconst c = a.done ? 1 : 2;')).toBe('a.done is a method, so it is always true here; call it as a.done().');
    expect(methodReadFacts('const o = { ready() { return false; } };\nif (o.ready) speak("go");')).toContain('o.ready is a method');
  });

  it('is not said for a call, a getter, a property, a browser object, or a value that is no condition', () => {
    for (const code of [
      'class A { done() { return true; } }\nconst a = new A();\nif (a.done()) speak("x");',
      'class A { get done() { return true; } }\nconst a = new A();\nif (a.done) speak("x");',
      'class A { constructor() { this.done = false; } }\nconst a = new A();\nif (a.done) speak("x");',
      'if (navigator.vibrate) navigator.vibrate(10);',
      'class A { done() { return true; } }\nconst a = new A();\nconst f = a.done;\nspeak(String(typeof f));',
      'class A { done() { return true; } }\nconst a = new A();\nel.onclick = a.done;',
    ]) {
      expect(methodReadFacts(code), code).toBeNull();
    }
  });
});

describe('the facts that go with an error', () => {
  it('say a method read in a condition is always true, with whatever error the program had', () => {
    const hint = errorHint(SECOND.replace('results.textContent = "Game Over"', 'results.textContent == "Game Over"'), "Cannot read properties of undefined (reading 'x')", 3);
    expect(hint?.text).toContain('game.isGameOver is a method, so it is always true here; call it as game.isGameOver().');
    expect(errorHint('const a = 1;\na.b.c();', "Cannot read properties of undefined (reading 'c')", 2)?.text ?? '').not.toContain('is a method');
  });
});

describe('a whole-program fix that only deleted', () => {
  // The original, failing at the statement that assigns inside &&; the reply was just the class
  const CLASS = SECOND.slice(SECOND.indexOf('class Game'));

  it('gets back the lines it deleted outside the error, keeps the deletion of the broken statement', () => {
    expect(errorRegion(SECOND, 7)).toEqual({ start: 6, end: 8 });
    const kept = restoreWhole(SECOND, CLASS, 7);
    // The program as it was, but for the statement that failed
    const without = SECOND.split('\n').filter((_, i) => i < 5 || i > 7).join('\n');
    expect(kept.code.split('\n').filter((l) => l.trim())).toEqual(without.split('\n').filter((l) => l.trim()));
    expect(kept.lines).toBe(5);
    expect(kept.code).toContain('document.body.innerHTML');
    expect(kept.code).toContain('board.addEventListener("click"');
    expect(kept.code).not.toContain('keydown');
    // Class where it was: the program parses
    expect(parsesAs(kept.code)).toBe(true);
  });

  it('leaves a fix that deletes the broken lines and nothing else, and one that changes things, as the reply made them', () => {
    const lines = SECOND.split('\n');
    const justBroken = lines.filter((_, i) => i < 5 || i > 7).join('\n');
    expect(restoreWhole(SECOND, justBroken, 7).code).toBe(justBroken);
    // The broken statement rewritten, and another line changed elsewhere (a change is not a deletion)
    const edited = lines.map((l, i) => (i === 6 ? '  game.isGameOver() && (results.textContent = "Game Over");' : i === 3 ? 'const board = document.querySelector("#game");' : l)).join('\n');
    expect(restoreWhole(SECOND, edited, 7).code).toBe(edited);
    // A line the program had twice: only the deleted one comes back
    const twice = 'a();\nb();\nbroken(;\nc();';
    expect(restoreWhole(twice, 'a();\nc();', 3).code).toBe('a();\nb();\nc();');
    // Without a known line there is no region to judge by
    expect(restoreWhole(SECOND, CLASS, undefined).code).toBe(CLASS);
    // A reply that does not parse is not touched
    expect(restoreDeleted(SECOND, 'class Game {', { start: 6, end: 8 })).toBeNull();
  });

  it('judges a program that parses by the statement holding the failing line', () => {
    const original = 'const a = 1;\nfunction go() {\n  const b = missing;\n  return b;\n}\ngo();\nspeak("done");';
    expect(errorRegion(original, 3)).toEqual({ start: 2, end: 5 });
    // The reply rewrote go() and dropped the rest: the rest comes back, the rewrite stays
    const reply = 'function go() {\n  return 2;\n}';
    expect(restoreWhole(original, reply, 3).code).toBe('const a = 1;\nfunction go() {\n  return 2;\n}\ngo();\nspeak("done");');
  });
});

const parsesAs = (code: string) => {
  try {
    new Function(code);
    return true;
  } catch {
    return false;
  }
};
