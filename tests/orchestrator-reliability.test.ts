import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ConversationMemoryStore } from '../src/core/memory-store.ts';
import { ConversationOrchestrator, changedLines, droppedCapabilities, failedReplyLine, onlyAsksExample, saysQuestionBack, normalizedError, promptRules } from '../src/core/orchestrator.ts';
import { StateMachineCoordinator } from '../src/core/state-machine.ts';
import { pastProgramResult } from '../src/core/history-format.ts';
import type { ConversationMessage } from '../src/types/index.ts';

const outcome = (request: string, runtime: object, code = '') =>
  (ConversationOrchestrator.prototype as any).missingOutcome.call({ javascriptRuntime: runtime }, request, { uses: 0, heard: 0, silent: 0 }, code) as Promise<string | null>;
const nothing = { soundUseCount: () => 0, hasVisualContent: () => false };
/** The two sound rules: Tone for music, Web Audio for beeps and sound effects */
const TONE_RULE = 'For music, Tone (Tone.js) is ready to use';
const WEB_AUDIO_RULE = 'Beeps, tones and sound effects use Web Audio (new AudioContext()';
const hasSoundRule = (rules: string) => rules.includes(TONE_RULE) || rules.includes(WEB_AUDIO_RULE);
const sees = { soundUseCount: () => 0, hasVisualContent: () => true };

describe('the outcome check', () => {
  it('counts sound only when it reaches the speakers, and says how to connect it when it never does', async () => {
    const asked = { soundUseCount: () => 1, hasVisualContent: () => false };
    expect(await outcome('Play a G major chord', { ...asked, soundHeardCount: () => 1, soundSilentCount: () => 0 })).toBeNull();
    expect(await outcome('Play a G major chord', { ...asked, soundHeardCount: () => 0, soundSilentCount: () => 1 })).toContain('never reached the speakers');
    // Not measured (audio paused until a tap): the request counts
    expect(await outcome('Play a G major chord', asked)).toBeNull();
  });

  it.each(['Show me the capital of France', 'List the planets', 'Write it in the form of a poem', 'Who was Ada Lovelace?'])(
    'does not fire for the spoken answer to "%s"',
    async (request) => {
      expect(await outcome(request, nothing)).toBeNull();
    }
  );

  it.each(['who won the game', 'why is the sky blue', 'speed of sound', 'nearest star', 'square root of 144', 'who invented the piano'])(
    'does not fire for a question that names something to see or hear: "%s"',
    async (request) => {
      expect(await outcome(request, nothing)).toBeNull();
    }
  );

  it('still fires for a request asked politely, or one with numbers in it', async () => {
    expect(await outcome('Can you draw a cat?', nothing)).toContain('showed nothing');
    expect(await outcome('Draw a 3x3 grid', nothing)).toContain('showed nothing');
  });

  it('does not count sound that waits for the user as missing (an instrument, a Play button)', async () => {
    const silentInstrument = { soundUseCount: () => 1, hasVisualContent: () => true, soundHeardCount: () => 0, soundSilentCount: () => 1 };
    const piano = "const ac = new AudioContext();\ndocument.addEventListener('keydown', (e) => { const o = ac.createOscillator(); o.connect(ac.destination); o.start(); });";
    expect(await outcome('Make a piano I can play with my keyboard', silentInstrument, piano)).toBeNull();
    const lazy = "let ac;\nbutton.onclick = () => { if (!ac) ac = new AudioContext(); };";
    expect(await outcome('Make a drum machine', { soundUseCount: () => 0, hasVisualContent: () => true }, lazy)).toBeNull();
    // Without anything to press, silence is still missing sound
    expect(await outcome('Play a G major chord', silentInstrument, 'const ac = new AudioContext();')).toContain('never reached the speakers');
  });

  it('takes "a minor" for music only in a musical phrase', () => {
    expect(hasSoundRule(promptRules('Can I sell alcohol to a minor', true))).toBe(false);
    expect(promptRules('Build a blues loop in G minor', true)).toContain(TONE_RULE);
    expect(promptRules('Play an A minor chord', true)).toContain(TONE_RULE);
  });

  it('still fires for something that must appear', async () => {
    expect(await outcome('Make a timer', nothing)).toContain('showed nothing');
    expect(await outcome('Make a timer', sees)).toBeNull();
  });

  it('does not take organize, playlist or a notes app for sound', async () => {
    for (const request of ['Organize my day', 'Make a playlist page', 'Build a notes app']) {
      expect(hasSoundRule(promptRules(request, true))).toBe(false);
    }
    expect(promptRules('Play a piano chord', true)).toContain(TONE_RULE);
  });

  it('keeps the visual check when the request names sound and something visual', async () => {
    const message = await outcome('Make a piano app that plays a chord', { soundUseCount: () => 1, hasVisualContent: () => false });
    expect(message).toContain('showed nothing');
    expect(message).not.toContain('played nothing');
  });

  it('does not ask for sound from a bare play next to something visual', async () => {
    expect(await outcome('Play a game of snake', sees)).toBeNull();
  });
});

describe('prompt rules', () => {
  it('teaches real browser interfaces: fetch for facts, Tone for music', () => {
    expect(promptRules('Who was Ada Lovelace?', true)).toContain('https://en.wikipedia.org/api/rest_v1/page/summary/');
    const drums = promptRules('Play a drum beat', true);
    expect(drums).toContain(TONE_RULE);
    expect(drums).not.toMatch(/requestMIDIAccess|out\.send|out\.loop/);
  });

  it('names the Tone API, positively and without example code', () => {
    const rule = promptRules('Play a melody', true).split('\n').find((line) => line.includes(TONE_RULE))!;
    for (const name of ['Tone.PolySynth', 'Tone.PluckSynth', 'Tone.MembraneSynth', 'Tone.NoiseSynth', 'Tone.MetalSynth', '.toDestination()', 'triggerAttackRelease(note, duration, time)', '"8n"', 'Tone.Transport.bpm.value', 'Tone.Loop', 'Tone.Part', '.start(0)', 'Tone.Transport.start()']) {
      expect(rule).toContain(name);
    }
    expect(rule).not.toMatch(/\bnew Tone\.|\bconst |=>|;\s/);
    expect(rule).not.toMatch(/\b(?:don't|never|do not)\b/i);
  });

  it('gives music Tone and no Web Audio sentence', () => {
    for (const request of ['Play a song', 'Make a melody in G minor', 'Build a beat at 120 bpm', 'A drum rhythm', 'Play an A minor chord on the piano', 'Slow tempo jazz']) {
      const rules = promptRules(request, true);
      expect(rules, request).toContain(TONE_RULE);
      expect(rules, request).not.toContain('Web Audio');
    }
  });

  it('gives sound effects Web Audio and no Tone rule', () => {
    for (const request of ['Make a beep', 'Play a chime', 'An alarm that buzzes', 'Add a click sound effect', 'A siren', 'Ding when I press the button', 'Make a high tone']) {
      const rules = promptRules(request, true);
      expect(rules, request).toContain(WEB_AUDIO_RULE);
      expect(rules, request).not.toContain('Tone');
    }
  });

  it('gives both when a request names both or neither kind of sound, and neither when it is about no sound', () => {
    for (const request of ['Play a sound', 'play something', 'Play a song with a beep at the end', 'Make some audio']) {
      const rules = promptRules(request, true);
      expect(rules, request).toContain(TONE_RULE);
      expect(rules, request).toContain(WEB_AUDIO_RULE);
    }
    expect(hasSoundRule(promptRules('Draw a cat', true))).toBe(false);
    // Unfiltered (the bigger models): every rule
    expect(promptRules()).toContain(TONE_RULE);
    expect(promptRules()).toContain(WEB_AUDIO_RULE);
    // An edit is matched against the program it changes too
    expect(promptRules('make it faster\nTone.Transport.bpm.value = 90;', true)).toContain(TONE_RULE);
    expect(promptRules('make it louder\nconst ctx = new AudioContext();', true)).not.toContain(TONE_RULE);
  });

  it('no longer teaches Web MIDI (programs that use it still run)', () => {
    expect(promptRules()).not.toMatch(/Web MIDI|requestMIDIAccess|output\.send/);
  });
});

describe('a Tone program is sound', () => {
  const song = 'const synth = new Tone.PolySynth().toDestination();\nsynth.triggerAttackRelease(["C4", "E4", "G4"], "8n");';
  const request = 'Play a C major chord';

  it('counts Tone calls as sound when a fix is judged', () => {
    // A fix that takes out every Tone call has lost the sound
    expect(droppedCapabilities(request, song, 'speak("A C major chord.");')).toEqual(['sound']);
    // One that keeps them has not
    expect(droppedCapabilities(request, song, song.replace('"8n"', '"4n"'))).toEqual([]);
    // Nor has a fix of a program that never had any
    expect(droppedCapabilities(request, 'speak("hi");', 'speak("hello");')).toEqual([]);
    // Tone in a comment is not a Tone call
    expect(droppedCapabilities(request, song, '// Tone.PolySynth plays it\nspeak("A C major chord.");')).toEqual(['sound']);
  });

  it('is recorded as played sound in the history', () => {
    expect(pastProgramResult({ id: 'm', turnId: 't', role: 'assistant', canonicalContent: 'A chord.', rawCode: song, timestamp: 0 })).toContain('played sound');
  });

  it('asks for Tone, and for connecting a Tone synth, in the outcome check', async () => {
    const silent = { soundUseCount: () => 0, hasVisualContent: () => false };
    expect(await outcome('Play a C major chord', silent)).toContain('Tone');
    expect(await outcome('Make a beep', silent)).not.toContain('Tone');
    const quiet = { soundUseCount: () => 1, hasVisualContent: () => false, soundHeardCount: () => 0, soundSilentCount: () => 1 };
    expect(await outcome('Play a C major chord', quiet, song)).toContain('.toDestination()');
  });
});

describe('the outcome check on an app with nothing to press', () => {
  // Qwen3 0.6B's "Make a quiz with 3 multiple choice questions about animals": a heading and an empty results div
  const quiz = 'document.body.innerHTML = `<div class="card"><h2>Quiz: Animals</h2><div id="quiz-results"></div></div>`;\nspeak("Hi!");';
  const request = 'Make a quiz with 3 multiple choice questions about animals';
  const page = (controls: number) => ({ soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => true, controlCount: () => controls });

  it('says the page has nothing to press or type in', async () => {
    expect(await outcome(request, page(0), quiz)).toContain('The page has nothing to press or type in');
    expect(await outcome('Code a tip calculator app with a UI for entering the bill and tip %', page(0), quiz)).toContain('nothing to press or type in');
  });

  it('is content with a control, a request for something to look at, or a runtime that cannot count', async () => {
    // (with a handler for them: controls that nothing listens to are the next test)
    expect(await outcome(request, page(3), `${quiz}\ndocument.addEventListener("click", () => {});`)).toBeNull();
    expect(await outcome('Show a big ten second countdown on screen', page(0), 'document.body.innerHTML = "10";\nsetInterval(() => {}, 1000);')).toBeNull();
    expect(await outcome('Draw a house with a red roof', page(0), 'ctx.fillRect(1, 1, 5, 5);')).toBeNull();
    expect(await outcome(request, { soundUseCount: () => 0, hasVisualContent: () => true }, quiz)).toBeNull();
  });

  it('is not asked of a drawing, something shown, or a program that listens for the user', async () => {
    // The reviewer's cases: a drawn calculator, a heart "in the form of", a list to show, a dice roller on a canvas
    expect(await outcome('Draw a calculator', page(0), 'ctx.fillRect(1, 1, 5, 5);')).toBeNull();
    expect(await outcome('Draw a cat in the form of a heart', page(0), 'ctx.fillRect(1, 1, 5, 5);')).toBeNull();
    expect(await outcome('Show my to-do list: milk, eggs', page(0), 'document.body.innerHTML = "<p>milk</p><p>eggs</p>";')).toBeNull();
    expect(await outcome('Make a dice roller', page(0), 'canvas.addEventListener("click", () => roll());')).toBeNull();
    expect(await outcome('Make a drawing app', page(0), 'ctx.fillRect(1, 1, 5, 5);')).toBeNull();
  });

  it('is not asked when the app word is not what is being made (the reviewer’s probes), and still is when it is', async () => {
    const text = 'document.body.innerHTML = "<p>Roses are red</p>";';
    for (const request of ['Write a poem about a calculator', 'Make a list of quiz questions about France', 'Write a story for a quiz show', 'Create a poster about a stopwatch']) {
      expect(await outcome(request, page(0), text), request).toBeNull();
    }
    for (const request of ['Build a simple unit converter', 'Make me a to-do list', 'Code a tip calculator', 'Create an editor for notes']) {
      expect(await outcome(request, page(0), text), request).toContain('nothing to press or type in');
    }
  });
});

describe('the outcome check on a canvas nothing was drawn on', () => {
  // The program of Qwen3 0.6B's Pong: a canvas, a paddle and a mouse listener, and nothing that draws
  const pong = 'const canvas = document.createElement("canvas");\ndocument.body.appendChild(canvas);\nconst paddle = { x: 100 };\nwindow.addEventListener("mousemove", (e) => { paddle.x = e.clientX; });';
  // (a blank canvas still counts when the program waits for the user: boxesOnly)
  const blank = { soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: (boxesOnly?: boolean) => !!boxesOnly };

  it('is a program that showed nothing drawn, with the facts', async () => {
    const error = await outcome('Make a single-player Pong game with a paddle you move by mouse or touch', blank, pong);
    expect(error).toContain('The program put nothing visible on screen');
  });

  it('names the empty elements the page has, as the bars of a chart Qwen3 0.6B left without size', async () => {
    const bars = { soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => false, emptyElements: () => ['div.bar ×5'] };
    const error = await outcome('Draw a bar chart of the numbers 3, 7, 5, 9 and 4', bars, 'const chart = document.createElement("div");\nchart.innerHTML = `<div class="bar" data-value="3"></div>`;\ndocument.body.appendChild(chart);');
    expect(error).toContain('(div.bar ×5 have no text and no size)');
    expect(error).toContain('give it a size');
  });

  it('is not one when the canvas has a drawing, the program waits for the user, or the runtime cannot tell', async () => {
    const request = 'Make a single-player Pong game with a paddle you move by mouse or touch';
    expect(await outcome(request, { ...blank, hasDrawnContent: () => true }, pong)).toBeNull();
    expect(await outcome(request, blank, `${pong}\ncanvas.addEventListener("click", () => start());`)).toBeNull();
    expect(await outcome(request, { soundUseCount: () => 0, hasVisualContent: () => true }, pong)).toBeNull();
    // Nothing on the page at all keeps its own words
    expect(await outcome(request, { soundUseCount: () => 0, hasVisualContent: () => false, hasDrawnContent: () => false }, pong)).toContain('showed nothing');
  });
});

describe('the outcome check on a screen that never changes', () => {
  // Qwen3 0.6B's "Show a big ten second countdown on screen": a stand-in div with the text 00:00:00, set once
  const countdown = 'speak("Show a big ten second countdown on screen.");\ndocument.getElementById("countdown").innerHTML = "00:00:00";';
  const request = 'Show a big ten second countdown on screen';
  const still = { soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => true, pageSignature: () => 'same' };

  it('says nothing changed, for a request of something that counts or moves', async () => {
    expect(await outcome(request, still, countdown)).toContain('The screen never changed and nothing is scheduled to change it');
    expect(await outcome('Animate 10 colored balls bouncing around the screen', still, 'ctx.fillRect(1, 1, 5, 5);')).toContain('The screen never changed and nothing is scheduled to change it');
  }, 15000);

  it('is content when the screen changes, cannot be read, or the user drives it', async () => {
    let n = 0;
    expect(await outcome(request, { ...still, pageSignature: () => `t${n++}` }, countdown)).toBeNull();
    // Still, but with an interval, a timeout or a frame pending: a days countdown, a light that blinks every 2 s, "count down from 2"
    expect(await outcome(request, { ...still, hasScheduledWork: () => true }, countdown)).toBeNull();
    expect(await outcome(request, { ...still, hasScheduledWork: () => false }, countdown)).toContain('nothing is scheduled');
    // It moves once and stops: the countdown from Qwen3 0.6B that showed 10, then 9 for good (nothing pending then)
    let ticks = 0;
    expect(await outcome(request, { ...still, pageSignature: () => `s${Math.min(ticks++, 1)}` }, countdown)).toContain('The screen never changed and nothing is scheduled to change it');
    expect(await outcome(request, { ...still, pageSignature: () => null }, countdown)).toBeNull();
    expect(await outcome(request, { soundUseCount: () => 0, hasVisualContent: () => true }, countdown)).toBeNull();
    // A stopwatch waits for its Start button; a paddle follows the pointer
    expect(await outcome('Make a stopwatch you can start and stop', still, 'startButton.addEventListener("click", start);')).toBeNull();
    expect(await outcome('Make a bouncing ball game', still, 'canvas.addEventListener("mousemove", (e) => { x = e.clientX; });')).toBeNull();
    // Nothing is asked to move
    expect(await outcome('Draw a smiling cat face', still, 'ctx.fillRect(1, 1, 5, 5);')).toBeNull();
  }, 15000);
});

describe('the outcome check on a request for sound with a visual word in a title', () => {
  // Qwen3 0.6B's Twinkle Twinkle program had no picture, and was told it "showed nothing" because of the word Star
  const played = { soundUseCount: () => 1, hasVisualContent: () => true, hasDrawnContent: () => false, soundHeardCount: () => 1, soundSilentCount: () => 0 };

  it('asks for no picture of a song, but still of a request that asks to see something or names an interface', async () => {
    expect(await outcome('Play Twinkle Twinkle Little Star on the piano', played, 'synth.triggerAttackRelease("C4", "8n");')).toBeNull();
    expect(await outcome('Play a melody with a square wave', played, 'osc.start();')).toBeNull();
    expect(await outcome('Play a drum beat and draw a star on screen', played, 'osc.start();')).toContain('nothing visible');
    expect(await outcome('Make a piano app with keys I can press', played, 'osc.start();')).toContain('nothing visible');
    expect(await outcome('Draw a star', played, 'ctx.fillRect(0, 0, 1, 1);')).toContain('nothing visible');
  }, 30000);
});

describe('the outcome check on a page that gets no animation frames', () => {
  const frames = 'function loop() { ctx.fillRect(1, 1, 5, 5); requestAnimationFrame(loop); }\nloop();';
  const request = 'Animate 10 colored balls bouncing around the screen';
  const still = { soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => true, pageSignature: () => 'same' };

  it('does not judge what runs on frames when none arrive (a hidden pane), and still does when they do', async () => {
    const real = globalThis.requestAnimationFrame;
    try {
      // (a page nobody watches: the frame request is never answered, though the visibility state says visible)
      globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;
      expect(await outcome(request, still, frames)).toBeNull();
      // (a program that does not draw on frames is judged as before)
      expect(await outcome(request, still, 'ctx.fillRect(1, 1, 5, 5);')).toContain('The screen never changed');
      globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => setTimeout(() => callback(0), 5)) as unknown as typeof requestAnimationFrame;
      expect(await outcome(request, still, frames)).toContain('The screen never changed');
    } finally {
      globalThis.requestAnimationFrame = real;
    }
  }, 20000);
});

describe('the outcome check names the step a silent program is missing', () => {
  const BLUES = 'const synth = new Tone.PolySynth(Tone.Synth).toDestination();\nconst loop = new Tone.Loop((time) => {\n  synth.triggerAttackRelease(["G3", "Bb3", "D4"], "8n", time);\n}, "4n");\nloop.start(0);';
  const quiet = { soundUseCount: () => 1, hasVisualContent: () => false, soundHeardCount: () => 0, soundSilentCount: () => 1 };
  const loopOnly = { things: [{ kind: 'Tone.Loop', system: 'tone', role: 'scheduler', starts: true, started: true, connected: true }], tone: { transport: 'stopped', transportStarted: false, scheduled: 1 }, library: [] };

  it('says Tone.Transport was never started, in place of advice the program already follows', async () => {
    const error = await outcome('Build a blues music loop with piano, bass, and drums in G minor, 120 bpm, 4 measures', { ...quiet, soundSetup: () => loopOnly }, BLUES);
    expect(error).toBe('Tone.Loop was started, but Tone.Transport never was: call Tone.Transport.start().');
  });

  it('keeps the general advice when the page names no step, and the MIDI explanation as it was', async () => {
    expect(await outcome('Play a C major chord', { ...quiet, soundSetup: () => ({ things: [], tone: null, library: [] }) }, BLUES)).toContain('.toDestination()');
    const midi = { ...quiet, soundSetup: () => loopOnly, midiSummary: () => ({ sent: 3, noteOns: 0, others: ['0xB0 control change'] }) };
    expect(await outcome('Play a C major chord', midi, 'output.send([0xB0, 7, 100]);')).toContain('No note was started');
  });

  it('says nothing more when the sound was heard', async () => {
    expect(await outcome('Play a C major chord', { ...quiet, soundHeardCount: () => 1, soundSilentCount: () => 0, soundSetup: () => loopOnly }, BLUES)).toBeNull();
  });
});

describe('a reply that says the question back', () => {
  it('is caught, as Qwen3 0.6B wrote it for a quick fact', () => {
    expect(saysQuestionBack('speak("Who was Ada Lovelace?")', 'Who was Ada Lovelace?')).toBe(true);
    expect(saysQuestionBack('speak("What is the capital of Australia?")', 'What is the capital of Australia?')).toBe(true);
    // The retry's version of it: logged, which the sandbox speaks
    expect(saysQuestionBack('// This is a test case for the user\'s request\nconsole.log("Who was Ada Lovelace?");', 'Who was Ada Lovelace?')).toBe(true);
    // Case, punctuation and a curly apostrophe don't hide it
    expect(saysQuestionBack("speak('what\u2019s 15 percent of 84')", 'What\u2019s 15 percent of 84?')).toBe(true);
  });

  it('leaves answers, other questions, greetings and programs alone', () => {
    expect(saysQuestionBack('speak("Canberra is the capital of Australia.")', 'What is the capital of Australia?')).toBe(false);
    // Asking the user something else is asking
    expect(saysQuestionBack('speak("Which Ada do you mean?")', 'Who was Ada Lovelace?')).toBe(false);
    // The question and its answer
    expect(saysQuestionBack('speak("Who was Ada Lovelace?");\nspeak("A mathematician.");', 'Who was Ada Lovelace?')).toBe(false);
    // A greeting answered with a greeting, and a short request
    expect(saysQuestionBack('speak("Hello")', 'Hello')).toBe(false);
    expect(saysQuestionBack('speak("Hi there")', 'Hi there')).toBe(false);
    // An answer that is logged
    expect(saysQuestionBack('console.log("Ada Lovelace was a mathematician.");', 'Who was Ada Lovelace?')).toBe(false);
    // A program that does something besides talk
    expect(saysQuestionBack('const a = 1;\nspeak("What is 1 plus 1?")', 'What is 1 plus 1?')).toBe(false);
    // A request that is no question
    expect(saysQuestionBack('speak("Draw a cat")', 'Draw a cat')).toBe(false);
  });
});

describe('a reply that asks the example question again', () => {
  const request = 'Play a simple drum beat';

  it('is caught, as Qwen3 0.6B wrote it for "Play a simple drum beat"', () => {
    // The real reply: the request with the question from the example reply, and a second sentence of nothing
    expect(onlyAsksExample('speak("Play a simple drum beat. What would you like me to make?")  \nspeak("Play a simple drum beat. Let\'s create a beat together...");', request)).toBe(true);
    expect(onlyAsksExample('speak("Play a simple drum beat. What would you like me to make?")', request)).toBe(true);
    expect(onlyAsksExample('// ask\nconsole.log("what would you like me to make");', request)).toBe(true);
  });

  it('leaves a greeting, other questions, answers and programs alone', () => {
    // A greeting is answered with the example's own words
    expect(onlyAsksExample('speak("Hi! What would you like me to make?");', 'Hi!')).toBe(false);
    expect(onlyAsksExample('speak("Which beat do you want, rock or funk?");', request)).toBe(false);
    expect(onlyAsksExample('speak("What would you like?");', request)).toBe(false);
    expect(onlyAsksExample('const x = 1;\nspeak("What would you like me to make?");', request)).toBe(false);
    expect(onlyAsksExample('speak("Here is a beat.");', request)).toBe(false);
  });
});

describe('fix bookkeeping', () => {
  it('keys errors without their numbers', () => {
    expect(normalizedError('x is not defined at line 12')).toBe(normalizedError('x is not defined at line 7'));
    expect(normalizedError('x is not defined')).not.toBe(normalizedError('y is not defined'));
  });

  it('remembers what a reply changed, not its first line', () => {
    expect(changedLines('function draw() {\n  boom();\n}', 'function draw() {\n  bang();\n}')).toBe('bang();');
    expect(changedLines('a();\nb();', 'a();\nb();')).toBe('');
  });

  it('lists a failed reply as one short line, and skips one that is the program\u2019s own first line back', () => {
    // A long line of escaped HTML, like the 400-character entry a real fix request listed
    const html = 'document.body.innerHTML = `<div class=\\"card\\"><h2>Tip Calculator</h2><label for=\\"bill\\">Bill</label><input id=\\"bill\\" type=\\"number\\"></div>`;';
    const program = 'const total = 0;\n' + html;
    const line = failedReplyLine(program, '', `// Cause: nothing\n${html}`);
    expect(line.length).toBeLessThanOrEqual(100);
    expect(line.startsWith('document.body.innerHTML = `<div')).toBe(true);
    // What a reply changed comes first, as before
    expect(failedReplyLine(program, 'bang();', 'bang();')).toBe('bang();');
    // The program's first line sent back unchanged is no entry; a first reply (nothing to compare with) is one
    expect(failedReplyLine(program, '', '```js\nconst total = 0;\n```')).toBe('');
    expect(failedReplyLine(undefined, '', 'const total = 0;')).toBe('const total = 0;');
    // A line of code that is short stays whole
    expect(failedReplyLine(program, '', 'boom();')).toBe('boom();');
    expect(failedReplyLine(program, '', '// only a comment')).toBe('');
  });
});

describe('history of a fixed program', () => {
  it('says the version that ran without an error, not that the broken one failed', () => {
    const broken: ConversationMessage = {
      id: 'a', turnId: 't1', role: 'assistant', canonicalContent: 'Done.', rawCode: 'boom();\nspeak("Done.");',
      toolCall: { name: 'execute_javascript', arguments: {}, error: 'boom is not defined' },
    } as ConversationMessage;
    expect(pastProgramResult(broken)).toContain('it failed');
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator: new StateMachineCoordinator(),
      llmProvider: { id: 'q', modelId: 'q', contextLimit: 8192, maxOutputTokens: 512 } as any,
    });
    (orchestrator as any).correctedPrograms.set('t1', { code: 'bang();\nspeak("Done.");', request: 't1' });
    const { promptMessages } = (orchestrator as any).buildModelPrompt(
      'hello',
      { workingMessages: [{ id: 'u', turnId: 't1', role: 'user', canonicalContent: 'Do it' }, broken], conversationSummary: null, relevantMemories: [], resolvedReferencesNote: null, estimatedTokens: 0 },
      null,
      false
    );
    const reply = promptMessages.find((m: any) => m.role === 'assistant' && m.content.includes('Your program'));
    expect(reply.content).toContain('ran without an error');
    expect(reply.content).not.toContain('failed');
  });
});

describe('the context budget', () => {
  it('counts code at about three characters a token', () => {
    const store = new ConversationMemoryStore();
    const code = 'function f(a) { return a[0] + (a[1] * 2); }\n'.repeat(10);
    expect(store.estimateTokens(code)).toBe(Math.ceil(code.length / 3));
    expect(store.estimateTokens('Just some words in a sentence.')).toBe(Math.ceil(30 / 4));
  });

  it('drops older history, down to none, for a program shown in full', () => {
    const store = new ConversationMemoryStore();
    for (let i = 0; i < 4; i++) {
      store.addMessage({ id: `u${i}`, turnId: `t${i}`, role: 'user', canonicalContent: `request number ${i} with some words`, timestamp: i } as ConversationMessage);
      store.addMessage({ id: `a${i}`, turnId: `t${i}`, role: 'assistant', canonicalContent: `reply ${i}`, timestamp: i } as ConversationMessage);
    }
    const roomy = store.resolveContextForQuery('make it bigger', 2000, 0);
    expect(roomy.workingMessages.length).toBe(8);
    const tight = store.resolveContextForQuery('make it bigger', 2000, 5000);
    expect(tight.workingMessages.length).toBe(0);
  });
});

describe('the outcome check on something to tap or use that nothing reacts to', () => {
  const page = (controls: number) => ({ soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => true, controlCount: () => controls });
  const message = 'Nothing in the program reacts to the user';
  // The programs Qwen3 0.6B wrote: a board drawn once, and three sliders read once
  const board = 'const canvas = document.getElementById("gameCanvas");\nconst ctx = canvas.getContext("2d");\nctx.fillRect(0, 0, 10, 10);';
  const sliders = 'document.body.innerHTML = `<input type="range" id="r"><input type="range" id="g">`;\ndocument.getElementById("out").textContent = document.getElementById("r").value;';

  it('says so for a game to tap and a picker with sliders, when no handler is anywhere in the program', async () => {
    expect(await outcome('Make a tic-tac-toe game where two players take turns tapping the squares', page(0), board)).toContain(message);
    expect(await outcome('Make a color picker with three sliders for red, green and blue', page(3), sliders)).toContain(message);
    expect(await outcome('Make a game where I click on the moving targets to score points', page(0), board)).toContain(message);
  });

  it('also for an instruction that starts with a verb the check did not list (the die Qwen3 0.6B answered with the request as text)', async () => {
    const echo = 'document.body.innerHTML = `Roll a six-sided die when I tap a button`;';
    expect(await outcome('Roll a six-sided die when I tap a button', page(0), echo)).toContain('The page has nothing to press');
    expect(await outcome('Roll a six-sided die when I tap a button', page(1), echo)).toContain(message);
    expect(await outcome('Roll a six-sided die when I tap a button', page(1), `${echo}\ndocument.body.addEventListener("click", () => {});`)).toBeNull();
    // (an instruction that names no tapping is not a request for a screen; a question about tapping is a question)
    expect(await outcome('Roll a six-sided die', page(0), echo)).toBeNull();
    expect(await outcome('Why do I tap a button to roll a die?', page(0), echo)).toBeNull();
  });

  it('is content with any handler: a click, a key, a pointer move, an onclick in the markup, an input listener', async () => {
    for (const handler of ['canvas.addEventListener("click", () => {});', 'document.addEventListener("keydown", () => {});', 'window.addEventListener("mousemove", () => {});', 'document.body.innerHTML = "<button onclick=\\"go()\\">go</button>";', 'r.addEventListener("input", () => {});']) {
      expect(await outcome('Make a tic-tac-toe game where two players take turns tapping the squares', page(0), `${board}\n${handler}`), handler).toBeNull();
    }
  });

  it('is not asked of a drawing, a display, or a request that does not name what the user does (a mouse is also an animal)', async () => {
    expect(await outcome('Draw a mouse with big ears', page(0), board)).toBeNull();
    expect(await outcome('Draw a house with a red roof', page(0), board)).toBeNull();
    expect(await outcome('Show a big ten second countdown on screen', page(0), 'document.body.innerHTML = "10";\nsetInterval(() => {}, 1000);')).toBeNull();
    expect(await outcome('Build a tip calculator', page(0), board)).not.toContain(message);
  });
});

describe('the outcome check on elements with nothing in them that wait for a tap', () => {
  // The real board from Qwen3 0.6B's tic-tac-toe: nine empty squares with click handlers, none with a size
  const empty = { soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => false };
  const board = 'document.body.innerHTML = `<div id="board"><div class="square"></div></div>`;\ndocument.querySelectorAll(".square").forEach((s) => s.addEventListener("click", () => {}));';

  it('are nothing to look at even when the program waits for the user', async () => {
    expect(await outcome('Make a tic-tac-toe game where two players take turns tapping the squares', empty, board)).toContain('nothing visible');
    expect(await outcome('Make a tic-tac-toe game where two players take turns tapping the squares', { ...empty, hasDrawnContent: () => true }, board)).toBeNull();
  }, 20000);
});

describe('the outcome check on a handler in the markup that calls a function nothing defines', () => {
  const page = (dead: string[]) => ({ soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => true, controlCount: () => 1, deadHandlers: () => dead });
  const die = 'document.body.innerHTML = `<button onclick="rollDice()">Roll</button><div id="result"></div>`;';

  it('says which function is missing, and says nothing when every handler has its function', async () => {
    const said = await outcome('Roll a six-sided die when I tap a button', page(['rollDice']), die);
    expect(said).toContain('call rollDice()');
    expect(said).toContain('which the program never defines');
    expect(await outcome('Roll a six-sided die when I tap a button', page([]), die)).toBeNull();
    // (a runtime that cannot tell is taken at its word)
    expect(await outcome('Roll a six-sided die when I tap a button', { soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => true }, die)).toBeNull();
  });
});

describe('the outcome check on a drawing that shows nothing: why, from the page and the program', () => {
  // The shape of the live beach program: values set for the drawing that nothing reads, and a draw() that clears and draws nothing
  const beach = [
    'const canvas = document.createElement("canvas");',
    'document.body.appendChild(canvas);',
    'const ctx = canvas.getContext("2d");',
    'let skyColor = "#87ceeb";',
    'let oceanColor;',
    'oceanColor = "rgba(75, 0, 130, 0.9)";',
    'const sunX = 120;',
    'function draw() {',
    '  ctx.clearRect(0, 0, canvas.width, canvas.height);',
    '}',
    'draw();',
  ].join('\n');
  const request = 'Draw a beach sunset with rainbow sky and deep purple ocean';
  const nothingShown = (cleared: { fn: string | null } | null) => ({ soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => false, clearedWithoutDrawing: () => cleared });
  const color = /^(?:#[0-9a-f]{6}|rgba?\([\d., ]+\))$/;

  it('names the function that cleared the canvas last and the values nothing reads', async () => {
    const real = (globalThis as { CSS?: unknown }).CSS;
    (globalThis as { CSS?: unknown }).CSS = { supports: (_property: string, value: string) => color.test(value) };
    try {
      const said = await outcome(request, nothingShown({ fn: 'draw' }), beach);
      expect(said).toContain('The program put nothing visible');
      expect(said).toContain('draw() clears the canvas and then draws nothing.');
      expect(said).toContain('skyColor, oceanColor, sunX are set but never used.');
      expect((await outcome(request, nothingShown({ fn: null }), beach)) ?? '').toContain('The canvas is cleared after the last drawing.');
      // (a program that clears and then draws has neither fact: nothing says it was cleared last, and what it sets it reads)
      const drawn = beach.replace('  ctx.clearRect(0, 0, canvas.width, canvas.height);', '  ctx.clearRect(0, 0, canvas.width, canvas.height);\n  ctx.fillStyle = skyColor;\n  ctx.fillRect(sunX, 0, 9, 9);\n  ctx.fillStyle = oceanColor;');
      const clean = await outcome(request, nothingShown(null), drawn);
      expect(clean ?? '').not.toContain('clears the canvas');
      expect(clean ?? '').not.toContain('never used');
    } finally {
      (globalThis as { CSS?: unknown }).CSS = real;
    }
  }, 30000);

  it('says neither on a drawing that shows, nor for a request that is not a drawing', async () => {
    const real = (globalThis as { CSS?: unknown }).CSS;
    (globalThis as { CSS?: unknown }).CSS = { supports: (_property: string, value: string) => color.test(value) };
    try {
      expect(await outcome(request, { ...nothingShown({ fn: 'draw' }), hasDrawnContent: () => true }, beach)).toBeNull();
      expect((await outcome('Build a tip calculator', nothingShown({ fn: 'draw' }), beach)) ?? '').not.toContain('never used');
    } finally {
      (globalThis as { CSS?: unknown }).CSS = real;
    }
  }, 30000);
});

describe('the outcome check on a drawing that is only words', () => {
  const drawing = (graphic: boolean | null) => ({ soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => true, hasGraphics: () => graphic });
  const message = 'The program drew nothing: the card shows only text';
  const words = 'document.body.innerHTML = `<div id="sailboat">Sailboat in the ocean</div><div id="water">Blue water</div>`;';

  it('says the card holds only text where a picture was asked for (the sailboat Qwen3 0.6B wrote)', async () => {
    expect(await outcome('Draw a sailboat on blue water', drawing(false), words)).toContain(message);
    expect(await outcome('Paint a sunset over the sea', drawing(false), words)).toContain(message);
  });

  it('is content with a picture, a page that cannot say, a request that does not draw, or a draw of cards and numbers', async () => {
    expect(await outcome('Draw a sailboat on blue water', drawing(true), 'ctx.fillRect(0, 0, 9, 9);')).toBeNull();
    expect(await outcome('Draw a sailboat on blue water', drawing(null), words)).toBeNull();
    expect(await outcome('Draw a sailboat on blue water', { soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => true }, words)).toBeNull();
    expect(await outcome('Show my to-do list: milk, eggs', drawing(false), words)).toBeNull();
    for (const request of ['Draw a card from a deck and show it', 'Draw a random number between 1 and 10', 'Draw the winner of the raffle']) {
      expect(await outcome(request, drawing(false), words), request).toBeNull();
    }
  });
});

describe('the outcome check on a request that names the button to tap, and the page has none', () => {
  // The real program from Qwen2.5 0.5B's die: text, a function, and a click handler on an element the page never had
  const die = 'document.body.innerHTML = `Roll a six-sided die when I tap a button`;\nfunction rollDice() {}\ndocument.getElementById("nextRoll").addEventListener("click", rollDice);';
  const page = (controls: number) => ({ soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => true, controlCount: () => controls });

  it('says the page has nothing to press, and is content with a button there', async () => {
    expect(await outcome('Roll a six-sided die when I tap a button', page(0), die)).toContain('The page has nothing to press or type in');
    expect(await outcome('Roll a six-sided die when I tap a button', page(1), die)).toBeNull();
    // (a request that names no control, or no tapping, is not held to it)
    expect(await outcome('Roll a six-sided die when I tap', page(0), die)).toBeNull();
    expect(await outcome('Show a button', page(0), die)).toBeNull();
  }, 30000);
});
