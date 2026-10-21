import { describe, expect, it } from 'vitest';
import { callUncalledFunctions, exposeFunctionsToInlineHandlers, hoistPageScripts, inspectExecutableCode, stripComments } from '../src/tools/javascript-runtime.ts';

describe('running code the model wrapped or forgot to call', () => {
  it('runs a fenced block, saying the talk before and after it with speak()', () => {
    const out = inspectExecutableCode('Sure! Here is a red circle:\n```javascript\nroot.innerHTML = "<b>hi</b>";\n```\nEnjoy!');
    expect(out.isProse).toBe(false);
    // All messages go through speak(): the talk around the code becomes speak() calls
    expect(out.code).toBe('speak("Sure! Here is a red circle.");\nroot.innerHTML = "<b>hi</b>";\nspeak("Enjoy!");');
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

  it('loads a page\'s <script src> first, in order, and keeps a shader or JSON block as markup', () => {
    const out = inspectExecutableCode(
      '```html\n<canvas id="c"></canvas>\n<script type="x-shader/x-vertex" id="vs">void main() { gl_Position = vec4(0.0); }</script>\n<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1"></script>\n<script>new Chart(document.getElementById("c"), {});</script>\n```'
    );
    const load = out.code.indexOf('script.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1"');
    expect(load).toBeGreaterThan(-1);
    expect(out.code.indexOf('await new Promise')).toBeLessThan(out.code.indexOf('new Chart('));
    expect(out.code.indexOf('new Chart(')).toBeGreaterThan(load);
    // The shader stays on the page, for the code to read (and isn't run as JavaScript)
    expect(out.code).toContain('<script type=\\"x-shader/x-vertex\\" id=\\"vs\\">void main()');
    expect(out.code).not.toMatch(/^void main/m);
  });

  it('does not fetch three.js, which comes with Chatty', () => {
    const out = inspectExecutableCode('```html\n<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>\n<script>const scene = new THREE.Scene();</script>\n```');
    expect(out.code).not.toContain('script.src');
    expect(out.code).toContain('new THREE.Scene()');
  });

  it('does not fetch Tone.js, which comes with Chatty, but still fetches other libraries', () => {
    for (const src of ['https://unpkg.com/tone', 'https://cdn.jsdelivr.net/npm/tone@14.7.77/build/Tone.js', 'https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js']) {
      const out = inspectExecutableCode(`\`\`\`html\n<script src="${src}"></script>\n<script>const synth = new Tone.Synth().toDestination();</script>\n\`\`\``);
      expect(out.code, src).not.toContain('script.src');
      expect(out.code, src).toContain('new Tone.Synth()');
    }
    const other = inspectExecutableCode('```html\n<script src="https://cdn.example.com/chart.js"></script>\n<script>new Chart();</script>\n```');
    expect(other.code).toContain('script.src');
  });

  it('runs a speak() written after the closing </script> instead of showing it', () => {
    const out = inspectExecutableCode('<canvas id="c"></canvas>\n<script>\nconst a = 1;\n</script>\n\nspeak("Here it is.");');
    expect(out.code).toBe('document.body.insertAdjacentHTML("beforeend", "<canvas id=\\"c\\"></canvas>");\n\nconst a = 1;\n\nspeak("Here it is.");');
  });

  it('says talk paragraphs between code paragraphs where the model put them', () => {
    const reply = 'Here is your counter.\n\nlet n = 0;\nroot.textContent = n;\n\nNow it counts up every second.\n\nsetInterval(() => { n++; root.textContent = n; }, 1000);';
    expect(inspectExecutableCode(reply).code).toBe(
      'speak("Here is your counter.");\nlet n = 0;\nroot.textContent = n;\nspeak("Now it counts up every second.");\nsetInterval(() => { n++; root.textContent = n; }, 1000);'
    );
  });

  it('runs code written outside the fences, and says only the talk', () => {
    const reply = 'speak("Here is your list.");\nclear();\n\n```html\n<ul><li>Towel</li></ul>\n```\n\nHave a good trip!';
    const code = inspectExecutableCode(reply).code;
    expect(code.startsWith('speak("Here is your list.");\nclear();\n')).toBe(true);
    expect(code.endsWith('speak("Have a good trip!");')).toBe(true);
  });

  it('runs a cut-off fenced program whole, blank lines and all', () => {
    const body = 'const ctx = 1;\n\nfunction play(note) {\n    const o = 1;\n\n    o.type = 2;\n}\n\nfunction loop() {\n    play();\n\n    id = setInterval(loop, 1000); // Loop';
    const code = inspectExecutableCode('speak("Here is a loop.");\n```javascript\n' + body).code;
    // Never empty, and none of the program is said aloud. Cut inside loop() after a whole line:
    // its block is closed, and loop(), which nothing calls (the word in the speak() text is no call), is started
    expect(code).toBe('speak("Here is a loop.");\n' + body + '\n}\nawait loop();');
  });

  it('runs a page written into innerHTML whose template string was never closed', () => {
    const reply = '```javascript\nclear();\ndocument.body.innerHTML = `\n<div>\n  <button id="go">Go</button>\n</div>\n<script>\n  const go = document.getElementById("go");\n  go.addEventListener("click", () => speak("Hi"));\n  function init() { const a = await navigator.requestMIDIAccess(); }\n</script>\n```\nspeak("Here is a button.");';
    const code = inspectExecutableCode(reply).code;
    expect(code).toContain('clear();\ndocument.body.insertAdjacentHTML("beforeend", "<div>');
    expect(code).toContain('const go = document.getElementById("go");');
    expect(code).toContain('speak("Here is a button.");');
    expect(code).not.toContain('<script>');
  });

  it('keeps plain text inside a template string as code', () => {
    const reply = 'root.innerHTML = `<h2>Notes</h2>\n\nWelcome to your notes app\n\n<p>Add one below</p>`;';
    expect(inspectExecutableCode(reply).code).toBe(reply);
  });

  it('runs unfenced code between explanations', () => {
    const out = inspectExecutableCode('I will draw it now.\nconst c = document.createElement("canvas");\nroot.appendChild(c);\nThis creates a canvas.');
    expect(out.isProse).toBe(false);
    expect(out.code).toBe('speak("I will draw it now.");\nconst c = document.createElement("canvas");\nroot.appendChild(c);\nspeak("This creates a canvas.");');
  });

  it('calls a drawing function nothing calls', () => {
    const code = 'function helper() { return 1; }\nfunction drawScene() {\n  helper();\n}';
    expect(callUncalledFunctions(code)).toBe(`${code}\nawait drawScene();`);
    expect(callUncalledFunctions('function go() {}\ngo();')).toBe('function go() {}\ngo();');
    // Used as an event handler: left alone
    expect(callUncalledFunctions('function onTap() {}\nroot.onclick = onTap;')).toBe('function onTap() {}\nroot.onclick = onTap;');
    expect(callUncalledFunctions('const start = () => speak("x");')).toBe('const start = () => speak("x");\nawait start();');
  });

  it('calls a function that only refers to itself (a loop or timer it never starts)', () => {
    const code = 'function playLoop() {\n  out.send(["piano", "C4", 80, 500]);\n  setTimeout(playLoop, 500);\n}';
    expect(callUncalledFunctions(code)).toBe(`${code}\nawait playLoop();`);
    const arrow = 'const tick = () => { requestAnimationFrame(tick); };';
    expect(callUncalledFunctions(arrow)).toBe(`${arrow}\nawait tick();`);
    // Started from outside its body: left alone
    const started = 'function playLoop() {\n  setTimeout(playLoop, 500);\n}\nplayLoop();';
    expect(callUncalledFunctions(started)).toBe(started);
  });

  it('calls the one function nothing refers to when it calls the others, whatever it is named', () => {
    // The shape of Qwen3 0.6B's Pong: a loop that runs update and draw, never started
    const pong = [
      'const canvas = document.createElement("canvas");',
      'document.body.appendChild(canvas);',
      'const ctx = canvas.getContext("2d");',
      'function updateBall() {',
      '  ball.x -= ball.speed;',
      '}',
      'function draw() {',
      '  ctx.fillRect(100, 100, 100, 10);',
      '}',
      'function gameLoop() {',
      '  updateBall();',
      '  draw();',
      '  requestAnimationFrame(gameLoop);',
      '}',
    ].join('\n');
    expect(callUncalledFunctions(pong)).toBe(`${pong}\nawait gameLoop();`);
    // The word in a string (an element's id, speech) is no reference to the function
    const countdown = 'document.getElementById("countdown").textContent = 10;\nfunction countdown() {\n  document.getElementById("countdown").textContent = 9;\n  setTimeout(countdown, 1000);\n}';
    expect(callUncalledFunctions(countdown)).toBe(`${countdown}\nawait countdown();`);
    // A handler (named in an inline handler or a listener) is referred to: not the head of the calls
    const tip = 'function formatMoney() { return 1; }\nfunction calculate() {\n  formatMoney();\n}\ndocument.body.innerHTML = \'<button onclick="calculate()">Go</button>\';';
    expect(callUncalledFunctions(tip)).toBe(tip);
    // Two functions nothing refers to, or one that calls none of the others
    const two = 'function a() { b(); }\nfunction b() {}\nfunction c() { b(); }';
    expect(callUncalledFunctions(two)).toBe(two);
    const lone = 'function onKey() { return 1; }\nfunction unrelated() { return 2; }\nconst handlers = { onKey };';
    expect(callUncalledFunctions(lone)).toBe(lone);
  });

  it('does not call a function a string calls: inline handlers of every shape, and setAttribute', () => {
    const shapes = [
      'document.body.innerHTML = `<form onsubmit="return checkAnswer()"><button>Go</button></form>`;\nfunction checkAnswer() { return false; }',
      'document.body.innerHTML = \'<button onclick="score++; update()">+</button>\';\nfunction update() { show(); }\nfunction show() {}',
      "const b = document.createElement('button');\nb.setAttribute('onclick', 'rollDice()');\ndocument.body.appendChild(b);\nfunction rollDice() { show(); }\nfunction show() {}",
      'document.body.innerHTML = `<button onclick="if (confirm(\'Reset?\')) resetScores()">Reset</button>`;\nfunction resetScores() { show(); }\nfunction show() {}',
    ];
    for (const code of shapes) expect(callUncalledFunctions(code), code).toBe(code);
    // The word alone, or a call in a comment, is still no use of it
    const word = 'document.getElementById("countdown").textContent = 10;\nfunction countdown() {\n  setTimeout(countdown, 1000);\n}';
    expect(callUncalledFunctions(word)).toBe(`${word}\nawait countdown();`);
  });

  it('runs a <script> in markup the program sets as part of the program, so its functions are called too', () => {
    // The real program from Qwen3 0.6B for "Draw a smiling cat face": a script that only defines its functions
    const cat = [
      'speak("Draw a smiling cat face.");',
      'document.body.innerHTML = `',
      '  <canvas id="catCanvas" width="200" height="200"></canvas>',
      '  <script>',
      "    const canvas = document.getElementById('catCanvas');",
      "    const ctx = canvas.getContext('2d');",
      '    function drawCat() {',
      "      ctx.fillStyle = 'rgb(255, 255, 255)';",
      '      ctx.fillRect(50, 100, 100, 60);',
      '    }',
      '    function update() {',
      '      drawCat();',
      '      requestAnimationFrame(update);',
      '    }',
      '  </script>`;',
    ].join('\n');
    const fixed = hoistPageScripts(cat);
    expect(fixed.hoisted).toBe(1);
    expect(fixed.code).toBe(
      [
        'speak("Draw a smiling cat face.");',
        'document.body.innerHTML = `',
        '  <canvas id="catCanvas" width="200" height="200"></canvas>',
        '  `;',
        "    const canvas = document.getElementById('catCanvas');",
        "    const ctx = canvas.getContext('2d');",
        '    function drawCat() {',
        "      ctx.fillStyle = 'rgb(255, 255, 255)';",
        '      ctx.fillRect(50, 100, 100, 60);',
        '    }',
        '    function update() {',
        '      drawCat();',
        '      requestAnimationFrame(update);',
        '    }',
      ].join('\n')
    );
    const prepared = inspectExecutableCode(cat);
    expect(prepared.code.endsWith('requestAnimationFrame(update);\n    }\nawait update();')).toBe(true);
    expect(prepared.called).toEqual(['update']);
    expect(prepared.hoistedScripts).toBe(1);
  });

  it('leaves a script with a source, escapes or placeholders, one inside a function, and other strings, alone', () => {
    const sourced = 'document.body.innerHTML = `<script src="a.js"></script>`;';
    expect(hoistPageScripts(sourced).hoisted).toBe(0);
    const placeholder = 'const n = 3;\ndocument.body.innerHTML = `<script>function draw() { return ${n}; }</script>`;';
    expect(hoistPageScripts(placeholder).hoisted).toBe(0);
    const inFunction = 'function show() {\n  document.body.innerHTML = `<script>go();</script>`;\n}\nshow();';
    expect(hoistPageScripts(inFunction).hoisted).toBe(0);
    const text = 'const note = "<script>function draw() { return 1; }</script>";\nspeak(note);';
    expect(hoistPageScripts(text).hoisted).toBe(0);
    const empty = 'document.body.innerHTML = `<p>hi</p><script></script>`;';
    expect(hoistPageScripts(empty).hoisted).toBe(0);
    // A data block or a template is read, not run: it stays in the markup
    const data = 'document.body.innerHTML = `<script type="application/json" id="data">{"a": 1}</script><script type="text/template" id="row"><li>x</li></script>`;';
    expect(hoistPageScripts(data).hoisted).toBe(0);
    const mixed = 'document.body.innerHTML = `<script type="application/json" id="data">{"a": 1}</script><script type="text/javascript">run();</script>`;';
    expect(hoistPageScripts(mixed)).toEqual({ code: 'document.body.innerHTML = `<script type="application/json" id="data">{"a": 1}</script>`;\nrun();', hoisted: 1 });
    // Modules can't be moved (they import)
    expect(hoistPageScripts('document.body.innerHTML = `<script type="module">go();</script>`;').hoisted).toBe(0);
    // Several, in order; the markup keeps the rest
    const two = 'document.body.insertAdjacentHTML("beforeend", "<b>x</b><script>a();</script><script>b();</script>");';
    expect(hoistPageScripts(two).code).toBe('document.body.insertAdjacentHTML("beforeend", "<b>x</b>");\na();\nb();');
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
    const { repetitionCutIndex } = await import('../src/core/orchestrator.ts');
    const program = [
      'const out = (await navigator.requestMIDIAccess()).outputs.values().next().value;',
      'const bpm = 90;',
      'const beat = 60000 / bpm;',
      "const theme = ['D4', 'F4', 'A4', 'G4', 'F4', 'E4', 'D4', 'A3'];",
      'let start = performance.now() + 100;',
      'function playTheme() {',
      '  for (let i = 0; i < theme.length; i++) {',
      '    const t = start + i * beat;',
      "    out.send(['organ', theme[i], 80, beat], t);",
      "    if (i % 4 === 0) out.send(['strings', 'D minor', 60, 4 * beat], t);",
      "    out.send(['drums', i % 2 ? 'snare' : 'kick', 90], t);",
      '  }',
      '  start += theme.length * beat;',
      '}',
      'playTheme();',
      'setInterval(playTheme, theme.length * beat);',
      'speak("Here it is, on repeat.");',
    ].join('\n');
    // Checked as the reply streams in, like the real guard
    for (let end = 40; end <= program.length + 40; end += 40) {
      expect(repetitionCutIndex(program.slice(0, end))).toBe(-1);
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

describe('broken model downloads', () => {
  it('recognizes the error a broken stored copy gives, and nothing else', async () => {
    const { isBrokenCacheError } = await import('../src/runtimes/webllm-provider.ts');
    expect(isBrokenCacheError(new Error('Tensor-cache record range [0, 393216) exceeds shard size 0'))).toBe(true);
    expect(isBrokenCacheError(new Error('Failed to get GPU adapter'))).toBe(false);
  });
});

describe('repairing a broken model download', () => {
  it('deletes only the stored pieces whose size does not match the index', async () => {
    const { dropBrokenPieces, modelFilesUrl } = await import('../src/runtimes/webllm-provider.ts');
    const base = modelFilesUrl('https://huggingface.co/mlc-ai/Some-Model-MLC');
    expect(base).toBe('https://huggingface.co/mlc-ai/Some-Model-MLC/resolve/main/');
    const store = new Map<string, Response>([
      [`${base}tensor-cache.json`, Response.json({ records: [
        { dataPath: 'params_shard_0.bin', nbytes: 8 },
        { dataPath: 'params_shard_1.bin', nbytes: 4 },
        { dataPath: 'params_shard_2.bin', nbytes: 4 },
      ] })],
      [`${base}params_shard_0.bin`, new Response(new Uint8Array(8))],
      [`${base}params_shard_1.bin`, new Response(new Uint8Array(0))],
      // params_shard_2.bin was never downloaded
    ]);
    const cache = {
      match: async (url: string) => store.get(url)?.clone(),
      delete: async (url: string) => store.delete(url),
    } as unknown as Cache;
    expect(await dropBrokenPieces(cache, base)).toBe(1);
    expect([...store.keys()].map((k) => k.split('/').pop())).toEqual(['tensor-cache.json', 'params_shard_0.bin']);
  });
});

describe('await inside a function that is not async', () => {
  it('makes that function async, keeping every line where it was', async () => {
    const { makeAwaitingFunctionsAsync } = await import('../src/tools/javascript-runtime.ts');
    const fix = makeAwaitingFunctionsAsync;
    expect(await fix('function play() {\n  const out = (await navigator.requestMIDIAccess()).outputs.values().next().value;\n}\nplay();')).toBe(
      'async function play() {\n  const out = (await navigator.requestMIDIAccess()).outputs.values().next().value;\n}\nplay();'
    );
    expect(await fix('setTimeout(() => {\n  const r = await fetch("x");\n}, 10);')).toBe('setTimeout(async () => {\n  const r = await fetch("x");\n}, 10);');
    expect(await fix('items.forEach(item => {\n  await save(item);\n});')).toBe('items.forEach(async item => {\n  await save(item);\n});');
    expect(await fix('function loop() {\n  for (let i = 0; i < 3; i++) {\n    if (i) {\n      await wait(1);\n    }\n  }\n}')).toBe(
      'async function loop() {\n  for (let i = 0; i < 3; i++) {\n    if (i) {\n      await wait(1);\n    }\n  }\n}'
    );
    expect(await fix('const o = {\n  go() {\n    await x();\n  },\n};')).toBe('const o = {\n  async go() {\n    await x();\n  },\n};');
    // Two functions, both fixed
    expect(await fix('function a() { await x(); }\nfunction b() { await y(); }')).toBe('async function a() { await x(); }\nasync function b() { await y(); }');
  });

  it('leaves code that already parses alone, including top-level await', async () => {
    const { makeAwaitingFunctionsAsync } = await import('../src/tools/javascript-runtime.ts');
    const ok = 'const out = (await navigator.requestMIDIAccess()).outputs.values().next().value;\nasync function f() { await g(); }';
    expect(await makeAwaitingFunctionsAsync(ok)).toBe(ok);
    const broken = 'const a = ;';
    expect(await makeAwaitingFunctionsAsync(broken)).toBe(broken);
  });
});

describe('const that a program changes', () => {
  it('becomes let, keeping columns and lines; other consts stay', async () => {
    const { letReassignedConsts } = await import('../src/tools/javascript-runtime.ts');
    const code = 'const x = 50, y = 50;\nconst dx = 3;\nfunction f() { x += dx; y++; }\nconst [a, b] = [1, 2];\na = 3;';
    expect(await letReassignedConsts(code)).toBe('let   x = 50, y = 50;\nconst dx = 3;\nfunction f() { x += dx; y++; }\nlet   [a, b] = [1, 2];\na = 3;');
    expect(await letReassignedConsts('const a = 1;\nspeak(a);')).toBe('const a = 1;\nspeak(a);');
  });
});

describe('stripping comments', () => {
  it('drops comment lines and trailing comments, keeping // inside strings and templates', () => {
    const code = '// Setup\nconst url = "https://x.org"; // the site\n/* block\n   comment */\nconst t = `a // b`;\nspeak(t);';
    expect(stripComments(code)).toBe('const url = "https://x.org";\nconst t = `a // b`;\nspeak(t);');
  });

  it('leaves code that does not parse alone', () => {
    const code = 'function a() { // open\n  play();';
    expect(stripComments(code)).toBe(code);
  });
});
