// @vitest-environment jsdom
// @ts-expect-error jsdom ships no type declarations here
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { JavascriptRuntime } from '../src/tools/javascript-runtime.ts';
import { errorHint } from '../src/core/error-hints.ts';
import { missingStepsError, onlyTransportMissing, withTransportStart, type SoundSetup } from '../src/core/sound-setup.ts';

// The sandbox runner page loaded in its own window, with a fake Tone (the shapes Tone.js has that
// matter here: classes that connect or start, a Transport that schedules and starts) and a fake
// shared audio context, so a program's calls can be watched without any sound

type Internals = { buildRunnerHtml(trial: boolean, host?: string, token?: string): string };

function loadRunner(prepare?: (win: any) => void): { win: any; posted: any[] } {
  const runtime = new JavascriptRuntime();
  const html = (runtime as unknown as Internals).buildRunnerHtml(false);
  // (a page address of its own: a library's script is another address on the same origin)
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/page.html', beforeParse: prepare });
  const posted: any[] = [];
  dom.window.addEventListener('message', (e: MessageEvent) => posted.push(e.data));
  return { win: dom.window, posted };
}

function fakeTone(win: any): void {
  const Destination = { name: 'destination' };
  const Transport = {
    state: 'stopped',
    schedule() {},
    scheduleRepeat() {},
    scheduleOnce() {},
    start() {
      this.state = 'started';
      return this;
    },
  };
  class Node {
    connect(target: unknown) {
      return target;
    }
    toDestination() {
      this.connect(Destination);
      return this;
    }
  }
  class Synth extends Node {
    triggerAttack() {}
    triggerAttackRelease() {}
  }
  class PolySynth extends Synth {}
  class Filter extends Node {}
  class Loop {
    callback: unknown;
    constructor(callback: unknown) {
      this.callback = callback;
    }
    start() {
      Transport.scheduleRepeat();
      return this;
    }
    get state() {
      return 'started';
    }
  }
  class Player extends Node {
    start() {
      return this;
    }
    get state() {
      return 'stopped';
    }
  }
  // Tone.connect() and Tone.connectSeries() join parts through their outputs, not through the part's own connect()
  const connect = (from: any, to: any) => {
    from.routedTo = to;
    return from;
  };
  const connectSeries = (...nodes: any[]) => {
    for (let i = 0; i + 1 < nodes.length; i++) connect(nodes[i], nodes[i + 1]);
    return nodes[0];
  };
  win.Tone = { Transport, Destination, Synth, PolySynth, Filter, Loop, Player, connect, connectSeries, now: () => 0 };
}

async function run(win: any, posted: any[], code: string): Promise<any> {
  const id = `run${posted.length}`;
  win.postMessage({ type: 'execute', id, code }, '*');
  await vi.waitFor(() => expect(posted.some((m) => m.type === 'result' && m.id === id)).toBe(true), { timeout: 2000 });
  return win.__chattySetup() as SoundSetup;
}

const BLUES = [
  'const synth = new Tone.PolySynth(Tone.Synth).toDestination();',
  'const loop = new Tone.Loop((time) => {',
  '  synth.triggerAttackRelease(["G3", "Bb3", "D4"], "8n", time);',
  '}, "4n");',
  'loop.start(0);',
].join('\n');

describe('what a program set up for sound', () => {
  it('names Tone.Transport when a loop was started and the Transport never was', async () => {
    const { win, posted } = loadRunner(fakeTone);
    const setup = await run(win, posted, BLUES);
    expect(setup.tone).toMatchObject({ transportStarted: false, scheduled: 1, transport: 'stopped' });
    expect(missingStepsError(setup)).toBe('Tone.Loop was started, but Tone.Transport never was: call Tone.Transport.start().');
    win.close();
  });

  it('says nothing about a program that starts its Transport, however it gets there', async () => {
    const { win, posted } = loadRunner(fakeTone);
    expect(missingStepsError(await run(win, posted, `${BLUES}\nTone.Transport.start();`))).toBeNull();
    win.close();
    const again = loadRunner(fakeTone);
    // (the transport reached through another name)
    expect(missingStepsError(await run(again.win, again.posted, `${BLUES}\nconst t = Tone.Transport;\nt.start();`))).toBeNull();
    again.win.close();
  });

  it('counts a Transport that is running from before as started', async () => {
    const { win, posted } = loadRunner((w) => {
      fakeTone(w);
      w.Tone.Transport.state = 'started';
    });
    expect(missingStepsError(await run(win, posted, BLUES))).toBeNull();
    win.close();
  });

  it('names a Tone synth that never reaches the output, and leaves one connected through another node alone', async () => {
    const { win, posted } = loadRunner(fakeTone);
    const loose = await run(win, posted, 'const synth = new Tone.Synth();\nsynth.triggerAttackRelease("C4", "8n");');
    expect(missingStepsError(loose)).toBe('Tone.Synth was never connected to the output: call .toDestination() on it (or connect it to Tone.Destination, directly or through other nodes).');
    expect(missingStepsError(await run(win, posted, 'const synth = new Tone.Synth().toDestination();\nsynth.triggerAttackRelease("C4", "8n");'))).toBeNull();
    const chained = 'const filter = new Tone.Filter().toDestination();\nconst synth = new Tone.PolySynth();\nsynth.connect(filter);\nsynth.triggerAttackRelease("C4", "8n");';
    expect(missingStepsError(await run(win, posted, chained))).toBeNull();
    win.close();
  });

  it('names a Tone source made and never started', async () => {
    const { win, posted } = loadRunner(fakeTone);
    const setup = await run(win, posted, 'const player = new Tone.Player().toDestination();');
    expect(missingStepsError(setup)).toBe('Tone.Player was made but never started: call its start().');
    expect(missingStepsError(await run(win, posted, 'const player = new Tone.Player().toDestination();\nplayer.start();'))).toBeNull();
    win.close();
  });

  const webAudio = (win: any) => {
    const output = { name: 'output' };
    const node = () => ({ connect: (t: unknown) => t, disconnect() {} });
    const context = {
      sampleRate: 48000,
      state: 'running',
      destination: { name: 'real destination' },
      createOscillator: () => ({ ...node(), start() {}, stop() {}, frequency: { value: 440 } }),
      createGain: () => ({ ...node(), gain: { value: 1 } }),
      createBufferSource: () => ({ ...node(), start() {} }),
      createBuffer: () => ({}),
      resume: () => Promise.resolve(),
    };
    win.__chattySharedAudio = () => ({ context, output });
  };

  it('names an oscillator made and never started, and one started but never connected', async () => {
    const { win, posted } = loadRunner(webAudio);
    const unstarted = await run(win, posted, 'const ctx = new AudioContext();\nconst osc = ctx.createOscillator();\nosc.connect(ctx.destination);');
    expect(missingStepsError(unstarted)).toBe('The oscillator was made but never started: call its start().');
    const unconnected = await run(win, posted, 'const ctx = new AudioContext();\nconst osc = ctx.createOscillator();\nosc.start();\nosc.stop(ctx.currentTime + 1);');
    expect(missingStepsError(unconnected)).toBe("The oscillator was never connected to the audio context's destination: connect it with node.connect(audioContext.destination), directly or through other nodes.");
    win.close();
  });

  it('leaves a working Web Audio program alone, through a gain node too', async () => {
    const { win, posted } = loadRunner(webAudio);
    const direct = 'const ctx = new AudioContext();\nconst osc = ctx.createOscillator();\nosc.connect(ctx.destination);\nosc.start();\nosc.stop(ctx.currentTime + 0.5);';
    expect(missingStepsError(await run(win, posted, direct))).toBeNull();
    const viaGain = 'const ctx = new AudioContext();\nconst gain = ctx.createGain();\ngain.connect(ctx.destination);\nconst osc = ctx.createOscillator();\nosc.connect(gain);\nosc.start();';
    expect(missingStepsError(await run(win, posted, viaGain))).toBeNull();
    // The buffer a program makes is no sound part, and a source whose output goes to something untracked is taken as connected
    const buffered = 'const ctx = new AudioContext();\nconst buffer = ctx.createBuffer(1, 10, 48000);\nconst src = ctx.createBufferSource();\nsrc.connect({ not: "a node" });\nsrc.start();';
    expect(missingStepsError(await run(win, posted, buffered))).toBeNull();
    win.close();
  });

  it('names an audio element made and never played, and leaves one with controls or played alone', async () => {
    const { win, posted } = loadRunner();
    expect(missingStepsError(await run(win, posted, "const clip = new Audio('chime.mp3');"))).toBe('The audio element was made but never played: call its play().');
    expect(missingStepsError(await run(win, posted, "const clip = new Audio('chime.mp3');\nclip.play();"))).toBeNull();
    expect(missingStepsError(await run(win, posted, 'document.body.innerHTML = \'<audio src="chime.mp3" controls></audio>\';'))).toBeNull();
    win.close();
  });

  it('keeps what the page says of a program that made no sound at all empty', async () => {
    const { win, posted } = loadRunner(fakeTone);
    const setup = await run(win, posted, 'document.body.innerHTML = "<p>hi</p>";');
    expect(setup.things).toEqual([]);
    expect(missingStepsError(setup)).toBeNull();
    win.close();
  });
});

describe('what Chatty’s libraries say about the program', () => {
  // A library's script is on the page's own origin: its frames say so (the sourceURL below)
  const LIBRARY = 'function toneWarns(text) { console.warn(text); }\n//# sourceURL=http://localhost/assets/tone-global-3fa9.js';

  it('collects the warnings and errors a library prints, and nothing the program prints itself', async () => {
    const { win, posted } = loadRunner();
    win.eval(LIBRARY);
    const setup = await run(
      win,
      posted,
      ['toneWarns("The AudioContext is \\"suspended\\".   Invoke Tone.start() from a user action");', 'console.warn("my own warning");', 'console.error("my own error");', 'console.log("hello");'].join('\n')
    );
    expect(setup.library).toEqual(['Tone.js warned: The AudioContext is "suspended". Invoke Tone.start() from a user action']);
    win.close();
  });

  it('keeps a library’s warning out of what is spoken, and out of a later program', async () => {
    const { win, posted } = loadRunner();
    win.eval(LIBRARY);
    await run(win, posted, 'toneWarns("careful");');
    expect(posted.filter((m) => m.type === 'speak')).toEqual([]);
    expect((await run(win, posted, 'document.body.innerHTML = "ok";')).library).toEqual([]);
    win.close();
  });

  it('collects at most three, each short', async () => {
    const { win, posted } = loadRunner();
    win.eval(LIBRARY);
    const setup = await run(win, posted, ['one', 'two', 'three', 'four'].map((t) => `toneWarns("${t} ${'x'.repeat(300)}");`).join('\n'));
    expect(setup.library.length).toBe(3);
    expect(setup.library.every((note: string) => note.length < 200)).toBe(true);
    win.close();
  });

  it('ignores a library the program loaded itself (another origin)', async () => {
    const { win, posted } = loadRunner();
    win.eval('function chartWarns() { console.warn("Chart: hello"); }\n//# sourceURL=https://cdn.example.com/chart.js');
    expect((await run(win, posted, 'chartWarns();')).library).toEqual([]);
    win.close();
  });
});

describe('the step a silent program is missing', () => {
  const setup = (over: Partial<SoundSetup>): SoundSetup => ({ things: [], tone: null, library: [], ...over });

  it('says several steps together, in order', () => {
    const things = [
      { kind: 'oscillator', system: 'web', role: 'source', starts: true, started: false, connected: false },
      { kind: 'audio element', system: 'media', role: 'source', starts: true, started: false, connected: true },
    ] as SoundSetup['things'];
    expect(missingStepsError(setup({ things }))).toBe(
      "The oscillator was made but never started: call its start(). The audio element was made but never played: call its play(). The oscillator was never connected to the audio context's destination: connect it with node.connect(audioContext.destination), directly or through other nodes."
    );
  });

  it('knows Transport-only errors, and no others', () => {
    expect(onlyTransportMissing('Tone.Loop was started, but Tone.Transport never was: call Tone.Transport.start().')).toBe(true);
    expect(onlyTransportMissing('Tone.Loop, Tone.Part and Tone.Sequence were started, but Tone.Transport never was: call Tone.Transport.start().')).toBe(true);
    expect(onlyTransportMissing('Something was scheduled on Tone.Transport, but Tone.Transport never was: call Tone.Transport.start().')).toBe(true);
    expect(onlyTransportMissing('Tone.Loop was started, but Tone.Transport never was: call Tone.Transport.start(). Tone.Synth was never connected to the output: call .toDestination() on it.')).toBe(false);
    expect(onlyTransportMissing("The program's sound never reached the speakers: connect each Tone synth to the output with .toDestination()")).toBe(false);
  });
});

describe('a program that never started Tone.Transport', () => {
  const error = 'Tone.Loop was started, but Tone.Transport never was: call Tone.Transport.start().';

  it('gets the call at its end, by rule, only when that is the one thing missing', () => {
    const hint = errorHint(BLUES, error);
    expect(hint?.correction).toMatchObject({ code: `${BLUES}\nTone.Transport.start();`, mustRunClean: true });
    expect(hint?.correction?.note).toContain('Tone.Transport.start() added at the end');
    // Another step missing too: the model gets the facts, the rule makes no change
    expect(errorHint(BLUES, `${error} Tone.Synth was never connected to the output: call .toDestination() on it.`)?.correction).toBeUndefined();
  });

  it('is left alone when its code already names a start of the Transport', () => {
    const named = `${BLUES}\nfunction begin() { Tone.Transport.start(); }`;
    expect(errorHint(named, error)?.correction).toBeUndefined();
    expect(withTransportStart('speak("hi");', () => true)).toBeNull();
    expect(withTransportStart(BLUES, () => false)).toBeNull();
  });
});

describe('a silent Tone program whose missing steps are all Tone steps', () => {
  // The real steps the page named for Qwen3 0.6B's blues loop: a Loop never started, a PolySynth never connected
  const error = 'Tone.Loop was made but never started: call its start(). Tone.PolySynth was never connected to the output: call .toDestination() on it (or connect it to Tone.Destination, directly or through other nodes).';
  const program = [
    'const gSynth = new Tone.PolySynth();',
    'gSynth.triggerAttackRelease("G4", 0.5, 0.5);',
    'const loop = new Tone.Loop((time) => gSynth.triggerAttackRelease("G4", "8n", time), "4n");',
  ].join('\n');

  it('reads the steps from the error, and nothing from errors that say more', async () => {
    const { toneStepsOnly } = await import('../src/core/sound-setup.ts');
    expect(toneStepsOnly(error)).toEqual({ transport: false, unconnected: ['Tone.PolySynth'], unstarted: ['Tone.Loop'] });
    expect(toneStepsOnly('Tone.Loop was started, but Tone.Transport never was: call Tone.Transport.start().')).toEqual({ transport: true, unconnected: [], unstarted: [] });
    // Another kind of step in it, words of the model's own, or none: nothing
    expect(toneStepsOnly(`${error} The oscillator was made but never started: call its start().`)).toBeNull();
    expect(toneStepsOnly('The program played nothing.')).toBeNull();
    expect(toneStepsOnly('')).toBeNull();
  });

  it('adds .toDestination() to the instrument, start(0) after the loop, and Transport.start() when it is named', () => {
    const fixed = errorHint(program, error)?.correction;
    expect(fixed?.code).toBe(
      [
        'const gSynth = new Tone.PolySynth().toDestination();',
        'gSynth.triggerAttackRelease("G4", 0.5, 0.5);',
        'const loop = new Tone.Loop((time) => gSynth.triggerAttackRelease("G4", "8n", time), "4n");',
        'loop.start(0);',
      ].join('\n')
    );
    expect(fixed?.mustRunClean).toBe(true);
    const withTransport = errorHint(program, `Tone.Loop was started, but Tone.Transport never was: call Tone.Transport.start(). ${error}`)?.correction;
    expect(withTransport?.code.endsWith('loop.start(0);\nTone.Transport.start();')).toBe(true);
  });

  it('leaves a program that connects and starts its own, or a step it cannot place, alone', () => {
    const own = ['const synth = new Tone.PolySynth();', 'synth.toDestination();', 'const loop = new Tone.Loop(() => {}, "4n");', 'loop.start(0);'].join('\n');
    expect(errorHint(own, error)?.correction).toBeUndefined();
    // Made inside a function: where it is used is unclear
    expect(errorHint('function build() {\n  const synth = new Tone.PolySynth();\n}\nbuild();', error)?.correction).toBeUndefined();
  });
});

describe('parts joined through Tone.connect and Tone.connectSeries', () => {
  it('count as connected, as when the part’s own connect() is called (the reviewer’s probe)', async () => {
    const { win, posted } = loadRunner(fakeTone);
    const setup = await run(
      win,
      posted,
      [
        'const reverb = new Tone.Filter().toDestination();',
        'const synth = new Tone.PolySynth(Tone.Synth);',
        'const bass = new Tone.Synth();',
        'const lead = new Tone.Synth();',
        'Tone.connect(synth, reverb);',
        'Tone.connectSeries(bass, new Tone.Filter(), Tone.Destination);',
        'lead.triggerAttackRelease("C4", "8n");',
      ].join('\n')
    );
    // The synth reaches the output through the reverb, the bass through its series; only the lead never was joined
    const unconnected = setup.things.filter((t: SoundSetup['things'][number]) => t.role === 'source' && !t.connected).map((t: SoundSetup['things'][number]) => t.kind);
    expect(unconnected).toEqual(['Tone.Synth']);
    expect(setup.things.filter((t: SoundSetup['things'][number]) => t.kind === 'Tone.PolySynth')[0].connected).toBe(true);
    win.close();
  });
});

describe('a Tone part used as a value is left for the program to connect', () => {
  const error = 'Tone.PolySynth was never connected to the output: call .toDestination() on it (or connect it to Tone.Destination, directly or through other nodes).';

  it('connects only the part nothing else touches: not those routed by a forEach or Tone.connect', () => {
    // The reviewer's probes: two synths routed through forEach, one that was missed
    const routed = [
      'const reverb = new Tone.Reverb(3).toDestination();',
      'const pad = new Tone.PolySynth(Tone.Synth);',
      'const lead = new Tone.PolySynth(Tone.Synth);',
      '[pad, lead].forEach((s) => s.connect(reverb));',
      'const bells = new Tone.PolySynth(Tone.Synth);',
      'const loop = new Tone.Loop((t) => { pad.triggerAttackRelease(["C4", "E4"], "2n", t); bells.triggerAttackRelease("C6", "8n", t); }, "1m");',
    ].join('\n');
    const fixed = errorHint(routed, error)?.correction?.code;
    expect(fixed).toContain('const bells = new Tone.PolySynth(Tone.Synth).toDestination();');
    expect(fixed).toContain('const pad = new Tone.PolySynth(Tone.Synth);');
    expect(fixed).toContain('const lead = new Tone.PolySynth(Tone.Synth);');
    // Joined with Tone.connect: a value of that call, so nothing is added
    const joined = 'const reverb = new Tone.Reverb(3).toDestination();\nconst synth = new Tone.PolySynth(Tone.Synth);\nTone.connect(synth, reverb);\nsynth.triggerAttackRelease("C4", "8n");';
    expect(errorHint(joined, error)?.correction).toBeUndefined();
    // A loop handed to something that starts it is not started a second time
    const loops = 'const loop = new Tone.Loop((t) => {}, "4n");\n[loop].forEach((l) => l.start(0));';
    expect(errorHint(loops, 'Tone.Loop was made but never started: call its start().')?.correction).toBeUndefined();
  });

  it('still connects a part used only through its own members', () => {
    const plain = 'const synth = new Tone.PolySynth(Tone.Synth);\nsynth.volume.value = -6;\nsynth.triggerAttackRelease("C4", "8n");';
    expect(errorHint(plain, error)?.correction?.code).toContain('const synth = new Tone.PolySynth(Tone.Synth).toDestination();');
  });
});

describe('names a program wrote on its objects that they do not have', () => {
  it('reads back what was added after the object was made: a name that nothing reads, not a function or an underscore name', async () => {
    const { win, posted } = loadRunner(fakeTone);
    await run(
      win,
      posted,
      [
        'const synth = new Tone.PolySynth(Tone.Synth);',
        'synth.tempo = 120;',
        'synth._private = 1;',
        'synth.helper = () => 1;',
        'const el = document.createElement("div");',
        'el.score = 3;',
        'el.textContent = "ok";',
        'document.body.append(el);',
      ].join('\n')
    );
    expect(win.__chattyUnknownWrites()).toEqual([
      { type: 'Tone.PolySynth', name: 'tempo' },
      { type: 'element:div', name: 'score' },
    ]);
    win.close();
  });

  it('is empty for a program that only uses what the objects have', async () => {
    const { win, posted } = loadRunner(fakeTone);
    await run(win, posted, 'const synth = new Tone.Synth().toDestination();\nsynth.triggerAttackRelease("C4", "8n");\nconst el = document.createElement("p");\nel.textContent = "x";\nel.className = "a";');
    expect(win.__chattyUnknownWrites()).toEqual([]);
    win.close();
  });
});
