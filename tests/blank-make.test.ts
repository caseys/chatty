// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { blankChoices, findBlank } from '../src/core/blank-fix.ts';

describe('a new object of the type its uses need', () => {
  const offer = (code: string, error: string, line: number) => blankChoices(code, findBlank(code, error, line)!, { ids: [] });
  it('a canvas, a 2D context, an element, a sound, a list: whatever every use needs', () => {
    expect(offer('const g = view.getContext("2d");\nview.width = 300;', "Can't find variable: view", 1)).toContain('document.body.appendChild(document.createElement("canvas"))');
    expect(offer('box.textContent = "Hi";\nbox.style.color = "red";', "Can't find variable: box", 1)).toContain('document.body.appendChild(document.createElement("div"))');
    expect(offer('const n = Number(field.value);\nfield.focus();', "Can't find variable: field", 1)).toContain('document.body.appendChild(document.createElement("input"))');
    expect(offer('for (let i = 0; i < balls.length; i++) balls[i].x += 1;', "Can't find variable: balls", 1)).toContain('[]');
    expect(offer('seen.add(1);\nif (seen.has(2)) speak("two");', "Can't find variable: seen", 1)).toContain('new Set()');
  });
});
