// What a program uses a value as, and the help and checks built on it: the hint for a value
// looked up as an element but used as something else, facts for vague errors, and fixes that
// drop what the request needs
import { describe, expect, it } from 'vitest';
import { browserTypeWith, onlySendsLists, usedAs } from '../src/core/value-use.ts';
import { errorHint } from '../src/core/error-hints.ts';
import { droppedCapabilities } from '../src/core/orchestrator.ts';

// From a real log: the MIDI output looked up as a page element, and handed to an audio node
const BLUES = [
  'function playNote(channel, note) {',
  "  const output = document.getElementById('output');",
  '  const gain = new AudioContext().createGain();',
  '  gain.connect(output);',
  '  output.send([0xC0 + channel, note, 0]);',
  '}',
  'playNote(9, 36);',
].join('\n');
const PAGE = { ids: [], standIns: [{ id: 'output', tag: 'div', made: 'empty' as const }] };

describe('what a value is used as', () => {
  it('reads a MIDI output from send([…]) and an audio node from connect()', () => {
    const use = usedAs(BLUES, 'output')!;
    expect(use.types).toEqual(['MIDIOutput', 'AudioNode']);
    expect(use.text).toContain('requestMIDIAccess');
    expect(use.text).toContain('audioContext.destination');
  });

  it('asks the browser which type has every member, a twin counting once', () => {
    class CanvasRenderingContext2D {
      fillRect() {}
      arc() {}
    }
    class OffscreenCanvasRenderingContext2D extends CanvasRenderingContext2D {}
    class Path2D {
      arc() {}
    }
    const scope = { CanvasRenderingContext2D, OffscreenCanvasRenderingContext2D, Path2D } as unknown as Record<string, unknown>;
    expect(browserTypeWith(['fillRect', 'arc'], scope)).toBe('CanvasRenderingContext2D');
    // Two different types have arc(): no answer
    expect(browserTypeWith(['arc'], scope)).toBeNull();
  });

  it('knows a value only ever sent lists to is a MIDI output', () => {
    expect(onlySendsLists('const o = document.getElementById("o");\no.send([0x90, 60, 100]);', 'o')).toBe(true);
    expect(onlySendsLists(BLUES, 'output')).toBe(false);
  });
});

describe('the hint for an element that never existed', () => {
  it('says what the program used it as instead of asking for a <div>', () => {
    const hint = errorHint(BLUES, 'Type error', 4, PAGE)!;
    expect(hint.text).toContain('as a MIDI output');
    expect(hint.text).not.toContain('Create the element');
    // The vague error gets what the failing call was given
    expect(hint.text).toContain("Line 4 calls gain.connect(output): output is a page element (document.getElementById('output')), which never existed.");
  });

  it('puts the ready MIDI output in place of a lookup only ever sent notes', () => {
    const code = "const output = document.getElementById('output');\noutput.send([0x90, 60, 100]);";
    const hint = errorHint(code, "output.send is not a function", 2, PAGE)!;
    expect(hint.correction?.code).toBe('const output = out;\noutput.send([0x90, 60, 100]);');
  });

  it('still asks for the element when the program uses it as one', () => {
    const code = "const box = document.getElementById('output');\nbox.textContent = 'Hi';\nbox.foo();";
    const hint = errorHint(code, 'box.foo is not a function', 3, PAGE)!;
    expect(hint.text).toContain('Create the element');
  });
});

describe('a fix that drops what the request needs', () => {
  const gutted = "speak('Here is your loop.');\nconst output = document.getElementById('output');\noutput.innerHTML = '<div>Blues loop</div>';";
  it('is caught when it takes out every sound call of a music program', () => {
    expect(droppedCapabilities('Build a blues music loop with piano, bass, and drums', BLUES, gutted)).toEqual(['sound']);
  });

  it('is not caught when it keeps some of them, or for a question', () => {
    const kept = "const midi = await navigator.requestMIDIAccess();\nconst output = [...midi.outputs.values()][0];\noutput.send([0x90, 60, 100]);";
    expect(droppedCapabilities('Build a blues music loop with piano, bass, and drums', BLUES, kept)).toEqual([]);
    expect(droppedCapabilities('Who invented the piano?', BLUES, gutted)).toEqual([]);
  });

  it('covers drawing, controls and motion too', () => {
    const pong = 'const ctx = c.getContext("2d");\ndocument.addEventListener("mousemove", (e) => { y = e.clientY; });\nfunction loop() { ctx.fillRect(0, y, 5, 40); requestAnimationFrame(loop); }\nloop();';
    expect(droppedCapabilities('Make a single-player Pong game', pong, 'speak("Pong!");\ndocument.body.textContent = "Pong";')).toEqual(['drawing', 'controls', 'motion']);
  });
});
