import { describe, expect, it } from 'vitest';
import { elementKinds } from '../src/tools/element-kinds.ts';

describe('the kind of element behind each looked-up id', () => {
  it('reads it from the members used, directly or through a variable', () => {
    const code = [
      "const ctx = document.getElementById('board').getContext('2d');",
      "const player = document.getElementById('sound');",
      'player.play();',
      "const n = Number(document.querySelector('#amount').value);",
      "document.getElementById('box').showModal();",
      "document.getElementById('title').textContent = 'Hi';",
    ].join('\n');
    expect(elementKinds(code)).toEqual({ board: 'canvas', sound: 'media', amount: 'field', box: 'dialog' });
  });

  it('leaves out an id used as two kinds, and code that does not parse', () => {
    expect(elementKinds("const x = document.getElementById('x'); x.play(); x.getContext('2d');")).toEqual({});
    expect(elementKinds('const = ;')).toEqual({});
  });
});
