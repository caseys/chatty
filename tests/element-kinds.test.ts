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

describe('the ids whose absence the program handles itself', async () => {
  const { checkedIds } = await import('../src/tools/element-kinds.ts');
  it('are the lookups tested for nothing, directly or through a variable', () => {
    const code = [
      "let overlay = document.getElementById('overlay');",
      "if (!overlay) { overlay = document.createElement('div'); overlay.id = 'overlay'; document.body.appendChild(overlay); }",
      "const panel = document.querySelector('#panel') ?? makePanel();",
      "const box = document.getElementById('box');",
      "box.textContent = 'hi';",
      "if (document.getElementById('score') === null) speak('no score');",
      "document.getElementById('lives')?.remove();",
    ].join('\n');
    expect(checkedIds(code).sort()).toEqual(['lives', 'overlay', 'panel', 'score']);
    expect(checkedIds('const = ;')).toEqual([]);
  });
});
