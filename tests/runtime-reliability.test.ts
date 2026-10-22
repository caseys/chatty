// @vitest-environment jsdom
// @ts-expect-error jsdom ships no type declarations here
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { JavascriptRuntime, registersHandlers } from '../src/tools/javascript-runtime.ts';

type Win = Window & typeof globalThis & { root: HTMLElement; out: any; start: number; __chattyHasVisual(): boolean };

// Loads the real sandbox runner page; its host (window.parent) is itself, so posts arrive as messages
function loadRunner(): { win: Win; posted: any[] } {
  const runtime = new JavascriptRuntime();
  const iframe = (runtime as unknown as { ensureIframe(): HTMLIFrameElement }).ensureIframe();
  const html = iframe.srcdoc;
  iframe.remove();
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
  const win = dom.window as unknown as Win;
  const posted: any[] = [];
  win.addEventListener('message', (e: MessageEvent) => posted.push(e.data));
  return { win, posted };
}
// The page gives a program its `out` when it runs one
async function programOut(win: Win) {
  win.postMessage({ type: 'execute', id: 'x', code: 'window.testOut = out;' }, '*');
  await wait(20);
  return (win as any).testOut;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runner reliability', () => {
  let win: Win;
  afterEach(() => win?.close());

  it('does not count an empty stand-in as visual output, but does once filled', () => {
    ({ win } = loadRunner());
    expect(win.__chattyHasVisual()).toBe(false);
    const el = win.document.getElementById('missing')!;
    expect(win.__chattyHasVisual()).toBe(false);
    el.textContent = 'hi';
    expect(win.__chattyHasVisual()).toBe(true);
  });

  it('flags a value that is the bad token, not words in ordinary text', async () => {
    // Only a program's first such value is reported, so each text gets its own page
    const reported = async (text: string) => {
      const { win: w, posted } = loadRunner();
      win = w;
      const el = w.document.createElement('div');
      w.document.body.appendChild(el);
      el.textContent = text;
      await wait(5);
      w.close();
      return posted.some((m) => m.type === 'program_error');
    };
    for (const ok of ['Infinity War', 'undefined behaviour is nasty', 'Movies: Infinity War', 'NaNa']) {
      expect(await reported(ok), ok).toBe(false);
    }
    for (const bad of ['Total: NaN', 'undefined', 'Score: Infinity', 'x = undefined', '$NaN', 'NaN%']) {
      expect(await reported(bad), bad).toBe(true);
    }
  });

  it('registersHandlers sees event wiring, not comments', () => {
    expect(registersHandlers("b.addEventListener('click', f)")).toBe(true);
    expect(registersHandlers('b.onclick = f')).toBe(true);
    expect(registersHandlers('<button onchange="f()">')).toBe(true);
    expect(registersHandlers('// b.addEventListener(\nlet x = 1')).toBe(false);
  });

  it('the smoke pass uses every control and reports an error thrown inside a handler', async () => {
    let posted: any[];
    ({ win, posted } = loadRunner());
    const d = win.document;
    const btn = d.createElement('button');
    const input = d.createElement('input');
    input.type = 'number';
    d.body.append(btn, input);
    let seen = '';
    input.addEventListener('input', () => (seen = input.value));
    btn.addEventListener('click', () => {
      throw new Error('boom in handler');
    });
    win.postMessage({ type: 'smoke' }, '*');
    await wait(450);
    expect(seen).toBe('5');
    expect(posted.some((m) => m.type === 'smoke_done')).toBe(true);
    const err = posted.find((m) => m.type === 'program_error');
    expect(err?.message).toContain('boom in handler');
  });
});

describe('real browser interfaces in the sandbox', () => {
  it('sends alert() messages to the chat, as speak() does', async () => {
    const { win, posted } = loadRunner();
    win.postMessage({ type: 'execute', id: 'a', code: 'alert("Done!");' }, '*');
    await wait(30);
    expect(posted.some((m) => m.type === 'speak' && m.text === 'Done!')).toBe(true);
    win.close();
  });

  it('says console.log() messages too, during the run and from a timer after it', async () => {
    const { win, posted } = loadRunner();
    win.postMessage({ type: 'execute', id: 'l', code: 'console.log("Total:", 42); setTimeout(() => console.log({ done: true }), 10);' }, '*');
    await wait(60);
    const said = posted.filter((m) => m.type === 'speak').map((m) => m.text);
    expect(said).toEqual(['Total: 42', '{"done":true}']);
    win.close();
  });
});

describe('adapting what programs do in the page', () => {
  it('adds px to a bare number given as a CSS length', async () => {
    const { win } = loadRunner();
    win.postMessage({ type: 'execute', id: 'p', code: 'const d = document.createElement("div");\nd.style.left = 42;\nd.style.width = "10";\nd.style.opacity = 0.5;\ndocument.body.appendChild(d);\nwindow.__d = d;' }, '*');
    await wait(30);
    const d = (win as any).__d as HTMLElement;
    expect(d.style.left).toBe('42px');
    expect(d.style.width).toBe('10px');
    expect(d.style.opacity).toBe('0.5');
    win.close();
  });

  it('adds to the card what was made to be seen but never added, when the card shows nothing', async () => {
    const { win } = loadRunner();
    win.postMessage({ type: 'execute', id: 'o', code: 'const ball = document.createElement("div");\nball.style.background = "red";\nconst c = document.createElement("canvas");\nconst scratch = document.createElement("span");\nwindow.__made = [ball, c, scratch];' }, '*');
    await wait(30);
    expect(((win as any).__made as HTMLElement[])[0].isConnected).toBe(false); // not at once
    await wait(700);
    const [ball, c, scratch] = (win as any).__made as HTMLElement[];
    expect(ball.isConnected).toBe(true);
    expect(c.isConnected).toBe(true);
    expect(scratch.isConnected).toBe(false);
    win.close();
  });

  it('runs a callback once a frame, however often it is asked for before its frame', async () => {
    const { win } = loadRunner();
    win.postMessage({ type: 'execute', id: 'f', code: 'window.__runs = 0;\nfunction tick() { window.__runs++; }\nconst a = requestAnimationFrame(tick);\nconst b = requestAnimationFrame(tick);\nwindow.__same = a === b;' }, '*');
    await wait(120);
    expect((win as any).__same).toBe(true);
    expect((win as any).__runs).toBe(1);
    win.close();
  });
});

describe('leaving off-page what is meant to stay off-page', () => {
  it('attaches nothing when the card already shows something (a buffer canvas, a sprite)', async () => {
    const { win } = loadRunner();
    win.postMessage({ type: 'execute', id: 'b', code: 'const shown = document.createElement("div");\nshown.textContent = "Score: 0";\ndocument.body.appendChild(shown);\nconst buffer = document.createElement("canvas");\nconst sprite = document.createElement("img");\nwindow.__off = [buffer, sprite];' }, '*');
    await wait(750);
    const [buffer, sprite] = (win as any).__off as HTMLElement[];
    expect(buffer.isConnected).toBe(false);
    expect(sprite.isConnected).toBe(false);
    win.close();
  });

  it('schedules a frame again after it was cancelled', async () => {
    const { win } = loadRunner();
    win.postMessage({ type: 'execute', id: 'c', code: 'window.__runs = 0;\nfunction loop() { window.__runs++; }\nconst a = requestAnimationFrame(loop);\ncancelAnimationFrame(a);\nrequestAnimationFrame(loop);' }, '*');
    await wait(150);
    expect((win as any).__runs).toBe(1);
    win.close();
  });
});

describe('undefined where a browser call needs a value', () => {
  it('is the program error, like NaN', async () => {
    const { win, posted } = loadRunner();
    win.postMessage({ type: 'execute', id: 'u', code: 'const d = document.createElement("div");\nd.setAttribute("title", undefined);' }, '*');
    await wait(40);
    const result = posted.find((m) => m.type === 'result');
    expect(result.success).toBe(false);
    expect(result.error).toContain('setAttribute');
    win.close();
  });
});

describe('a sound the program never made', () => {
  it('plays a note on play() instead of failing', async () => {
    const { win, posted } = loadRunner();
    win.postMessage({ type: 'execute', id: 's', code: 'document.getElementById("sound").play();\nspeak("Played.");', idKinds: { sound: 'media' } }, '*');
    await wait(60);
    const result = posted.find((m) => m.type === 'result');
    expect(result.success).toBe(true);
    expect(posted.some((m) => m.type === 'imagined' && /no such sound/.test(m.text))).toBe(true);
    win.close();
  });
});

describe('an id the program checks for itself', () => {
  let win: Win;
  afterEach(() => win?.close());

  it('gets the real answer, null, where a stand-in would hide the missing element from the program that makes it', async () => {
    ({ win } = loadRunner());
    win.root.innerHTML = '<p id="startBtn">go</p>';
    win.postMessage(
      {
        type: 'execute',
        id: 'c',
        code: "window.__overlay = document.getElementById('overlay');\nwindow.__other = document.getElementById('other');\nwindow.__slip = document.getElementById('startbtn');",
        idChecked: ['overlay', 'startbtn'],
      },
      '*'
    );
    await wait(30);
    const w = win as any;
    expect(w.__overlay).toBeNull();
    // Another id still gets its stand-in, and a sure slip of a real id still finds it
    expect(w.__other?.tagName).toBe('DIV');
    expect(w.__slip?.id).toBe('startBtn');
  });
});

describe('a bare number given as a style value', () => {
  let win: Win;
  afterEach(() => win?.close());

  it('gets px for any property the browser says takes a length but not the number (CSS.supports)', async () => {
    ({ win } = loadRunner());
    // What this browser would answer: border widths take lengths only; line-height takes a number
    (win as any).CSS = {
      supports: (prop: string, value: string) => (value === 'initial' ? true : prop === 'border-top-width' ? /px$/.test(value) : prop === 'line-height' ? true : false),
    };
    win.postMessage({ type: 'execute', id: 'u', code: 'const d = document.createElement("div");\nd.style.borderTopWidth = 3;\nd.style.lineHeight = 1.5;\ndocument.body.appendChild(d);\nwindow.__d = d;' }, '*');
    await wait(30);
    const d = (win as any).__d as HTMLElement;
    expect(d.style.borderTopWidth).toBe('3px');
    expect(d.style.lineHeight).toBe('1.5');
  });
});

describe('a bare number in CSS text gets px, whichever way the CSS is written', () => {
  let win: Win;
  afterEach(() => win?.close());
  const runCode = async (code: string): Promise<{ w: any; posted: any[] }> => {
    const loaded = loadRunner();
    win = loaded.win;
    win.postMessage({ type: 'execute', id: 'c', code }, '*');
    await wait(40);
    return { w: win as any, posted: loaded.posted };
  };

  it('style.setProperty(name, number), as the property does', async () => {
    const { w, posted } = await runCode(`const d = document.createElement('div');\nd.style.setProperty('left', 50);\nd.style.setProperty('width', '100');\nd.style.setProperty('z-index', 10);\nd.style.setProperty('opacity', 0.5);\nwindow.__d = d;`);
    expect(w.__d.style.left).toBe('50px');
    expect(w.__d.style.width).toBe('100px');
    expect(w.__d.style.zIndex).toBe('10');
    expect(w.__d.style.opacity).toBe('0.5');
    expect(posted.filter((m) => m.type === 'imagined').map((m) => m.text)).toEqual(['style.left = 50 (a number) → 50px', 'style.width = 100 (a number) → 100px']);
  });

  it('CSS text: style.cssText, the style setter, and setAttribute("style", …)', async () => {
    const { w } = await runCode(
      `const a = document.createElement('div');\na.style.cssText = 'left: 50; width: 100; opacity: 0.5; top: 0';\nconst b = document.createElement('div');\nb.style = 'top: 20; height: 3em';\nconst c = document.createElement('div');\nc.setAttribute('style', 'height: 30; left: 5px; line-height: 1.5');\nwindow.__a = a; window.__b = b; window.__c = c;`
    );
    expect([w.__a.style.left, w.__a.style.width, w.__a.style.opacity, w.__a.style.top]).toEqual(['50px', '100px', '0.5', '0px']);
    expect([w.__b.style.top, w.__b.style.height]).toEqual(['20px', '3em']);
    expect(w.__c.getAttribute('style')).toBe('height: 30px; left: 5px; line-height: 1.5');
  });

  it('style attributes in markup set through innerHTML, outerHTML and insertAdjacentHTML', async () => {
    const { w } = await runCode(
      `const host = document.createElement('div');\ndocument.body.appendChild(host);\nhost.innerHTML = "<div id='one' style='width: 100; height: 50'></div>";\nhost.insertAdjacentHTML('beforeend', '<div id="two" style="left: 7; z-index: 3"></div>');\nhost.firstChild.outerHTML = '<div id="three" style="top: 9"></div>';\nwindow.__host = host;`
    );
    const styles = [...w.__host.children].map((el: HTMLElement) => el.getAttribute('style'));
    expect(styles).toEqual(['top: 9px', 'left: 7px; z-index: 3']);
  });

  it('the text of a <style> element, and rules in a sheet, leaving line-height, z-index, 0, units and calc() alone', async () => {
    const { w } = await runCode(
      `const s = document.createElement('style');\ns.textContent = '.a { width: 100; line-height: 1.5; z-index: 10; margin: 0; padding: 5px; height: calc(100); font-size: 18 }';\ndocument.head.appendChild(s);\nconst t = document.createElement('div');\nt.innerHTML = '<style>.b { left: 12; opacity: 0.5 }</style><p style="line-height: 2">x</p>';\nwindow.__s = s; window.__t = t;`
    );
    expect(w.__s.textContent).toBe('.a { width: 100px; line-height: 1.5; z-index: 10; margin: 0; padding: 5px; height: calc(100); font-size: 18px }');
    expect(w.__t.querySelector('style').textContent).toBe('.b { left: 12px; opacity: 0.5 }');
    expect(w.__t.querySelector('p').getAttribute('style')).toBe('line-height: 2');
  });
});

describe('round 21: a hex color without #, and text set many times in one go', () => {
  let win: Win;
  afterEach(() => win?.close());

  it('adds the # to hex digits the browser ignores, and leaves real colors and names alone', async () => {
    const loaded = loadRunner();
    win = loaded.win;
    (win as any).CSS = { supports: (_prop: string, value: string) => /^#[0-9a-f]{3,8}$/i.test(value) || /^(?:red|initial)$/.test(value) };
    win.postMessage({ type: 'execute', id: 'h', code: "const d = document.createElement('div');\nd.style.color = '55558B';\nd.style.background = 'red';\ndocument.body.appendChild(d);\nwindow.__d = d;" }, '*');
    await wait(40);
    const imagined = loaded.posted.filter((m) => m.type === 'imagined').map((m) => m.text);
    expect(imagined).toContain("style.color = '55558B' (hex digits without #) → '#55558B'");
    expect(imagined.filter((t: string) => /background/.test(t))).toEqual([]);
  });

  it('notes text replaced three or more times in one go (only the last shows), not text added to', async () => {
    const loaded = loadRunner();
    win = loaded.win;
    win.postMessage({ type: 'execute', id: 'o', code: "const el = document.createElement('div');\nel.id = 'countdown';\ndocument.body.appendChild(el);\nlet n = 5;\nwhile (n > 0) { el.textContent = n; n--; }\nconst list = document.createElement('ul');\ndocument.body.appendChild(list);\nfor (let i = 0; i < 5; i++) list.innerHTML += '<li>' + i + '</li>';" }, '*');
    await wait(60);
    expect((win as any).__chattyOverwrites()).toEqual(["div#countdown's text was set 5 times in a row without waiting, so only the last ('1') shows"]);
  });
});

describe('what the network did', () => {
  let win: Win;
  afterEach(() => win?.close());

  it('notes a reply read right after send(), and a local server that is not there (a live countdown)', async () => {
    const loaded = loadRunner();
    win = loaded.win;
    win.postMessage({ type: 'execute', id: 'n', code: 'var xhr = new XMLHttpRequest();\nxhr.open("GET", "http://127.0.0.1:9/ten_second_countdown", true);\nxhr.send(null);\nif (xhr.status === 200) document.body.textContent = xhr.responseText;' }, '*');
    await wait(1500);
    const facts: string[] = (win as any).__chattyNetwork();
    expect(facts).toContain('xhr.status is read right after send(), before the reply can arrive: read it in xhr.onload');
    expect(facts.some((f) => f.startsWith("XMLHttpRequest to 'http://127.0.0.1:9/ten_second_countdown' got no answer (there is no server at 127.0.0.1:9 on this device"))).toBe(true);
  });

  it('says nothing about a reply read once it has arrived', async () => {
    const loaded = loadRunner();
    win = loaded.win;
    win.postMessage({ type: 'execute', id: 'm', code: 'var xhr = new XMLHttpRequest();\nxhr.open("GET", "http://127.0.0.1:9/x", true);\nxhr.onerror = () => {};\nxhr.send(null);' }, '*');
    await wait(1500);
    expect(((win as any).__chattyNetwork() as string[]).some((f) => f.includes('read right after send'))).toBe(false);
  });
});
