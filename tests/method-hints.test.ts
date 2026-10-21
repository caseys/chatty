import { describe, expect, it } from 'vitest';
import { applyCorrection, argumentCountFact, closestMethods, libraryClassName, libraryClassNamed, memberWithMethod, methodHint, missingMethod, nearMiss, objectType, valueMadeAt, withLibraryClassNames } from '../src/core/method-hints.ts';

class FakeContext2D {
  arc() {}
  fill() {}
  fillRect() {}
  fillText() {}
  clearRect() {}
  beginPath() {}
}
const scope = { CanvasRenderingContext2D: FakeContext2D } as unknown as Record<string, unknown>;

describe('missing methods', () => {
  it('reads the object and method from Chrome and Safari errors', () => {
    expect(missingMethod('ctx.fillCircle is not a function')).toEqual({ object: 'ctx', method: 'fillCircle' });
    expect(missingMethod("document.body.clear is not a function. (In 'document.body.clear()', 'document.body.clear' is undefined)")).toEqual({
      object: 'document.body',
      method: 'clear',
    });
    expect(missingMethod("Cannot read properties of undefined (reading 'get')")).toBeNull();
  });

  it('works out what an object is from the code that made it', () => {
    const code = "const canvas = document.createElement('canvas');\nconst ctx = canvas.getContext('2d');";
    expect(objectType(code, 'ctx')).toBe('CanvasRenderingContext2D');
    expect(objectType(code, 'canvas')).toBe('element:canvas');
    expect(objectType(code, 'document.body')).toBe('HTMLElement');
    expect(objectType('const box = document.getElementById("b");', 'box')).toBe('HTMLElement');
    expect(objectType('', 'mystery')).toBeNull();
  });

  it('ranks the real methods closest to the missing one', () => {
    const closest = closestMethods('fillCircle', ['arc', 'fill', 'fillRect', 'beginPath', 'fillText']);
    expect(closest).toContain('fill');
    expect(closest).toContain('fillRect');
    expect(closest).not.toContain('beginPath');
  });

  it('corrects only a sure slip', () => {
    expect(nearMiss('fillrect', ['fillRect', 'fillText'])).toBe('fillRect');
    expect(nearMiss('getElementByID', ['getElementById', 'getElementsByName'])).toBe('getElementById');
    expect(nearMiss('fillCircle', ['fill', 'fillRect', 'arc'])).toBeNull();
  });

  it('gives the fix request the candidates, and a correction for a slip', () => {
    const code = "const ctx = c.getContext('2d');\nctx.fillCircle(1, 2, 3);";
    const hint = methodHint(code, 'ctx.fillCircle is not a function', scope)!;
    expect(hint.text).toMatch(/^ctx is a CanvasRenderingContext2D, which has no fillCircle\(\)\. It has .*\(a method\).*: use the one you meant\.$/);
    expect(hint.text).toContain('fill()');
    expect(hint.correction).toBeUndefined();
    const slip = methodHint("const ctx = c.getContext('2d');\nctx.fillrect(0, 0, 9, 9);", 'ctx.fillrect is not a function', scope)!;
    expect(slip.correction).toEqual({ object: 'ctx', from: 'fillrect', to: 'fillRect' });
  });

  it('renames every call of the slipped method on that object', () => {
    const code = 'ctx.fillrect(0, 0, 1, 1);\nother.fillrect();\nctx . fillrect(2, 2, 1, 1);';
    expect(applyCorrection(code, { object: 'ctx', from: 'fillrect', to: 'fillRect' })).toBe(
      'ctx.fillRect(0, 0, 1, 1);\nother.fillrect();\nctx . fillRect(2, 2, 1, 1);'
    );
  });

  it('knows real browser types (document.body is an element)', () => {
    const hint = methodHint('document.body.clear();', 'document.body.clear is not a function')!;
    expect(hint.text).toContain('document.body is a HTMLElement, which has no clear()');
  });
});

describe('argument count facts', () => {
  class Ctx {
    arc(_x: number, _y: number, _r: number, _s: number, _e: number) {}
    fillRect(_x: number, _y: number, _w: number, _h: number) {}
    beginPath() {}
    fillText(_t: string, _x: number, _y: number, _max?: number) {}
  }
  Object.defineProperty(Ctx.prototype.fillText, 'length', { value: 3 });
  const sc = { CanvasRenderingContext2D: Ctx } as unknown as Record<string, unknown>;
  const code = (call: string) => `const c = document.createElement('canvas');\nconst ctx = c.getContext('2d');\n${call}`;

  it('gives the count and the names for a call with too few (Chrome message)', () => {
    const fact = argumentCountFact(code('ctx.arc(10, 10, 5);'), "Failed to execute 'arc' on 'CanvasRenderingContext2D': 5 arguments required, but only 3 present.", 3, sc);
    expect(fact).toBe('ctx.arc needs 5 arguments (x, y, radius, startAngle, endAngle); this call gives 3.');
  });

  it('works from the failing line alone (Safari message), and counts nested commas once', () => {
    const fact = argumentCountFact(code('ctx.fillRect(Math.max(1, 2), 5);'), 'Not enough arguments', 3, sc);
    expect(fact).toBe('ctx.fillRect needs 4 arguments (x, y, width, height); this call gives 2.');
  });

  it('gives only the count when the names are not known', () => {
    class Other { poke(_a: number, _b: number) {} }
    const fact = argumentCountFact("const a = new AudioContext();\na.poke(1);", 'Not enough arguments', 2, { AudioContext: Other } as unknown as Record<string, unknown>);
    expect(fact).toBe('a.poke needs 2 arguments; this call gives 1.');
  });

  it('says nothing for a complete call, a spread, optional arguments, other errors, or unknown objects', () => {
    const msg = 'Not enough arguments';
    expect(argumentCountFact(code('ctx.arc(1, 2, 3, 4, 5);'), msg, 3, sc)).toBeNull();
    expect(argumentCountFact(code('ctx.arc(...args);'), msg, 3, sc)).toBeNull();
    expect(argumentCountFact(code('ctx.fillText("a", 1, 2);'), msg, 3, sc)).toBeNull();
    expect(argumentCountFact(code('ctx.arc(1, 2);'), 'x is not a function', 3, sc)).toBeNull();
    expect(argumentCountFact('mystery.arc(1, 2);', msg, 1, sc)).toBeNull();
  });
});

describe('a value computed from an element is not the element', () => {
  it('types a name only from a whole making call', () => {
    const code = [
      "const total = parseFloat(document.getElementById('billInput').value) + 1;",
      "const text = document.getElementById('name').value;",
      "const box = document.getElementById('box');",
      "const ctx = await canvas.getContext('2d');",
    ].join('\n');
    expect(objectType(code, 'total')).toBeNull();
    expect(objectType(code, 'text')).toBeNull();
    expect(objectType(code, 'box')).not.toBeNull();
  });
});

describe('names a model reshapes rather than mistypes', async () => {
  const { sureMatch } = await import('../src/core/fuzzy-match.ts');
  class Pages {
    getPage() {}
    getPages() {}
    get page() { return 1; }
  }
  const pages = { CanvasRenderingContext2D: Pages } as unknown as Record<string, unknown>;
  const code = (line: string) => `const ctx = c.getContext('2d');\n${line}`;

  it('adds or drops a conventional verb, and a tie is no answer', () => {
    expect(sureMatch('page', ['getPage', 'getPages'], { reshaped: true })).toBe('getPage');
    expect(sureMatch('page', ['getPage', 'setPage'], { reshaped: true })).toBeNull();
    expect(sureMatch('page', ['getPage'])).toBeNull();
  });

  it('takes a short form only when it points one way, or the program uses that name elsewhere', () => {
    expect(sureMatch('val', ['value', 'validity'], { reshaped: true })).toBeNull();
    expect(sureMatch('val', ['value', 'validity'], { reshaped: true, used: ['value'] })).toBe('value');
  });

  it('corrects a call to the verb form when that method is the only one', () => {
    const hint = methodHint(code('ctx.page();'), 'ctx.page is not a function', pages);
    // page is a property here: a call of it isn't page; getPage() is the method meant
    expect(hint?.correction).toEqual({ object: 'ctx', from: 'page', to: 'getPage' });
  });

  it('lists a property first when a missing method is its verb form, without correcting the kind', () => {
    class Book {
      get page() { return 1; }
      turn() {}
    }
    const hint = methodHint(code('ctx.getPage();'), 'ctx.getPage is not a function', { CanvasRenderingContext2D: Book } as unknown as Record<string, unknown>)!;
    expect(hint.correction).toBeUndefined();
    expect(hint.text).toMatch(/It has ctx\.page \(a property\)/);
  });
});

describe('the libraries a program’s page has (Tone, THREE)', () => {
  // The shapes of Tone's classes that matter here, read as the page gives them
  class Node {
    connect() {}
    toDestination() {
      return this;
    }
    dispose() {}
  }
  class Synth extends Node {
    triggerAttack() {}
    triggerAttackRelease() {}
  }
  class PolySynth extends Synth {
    set() {}
  }
  class MembraneSynth extends Synth {}
  class Loop {
    start() {}
    stop() {}
  }
  const tone = { Synth, PolySynth, MembraneSynth, Loop, Transport: { start() {} }, now: () => 0 };
  const page = { Tone: tone } as unknown as Record<string, unknown>;

  it('types an object by the class it was made from, even through toDestination()', () => {
    expect(objectType('const synth = new Tone.PolySynth().toDestination();', 'synth')).toBe('Tone.PolySynth');
    expect(objectType('const s = new Tone.Synth({ oscillator: { type: "sine" } });', 's')).toBe('Tone.Synth');
    expect(objectType('const m = new THREE.Mesh(g, mat);', 'm')).toBe('THREE.Mesh');
    expect(objectType('const loop = new Tone.Loop(cb, "4n");', 'loop')).toBe('Tone.Loop');
    // Not an object the chain gives back, or a library the program names itself
    expect(objectType('const x = new Tone.Synth().triggerAttack("C4");', 'x')).toBeNull();
    expect(objectType('const y = new Other.Synth();', 'y')).toBeNull();
    expect(objectType('', 'Tone')).toBe('@Tone');
  });

  it('corrects a method name that is a slip of one the class has', () => {
    const code = 'const synth = new Tone.PolySynth().toDestination();\nsynth.triggerAttackrelease("C4", "8n");';
    const hint = methodHint(code, 'synth.triggerAttackrelease is not a function', page);
    expect(hint?.correction).toEqual({ object: 'synth', from: 'triggerAttackrelease', to: 'triggerAttackRelease' });
    expect(hint?.text).toContain('a Tone.PolySynth');
  });

  it('gives the names Tone has when a made-up one is called, and corrects the create… form', () => {
    // The real call from Qwen3 0.6B's blues loop
    const code = 'const synth = Tone.createSynth.createSynth(Tone.createSynth.PolySynth);';
    expect(methodHint(code, 'Tone.createSynth is not a function', page)?.text).toContain('Tone.Synth');
    const plain = 'const synth = Tone.createSynth();';
    expect(methodHint(plain, 'Tone.createSynth is not a function', page)?.correction).toEqual({ object: 'Tone', from: 'createSynth', to: 'Synth' });
  });

  it('says what the value is, where it was made, and which classes do have the method', () => {
    // The failing program: a Loop asked to play notes
    const code = [
      'const loop = new Tone.Loop({ duration: 4, tempo: 120 });',
      'loop.triggerAttackRelease("G4", 0.5);',
      'loop.start();',
    ].join('\n');
    const hint = methodHint(code, 'loop.triggerAttackRelease is not a function', page, 2);
    expect(hint?.text).toContain('loop is a Tone.Loop (made at line 1), which has no triggerAttackRelease().');
    expect(hint?.text).toContain('triggerAttackRelease() belongs to Tone.Synth, Tone.MembraneSynth, Tone.PolySynth.');
    // What it does have
    expect(hint?.text).toContain('It has loop.start() (a method)');
    // No swap of one class for another: the hint corrects nothing
    expect(hint?.correction).toBeUndefined();
    expect(valueMadeAt(code, 'loop.triggerAttackRelease is not a function')).toEqual({ name: 'loop', line: 1 });
    // A name declared twice, or an object that is not a plain name, has no one place
    expect(valueMadeAt('let a = 1;\nlet a = 2;\na.go();', 'a.go is not a function')).toBeNull();
    expect(valueMadeAt('x.y.go();', 'x.y.go is not a function')).toBeNull();
  });

  it('says nothing without the page’s Tone, and leaves a method the class has alone', () => {
    expect(methodHint('const synth = new Tone.PolySynth();\nsynth.triggerAttackrelease("C4");', 'synth.triggerAttackrelease is not a function')).toBeNull();
    expect(methodHint('Tone.createSynth();', 'Tone.createSynth is not a function')).toBeNull();
    expect(methodHint('const synth = new Tone.PolySynth();\nsynth.triggerAttackRelease("C4");', 'synth.triggerAttackRelease is not a function', page)?.correction).toBeUndefined();
  });
});

describe('an object the browser abbreviated', () => {
  // The real line from Qwen3 0.6B's solar system: methods called on the context straight from getElementById()
  const code = [
    'document.getElementById("solarSystemCanvas").getContext("2d").fillRect(0, 0, 100, 100);',
    'document.getElementById("solarSystemCanvas").getContext("2d").fillArc(0, 0, 100, 100, 0, 180, 0, 180);',
  ].join('\n');
  const error = 'document.getElementById(...).getContext(...).fillArc is not a function';

  it('is typed from the code that makes it, and its real methods are offered', () => {
    const hint = methodHint(code, error, scope, 2);
    expect(hint?.text).toContain('document.getElementById("solarSystemCanvas").getContext("2d") is a CanvasRenderingContext2D, which has no fillArc().');
    expect(hint?.text).toMatch(/It has \.[a-zA-Z]+\([^)]*\) \(a method\)[^:]*(?:arc|fillRect|fill)/);
    expect(hint?.correction).toBeUndefined();
  });

  it('is corrected, at the name, when the slip is sure', () => {
    const slip = 'document.getElementById("c").getContext("2d").fillrect(0, 0, 10, 10);';
    const hint = methodHint(slip, 'document.getElementById(...).getContext(...).fillrect is not a function', scope, 1);
    expect(hint?.correction?.to).toBe('fillRect');
    expect(applyCorrection(slip, hint!.correction!)).toBe('document.getElementById("c").getContext("2d").fillRect(0, 0, 10, 10);');
  });

  it('says nothing for an object that is not clear', () => {
    expect(methodHint('make().draw();', 'make(...).draw is not a function', scope, 1)).toBeNull();
    expect(methodHint('a.b(1).c(2);\nx.y(3).c(4);', 'a.b(...).c is not a function', scope, 1)).toBeNull();
    expect(methodHint(code, error, scope)?.text).toContain('has no fillArc()');
  });
});

describe('real members when nothing is close', () => {
  class Synth {}
  class PolySynth extends Synth {}
  class MembraneSynth extends Synth {}
  class Loop {
    start() {}
  }
  const Tone = { Synth, PolySynth, MembraneSynth, Loop, Transport: { start() {}, stop() {}, schedule() {}, bpm: {} }, now: () => 0 };
  const scope = { Tone, Math } as unknown as Record<string, unknown>;

  it('names what a namespace makes with new, as for the Tone.create(...) the blues programs call', () => {
    // The real call: nothing in Tone is close to "create"
    const hint = methodHint('const synth = Tone.create("PolySynth");', 'Tone.create is not a function', scope, 1);
    expect(hint?.text).toBe('Tone has no create(); things are made with new: Tone.Loop, Tone.Synth, Tone.MembraneSynth, Tone.PolySynth.');
    expect(hint?.correction).toBeUndefined();
  });

  it('names the members that share a word with the name, in place of the closest names', () => {
    const hint = methodHint('Tone.buildSynth();', 'Tone.buildSynth is not a function', scope, 1);
    expect(hint?.text).toBe('Tone has no buildSynth(); the members that share a word with it: Tone.Synth, Tone.PolySynth, Tone.MembraneSynth.');
  });

  it('reads an object the types do not know from the page: Tone.Transport has start(), not begin()', () => {
    const hint = methodHint('Tone.Transport.begin();', 'Tone.Transport.begin is not a function', scope, 1);
    expect(hint?.text).toContain('Tone.Transport has no begin()');
    expect(hint?.text).toContain('Tone.Transport.start()');
    // A sure slip is corrected there too
    const slip = methodHint('Tone.Transport.strat();', 'Tone.Transport.strat is not a function', scope, 1);
    expect(slip?.correction).toEqual({ object: 'Tone.Transport', from: 'strat', to: 'start' });
  });

  it('says nothing for a program’s own object, or without the page', () => {
    expect(methodHint('const Tone = { go() {} };\nTone.create();', 'Tone.create is not a function', scope, 2)).toBeNull();
    expect(methodHint('Tone.Transport.begin();', 'Tone.Transport.begin is not a function', undefined, 1)).toBeNull();
  });
});

describe('a method that belongs to a setting of an audio node', () => {
  // The shapes of the browser's: a node whose settings are AudioParams (with setValueAtTime)
  class AudioNode {
    connect() {}
  }
  class Param {
    value = 0;
    setValueAtTime() {}
    linearRampToValueAtTime() {}
  }
  class GainNode extends AudioNode {
    get gain() {
      return new Param();
    }
  }
  class OscillatorNode extends AudioNode {
    start() {}
    get frequency() {
      return new Param();
    }
    get detune() {
      return new Param();
    }
  }
  class OfflineAudioContext {
    suspend() {}
    resume() {}
  }
  const audio = { AudioNode, AudioParam: Param, GainNode, OscillatorNode, OfflineAudioContext, AudioContext: class {} } as unknown as Record<string, unknown>;

  it('is called through the one setting that has it, as Qwen3 0.6B wrote for a siren', () => {
    // The real call: setValueAtTime on the gain node itself
    const code = 'const audioContext = new AudioContext();\nconst gain = audioContext.createGain();\ngain.setValueAtTime(0.5, 0);\ngain.gain.setValueAtTime(1, 1);';
    const hint = methodHint(code, 'gain.setValueAtTime is not a function', audio, 3);
    expect(hint?.correction).toEqual({ object: 'gain', from: 'setValueAtTime', to: 'gain.setValueAtTime' });
    // Only the call on the node is changed: the right one a line later keeps its single gain
    expect(applyCorrection(code, hint!.correction!)).toBe('const audioContext = new AudioContext();\nconst gain = audioContext.createGain();\ngain.gain.setValueAtTime(0.5, 0);\ngain.gain.setValueAtTime(1, 1);');
  });

  it('never goes through a node’s context: suspend() on a gain node is not gain.context.suspend(), which would stop the page’s audio', () => {
    // The browser's nodes carry their context, which has suspend() and resume() (the reviewer's probe)
    class BaseContext {
      suspend() {}
      resume() {}
    }
    class Offline extends BaseContext {}
    class Gain extends AudioNode {
      _context = new Offline();
      get context() {
        return this._context;
      }
      get gain() {
        return new Param();
      }
    }
    const withContext = { AudioNode, AudioParam: Param, GainNode: Gain, OfflineAudioContext: Offline, AudioContext: class {} } as unknown as Record<string, unknown>;
    const code = 'const ctx = new AudioContext();\nconst gainNode = ctx.createGain();\ngainNode.connect(ctx.destination);\ngainNode.suspend();';
    expect(memberWithMethod('GainNode', 'suspend', withContext)).toBeNull();
    expect(methodHint(code, 'gainNode.suspend is not a function', withContext, 4)?.correction).toBeUndefined();
    // The setting that does have the method is still found
    expect(memberWithMethod('GainNode', 'setValueAtTime', withContext)).toBe('gain');
    expect(methodHint(code.replace('suspend()', 'setValueAtTime(0, 0)'), 'gainNode.setValueAtTime is not a function', withContext, 4)?.correction?.to).toBe('gain.setValueAtTime');
  });

  it('is left to the facts when several settings have it, or none', () => {
    // An oscillator's frequency and detune both take setValueAtTime
    const osc = 'const audioContext = new AudioContext();\nconst osc = audioContext.createOscillator();\nosc.setValueAtTime(440, 0);';
    expect(methodHint(osc, 'osc.setValueAtTime is not a function', audio, 3)?.correction).toBeUndefined();
    expect(memberWithMethod('GainNode', 'setValueAtTime', audio)).toBe('gain');
    expect(memberWithMethod('GainNode', 'nothing', audio)).toBeNull();
    expect(memberWithMethod('OscillatorNode', 'setValueAtTime', audio)).toBeNull();
    // Not an audio node, or no audio in the page
    expect(memberWithMethod('Param', 'setValueAtTime', audio)).toBeNull();
    expect(memberWithMethod('GainNode', 'setValueAtTime', {})).toBeNull();
  });
});

describe('a library class the bundle shortened (Safari: "an instance of e")', () => {
  // A bundle's class for Tone.Param, whose own name was minified to e
  const e = class {
    value = 0;
    rampTo() {}
    setValueAtTime() {}
  };
  Object.defineProperty(e, 'name', { value: 'e' });
  const Transport = { bpm: new e(), start() {} };
  const scope = { Tone: { Param: e, Transport } } as unknown as Record<string, unknown>;
  // The real message from the live log (iPhone Safari)
  const safari = "Tone.Transport.bpm is not a function. (In 'Tone.Transport.bpm(value = tempo)', 'Tone.Transport.bpm' is an instance of e)";
  const code = 'const tempo = 120;\nTone.Transport.bpm(value = tempo);';

  it('names the class by the library’s own export', () => {
    expect(withLibraryClassNames(safari, code, scope)).toBe(safari.replace('instance of e', 'instance of Tone.Param'));
    expect(libraryClassName(Transport.bpm, scope)).toBe('Tone.Param');
    // Another error, an object the page doesn't have, or a name that is the export's already: as it was
    expect(withLibraryClassNames('x is not defined', code, scope)).toBe('x is not defined');
    expect(withLibraryClassNames("... 'Tone.Nothing.go' is an instance of e)", code, scope)).toBe("... 'Tone.Nothing.go' is an instance of e)");
    expect(withLibraryClassNames("... 'Tone.Transport.bpm' is an instance of Tone.Param)", code, scope)).toBe("... 'Tone.Transport.bpm' is an instance of Tone.Param)");
  });

  it('says what the value is and what it has, when a value is called as a function', () => {
    const hint = methodHint(code, safari, scope, 2);
    expect(hint?.text).toBe('Tone.Transport.bpm is a Tone.Param, not a function; it has .value, .rampTo(), .setValueAtTime().');
    expect(hint?.correction).toBeUndefined();
    // A function of the same object is not told that
    expect(methodHint('Tone.Transport.begin();', 'Tone.Transport.begin is not a function', scope, 1)?.text).not.toContain('not a function; it has');
  });
});

describe('a library class the bundle shortened (Chrome: "Class constructor Cu")', () => {
  // The built bundle's Tone.PolySynth is called Cu; a second export is a class named differently
  class Cu {
    triggerAttackRelease() {}
  }
  class Synth {
    triggerAttackRelease() {}
  }
  const scope = { Tone: { PolySynth: Cu, Synth, now: () => 0 } } as unknown as Record<string, unknown>;
  const chrome = "Class constructor Cu cannot be invoked without 'new'";
  const code = 'const synth = Tone.PolySynth().toDestination();';

  it('names the export whose class is called that', () => {
    expect(withLibraryClassNames(chrome, code, scope)).toBe("Class constructor Tone.PolySynth cannot be invoked without 'new'");
    expect(withLibraryClassNames(`TypeError: ${chrome} (at line 1)`, code, scope)).toBe("TypeError: Class constructor Tone.PolySynth cannot be invoked without 'new' (at line 1)");
    expect(libraryClassNamed('Cu', code, scope)).toBe('Tone.PolySynth');
  });

  it('leaves a class of the program’s own, a name no export has, a tie and other text alone', () => {
    const own = 'class Ball {}\nconst ball = Ball();';
    expect(withLibraryClassNames("Class constructor Ball cannot be invoked without 'new'", own, scope)).toBe("Class constructor Ball cannot be invoked without 'new'");
    expect(withLibraryClassNames("Class constructor Zz cannot be invoked without 'new'", code, scope)).toBe("Class constructor Zz cannot be invoked without 'new'");
    // A program that declares the shortened name itself: its own
    expect(withLibraryClassNames(chrome, 'class Cu {}\nCu();', scope)).toBe(chrome);
    // Two exports with that class name: no way to say which
    class Twin {}
    const tied = { Tone: { PolySynth: Cu, Other: Twin } } as unknown as Record<string, unknown>;
    Object.defineProperty(Twin, 'name', { value: 'Cu' });
    expect(withLibraryClassNames(chrome, code, tied)).toBe(chrome);
    // The name only counts in its slot: other words stay
    const word = 'Cu is not a function; Class constructor Cu is something else';
    expect(withLibraryClassNames(word, code, scope)).toBe(word);
    // An export that is a function but no class
    expect(libraryClassNamed('now', code, { Tone: { now: function now() { return 0; } } })).toBeNull();
  });
});
