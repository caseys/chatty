// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { blankChoices, fillBlank, findBlank } from '../src/core/blank-fix.ts';

// The tic-tac-toe program of the live log (iPhone, build 71a80f8): markup with a canvas #board and two
// divs, `let board = …getElementById('board')`, and an undeclared `canvas` used in two functions
const PROGRAM = [
  "document.body.innerHTML = '<div id=\"game\"><canvas id=\"board\"></canvas></div><div id=\"result\"></div>';",
  "let board = document.getElementById('board');",
  'let current = "X";',
  '',
  'function drawBoard() {',
  "  const ctx = canvas.getContext('2d');",
  '  ctx.fillRect(0, 0, 10, 10);',
  '}',
  '',
  'function drawBoardWithColors() {',
  "  const ctx = canvas.getContext('2d');",
  '  ctx.fillRect(0, 0, 20, 20);',
  '}',
  '',
  'function gameLoop() {',
  '  drawBoardWithColors();',
  "  document.getElementById('result').textContent = current;",
  '}',
  'gameLoop();',
].join('\n');
const ERROR = 'canvas is not defined';
const PAGE = { ids: ['game', 'board', 'result'], fields: [], tags: { game: 'div', board: 'canvas', result: 'div' } };

describe('a name that is undeclared in two functions', () => {
  it('is one blank with both uses, declared once above the first function that uses it', () => {
    const blank = findBlank(PROGRAM, ERROR, 11)!;
    expect(blank.spans).toHaveLength(2);
    expect(blank.declareAt).toBeDefined();
    const filled = fillBlank(PROGRAM, blank, 'board')!;
    expect(filled).toContain('const canvas = board;\nfunction drawBoard() {');
    // Both uses read it: running it gives no error at either
    expect(filled.match(/canvas\.getContext/g)).toHaveLength(2);
    expect(() => new Function(filled)).not.toThrow();
  });
});

describe('what a blank offers by what the page says each element is', () => {
  it('offers the canvas the page has, in its two shapes, and no div or new canvas, for a name that calls getContext', () => {
    const blank = findBlank(PROGRAM, ERROR, 11)!;
    const choices = blankChoices(PROGRAM, blank, PAGE);
    expect(choices).toContain('board');
    expect(choices).toContain("document.getElementById('board')");
    // The existing variable and lookup come before anything else
    expect(choices.indexOf('board')).toBeLessThan(2);
    expect(choices).not.toContain("document.getElementById('result')");
    expect(choices).not.toContain("document.getElementById('game')");
    expect(choices.some((c) => /createElement\("canvas"\)/.test(c))).toBe(false);
    // The card (root) is a div: it has no getContext
    expect(choices).not.toContain('root');
  });

  it('offers a new canvas only when the page has none, and every element when it does not know what they are', () => {
    const blank = findBlank(PROGRAM, ERROR, 11)!;
    const none = blankChoices(PROGRAM, blank, { ids: ['game', 'result'], fields: [], tags: { game: 'div', result: 'div' } });
    expect(none.some((c) => /createElement\("canvas"\)/.test(c))).toBe(true);
    expect(none).not.toContain("document.getElementById('game')");
    // Without the tags, as before: the lookups are offered with the made one
    const unknown = blankChoices(PROGRAM, blank, { ids: ['game', 'board', 'result'], fields: [] });
    expect(unknown.some((c) => /createElement\("canvas"\)/.test(c))).toBe(true);
  });

  it('keeps a div for a member every element has, and a field for its value', () => {
    const program = "document.body.innerHTML = '<div id=\"out\"></div><input id=\"bill\">';\nlabel.textContent = 'x';";
    const blank = findBlank(program, 'label is not defined', 2)!;
    const choices = blankChoices(program, blank, { ids: ['out', 'bill'], fields: ['bill'], tags: { out: 'div', bill: 'input' } });
    expect(choices).toContain("document.getElementById('out')");
    const valued = "document.body.innerHTML = '<input id=\"bill\">';\nspeak(bill.toFixed(2));";
    const b2 = findBlank(valued, 'bill is not defined', 2)!;
    expect(blankChoices(valued, b2, { ids: ['bill'], fields: ['bill'], tags: { bill: 'input' } })).toContain("document.getElementById('bill').value");
  });
});

describe('candidates for a blank that have what is used on it', () => {
  // The shape of the live beach program (Qwen2.5 0.5B): colors, a context, and a drawing area nothing declared
  const beach = [
    'let ctx, skyColor, oceanColor;',
    "ctx = document.body.appendChild(document.createElement('canvas')).getContext('2d');",
    "skyColor = 'rgb(135, 206, 235)';",
    "oceanColor = '#4b0082';",
    'function draw() {',
    '  drawingArea.clearRect(0, 0, 300, 150);',
    '  drawingArea.translate(10, 10);',
    '  ctx.fillStyle = skyColor;',
    '}',
    'draw();',
  ].join('\n');

  it('offers the context the program has, not its colors, and not a new canvas beside it', () => {
    const blank = findBlank(beach, 'drawingArea is not defined', 6)!;
    expect(blankChoices(beach, blank, { ids: [] })).toEqual(['ctx']);
  });

  it('offers a name that holds text for a text member, and the new canvas when nothing the program has fits', () => {
    const text = "const title = 'Hello';\nconst count = 3;\nfunction f() { return label.toUpperCase(); }";
    expect(blankChoices(text, findBlank(text, 'label is not defined', 3)!, { ids: [] })).toContain('title');
    expect(blankChoices(text, findBlank(text, 'label is not defined', 3)!, { ids: [] })).not.toContain('count');
    const bare = "const skyColor = '#87ceeb';\nfunction draw() { area.clearRect(0, 0, 9, 9); }";
    const choices = blankChoices(bare, findBlank(bare, 'area is not defined', 2)!, { ids: [] });
    expect(choices).not.toContain('skyColor');
    expect(choices.some((c) => c.includes('getContext("2d")'))).toBe(true);
  });
});
