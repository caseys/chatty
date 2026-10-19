import { describe, expect, it } from 'vitest';
import { callUncalledFunctions, inspectExecutableCode } from '../src/tools/javascript-runtime.ts';

describe('running code the model wrapped or forgot to call', () => {
  it('runs a fenced block after an explanation, speaking the explanation', () => {
    const out = inspectExecutableCode('Sure! Here is a red circle:\n```javascript\nroot.innerHTML = "<b>hi</b>";\n```\nEnjoy!');
    expect(out.isProse).toBe(false);
    expect(out.code).toBe('speak("Sure! Here is a red circle");\nroot.innerHTML = "<b>hi</b>";');
  });

  it('does not speak explanations that talk about code', () => {
    const out = inspectExecutableCode("Here's the JavaScript code:\n```js\nspeak(\"Done\");\n```");
    expect(out.code).toBe('speak("Done");');
  });

  it('turns an html block into markup plus its scripts', () => {
    const out = inspectExecutableCode('```html\n<button id="b">Go</button>\n<script>document.getElementById("b").onclick = () => speak("hi");</script>\n```');
    expect(out.isProse).toBe(false);
    expect(out.code).toContain('document.body.insertAdjacentHTML("beforeend", "<button id=\\"b\\">Go</button>");');
    expect(out.code).toContain('document.getElementById("b").onclick');
  });

  it('runs unfenced code between explanations', () => {
    const out = inspectExecutableCode('I will draw it now.\nconst c = document.createElement("canvas");\nroot.appendChild(c);\nThis creates a canvas.');
    expect(out.isProse).toBe(false);
    expect(out.code).toBe('speak("I will draw it now.");\nconst c = document.createElement("canvas");\nroot.appendChild(c);');
  });

  it('calls a drawing function nothing calls', () => {
    const code = 'function helper() { return 1; }\nfunction drawScene() {\n  helper();\n}';
    expect(callUncalledFunctions(code)).toBe(`${code}\nawait drawScene();`);
    expect(callUncalledFunctions('function go() {}\ngo();')).toBe('function go() {}\ngo();');
    // Used as an event handler: left alone
    expect(callUncalledFunctions('function onTap() {}\nroot.onclick = onTap;')).toBe('function onTap() {}\nroot.onclick = onTap;');
    expect(callUncalledFunctions('const start = () => speak("x");')).toBe('const start = () => speak("x");\nawait start();');
  });

  it('still treats chat as prose', () => {
    expect(inspectExecutableCode('Sure, thanks').isProse).toBe(true);
    expect(inspectExecutableCode('I am doing well today, thanks for asking!').isProse).toBe(true);
  });
});

describe('repeat-loop guard', () => {
  it('cuts a line repeated over and over, keeping the first copy', async () => {
    const { repetitionCutIndex } = await import('../src/core/orchestrator.ts');
    const text = 'Hello there.\nLoving Ash\nLoving Ash\nLoving Ash\nLoving Ash\nLov';
    expect(text.slice(0, repetitionCutIndex(text))).toBe('Hello there.\nLoving Ash');
    const inline = 'I love you! I love you! I love you! I love you! I lo';
    expect(inline.slice(0, repetitionCutIndex(inline))).toBe('I love you! ');
  });

  it('leaves normal code alone', async () => {
    const { repetitionCutIndex } = await import('../src/core/orchestrator.ts');
    expect(repetitionCutIndex('function a() {\n  if (x) {\n    y();\n  }\n}\n}\n}\n}')).toBe(-1);
    expect(repetitionCutIndex('ctx.lineTo(1, 2);\nctx.lineTo(3, 4);\nctx.lineTo(5, 6);\nctx.lineTo(7, 8);')).toBe(-1);
  });
});

describe('spoken input filtering', () => {
  it('drops "Thank you" and keeps busy-time interruptions deliberate', async () => {
    const { classifyTranscript } = await import('../src/core/orchestrator.ts');
    expect(classifyTranscript('Thank you.', false)).toBe('ignore');
    expect(classifyTranscript('thank you', true)).toBe('ignore');
    expect(classifyTranscript('Thank you, now draw a cat', false)).toBe('submit');
    expect(classifyTranscript('...', false)).toBe('ignore');
    expect(classifyTranscript('Hello', false)).toBe('submit');
    // While the assistant is busy: one stray word is ignored, stop words stop it, requests replace it
    expect(classifyTranscript('Hmm.', true)).toBe('ignore');
    expect(classifyTranscript('Stop!', true)).toBe('stop');
    expect(classifyTranscript('wait please', true)).toBe('stop');
    expect(classifyTranscript('Draw a dog instead', true)).toBe('submit');
    expect(classifyTranscript('Zeichne einen Hund', true)).toBe('submit');
  });
});
