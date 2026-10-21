import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ConversationMemoryStore } from '../src/core/memory-store.ts';
import { ConversationOrchestrator, changedLines, droppedCapabilities, normalizedError, promptRules } from '../src/core/orchestrator.ts';
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

describe('fix bookkeeping', () => {
  it('keys errors without their numbers', () => {
    expect(normalizedError('x is not defined at line 12')).toBe(normalizedError('x is not defined at line 7'));
    expect(normalizedError('x is not defined')).not.toBe(normalizedError('y is not defined'));
  });

  it('remembers what a reply changed, not its first line', () => {
    expect(changedLines('function draw() {\n  boom();\n}', 'function draw() {\n  bang();\n}')).toBe('bang();');
    expect(changedLines('a();\nb();', 'a();\nb();')).toBe('');
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
