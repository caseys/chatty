// A reply going round in circles is stopped at the third declaration of one name in one scope
import { describe, expect, it } from 'vitest';
import { redeclaredCut } from '../src/core/repeat-guard.ts';

// From live replies (Qwen2.5 0.5B beach, Qwen3 0.6B blues), as they were streaming
const beach = [
  '```javascript',
  "let drawingArea = document.getElementById('drawing-area');",
  'function draw() {',
  '  drawingArea.clearRect(0, 0, 1000, 1000);',
  '  function updateDrawingArea() {',
  '    drawingArea.translate(drawingArea.x, drawingArea.y);',
  '  }',
  '  // Update the drawing area every frame (100 milliseconds)',
  '  function updateDrawingArea() {',
  '    drawingArea.update();',
  '    updateDrawingArea();',
  '  }',
  '  function moveDrawingArea() {',
  '    drawingArea.x = 0;',
  '  }',
  '  // Update the drawing area every frame (100 milliseconds)',
  '  function updateDrawingArea() {',
  '    drawingArea.update();',
  '    moveDrawingArea();',
  '  }',
  '  function drawAreaWidth() {',
].join('\n');

const blues = [
  'speak("Build a blues music loop.");',
  '```javascript',
  'const synthSetup = () => {',
  '  const synth = Tone.PolySynth();',
  '  const tempo = Tone.Transport.bpm.value;',
  '  const synth = Tone.PolySynth();',
  '',
  '  // Create a basic structure',
  '  const synth = Tone.PolySynth();',
  '',
  '  // Set up the instrument',
  '  const instrument = Tone.PluckSynth();',
].join('\n');

describe('a reply that declares the same name a third time', () => {
  it('stops at the line that starts the third declaration, keeping the first two', () => {
    const cut = redeclaredCut(beach)!;
    expect(cut.name).toBe('updateDrawingArea');
    const kept = beach.slice(0, cut.index);
    expect(kept.match(/function updateDrawingArea/g)).toHaveLength(2);
    expect(kept.endsWith('  // Update the drawing area every frame (100 milliseconds)\n')).toBe(true);

    const again = redeclaredCut(blues)!;
    expect(again.name).toBe('synth');
    expect(blues.slice(0, again.index).match(/const synth\b/g)).toHaveLength(2);
  });

  it('leaves correct code alone: one name in many scopes, var, loops, and only two copies', () => {
    const scopes = [
      'function drawSky() {\n  const ctx = canvas.getContext("2d");\n  ctx.fillRect(0, 0, 10, 10);\n}',
      'function drawSea() {\n  const ctx = canvas.getContext("2d");\n  ctx.fillRect(0, 10, 10, 10);\n}',
      'function drawSun() {\n  const ctx = canvas.getContext("2d");\n  ctx.arc(5, 5, 2, 0, 7);\n}',
      'for (let i = 0; i < 3; i++) { const x = i; }\nfor (let i = 0; i < 3; i++) { const x = i; }\nfor (let i = 0; i < 3; i++) { const x = i; }',
      'var i = 0;\nvar i = 1;\nvar i = 2;',
    ].join('\n');
    expect(redeclaredCut(scopes)).toBeNull();
    expect(redeclaredCut('const a = 1;\nconst a = 2;\nconst b = 3;')).toBeNull();
    // A name inside a string or a comment is not a declaration
    expect(redeclaredCut('// const a\n// const a\nconst a = "const a";')).toBeNull();
  });
});
