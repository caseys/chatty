import { describe, expect, it } from 'vitest';
import { callUncalledFunctions, exposeFunctionsToInlineHandlers, inspectExecutableCode } from '../src/tools/javascript-runtime.ts';

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

  it('runs bare HTML with a script instead of speaking it', () => {
    const out = inspectExecutableCode('<canvas id="c" width="80" height="60"></canvas>\n\n<script>\nconst ctx = document.getElementById("c").getContext("2d");\nctx.fillRect(0, 0, 10, 10);\n</script>');
    expect(out.isProse).toBe(false);
    expect(out.code).toContain('<canvas id=\\"c\\"');
    expect(out.code).toContain('ctx.fillRect(0, 0, 10, 10);');
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

describe('syntax errors are not hidden', () => {
  it('runs the whole program when the part that would be cut off is code', () => {
    const broken = 'const a = 1;\nout.send([1, 2);\nconst b = 2;\nspeak("done");';
    const out = inspectExecutableCode(broken);
    expect(out.isProse).toBe(false);
    expect(out.code).toContain('speak("done")');
  });
});

describe('inline handlers in written HTML', () => {
  it('makes top-level functions global only when the HTML calls them inline', () => {
    const withHandler = exposeFunctionsToInlineHandlers('function calc() {}\nconst reset = () => {};\ndocument.write(\'<button onclick="calc()">Go</button>\');');
    expect(withHandler).toContain('try { window.calc = calc; } catch {}');
    expect(withHandler).toContain('try { window.reset = reset; } catch {}');
    const without = 'function calc() {}\ncalc();';
    expect(exposeFunctionsToInlineHandlers(without)).toBe(without);
  });
});

describe('other code fences small models use', () => {
  it.each([
    ['Javascript """', '"""'],
    ['"""javascript', '"""'],
    ["'''js", "'''"],
    ['~~~', '~~~'],
  ])('runs code wrapped as %s ... %s', (open, close) => {
    const out = inspectExecutableCode(`Here you go:\n${open}\nconst total = 2 * 3;\nspeak("Total " + total);\n${close}`);
    expect(out.isProse).toBe(false);
    expect(out.code).toContain('const total = 2 * 3;');
    expect(out.code).not.toMatch(/"""|'''|~~~/);
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

  it('cuts a block of lines repeated over and over, keeping the first copy', async () => {
    const { repetitionCutIndex } = await import('../src/core/orchestrator.ts');
    const block = 'inputTotal.addEventListener("input", () => {\n  calculate();\n});\n\n';
    const text = `const inputTotal = document.getElementById("total");\n${block.repeat(4)}inputTotal.add`;
    expect(text.slice(0, repetitionCutIndex(text))).toBe(
      'const inputTotal = document.getElementById("total");\ninputTotal.addEventListener("input", () => {\n  calculate();\n});\n'
    );
  });

  it('leaves normal code alone', async () => {
    const { repetitionCutIndex, EXAMPLE_TURNS } = await import('../src/core/orchestrator.ts');
    // Checked as the reply streams in, like the real guard
    for (const turn of EXAMPLE_TURNS.filter((t) => t.role === 'assistant')) {
      for (let end = 40; end <= turn.content.length + 40; end += 40) {
        expect(repetitionCutIndex(turn.content.slice(0, end))).toBe(-1);
      }
    }
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

describe('WebLLM thinking filter', () => {
  it('holds back a leading <think> block and passes everything else through', async () => {
    const { withoutThinking } = await import('../src/runtimes/webllm-provider.ts');
    expect(withoutThinking('<thi')).toBeNull();
    expect(withoutThinking('<think>planning the answer')).toBeNull();
    expect(withoutThinking('<think>planning</think>\n\nspeak("Hi");')).toBe('speak("Hi");');
    expect(withoutThinking('speak("Hi");')).toBe('speak("Hi");');
    expect(withoutThinking('<b>bold</b>')).toBe('<b>bold</b>');
  });
});

describe('echo guard', () => {
  it('only a stop word counts when speech overlapped Chatty speaking', async () => {
    const { classifyTranscript } = await import('../src/core/orchestrator.ts');
    expect(classifyTranscript('Here is a red circle on your screen.', true, true)).toBe('ignore');
    expect(classifyTranscript('Here is a red circle on your screen.', false, true)).toBe('ignore');
    expect(classifyTranscript('Stop!', true, true)).toBe('stop');
    expect(classifyTranscript('Draw a dog', false, false)).toBe('submit');
  });
});

describe('syntax error lines', () => {
  it('finds the line of a syntax error, and nothing for code that parses', async () => {
    const { syntaxErrorLine } = await import('../src/tools/javascript-runtime.ts');
    expect(await syntaxErrorLine("const a = 1;\nout.send(['bass', 'D', beat + beat);\nconst b = 2;")).toBe(2);
    expect(await syntaxErrorLine('const a = await fetch("x");\nreturn a;')).toBeUndefined();
  });
});
