import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ConversationMemoryStore } from '../src/core/memory-store.ts';
import { ConversationOrchestrator, changedLines, droppedCapabilities, failedReplyLine, madeUpWeather, onlyAsksExample, onlyRestates, saidNothing, saysQuestionBack, normalizedError, promptRules, wrongTypedAnswer } from '../src/core/orchestrator.ts';
import { StateMachineCoordinator } from '../src/core/state-machine.ts';
import { pastProgramResult } from '../src/core/history-format.ts';
import type { ConversationMessage } from '../src/types/index.ts';

const outcome = (request: string, runtime: object, code = '') =>
  (ConversationOrchestrator.prototype as any).missingOutcome.call({ javascriptRuntime: runtime }, request, { uses: 0, heard: 0, silent: 0 }, code) as Promise<string | null>;
const nothing = { soundUseCount: () => 0, hasVisualContent: () => false };
/** The two sound rules: Tone for music, Web Audio for beeps and sound effects */
const TONE_RULE = 'For music, this browser has a General MIDI software instrument library';
// (the music rule: General MIDI through Web MIDI; Tone is no longer advertised)
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
  it('teaches real browser interfaces: fetch for facts, General MIDI through Web MIDI for music', () => {
    expect(promptRules('Who was Ada Lovelace?', true)).toContain('https://en.wikipedia.org/api/rest_v1/page/summary/');
    const drums = promptRules('Play a drum beat', true);
    expect(drums).toContain(TONE_RULE);
    expect(drums).toContain('navigator.requestMIDIAccess');
    expect(drums).not.toMatch(/Tone|out\.send|out\.loop/);
  });

  it('names Web MIDI and teaches the plain form of send() with one example track, no message bytes', () => {
    const rule = promptRules('Play a melody', true).split('\n').find((line) => line.includes(TONE_RULE))!;
    expect(rule).toBe(
      '- For music, this browser has a General MIDI software instrument library, available through Web MIDI. One track plays like this:'
    );
    const whole = promptRules('Play a melody', true);
    expect(whole).toContain(
      '```js\nconst output = [...(await navigator.requestMIDIAccess()).outputs.values()][0];\nconst instrument = ""; // the General MIDI instrument asked for, like "violin", "bass" or "drums"\nconst notes = []; // the music\'s notes in order, like "C4" (for drums: "kick", "snare", "hihat")\noutput.send(instrument, notes, 400); // 400 is each note\'s length in ms\n```'
    );
    expect(whole).toContain('```\nThe notes play one after another.');
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

  it('no longer teaches Tone (programs that use it still run)', () => {
    expect(promptRules()).not.toMatch(/Tone|toDestination|triggerAttackRelease/);
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

  it('asks for Web MIDI in the outcome check, and for connecting a Tone synth when the program uses Tone', async () => {
    const silent = { soundUseCount: () => 0, hasVisualContent: () => false };
    expect(await outcome('Play a C major chord', silent)).toContain('notes play through Web MIDI. Get an output with const output = [...(await navigator.requestMIDIAccess()).outputs.values()][0], then output.send(instrument, notes, 400) plays the notes one after another');
    expect(await outcome('Play a C major chord', silent)).not.toContain('Tone');
    expect(await outcome('Make a beep', silent)).not.toContain('Web MIDI');
    const quiet = { soundUseCount: () => 1, hasVisualContent: () => false, soundHeardCount: () => 0, soundSilentCount: () => 1 };
    expect(await outcome('Play a C major chord', quiet, song)).toContain('.toDestination()');
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

describe('sound that waits for the user', () => {
  it('is only waiting when the program has something that makes sound (a live Twinkle had only a mousedown listener)', async () => {
    const request = 'Play Twinkle Twinkle Little Star on the piano';
    const noSound = 'const notes = ["C4", "D4"];\nfunction playNote(e) { e.preventDefault(); }\ndocument.body.addEventListener("mousedown", playNote);';
    expect(await outcome(request, { soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => true }, noSound)).toContain('played nothing');
    const onTap = 'const output = [...(await navigator.requestMIDIAccess()).outputs.values()][0];\ndocument.body.addEventListener("mousedown", () => output.send("piano", ["C4"], 400));';
    expect(await outcome(request, { soundUseCount: () => 0, hasVisualContent: () => true, hasDrawnContent: () => true }, onTap)).toBeNull();
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

describe('a temperature for the weather that no look-up gave', () => {
  const looked = (weather: Array<number | null>, requests = 0, numbers: number[] = []) => ({ weather, requests, numbers });
  const TOKYO = 'const place = "Tokyo";\nconst { temperature, rain, sky } = await getWeather(place);\n';

  it('is caught, as Qwen3.5 2B wrote it for "how hot is it in Tokyo right now?"', () => {
    const said = 'It is currently 25 degrees Celsius in Tokyo, with clear skies and no rain.';
    expect(madeUpWeather('how hot is it in Tokyo right now?', `${TOKYO}speak("${said}");`, [said], looked([12.5]))).toBe(
      "The weather numbers spoken (25 degrees) don't come from getWeather(), which gave 12.5 °C: speak its temperature (speak(`It is ${temperature} degrees`))."
    );
  });

  it('is caught with nothing looked up, for the weather now, and when the look-up got no temperature', () => {
    expect(madeUpWeather("What's the weather in Berlin?", 'speak("It is 55 °C in Berlin.");', ['It is 55 °C in Berlin.'], looked([]))).toBe(
      'The program says 55 °C without looking the weather up: get it with const { temperature } = await getWeather("") (the city\'s name in the quotes, "" for where the user is) and speak its temperature.'
    );
    expect(madeUpWeather('is it cold outside?', 'speak("It is -3 degrees.");', ['It is -3 degrees.'], looked([]))).toContain('-3 degrees');
    expect(madeUpWeather('how hot is it in Tokyo right now?', `${TOKYO}speak("It is 20 degrees.");`, ['It is 20 degrees.'], looked([null]))).toContain("don't come from getWeather()");
    // A fetch whose reply held no such number
    expect(
      madeUpWeather("what's the weather in Paris today?", 'const r = await fetch(url);\nspeak("It is 31 degrees.");', ['It is 31 degrees.'], looked([], 1, [48.8, 2.3, 14.2]))
    ).toContain('what the program fetched');
  });

  it('leaves the reading spoken rounded, cut, in °F or from kelvin, and a reply with no temperature', () => {
    const tokyo = (said: string, reading: Array<number | null> = [12.5]) =>
      madeUpWeather('how hot is it in Tokyo right now?', `${TOKYO}speak(\`${said}\`);`, [said], looked(reading));
    expect(tokyo('It is 12.5 degrees Celsius in Tokyo.')).toBeNull();
    expect(tokyo('It is 13°C in Tokyo.')).toBeNull();
    expect(tokyo('It is 12 degrees in Tokyo.')).toBeNull();
    expect(tokyo('It is 54.5 °F in Tokyo.')).toBeNull();
    expect(tokyo('It is 55 degrees Fahrenheit in Tokyo.')).toBeNull();
    expect(tokyo('It is -2 degrees.', [-1.6])).toBeNull();
    expect(tokyo("It's clear and dry in Tokyo.")).toBeNull();
    // Fetched in kelvin and worked out
    expect(
      madeUpWeather("what's the weather in Oslo now?", 'const r = await (await fetch(url)).json();\nspeak(`It is ${Math.round(r.main.temp - 273.15)} degrees.`);', ['It is 12 degrees.'], looked([], 1, [285.6]))
    ).toBeNull();
  });

  it('leaves a temperature the request names, a threshold the code compares with, and the climate', () => {
    // The user's own number
    expect(madeUpWeather('is 20 degrees warm?', 'speak("20 degrees is mild.");', ['20 degrees is mild.'], looked([]))).toBeNull();
    expect(
      madeUpWeather(
        'is it warmer than 20 degrees in Paris today?',
        'const { temperature } = await getWeather("Paris");\nspeak(temperature > 20 ? "Yes, above 20 degrees." : "No, under 20 degrees.");',
        ['No, under 20 degrees.'],
        looked([14])
      )
    ).toBeNull();
    // The code's own threshold, said with the reading
    expect(
      madeUpWeather('should I bring a jacket today?', 'const { temperature } = await getWeather("");\nif (temperature < 15) speak("Yes: it is below 15 degrees.");', ['Yes: it is below 15 degrees.'], looked([9.8]))
    ).toBeNull();
    // Facts, not today's weather: nothing to look up
    expect(madeUpWeather('How cold is Moscow in winter?', 'speak("About -10 degrees Celsius.");', ['About -10 degrees Celsius.'], looked([]))).toBeNull();
    expect(madeUpWeather('what temperature does water boil at?', 'speak("100 degrees Celsius.");', ['100 degrees Celsius.'], looked([]))).toBeNull();
    expect(madeUpWeather("what's the weather like on Mars?", 'speak("About -60 degrees.");', ['About -60 degrees.'], looked([]))).toBeNull();
  });

  it('leaves temperatures that are not the weather: a conversion, a story, an app', () => {
    expect(madeUpWeather('convert 20°C to F', 'speak("20°C is 68 °F.");', ['20°C is 68 °F.'], looked([]))).toBeNull();
    expect(
      madeUpWeather('a temperature converter between Celsius and Fahrenheit', 'speak("0 degrees Celsius is 32 degrees Fahrenheit.");', ['0 degrees Celsius is 32 degrees Fahrenheit.'], looked([]))
    ).toBeNull();
    expect(
      madeUpWeather('write one sentence describing the weather in the opening of my novel', 'speak("It was a crisp 4 degrees.");', ['It was a crisp 4 degrees.'], looked([12]))
    ).toBeNull();
  });
});

describe('a wrong answer typed into what the program says', () => {
  // Nine words
  const WORDS = "count the words in 'the quick brown fox jumps over the lazy dog'";

  it('is caught when the request has one answer worked out here, and the typed one is another', () => {
    expect(wrongTypedAnswer(WORDS, 'speak("Word count: 10");', ['Word count: 10'])).toBe(
      '"Word count: 10" is typed into the program, and 10 isn\'t the answer: count the words with text.trim().split(/\\s+/).length in the program and speak the result.'
    );
    expect(wrongTypedAnswer('what is 17 times 23?', 'console.log(`The answer is 381`);', ['The answer is 381'])).toBe(
      '"The answer is 381" is typed into the program, and 381 isn\'t the answer: work out a * b with the request\'s numbers in the program and speak the result.'
    );
    expect(wrongTypedAnswer("what's 15% of 84", 'speak("15% of 84 is 12");', ['15% of 84 is 12'])).toContain("12 isn't the answer");
    expect(wrongTypedAnswer("how many vowels in 'banana split'?", "speak('There are 5 vowels.');", ['There are 5 vowels.'])).toContain('count the vowels');
    expect(wrongTypedAnswer('what is 72°F in Celsius?', 'speak("72°F is 20°C.");', ['72°F is 20°C.'])).toContain('(f - 32) * 5 / 9');
    expect(wrongTypedAnswer("reverse the word 'stressed'", 'speak("Reversed: desstres");', ['Reversed: desstres'])).toBe(
      '"Reversed: desstres" is typed into the program, and "desstres" isn\'t the word reversed: reverse it in the program (text.split(\'\').reverse().join(\'\')) and speak the result.'
    );
    // The answer is never in the message: a fix would copy it
    expect(wrongTypedAnswer(WORDS, 'speak("Word count: 10");', ['Word count: 10'])).not.toMatch(/\b9\b/);
  });

  it('leaves a right answer typed in, rounded as said', () => {
    expect(wrongTypedAnswer('what is 17 times 23?', 'speak("17 times 23 is 391");', ['17 times 23 is 391'])).toBeNull();
    expect(wrongTypedAnswer(WORDS, 'speak("Word count: 9");', ['Word count: 9'])).toBeNull();
    expect(wrongTypedAnswer("what's 15% of 84", 'speak("15% of 84 is 12.6");', ['15% of 84 is 12.6'])).toBeNull();
    expect(wrongTypedAnswer('what is 10 divided by 3', 'speak("About 3.33");', ['About 3.33'])).toBeNull();
    expect(wrongTypedAnswer("reverse 'hello'", 'speak("olleh");', ['olleh'])).toBeNull();
    expect(wrongTypedAnswer("reverse the word 'stressed'", 'speak("Stressed reversed is desserts.");', ['Stressed reversed is desserts.'])).toBeNull();
    // Words that count more than one way: not judged
    expect(wrongTypedAnswer("count the words in 'a well-known idea'", 'speak("3 words");', ['3 words'])).toBeNull();
    expect(wrongTypedAnswer("count the words in 'a 3-step plan — easy'", 'speak("6 words");', ['6 words'])).toBeNull();
    // With the space or without
    expect(wrongTypedAnswer("how many characters in 'hi there'", 'speak("7 characters");', ['7 characters'])).toBeNull();
    expect(wrongTypedAnswer("how many characters in 'hi there'", 'speak("8 characters");', ['8 characters'])).toBeNull();
  });

  it('leaves an answer the program put together, whatever its value, and words with no answer in them', () => {
    expect(wrongTypedAnswer("what's 15% of 84", 'speak("15% of 84 is " + 0.15 * 85);', ['15% of 84 is 12.75'])).toBeNull();
    expect(wrongTypedAnswer("what's 15% of 84", 'const answer = 0.15 * 84;\nspeak(`15% of 84 is ${answer}`);', ['15% of 84 is 12.6'])).toBeNull();
    expect(wrongTypedAnswer('what is 17 times 23?', 'console.log(17 * 23);', ['391'])).toBeNull();
    expect(wrongTypedAnswer("what's 15% of 84", 'speak("Working out 15% of 84.");\nspeak(0.15 * 84);', ['Working out 15% of 84.', '12.6'])).toBeNull();
    // Working typed in, and the answer worked out and said too
    expect(wrongTypedAnswer("what's 15% of 84", 'speak("Step 1: 15% is 0.15");\nspeak(0.15 * 84);', ['Step 1: 15% is 0.15', '12.6'])).toBeNull();
    expect(wrongTypedAnswer("reverse the word 'stressed'", 'speak("Here it is reversed!");', ['Here it is reversed!'])).toBeNull();
  });

  it('leaves requests not worked out here, and things to make', () => {
    expect(wrongTypedAnswer('how many words are in a novel?', 'speak("About 90000 words.");', ['About 90000 words.'])).toBeNull();
    expect(wrongTypedAnswer('what is 2 plus 3 times 4', 'speak("It is 20.");', ['It is 20.'])).toBeNull();
    expect(wrongTypedAnswer('what is half of three quarters', 'speak("It is 0.4.");', ['It is 0.4.'])).toBeNull();
    expect(wrongTypedAnswer('tell me a joke about cats', 'speak("Why did 2 cats...");', ['Why did 2 cats...'])).toBeNull();
    expect(wrongTypedAnswer('a word counter for whatever I type in a text area', 'speak("Words: 0");', ['Words: 0'])).toBeNull();
    expect(wrongTypedAnswer('a tip calculator for a 15% tip on 80', 'speak("Tip: 0");', ['Tip: 0'])).toBeNull();
  });
});

describe('a reply that only says the question again', () => {
  it('is caught as small models said it, in a program or alone', () => {
    // Qwen3 0.6B, each passed before
    expect(onlyRestates("what's 15% of 80", ["What's 15% of 80?"])).toBe("What's 15% of 80?");
    expect(onlyRestates('what is half of three quarters', ['You asked what is half of three quarters.'])).not.toBeNull();
    expect(onlyRestates('should I bring a jacket today?', ['Should I bring a jacket today?'])).not.toBeNull();
    expect(onlyRestates("what's my IP address?", ["What's your IP address?"])).not.toBeNull();
    expect(onlyRestates("what's a good name for a rock band", ["What's a good name for a rock band?"])).not.toBeNull();
    expect(onlyRestates("help me remember my friend's birthday, any tricks?", ["Help me remember my friend's birthday! What can I do?"])).not.toBeNull();
    expect(onlyRestates('Who was Ada Lovelace?', ['Ada Lovelace.'])).not.toBeNull();
    // A choice question said back as a question is no answer
    expect(onlyRestates('Which is bigger, 7 or 9?', ['Which is bigger, 7 or 9?'])).not.toBeNull();
  });

  it("leaves answers in the question's words, a yes or no said as a statement, and questions back", () => {
    expect(onlyRestates('What is the capital of France?', ['The capital of France is Paris.'])).toBeNull();
    expect(onlyRestates("what's 17 times 23", ['17 times 23 is 391'])).toBeNull();
    // Wrong, but an answer
    expect(onlyRestates('is 91 a prime number', ['91 is a prime number.'])).toBeNull();
    expect(onlyRestates('is it raining where I am?', ['It is raining.'])).toBeNull();
    expect(onlyRestates('is it raining where I am?', ['No.'])).toBeNull();
    // A choice answered in the words it offers
    expect(onlyRestates('Which is bigger, 7 or 9?', ['9 is bigger.'])).toBeNull();
    expect(onlyRestates('Is the earth round or flat?', ['The earth is round.'])).toBeNull();
    expect(onlyRestates('Is 7 odd or even?', ['7 is odd.'])).toBeNull();
    // Asking the user to choose
    expect(onlyRestates('Who was Ada Lovelace?', ['Which Ada do you mean?'])).toBeNull();
    expect(onlyRestates('Who is John?', ['Which John?'])).toBeNull();
    // Nothing said, a request to make something, a request that is no question
    expect(onlyRestates('Who was Ada Lovelace?', [])).toBeNull();
    expect(onlyRestates('can you draw a cat?', ['Can you draw a cat?'])).toBeNull();
    expect(onlyRestates('say something encouraging', ['Something encouraging!'])).toBeNull();
  });

  it('is judged only when the card shows nothing and nothing played', () => {
    const run = (runtime: object) =>
      (ConversationOrchestrator.prototype as any).answerFault.call(
        { javascriptRuntime: runtime },
        "what's 15% of 80",
        'const result = 80 * 0.15;\nspeak("What\'s 15% of 80?");',
        { spokenTexts: ["What's 15% of 80?"] },
        { uses: 0 }
      );
    expect(run({ hasVisualContent: () => false, soundUseCount: () => 0 })).toContain('only said the question again');
    expect(run({ hasVisualContent: () => true, soundUseCount: () => 0 })).toBeNull();
    expect(run({ hasVisualContent: () => false, soundUseCount: () => 1 })).toBeNull();
  });
});

describe('a run that said nothing', () => {
  it('is caught when its speak() had no words, as Qwen3 0.6B wrote it', () => {
    expect(saidNothing('speak();', [''])).toBe('The program said nothing: speak() was called with no words. Put the reply in it: speak("…").');
    expect(saidNothing('console.log("Waves and tides in the ocean\'s embrace.");\nspeak();\nspeak()', ['', ''])).toContain("console.log() writes isn't read out");
    expect(saidNothing('const daysLeft = 5;\n\nawait speak();', [''])).not.toBeNull();
    expect(saidNothing("speak('')", [''])).not.toBeNull();
  });

  it('leaves a run that said something, and programs that wait, keep or fetch without words', () => {
    expect(saidNothing('speak("Hi");\nspeak();', ['Hi', ''])).toBeNull();
    // Nothing said, but no empty speak() either (a silent program is not this)
    expect(saidNothing('const x = 1;', [])).toBeNull();
    expect(saidNothing('speak(result);', [''])).toBeNull();
    expect(saidNothing('navigator.clipboard.writeText(new Date().toDateString());\nspeak();', [''])).toBeNull();
    expect(saidNothing('localStorage.setItem("name", "Casey");\nspeak();', [''])).toBeNull();
    expect(saidNothing('setTimeout(() => speak("Time is up"), 300000);\nspeak();', [''])).toBeNull();
    expect(saidNothing('document.addEventListener("keydown", (e) => speak(e.key));\nspeak();', [''])).toBeNull();
  });

  it('is judged only when the card shows nothing and nothing played', () => {
    const run = (runtime: object, stillRunning = false) =>
      (ConversationOrchestrator.prototype as any).answerFault.call({ javascriptRuntime: runtime }, 'write a four-line poem about autumn', 'speak();', { spokenTexts: [''], stillRunning }, { uses: 0 });
    expect(run({ hasVisualContent: () => false, soundUseCount: () => 0 })).toContain('said nothing');
    expect(run({ hasVisualContent: () => true, soundUseCount: () => 0 })).toBeNull();
    expect(run({ hasVisualContent: () => false, soundUseCount: () => 1 })).toBeNull();
    expect(run({ hasVisualContent: () => false, soundUseCount: () => 0 }, true)).toBeNull();
  });
});

describe('a card whose things all show nothing', () => {
  const blank = (request: string, runtime: object, result: object = { spokenTexts: [] }, code = 'document.body.appendChild(document.createElement("div"));') =>
    (ConversationOrchestrator.prototype as any).blankCard.call({ javascriptRuntime: runtime }, request, code, result) as Promise<string | null>;
  const empty = { hasVisualContent: () => true, hasDrawnContent: () => false, emptyElements: () => ['div#count'], networkFacts: () => [], lookedUp: () => ({ weather: [], requests: 0, numbers: [] }) };

  it('is caught for a thing named without a verb, and for a shape the outcome check has no word for', async () => {
    // Qwen2.5 0.5B: an empty <div id="count"> and nothing said
    expect(await blank('a button that counts how many times I click it', empty)).toBe(
      'The program put nothing visible on screen: its canvas has nothing drawn on it, or its elements are empty (div#count have no text and no size). Put text in an element (textContent, innerHTML) or give it a size (a style with width and height), or draw with the 2d context (fillRect, arc, lineTo, fill, stroke, fillText) in a function that is called.'
    );
    // Qwen3.5 2B: an empty red <div>, and words that say it was drawn
    expect(await blank('show a big red heart in the middle of the page', empty, { spokenTexts: ['A big red heart has been drawn in the middle of the page.'] })).toContain('nothing visible');
    // The data it fetched never came: why, too
    expect(await blank('a list of posts', { ...empty, networkFacts: () => ['fetch(posts.json) answered 404'], lookedUp: () => ({ weather: [], requests: 1, numbers: [] }) })).toContain('answered 404.');
  });

  it('leaves a card that shows something, a spoken answer beside an empty element, and what may still come', async () => {
    expect(await blank('a button that counts how many times I click it', { ...empty, hasDrawnContent: () => true })).toBeNull();
    expect(await blank('tell me a joke about cats', empty, { spokenTexts: ['Why did the cat sit on the computer? To keep an eye on the mouse.'] })).toBeNull();
    expect(await blank('a button that counts how many times I click it', empty, { spokenTexts: [], stillRunning: true })).toBeNull();
    // Fetched and answered: a picture may still be loading
    expect(await blank('show a random dog picture from the dog.ceo api', { ...empty, lookedUp: () => ({ weather: [], requests: 1, numbers: [] }) })).toBeNull();
    // A picture still loading, or a fade-in longer than the wait
    expect(await blank('show a big red heart in the middle of the page', { ...empty, stillAppearing: () => true })).toBeNull();
    // Nothing on the card at all is the outcome check's (or nobody's) to judge
    expect(await blank('a button that counts how many times I click it', { ...empty, hasVisualContent: () => false })).toBeNull();
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

  it('says the canvas is painted over when the last thing it did was fill all of it', async () => {
    const said = await outcome(request, nothingShown({ fn: 'paintSky', covered: true } as never), beach);
    expect(said ?? '').toContain('paintSky() paints over the whole canvas after the last drawing.');
    expect((await outcome(request, nothingShown({ fn: null, covered: true } as never), beach)) ?? '').toContain('The whole canvas is painted over after the last drawing.');
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
