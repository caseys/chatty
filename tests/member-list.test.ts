// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { memberList, memberListText, methodHint } from '../src/core/method-hints.ts';
import { errorHint } from '../src/core/error-hints.ts';
import { ConversationOrchestrator } from '../src/core/orchestrator.ts';

// The prototypes of Tone 15.1.22's PolySynth, level by level (the members read from the real library)
/* eslint-disable @typescript-eslint/no-unused-vars */
class Tone {
  log() {}
  dispose() {}
  get disposed() { return false; }
  toString() { return 'Tone'; }
}
class ToneWithContext extends Tone {
  now() {}
  immediate() {}
  get sampleTime() { return 0; }
  get blockTime() { return 0; }
  toSeconds() {}
  toFrequency() {}
  toTicks() {}
  _getPartialProperties() {}
  get() {}
  set() {}
}
class ToneAudioNode extends ToneWithContext {
  get numberOfInputs() { return 1; }
  get numberOfOutputs() { return 1; }
  _isAudioNode() {}
  _getInternalNodes() {}
  _setChannelProperties() {}
  _getChannelProperties() {}
  get channelCount() { return 2; }
  set channelCount(_v: number) {}
  get channelCountMode() { return 'max'; }
  set channelCountMode(_v: string) {}
  connect() {}
  toDestination() {}
  toMaster() {
    console.warn('toMaster() has been renamed toDestination()');
  }
  disconnect() {}
  chain() {}
  fan() {}
  dispose() {}
}
class Instrument extends ToneAudioNode {
  sync() {}
  _syncState() {}
  _syncMethod() {}
  unsync() {}
  triggerAttackRelease() {}
  dispose() {}
}
class PolySynth extends Instrument {
  get activeVoices() { return 0; }
  _makeVoiceAvailable() {}
  _getNextAvailableVoice() {}
  _collectGarbage() {}
  _triggerAttack() {}
  _triggerRelease() {}
  _scheduleEvent() {}
  triggerAttack() {}
  triggerRelease() {}
  triggerAttackRelease() {}
  sync() {}
  set() {}
  get() {}
  releaseAll() {}
  dispose() {}
  static getDefaults() {
    return { context: {}, volume: 0, maxPolyphony: 32, options: {}, voice: {} };
  }
}
class Synth extends Instrument {}
class MembraneSynth extends Instrument {}
class Filter extends ToneAudioNode {}
class Gain extends ToneAudioNode {}
class Param extends ToneWithContext {}
class Loop extends ToneWithContext {}
const scope = { Tone: { PolySynth, Synth, MembraneSynth, Filter, Gain, Param, Loop, Transport: {} } } as unknown as Record<string, unknown>;
// (with the instrument and source bases the library exports, for the connection facts)
class Source extends ToneAudioNode {}
class PluckSynth extends Instrument {}
const sourcesScope = { Tone: { PolySynth, Synth, PluckSynth, MembraneSynth, Filter, Gain, Instrument, Source, Param, Loop } } as unknown as Record<string, unknown>;

describe('what an instance of a library class has', () => {
  it('lists PolySynth’s own methods and settings, cleaned: no plumbing, no underscores, no repeats, nothing deprecated', () => {
    const list = memberList('Tone.PolySynth', 'setInstruments', scope)!;
    // Closest to the wrong name first (set), then the class's own in its order, then inherited; at most 12
    expect(list.methods).toEqual(['set', 'triggerAttack', 'triggerRelease', 'triggerAttackRelease', 'sync', 'get', 'releaseAll', 'dispose', 'unsync', 'connect', 'toDestination', 'disconnect']);
    // Its own accessor (read-only) and the keys of getDefaults() without context; the node's channelCount and the like are plumbing
    expect(list.settings).toEqual([{ name: 'activeVoices', readOnly: true }, { name: 'volume', readOnly: false }, { name: 'maxPolyphony', readOnly: false }, { name: 'options', readOnly: false }, { name: 'voice', readOnly: false }]);
    for (const dropped of ['toMaster', 'now', 'toSeconds', 'sampleTime', 'log', 'channelCount', 'numberOfInputs', '_syncState', 'constructor']) {
      expect([...list.methods, ...list.settings.map((s) => s.name)]).not.toContain(dropped);
    }
  });

  it('is one sentence for the fix: what it is, what it has no, its methods, its settings', () => {
    const code = 'const gMinor = new Tone.PolySynth();\ngMinor.setInstruments({});';
    const hint = methodHint(code, 'gMinor.setInstruments is not a function', scope, 2);
    expect(hint?.text).toBe(
      'gMinor is a Tone.PolySynth (made at line 1); it has no setInstruments(). Its methods: set(), triggerAttack(), triggerRelease(), triggerAttackRelease(), sync(), get(), releaseAll(), dispose(), unsync(), connect(), toDestination(), disconnect(), …. Its settings: activeVoices (read-only), volume, maxPolyphony, options, voice.'
    );
    expect(hint?.correction).toBeUndefined();
    // Through the error hints of the whole program
    expect(errorHint(code, 'gMinor.setInstruments is not a function', 2, { ids: [], scope })?.text).toContain('gMinor is a Tone.PolySynth');
    expect(memberListText('gMinor', 'Tone.PolySynth', 'tempo', 'read', scope)).toContain('gMinor is a Tone.PolySynth; it has no tempo. Its methods:');
  });

  it('lists a canvas’s own members, without those every element has', () => {
    const list = memberList('element:canvas', 'getcontxt')!;
    expect(list.methods).toContain('getContext');
    expect(list.methods).toContain('toDataURL');
    expect(list.methods).toContain('toBlob');
    expect(list.settings.map((s) => s.name)).toEqual(expect.arrayContaining(['width', 'height']));
    // The element plumbing (HTMLElement, Element, Node, EventTarget) is not listed
    for (const plumbing of ['appendChild', 'addEventListener', 'querySelector', 'remove', 'click', 'textContent', 'classList']) {
      expect([...list.methods, ...list.settings.map((s) => s.name)]).not.toContain(plumbing);
    }
    const code = "const canvas = document.createElement('canvas');\ncanvas.getcontxt('2d');";
    expect(methodHint(code, 'canvas.getcontxt is not a function', globalThis as unknown as Record<string, unknown>, 2)?.text ?? '').toBeTruthy();
  });

  it('still names a member of a plumbing level when it is the closest match to the wrong name', () => {
    const list = memberList('element:canvas', 'addEventListner')!;
    expect(list.methods[0]).toBe('addEventListener');
    expect(list.methods).toContain('getContext');
    // (and not the rest of the plumbing)
    expect(list.methods).not.toContain('appendChild');
    // Likewise in the library: toSeconds sits in a plumbing level
    expect(memberList('Tone.PolySynth', 'toSecond', scope)!.methods[0]).toBe('toSeconds');
  });

  it('gives no list for a program’s own object, a namespace, or a class the page does not have', () => {
    expect(methodHint('class Game {}\nconst game = new Game();\ngame.start();', 'game.start is not a function', scope, 3)).toBeNull();
    expect(memberList('Tone.Nothing', 'x', scope)).toBeNull();
    expect(memberListText('Tone', '@Tone', 'x', 'call', scope)).toBeNull();
    expect(memberList('element:div', 'x')).toBeNull();
  });
});

describe('a name written on an object that has no such setting', () => {
  const outcome = (request: string, runtime: object, code = '') =>
    (ConversationOrchestrator.prototype as any).missingOutcome.call({ javascriptRuntime: runtime }, request, { uses: 0, heard: 0, silent: 0 }, code) as Promise<string | null>;
  const writes = { unknownWrites: () => [{ type: 'Tone.PolySynth', name: 'tempo' }], pageScope: () => scope };

  it('is said as a fact with the settings the object has, when the outcome check fails', async () => {
    // Nothing played: the check fails, and the write that did nothing is named
    const silent = { soundUseCount: () => 0, hasVisualContent: () => false, ...writes };
    const error = await outcome('Play a C major chord', silent, 'const synth = new Tone.PolySynth();\nsynth.tempo = 120;');
    expect(error).toContain('The program played nothing');
    expect(error).toContain("tempo isn't a setting of Tone.PolySynth; its settings: activeVoices, volume, maxPolyphony, options, voice.");
    // An element: its own settings
    const element = { soundUseCount: () => 0, hasVisualContent: () => false, unknownWrites: () => [{ type: 'element:canvas', name: 'score' }], pageScope: () => globalThis };
    expect(await outcome('Draw a house', element)).toContain("score isn't a setting of a <canvas> element; its settings: ");
  });

  it('is not said when the check passes, for a class the page can’t list, or without a runtime that reads writes', async () => {
    const heard = { soundUseCount: () => 1, hasVisualContent: () => false, soundHeardCount: () => 1, soundSilentCount: () => 0, ...writes };
    expect(await outcome('Play a C major chord', heard)).toBeNull();
    const unknown = { soundUseCount: () => 0, hasVisualContent: () => false, unknownWrites: () => [{ type: 'Tone.Nothing', name: 'tempo' }], pageScope: () => scope };
    expect(await outcome('Play a C major chord', unknown)).not.toContain("isn't a setting");
    expect(await outcome('Play a C major chord', { soundUseCount: () => 0, hasVisualContent: () => false })).not.toContain("isn't a setting");
  });
});

describe('Tone: something connected into a sound source', () => {
  const error = 'Cannot connect to node with no inputs';
  // The program from the live blues run: instruments connected into instruments
  const code = [
    'const gMinor = new Tone.PolySynth();',
    'const synthPiano = new Tone.PluckSynth();',
    'const reverb = new Tone.Filter();',
    'gMinor.connect(synthPiano, "input", "toDestination");',
    'gMinor.connect(reverb);',
  ].join('\n');

  it('says the target is a sound source with no inputs, for each call on the failing line', () => {
    const hint = errorHint(code, error, 4, { ids: [], scope: sourcesScope });
    expect(hint?.text).toBe('synthPiano is a Tone.PluckSynth, a sound source with no inputs: nothing can be connected into it. It sends sound onward: synthPiano.toDestination(), or synthPiano.connect(an effect that has inputs, such as a Tone.Reverb or Tone.Filter).');
    // Without a line: every call whose target is a source
    expect(errorHint(code, error, undefined, { ids: [], scope: sourcesScope })?.text).toContain('synthPiano is a Tone.PluckSynth');
  });

  it('is not said for a node with inputs, another error, or without the page', () => {
    expect(errorHint(code, error, 5, { ids: [], scope: sourcesScope })?.text ?? '').not.toContain('no inputs: nothing');
    expect(errorHint(code, 'Tone.Reverb is not a constructor', 4, { ids: [], scope: sourcesScope })?.text ?? '').not.toContain('no inputs');
    expect(errorHint(code, error, 4)?.text ?? '').not.toContain('no inputs: nothing');
  });
});

describe('a canvas element and its context, as the live beach program wrote them', () => {
  // The fill that was right: the 2D context of a canvas the program made and added
  const context = 'const ctx = document.body.appendChild(document.createElement("canvas")).getContext("2d");\nctx.scale(1, 1);\nctx.fillStyle = skyColor;\nctx.fillRect(0, 0, 100, 100);';

  it('types a chain by its outermost result: a context, not the canvas inside it', async () => {
    const { objectType } = await import('../src/core/method-hints.ts');
    expect(objectType(context, 'ctx')).toBe('CanvasRenderingContext2D');
    expect(objectType('const c = document.body.appendChild(document.createElement("canvas"));', 'c')).toBe('element:canvas');
    expect(objectType('const c = document.createElement("canvas");', 'c')).toBe('element:canvas');
    expect(objectType('const c = document.createElement("canvas").getContext("2d");', 'c')).toBe('CanvasRenderingContext2D');
    expect(objectType('const d = document.createElement("div").getBoundingClientRect();', 'd')).toBeNull();
  });

  it('does not move ctx.scale, ctx.fillStyle, ctx.fillRect through getContext when ctx already is the context', async () => {
    const { moveToContext } = await import('../src/core/property-check.ts');
    expect(moveToContext(context).moved).toEqual([]);
    // (a real canvas element given drawing calls is still moved)
    expect(moveToContext('const canvas = document.createElement("canvas");\ncanvas.fillRect(0, 0, 9, 9);').moved).toEqual([{ object: 'canvas', members: ['fillRect'] }]);
  });

  it('never says a type has no getContext() and lists getContext() among its methods', () => {
    // The wrong type read from the code (a context taken for the canvas): no fact at all
    const hint = errorHint('const ctx = document.createElement("canvas");\nctx.getContext("2d");', 'ctx.getContext is not a function', 2, { ids: [], scope: globalThis as unknown as Record<string, unknown> });
    expect(hint?.text ?? '').not.toContain('it has no getContext()');
    expect(memberListText('canvas', 'element:canvas', 'getContext', 'call', globalThis as unknown as Record<string, unknown>)).toBeNull();
  });

  it('lists a canvas element’s own members and the single closest inherited one, not the DOM’s plumbing', () => {
    const text = memberListText('canvas', 'element:canvas', 'paint', 'call', globalThis as unknown as Record<string, unknown>);
    expect(text).toContain('getContext()');
    expect(text).toContain('toDataURL()');
    expect(text).toContain('toBlob()');
    expect(text).toContain('width');
    for (const noise of ['getAttributeNames', 'getAttributeNS', 'getAnimations', 'getClientRects', 'getElementsByTagNameNS', 'translate', 'lang', 'cuebackground']) expect(text, noise).not.toContain(noise);
  });
});
