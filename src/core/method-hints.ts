/**
 * Missing methods. Models call methods that don't exist (ctx.fillCircle, document.body.clear,
 * clearIntreval). When a program fails with "x.m is not a function", this works out what x is
 * (from the program's own code or the globals it names), reads its real method names from the
 * browser's prototypes, and ranks the closest. A near-miss (a typo or wrong case) is corrected
 * without the model; otherwise the candidates go into the fix request, so the model picks from
 * a list instead of guessing again.
 */
import { parse, parseExpressionAt } from 'acorn';
import { MIDI_OUTPUT, MIDI_PLAIN_FORM } from './midi-form.ts';
import { closestNames, editDistance, flatName, NAME_VERBS, nameWords, sureMatch } from './fuzzy-match.ts';

/** The object and the method a "not a function" error names, or null */
export function missingMethod(error: string): { object: string; method: string } | null {
  // Chrome: "a.b.m is not a function"; Safari: "undefined is not a function (evaluating 'a.b.m(...)')"
  const match =
    error.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*) is not a function/) ??
    error.match(/(?:undefined|null) is not a function \(evaluating '([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)\(/);
  return match ? { object: match[1], method: match[2] } : null;
}

/**
 * The object and the member a "not a constructor" error names (`new Tone.Melody()`), or null. Chrome:
 * "Tone.Melody is not a constructor"; Safari: "undefined is not a constructor (evaluating 'new Tone.Melody()')".
 */
export function missingConstructor(error: string): { object: string; method: string } | null {
  const path = '([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\.([A-Za-z_$][\\w$]*)';
  const match =
    error.match(new RegExp(`${path} is not a constructor`)) ?? error.match(new RegExp(`(?:undefined|null) is not a constructor \\(evaluating 'new ${path}\\(`));
  return match ? { object: match[1], method: match[2] } : null;
}

/**
 * Types the page's programs get that this window may not have under their browser names (Chatty's software MIDI is the
 * MIDIAccess and MIDIOutput of every program, on a browser that has no Web MIDI too): registered by the runtime
 */
const REGISTERED: Record<string, unknown> = {};
export function registerBrowserTypes(types: Record<string, unknown>): void {
  Object.assign(REGISTERED, types);
}
/** The class of a browser type: the scope's own, else a registered one */
export function typeClass(type: string, scope: Record<string, unknown>): unknown {
  return scope[type] ?? REGISTERED[type];
}

/** What a value made by this code is: a browser type name, or a known object */
const MADE_BY: ReadonlyArray<[RegExp, string]> = [
  [/\brequestMIDIAccess\s*\(/, 'MIDIAccess'],
  [/getContext\(\s*['"]2d['"]/, 'CanvasRenderingContext2D'],
  [/getContext\(\s*['"]webgl2['"]/, 'WebGL2RenderingContext'],
  [/getContext\(\s*['"](?:experimental-webgl|webgl)['"]/, 'WebGLRenderingContext'],
  [/new\s+(?:window\.)?(?:webkit)?AudioContext\b|AudioContext\s*\|\|/, 'AudioContext'],
  [/(?:getElementById|querySelector|closest)\(|\.(?:parentElement|firstElementChild|lastElementChild)\b/, 'HTMLElement'],
  [/^\s*\[/, 'Array'],
  [/^\s*['"`]/, 'String'],
  [/^\s*new\s+Map\b/, 'Map'],
  [/^\s*new\s+Set\b/, 'Set'],
  [/^\s*new\s+Date\b/, 'Date'],
];

/** Objects programs reach by name */
const NAMED: Record<string, string> = {
  document: 'Document',
  'document.body': 'HTMLElement',
  'document.documentElement': 'HTMLElement',
  root: 'HTMLElement',
  window: 'Window',
  Math: '@Math',
  JSON: '@JSON',
  console: '@console',
  navigator: '@navigator',
  out: '@out',
  // The libraries Chatty puts in a program's page: named once the page is the scope (see PageFacts.scope)
  Tone: '@Tone',
  THREE: '@THREE',
};

/** Tone methods that give back the object they were called on, so a chain of them still is that object */
const GIVES_BACK_THIS = new Set(['toDestination', 'toMaster', 'connect', 'chain', 'fan', 'sync']);

/** The type (or named object) the object expression refers to in this program, or null */
/** A name the program declares exactly once, and never as a parameter or loop variable */
function declaredOnce(code: string, name: string): boolean {
  const n = name.replace(/\$/g, '\\$');
  const declarations = code.match(new RegExp(`\\b(?:const|let|var)\\s+${n}\\b`, 'g'))?.length ?? 0;
  const asParameter =
    [...code.matchAll(/function\b[^(]*\(([^)]*)\)|\(([^()]*)\)\s*=>/g)].some((m) => new RegExp(`(^|[^\\w$])${n}([^\\w$]|$)`).test(m[1] ?? m[2] ?? '')) ||
    new RegExp(`(^|[^\\w$.])${n}\\s*=>`).test(code);
  return declarations === 1 && !asParameter;
}

/** The audio node types the context's create…() methods make, for where this browser lacks the type */
const NODE_MADE_BY: Record<string, string> = { Oscillator: 'OscillatorNode', Gain: 'GainNode', BiquadFilter: 'BiquadFilterNode' };

/**
 * The audio node an AudioContext's `create…()` makes (`ctx.createAnalyser()` is an AnalyserNode):
 * the browser's own type of that name, where it is one of its audio nodes; a few common ones
 * by the table above where the browser lacks the type. Only on something known to be an
 * AudioContext: a program's own factory may name its methods the same way.
 */
function audioNodeMadeBy(expression: string, code: string): string | null {
  const made = expression.match(/^\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\.\s*create([A-Z]\w*)\s*\(/);
  if (!made || objectType(code, made[1]) !== 'AudioContext') return null;
  const kind = made[2];
  const name = kind === 'BufferSource' ? 'AudioBufferSourceNode' : `${kind}Node`;
  const g = globalThis as unknown as Record<string, unknown>;
  const ctor: unknown = g[name];
  const base: unknown = g.AudioNode;
  if (typeof ctor === 'function' && typeof base === 'function' && ctor.prototype instanceof base) return name;
  return typeof base === 'function' ? null : (NODE_MADE_BY[kind] ?? null);
}

/** The type of what an expression makes: `canvas.getContext('2d')`, `createElement('canvas')` */
function typeMadeBy(expression: string, code = ''): string | null {
  // Only when the whole value is the call (or `new`) that makes it: in
  // `parseFloat(document.getElementById('a').value) + 1` or `getElementById('a').value` the
  // lookup is part of the value, not what it is
  type Top = { type: string; argument?: Top };
  let top: Top | undefined;
  try {
    top = parseExpressionAt(expression, 0, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true }) as unknown as Top;
  } catch {
    return null;
  }
  // The first output of a MIDI access: [...midi.outputs.values()][0], midi.outputs.values().next().value
  if (/^\[\s*\.\.\.[\s\S]*\.outputs\b[\s\S]*\]\s*\[\s*\d+\s*\]\s*$|\.outputs\.values\(\)\.next\(\)\.value\s*$|^Array\.from\([\s\S]*\.outputs\.values\(\)\)\s*\[\s*\d+\s*\]\s*$/.test(expression.trim())) return 'MIDIOutput';
  if (top.type === 'AwaitExpression') top = top.argument;
  // A value written out: a list, a string, a number, a pattern: what the language itself makes of it
  const literal = top as unknown as { type: string; value?: unknown; regex?: unknown };
  if (literal.type === 'ArrayExpression') return 'Array';
  if (literal.type === 'TemplateLiteral') return 'String';
  if (literal.type === 'Literal') return literal.regex ? 'RegExp' : typeof literal.value === 'string' ? 'String' : typeof literal.value === 'number' ? 'Number' : null;
  if (!top || !/^(?:CallExpression|NewExpression)$/.test(top.type)) return null;
  // A class of a library the page has (new Tone.Synth().toDestination(), new THREE.Mesh(a, b))
  type Loose = { type: string; callee?: Loose; object?: Loose; property?: { name?: string }; name?: string; computed?: boolean };
  let made = top as unknown as Loose;
  while (made.type === 'CallExpression' && made.callee?.type === 'MemberExpression' && !made.callee.computed && GIVES_BACK_THIS.has(made.callee.property?.name ?? '') && made.callee.object) {
    made = made.callee.object;
  }
  if (made.type === 'NewExpression' && made.callee?.type === 'MemberExpression' && !made.callee.computed && made.callee.object?.type === 'Identifier' && /^(?:Tone|THREE)$/.test(made.callee.object.name ?? '')) {
    return `${made.callee.object.name}.${made.callee.property?.name}`;
  }
  // The type of a chain is its outermost result: appendChild gives back what it was handed, getContext a context
  // (`document.body.appendChild(document.createElement("canvas")).getContext("2d")` is a 2D context, not a canvas)
  const outer = top as unknown as Loose & { arguments?: Array<{ start: number; end: number }> };
  const outerName =
    outer.type === 'CallExpression' ? (outer.callee?.type === 'MemberExpression' && !outer.callee.computed ? outer.callee.property?.name : outer.callee?.type === 'Identifier' ? outer.callee.name : undefined) : undefined;
  if (outerName === 'appendChild' && outer.arguments?.[0]) return typeMadeBy(expression.slice(outer.arguments[0].start, outer.arguments[0].end), code);
  const tag = outerName === 'createElement' ? expression.match(/createElement\(\s*['"]([\w-]+)['"]/)?.[1] : undefined;
  if (tag) return `element:${tag.toLowerCase()}`;
  const node = audioNodeMadeBy(expression, code);
  if (node) return node;
  for (const [made, type] of MADE_BY) if (made.test(expression)) return type;
  return null;
}

/** The type of what an expression makes (a context from getContext, an element from createElement, a list, a text), or null */
export function typeOfExpression(expression: string, code = ''): string | null {
  return typeMadeBy(expression, code);
}

/**
 * The type (or named object) an object path refers to in this program, or null when unsure:
 * a name is typed only from its own single declaration, and a member path (`canvas.style`,
 * `document.body`) only when what it hangs off is itself a known element or document
 */
export function objectType(code: string, object: string): string | null {
  if (NAMED[object]) return NAMED[object];
  const segments = object.split('.');
  if (segments.length === 1) {
    const name = segments[0];
    // The access handed to the callback of requestMIDIAccess().then(…)
    const handed = code.match(/requestMIDIAccess\s*\([^)]*\)\s*\.then\(\s*(?:async\s*)?(?:function\s*\(\s*([A-Za-z_$][\w$]*)|\(\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*=>)/);
    if (handed && (handed[1] ?? handed[2] ?? handed[3]) === name) return 'MIDIAccess';
    if (!declaredOnce(code, name)) return null;
    const init = code.match(new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=(?!=)\\s*([^;\\n]+)`))?.[1];
    return init ? typeMadeBy(init, code) : null;
  }
  const last = segments[segments.length - 1];
  const headType = objectType(code, segments.slice(0, -1).join('.'));
  const elementish = !!headType && (/^HTML|^SVG|^element:/.test(headType) || headType === 'Document');
  if (!elementish) return null;
  if (last === 'style') return 'CSSStyleDeclaration';
  if (last === 'classList') return 'DOMTokenList';
  if (/^(body|parentElement|firstElementChild|lastElementChild|documentElement)$/.test(last)) return 'HTMLElement';
  return null;
}

/** How a type reads in a message: 'a CanvasRenderingContext2D', 'a <canvas> element' */
export function typeLabel(type: string, object: string): string {
  if (type.startsWith('@')) return object;
  if (type.startsWith('element:')) return `a <${type.slice(8)}> element`;
  const builtIn: Record<string, string> = { Array: 'an array', String: 'a string', Number: 'a number', RegExp: 'a regular expression' };
  return builtIn[type] ?? `a ${type}`;
}

/**
 * What to read names from for a type: an element made by tag is asked directly (a real one);
 * an element of unknown tag gets the names of every element type (a name only needs to exist on
 * some element); a named object is itself; anything else is its prototype
 */
export function namesSources(type: string, scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): unknown[] {
  if (type.startsWith('@')) return [scope[type.slice(1)]];
  if (type.startsWith('element:')) {
    try {
      return [(scope.document as Document | undefined)?.createElement(type.slice(8))];
    } catch {
      return [];
    }
  }
  if (type === 'HTMLElement') {
    return Object.getOwnPropertyNames(scope)
      .filter((key) => /^(?:HTML|SVG)\w*Element$/.test(key))
      .map((key) => (scope[key] as { prototype?: unknown } | undefined)?.prototype);
  }
  // A class of a library (Tone.Synth): found by its path from the page
  if (type.includes('.')) {
    let at: unknown = scope;
    for (const segment of type.split('.')) at = (at as Record<string, unknown> | undefined)?.[segment];
    return [(at as { prototype?: unknown } | undefined)?.prototype];
  }
  return [(typeClass(type, scope) as { prototype?: unknown } | undefined)?.prototype];
}

/** Every member name (methods and properties) of a browser type, own and inherited (not Object's own: valueOf, toString) */
function memberNamesOf(type: string, scope?: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const plain = new Set(Object.getOwnPropertyNames(Object.prototype));
  if (type === 'CSSStyleDeclaration') {
    // Style properties live on the style object itself in some browsers: ask a real one
    try {
      const style = ((scope ?? globalThis) as { document?: Document }).document?.createElement('div').style as unknown as Record<string, unknown> | undefined;
      if (style) for (const key in style) if (/^[A-Za-z_$][\w$]*$/.test(key) && !plain.has(key)) names.add(key);
    } catch {
      // No document here
    }
  }
  for (const source of namesSources(type, scope)) {
    let target: unknown = source;
    while (target && !isRootPrototype(target)) {
      for (const key of Object.getOwnPropertyNames(target)) {
        if (key !== 'constructor' && !key.startsWith('_') && !plain.has(key) && /^[A-Za-z_$][\w$]*$/.test(key)) names.add(key);
      }
      target = Object.getPrototypeOf(target);
    }
  }
  return [...names];
}

/**
 * The members closest to a missing one, for a hint: of the kind its use asks for (methods for a
 * call, properties for a read or write), with any of the other kind that is the same name
 * reshaped put first (getPage() where the object has page)
 */
export function closestMembers(type: string, missing: string, isCall: boolean, scope?: Record<string, unknown>, count = 3): string[] {
  const all = memberNamesOf(type, scope);
  const wanted = all.filter((n) => (memberKind(type, n, scope) === 'method') === isCall);
  const flat = flatName(missing);
  const reshapedOther = all.filter((n) => {
    if ((memberKind(type, n, scope) === 'method') === isCall) return false;
    const f = flatName(n);
    return NAME_VERBS.some((v) => f === v + flat || flat === v + f) || f === flat;
  });
  return [...new Set([...reshapedOther, ...closestNames(missing, wanted, count)])].slice(0, count);
}

/** Every method name of a browser type or known object (own and inherited) */
export function methodNames(type: string, scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const source of namesSources(type, scope)) {
    let target: unknown = source;
    while (target && !isRootPrototype(target)) {
      for (const key of Object.getOwnPropertyNames(target)) {
        if (key === 'constructor' || key.startsWith('_')) continue;
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if (descriptor && typeof descriptor.value === 'function') names.add(key);
      }
      target = Object.getPrototypeOf(target);
    }
  }
  return [...names];
}


/** Words of a camelCase name: fillCircle → fill, circle */
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_]+/).filter(Boolean);

/** The real methods closest to the missing one, best first (see fuzzy-match.ts) */
export function closestMethods(missing: string, names: string[], count = 3): string[] {
  return closestNames(missing, names, count);
}

/** The methods of the browser's CanvasRenderingContext2D (a canvas's 2D drawing context) */
export const CONTEXT_2D_METHODS = new Set([
  'arc', 'arcTo', 'beginPath', 'bezierCurveTo', 'clearRect', 'clip', 'closePath', 'createLinearGradient',
  'createPattern', 'createRadialGradient', 'drawImage', 'ellipse', 'fill', 'fillRect', 'fillText', 'getImageData',
  'lineTo', 'measureText', 'moveTo', 'putImageData', 'quadraticCurveTo', 'rect', 'restore', 'rotate', 'roundRect',
  'save', 'scale', 'setTransform', 'stroke', 'strokeRect', 'strokeText', 'transform', 'translate',
]);

/** The one real method a missing name is surely a slip of (wrong case, a typo), or null (see fuzzy-match.ts) */
export function nearMiss(missing: string, names: string[]): string | null {
  return sureMatch(missing, names);
}

// ============================================================================
// What an object really has. The members of a real value (an instance, a namespace like Tone or
// Math, a class's statics), read from the page's own prototypes, each as a class (made with new), a
// function, or a plain value. Accessors are never called. Used for the member blank, the real
// names in an error and the repair of `new` on an object that is no class.
// ============================================================================

export interface RealMember {
  name: string;
  kind: 'class' | 'function' | 'property';
}

/**
 * Whether an object is the root of a chain: Object.prototype or Function.prototype, of this realm or of the
 * program's page (an iframe has its own, which `=== Object.prototype` does not match): what every object has is
 * not what this object has
 */
export function isRootPrototype(target: unknown): boolean {
  if (target === Object.prototype || target === Function.prototype) return true;
  if (typeof target !== 'object' && typeof target !== 'function') return false;
  try {
    const own = (name: string) => Object.prototype.hasOwnProperty.call(target, name);
    const root = Object.getPrototypeOf(target) === null && own('isPrototypeOf') && own('propertyIsEnumerable');
    const fn = own('call') && own('apply') && own('bind') && own('toString') && own('constructor');
    return root || fn;
  } catch {
    return false;
  }
}

const FUNCTION_INTRINSICS = new Set(['constructor', 'prototype', 'length', 'name', 'caller', 'arguments', 'callee']);

/** Whether a function is a class (`class X`), or a capitalized function with a prototype of methods (a native constructor) */
export function classLike(fn: (...args: unknown[]) => unknown, name: string): boolean {
  try {
    if (/^class\b/.test(Function.prototype.toString.call(fn))) return true;
  } catch {
    // not readable as text
  }
  const proto = (fn as unknown as { prototype?: object }).prototype;
  return /^[A-Z]/.test(name) && !!proto && Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor').length > 0;
}

/** Own and inherited members of a real value: the prototype chain up to Object's (and Function's) */
export function membersOfValue(value: unknown): RealMember[] {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return [];
  const found = new Map<string, RealMember>();
  let target: unknown = value;
  for (let hops = 0; target && hops < 12 && !isRootPrototype(target); hops++) {
    for (const key of Object.getOwnPropertyNames(target)) {
      if (FUNCTION_INTRINSICS.has(key) || key.startsWith('_') || !/^[A-Za-z$][\w$]*$/.test(key) || found.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor) continue;
      const member = descriptor.value;
      found.set(key, { name: key, kind: typeof member === 'function' ? (classLike(member, key) ? 'class' : 'function') : 'property' });
    }
    target = Object.getPrototypeOf(target);
  }
  return [...found.values()];
}

/**
 * What the object an expression names really has: a typed object (made by `new Tone.Synth()`,
 * `getContext('2d')`, `createElement('div')`) by its prototype, a global path (Tone, Math,
 * Tone.Transport, document.body) by walking it from the page. Null when it can't be found.
 */
export function realMembers(code: string, expression: string, scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): { label: string; members: RealMember[]; namespace: boolean } | null {
  const first = expression.split('.')[0];
  const declaredHere = new RegExp(`(?:const|let|var|function|class)\\s+${first.replace(/\$/g, '\\$')}\\b`).test(code);
  let type = objectType(code, expression);
  // A well-known name (Tone, Math, document) that the program declares for itself is its own
  if (type?.startsWith('@') && declaredHere) type = null;
  if (type) {
    const members = new Map<string, RealMember>();
    for (const source of namesSources(type, scope)) for (const member of membersOfValue(source)) if (!members.has(member.name)) members.set(member.name, member);
    if (members.size === 0) return null;
    return { label: typeLabel(type, expression), members: [...members.values()], namespace: type.startsWith('@') };
  }
  const path = expression.split('.');
  if (path.length > 3 || !path.every((segment) => /^[A-Za-z_$][\w$]*$/.test(segment))) return null;
  // A name the program declares itself is its own, not the page's
  if (new RegExp(`(?:const|let|var|function|class)\\s+${path[0].replace(/\$/g, '\\$')}\\b`).test(code)) return null;
  let value: unknown = scope[path[0]];
  try {
    for (const segment of path.slice(1)) value = (value as Record<string, unknown> | null | undefined)?.[segment];
  } catch {
    return null;
  }
  const members = membersOfValue(value);
  return members.length ? { label: expression, members, namespace: typeof value === 'object' && members.filter((m) => m.kind === 'class').length >= members.length / 2 } : null;
}

/**
 * What a library value is, by the library's own name for its class: the export whose class made it
 * ("Tone.Param"), found by walking the library's exports (a bundle shortens its own class names:
 * Safari says "an instance of e"). A browser object gives its own constructor's name. Null when
 * the value is not an object or its class has no name here.
 */
export function libraryClassName(value: unknown, scope: Record<string, unknown>): string | null {
  if (value === null || typeof value !== 'object') return null;
  const ctor = (value as { constructor?: unknown }).constructor;
  if (typeof ctor !== 'function') return null;
  for (const library of ['Tone', 'THREE']) {
    const exported = scope[library] as Record<string, unknown> | undefined;
    if (!exported) continue;
    try {
      for (const key of Object.keys(exported)) if (exported[key] === ctor) return `${library}.${key}`;
    } catch {
      // an export that can't be read
    }
  }
  const name = (ctor as { name?: string }).name;
  return name && name.length > 2 ? name : null;
}

/**
 * The library export whose class is called `name` ("Cu" → "Tone.PolySynth"): a bundle shortens
 * its class names, and Chrome names the class that way in "Class constructor Cu cannot be invoked
 * without 'new'". Only when exactly one export of Tone or THREE is a class with that name (two
 * is a tie, and a tie changes nothing), and not when the program declares that name itself.
 */
export function libraryClassNamed(name: string, code: string, scope: Record<string, unknown>): string | null {
  if (new RegExp(`(?:const|let|var|function|class)\\s+${name.replace(/\$/g, '\\$')}\\b`).test(code)) return null;
  const found: string[] = [];
  for (const library of ['Tone', 'THREE']) {
    const exported = scope[library] as Record<string, unknown> | undefined;
    if (!exported) continue;
    try {
      for (const key of Object.keys(exported)) {
        const value = exported[key];
        if (typeof value === 'function' && (value as { name?: string }).name === name && classLike(value as never, key)) found.push(`${library}.${key}`);
      }
    } catch {
      // an export that can't be read
    }
  }
  return found.length === 1 ? found[0] : null;
}

/**
 * An error that names a class the bundle shortened, with the class's own library name in its
 * place. Only the two slots the browsers use for it: "'Tone.Transport.bpm' is an instance of e"
 * (→ "… is an instance of Tone.Param", the object found in the page) and "Class constructor Cu
 * cannot be invoked without 'new'" (→ "Class constructor Tone.PolySynth …", the export class of
 * that name). A name that isn't a library class stays as it is, and so does any other text.
 */
export function withLibraryClassNames(error: string, code: string, scope: Record<string, unknown>): string {
  return error
    .replace(/'([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)' is an instance of ([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g, (whole, path: string, shortened: string) => {
      if (shortened.includes('.')) return whole;
      const name = libraryClassName(valueOfPath(code, path, scope), scope);
      return name && name !== shortened ? `'${path}' is an instance of ${name}` : whole;
    })
    .replace(/\bClass constructor ([A-Za-z_$][\w$]*) cannot be invoked without 'new'/g, (whole, shortened: string) => {
      const name = libraryClassNamed(shortened, code, scope);
      return name ? `Class constructor ${name} cannot be invoked without 'new'` : whole;
    })
    // Safari's wording of the same: "Cannot call a class constructor e without |new|" (e: one of many the bundle shortened that way)
    .replace(/\bCannot call a class constructor ([A-Za-z_$][\w$]*) without \|new\|/g, (whole, shortened: string) => {
      const name = libraryClassNamed(shortened, code, scope);
      return name ? `Cannot call a class constructor ${name} without |new|` : whole;
    });
}

/** The value a global path names in the page (Tone.Transport, Math): undefined when it isn't there or the program declares the first name itself */
export function valueOfPath(code: string, path: string, scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): unknown {
  const segments = path.split('.');
  if (segments.length > 3 || !segments.every((segment) => /^[A-Za-z_$][\w$]*$/.test(segment))) return undefined;
  if (new RegExp(`(?:const|let|var|function|class)\\s+${segments[0].replace(/\$/g, '\\$')}\\b`).test(code)) return undefined;
  try {
    let value: unknown = scope[segments[0]];
    for (const segment of segments.slice(1)) value = (value as Record<string, unknown> | null | undefined)?.[segment];
    return value;
  } catch {
    return undefined;
  }
}

/** How near a real member's name is to the missing one: shared words weigh most, then a name inside the other, then a few edits (0: unrelated) */
export function relatedness(missing: string, name: string, withoutVerbs = false): number {
  const mine = nameWords(missing);
  // (withoutVerbs: get, set, create… begin the names of most members, so sharing only that is no relation)
  const shared = nameWords(name).filter((w) => w.length > 2 && mine.includes(w) && !(withoutVerbs && (NAME_VERBS as readonly string[]).includes(w))).length;
  const a = flatName(missing);
  const b = flatName(name);
  const near = b.length >= 3 && (a.includes(b) || b.includes(a)) ? 2 : editDistance(a, b) <= Math.max(2, Math.floor(a.length / 3)) ? 1 : 0;
  return shared * 3 + near;
}

export type MemberUse = 'call' | 'new' | 'read';

/**
 * The real members that fit how the missing one was used (a function for a call, a class for new,
 * anything to read) and are related to its name, closest first, a few (what the model is asked to
 * choose from). Fewer than two related ones is no choice: an empty list.
 */
export function memberChoices(missing: string, members: readonly RealMember[], use: MemberUse, count = 5): RealMember[] {
  const fits = members.filter((m) => (use === 'read' ? true : use === 'new' ? m.kind === 'class' : m.kind !== 'property'));
  const ranked = fits
    .map((member) => ({ member, score: relatedness(missing, member.name) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.member.kind === 'class') - Number(a.member.kind === 'class') || a.member.name.length - b.member.name.length || a.member.name.localeCompare(b.member.name));
  return ranked.length >= 2 ? ranked.slice(0, count).map((entry) => entry.member) : [];
}

/**
 * What to tell about an object that has no such member, when no single one is meant: the
 * members that share a word with the name, or failing that what the object makes (a namespace of
 * classes: "things are made with new: Tone.Synth, Tone.PolySynth"), else nothing
 */
export function memberFacts(object: string, missing: string, members: readonly RealMember[], namespace: boolean, use: MemberUse): string {
  const share = members.filter((m) => nameWords(m.name).some((w) => w.length > 2 && nameWords(missing).includes(w)));
  if (share.length > 0) return `${object} has no ${missing}${use === 'read' ? '' : '()'}; the members that share a word with it: ${share.slice(0, 5).map((m) => `${object}.${m.name}`).join(', ')}.`;
  const classes = members.filter((m) => m.kind === 'class');
  if (namespace && classes.length >= 2) {
    const words = (name: string) => nameWords(name).length;
    const simplest = [...classes].sort((a, b) => words(a.name) - words(b.name) || a.name.localeCompare(b.name)).slice(0, 5);
    return `${object} has no ${missing}${use === 'read' ? '' : '()'}; things are made with new: ${simplest.map((m) => `${object}.${m.name}`).join(', ')}.`;
  }
  return '';
}

export interface MethodHint {
  /** A sentence for the fix request: what the object is and its closest methods */
  text: string;
  /** A slip that can be corrected without the model (`at`: where its name is written, for an object that is an expression) */
  correction?: { object: string; from: string; to: string; at?: { start: number; end: number } };
}

/**
 * A "not a function" error whose object the browser abbreviated (`document.getElementById(...)
 * .getContext(...).fillArc is not a function`): the call is found in the program (on the failing
 * line, when it is known), and what its object is read from the code that makes it. Exactly one
 * such call, or nothing.
 */
function inlineMethodHint(code: string, error: string, errorLine: number | undefined, scope?: Record<string, unknown>): MethodHint | null {
  const method = error.match(/\)\.([A-Za-z_$][\w$]*) is not a function/)?.[1];
  if (!method) return null;
  let ast: { type: string; [key: string]: unknown };
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, locations: true }) as never;
  } catch {
    return null;
  }
  type Call = { loc: { start: { line: number } }; callee: { object: { start: number; end: number }; property: { name: string; start: number; end: number } } };
  const calls: Call[] = [];
  const visit = (node: { type: string; [key: string]: unknown }) => {
    const callee = node.callee as { type?: string; computed?: boolean; property?: { name?: string } } | undefined;
    if (node.type === 'CallExpression' && callee?.type === 'MemberExpression' && !callee.computed && callee.property?.name === method) calls.push(node as unknown as Call);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && visit(child);
      else if (value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string') visit(value as never);
    }
  };
  visit(ast);
  // The calls on the failing line, else every one of that name; written again is the same slip,
  // so every one of them must have the same object type
  const onLine = calls.filter((call) => call.loc.start.line === errorLine);
  const found = (onLine.length > 0 ? onLine : calls).map((call) => ({ call, text: code.slice(call.callee.object.start, call.callee.object.end) }));
  if (found.length === 0) return null;
  const type = typeMadeBy(found[0].text, code);
  if (!type || !found.every((one) => typeMadeBy(one.text, code) === type)) return null;
  const names = methodNames(type, scope);
  if (names.length === 0) return null;
  const object = found[0].text.replace(/\s+/g, ' ');
  const shortObject = object.length > 90 ? `${object.slice(0, 87)}...` : object;
  const fix = sureMatch(method, names, { reshaped: true, used: usedMembers(code) });
  const closest = closestMembers(type, method, true, scope);
  return {
    // (the members as they follow that object: .fillRect(x, y, width, height) (a method))
    text: `${shortObject} is ${typeLabel(type, shortObject)}, which has no ${method}(). It has ${closest.map((n) => describeMember(type, '', n, scope)).join(', ')}: use the one you meant.`,
    ...(fix && found.length === 1 ? { correction: { object: shortObject, from: method, to: fix, at: { start: found[0].call.callee.property.start, end: found[0].call.callee.property.end } } } : {}),
  };
}

/** Help for a "not a function" error: the candidates, and a correction when it's a slip */
export function methodHint(code: string, error: string, scope?: Record<string, unknown>, errorLine?: number): MethodHint | null {
  const missing = missingMethod(error);
  // A class the object doesn't have, made with new (Tone.Melody): what the object really has, as for a method
  const constructing = missing ? null : missingConstructor(error);
  if (constructing) {
    const type = objectType(code, constructing.object);
    if (type?.startsWith('@') && new RegExp(`(?:const|let|var|function|class)\\s+${constructing.object.split('.')[0].replace(/\$/g, '\\$')}\\b`).test(code)) return null;
    return realObjectHint(code, constructing, scope, 'new');
  }
  if (!missing) return inlineMethodHint(code, error, errorLine, scope);
  let type = objectType(code, missing.object);
  // A well-known name (Tone, Math, document) that the program declares for itself is its own
  if (type?.startsWith('@') && new RegExp(`(?:const|let|var|function|class)\\s+${missing.object.split('.')[0].replace(/\$/g, '\\$')}\\b`).test(code)) return null;
  // An object the program didn't make by a call the types know (Tone.Transport, Math, document.body):
  // what it really has, read from the page
  if (!type) return realObjectHint(code, missing, scope);
  const names = methodNames(type, scope);
  if (names.length === 0) return null;
  // The type has the method the error says is missing: the type read from the code is wrong (the value was made another way)
  if (names.includes(missing.method)) return null;
  const typeName = typeLabel(type, missing.object);
  // A drawing method called on the canvas instead of its 2D context: the context is one call away
  if ((type === 'HTMLCanvasElement' || type === 'element:canvas') && CONTEXT_2D_METHODS.has(missing.method)) {
    return {
      text: `${missing.object} is ${typeName}; ${missing.method}() is a method of its 2D drawing context: ${missing.object}.getContext('2d').${missing.method}(…).`,
      correction: { object: missing.object, from: missing.method, to: `getContext("2d").${missing.method}` },
    };
  }
  // A sure method (a slip, or the name reshaped: page() for getPage()) is corrected; otherwise the
  // closest members, methods or properties (getPage() where it has page), each shown as it is used
  let fix = sureMatch(missing.method, names, { reshaped: true, used: usedMembers(code) });
  // Chatty's own helper (out): what it really offers, when no single name is meant
  if (!fix && type === '@out') {
    const helper = helperListText(code, missing.object, missing.method, scope);
    if (helper) return { text: helper };
  }
  // A method that belongs to a setting of the object (gain.setValueAtTime(…), which is
  // gain.gain.setValueAtTime(…)): when exactly one of its settings has it, that is the one
  const through = fix ? null : memberWithMethod(type, missing.method, scope);
  if (through) fix = `${through}.${missing.method}`;
  const closest = closestMembers(type, missing.method, true, scope);
  // A class of a library (Tone.Loop): where the value was made, and which classes do have the method
  const library = /^(?:Tone|THREE)\./.test(type);
  const made = library ? madeAtLine(code, missing.object) : null;
  const owners = library ? classesWithMethod(type, missing.method, scope) : [];
  // A namespace (Tone, Math): the real names that share a word, or what it makes, in place of its closest names
  if (type.startsWith('@')) {
    // The language's own namespaces (Math, JSON, console): their own functions and values, nearest first
    const own = !fix && POPULAR[type] ? namespaceList(type, missing.method, scope) : null;
    if (own) {
      const functions = own.methods.length ? ` Its functions: ${own.methods.map((m) => `${m}()`).join(', ')}${own.more ? ', …' : ''}.` : '';
      const values = own.settings.length ? ` Its values: ${own.settings.map((v) => v.name).join(', ')}.` : '';
      return { text: `${missing.object} has no ${missing.method}().${functions}${values}` };
    }
    const real = realMembers(code, missing.object, scope);
    const facts = real && !fix ? memberFacts(missing.object, missing.method, real.members, real.namespace, 'call') : '';
    if (facts) return { text: facts };
  }
  // What an instance of a class of the library or the browser really has: one clean list (a methods line and a
  // settings line) in place of the closest names, when the page can say
  const builtIn = !type.includes('.') && !type.startsWith('element:') && !type.startsWith('@') && type in POPULAR;
  const listScope = scope ?? (builtIn ? (globalThis as unknown as Record<string, unknown>) : undefined);
  const list = listScope && !fix ? memberListText(missing.object, type, missing.method, 'call', listScope) : null;
  if (list) {
    return { text: `${list.replace(`${missing.object} is ${typeName};`, `${missing.object} is ${typeName}${made ? ` (made at line ${made})` : ''};`)}${owners.length ? ` ${missing.method}() belongs to ${owners.join(', ')}.` : ''}` };
  }
  return {
    text:
      `${missing.object} is ${typeName}${made ? ` (made at line ${made})` : ''}, which has no ${missing.method}(). ` +
      `${owners.length ? `${missing.method}() belongs to ${owners.join(', ')}. ` : ''}` +
      `It has ${closest.map((n) => describeMember(type, missing.object, n, scope)).join(', ')}: use the one you meant.`,
    ...(fix ? { correction: { object: missing.object, from: missing.method, to: fix } } : {}),
  };
}

/**
 * What an instance of a library or browser class has, as a clean list: its methods and its settings.
 * Read from the real prototypes, level by level up the chain:
 *  - names with an underscore, `constructor` and repeats (dispose at three levels) are left out, and so
 *    are members whose source says they are deprecated or renamed (Tone's toMaster)
 *  - the levels every class of the library inherits (Tone and ToneWithContext: now, toSeconds, log…; for
 *    elements HTMLElement, Element, Node and EventTarget) are plumbing, found from what the library
 *    exports: the prototypes most of its classes share. A member of such a level still comes
 *    when it is the closest match to the name that was wrong (addEventListner → addEventListener)
 *  - a function is a method; an accessor is a setting (read-only when it has no setter), and so are the
 *    keys of getDefaults() without `context`. Accessors of the levels between that aren't in getDefaults
 *    (channelCount, numberOfInputs) are plumbing too
 *  - closest to the wrong name first, then the class's own members in the order it declares them, then
 *    the inherited ones; at most 12 methods and 8 settings
 * Null when the class can't be found in the page.
 */
export interface MemberList {
  methods: string[];
  settings: Array<{ name: string; readOnly: boolean }>;
  /** More methods or settings than the lists show */
  more?: boolean;
}

/**
 * The members people reach for first on the language's own types, in that order (after any name close to the
 * wrong one): a name that the object doesn't really have is left out, so this is an order, not a list
 */
const POPULAR: Record<string, string[]> = {
  Array: ['push', 'pop', 'shift', 'unshift', 'includes', 'indexOf', 'find', 'findIndex', 'map', 'filter', 'reduce', 'forEach', 'join', 'slice', 'splice', 'sort', 'reverse', 'concat', 'some', 'every', 'flat', 'fill'],
  String: ['includes', 'startsWith', 'endsWith', 'indexOf', 'slice', 'substring', 'split', 'trim', 'replace', 'replaceAll', 'toUpperCase', 'toLowerCase', 'padStart', 'padEnd', 'repeat', 'charAt', 'match', 'at', 'concat'],
  Number: ['toFixed', 'toString', 'toPrecision', 'toLocaleString'],
  Map: ['get', 'set', 'has', 'delete', 'clear', 'forEach', 'keys', 'values', 'entries'],
  Set: ['add', 'has', 'delete', 'clear', 'forEach', 'values', 'keys', 'entries'],
  Date: ['getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds', 'getTime', 'toISOString', 'toLocaleDateString', 'toLocaleTimeString', 'setDate', 'setHours'],
  RegExp: ['test', 'exec'],
  '@Math': ['random', 'floor', 'round', 'ceil', 'max', 'min', 'abs', 'sqrt', 'pow', 'sin', 'cos', 'atan2', 'PI', 'trunc', 'sign'],
  '@JSON': ['parse', 'stringify'],
  '@console': ['log', 'warn', 'error', 'info', 'table'],
};

/** The share of a library's classes that must inherit a prototype for it to be plumbing */
const PLUMBING_SHARE = 0.8;

function classOfType(type: string, scope: Record<string, unknown>): { ctor: ((...args: unknown[]) => unknown) & { getDefaults?: () => Record<string, unknown> }; proto: object; universe: unknown[] } | null {
  try {
    if (type.startsWith('element:')) {
      const element = (scope.document as Document | undefined)?.createElement(type.slice(8));
      const proto = element ? Object.getPrototypeOf(element) : null;
      if (!proto || isRootPrototype(proto) || type === 'element:div') return null;
      const ctor = proto.constructor;
      return { ctor, proto, universe: htmlClasses(scope) };
    }
    let ctor: unknown;
    let universe: unknown[] = [];
    if (type.includes('.')) {
      const [library, name] = type.split('.');
      const exported = scope[library] as Record<string, unknown> | undefined;
      ctor = exported?.[name];
      universe = Object.keys(exported ?? {}).map((key) => exported![key]).filter((value) => typeof value === 'function' && !!(value as { prototype?: unknown }).prototype);
    } else {
      ctor = typeClass(type, scope);
      universe = /^(?:HTML|SVG)\w*Element$/.test(type) ? htmlClasses(scope) : [];
    }
    const proto = (ctor as { prototype?: object } | undefined)?.prototype;
    if (typeof ctor !== 'function' || !proto) return null;
    return { ctor: ctor as never, proto, universe };
  } catch {
    return null;
  }
}

/** The browser's own element classes: what the DOM exports */
function htmlClasses(scope: Record<string, unknown>): unknown[] {
  try {
    return Object.getOwnPropertyNames(scope)
      .filter((key) => /^(?:HTML|SVG)\w*Element$/.test(key))
      .map((key) => scope[key])
      .filter((value) => typeof value === 'function');
  } catch {
    return [];
  }
}

export function memberList(type: string, missing: string, scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): MemberList | null {
  const found = classOfType(type, scope);
  if (!found) return null;
  const { ctor, proto, universe } = found;
  // The prototypes from the class up, not Object's
  const levels: object[] = [];
  for (let at: object | null = proto; at && !isRootPrototype(at) && levels.length < 12; at = Object.getPrototypeOf(at)) levels.push(at);
  if (levels.length === 0) return null;
  // Plumbing: inherited by most of what the library exports
  const inherits = (cls: unknown, level: object) => {
    for (let at: object | null = (cls as { prototype?: object }).prototype ?? null; at; at = Object.getPrototypeOf(at)) if (at === level) return true;
    return false;
  };
  const plumbing = levels.map((level, i) => i > 0 && universe.length >= 5 && universe.filter((cls) => inherits(cls, level)).length / universe.length >= PLUMBING_SHARE);
  const deprecated = (fn: unknown) => {
    try {
      return /deprecat|renamed/i.test(Function.prototype.toString.call(fn));
    } catch {
      return false;
    }
  };
  const defaults = (() => {
    try {
      return Object.keys(ctor.getDefaults?.() ?? {}).filter((key) => key !== 'context' && /^[A-Za-z$][\w$]*$/.test(key));
    } catch {
      return [];
    }
  })();
  const seen = new Set<string>();
  const methods: Array<{ name: string; level: number; plumbing: boolean }> = [];
  const accessors: Array<{ name: string; level: number; readOnly: boolean; plumbing: boolean }> = [];
  levels.forEach((level, index) => {
    for (const name of Object.getOwnPropertyNames(level)) {
      if (name === 'constructor' || name.startsWith('_') || !/^[A-Za-z$][\w$]*$/.test(name) || seen.has(name)) continue;
      const d = Object.getOwnPropertyDescriptor(level, name);
      if (!d) continue;
      if (typeof d.value === 'function') {
        seen.add(name);
        if (!deprecated(d.value)) methods.push({ name, level: index, plumbing: plumbing[index] });
      } else if (d.get || d.set) {
        seen.add(name);
        accessors.push({ name, level: index, readOnly: !d.set, plumbing: plumbing[index] });
      } else if ('value' in d) {
        // (a value on the prototype itself: a setting that can be set)
        seen.add(name);
        accessors.push({ name, level: index, readOnly: false, plumbing: plumbing[index] });
      }
    }
  });
  const related = (name: string) => relatedness(missing, name);
  // An element of the page: the DOM's levels above the class (HTMLElement, Element, Node) hold hundreds of names, so the
  // element's own are listed, and of the inherited ones only the single closest to the wrong name
  const dom = type.startsWith('element:') || /^(?:HTML|SVG)\w*Element$/.test(type);
  const closestInherited = dom
    ? [...methods.filter((m) => m.level > 0), ...accessors.filter((a) => a.level > 0)].map((m) => ({ name: m.name, score: relatedness(missing, m.name, true) })).filter((m) => m.score >= 1).sort((a, b) => b.score - a.score)[0]?.name
    : undefined;
  // The methods: closest to the wrong name (from any level), then the class's own, then inherited; plumbing only when close
  const popular = POPULAR[type] ?? [];
  const popularity = (name: string) => (popular.includes(name) ? popular.indexOf(name) : popular.length);
  const wanted = methods
    // (the names Chatty's software output answers to for what models invent are not ones to teach)
    .filter((m) => !(type === 'MIDIOutput' && /^(?:play|playNote)$/.test(m.name)))
    .filter((m) => !dom || m.level === 0 || m.name === closestInherited)
    .filter((m) => !m.plumbing || related(m.name) >= 1)
    .map((m, order) => ({ ...m, order, score: related(m.name) }))
    .sort((a, b) => b.score - a.score || a.level - b.level || popularity(a.name) - popularity(b.name) || a.order - b.order);
  const names = wanted.map((m) => m.name);
  // The settings: the class's own accessors, the defaults (without context), and accessors between that the defaults name
  const settings: Array<{ name: string; readOnly: boolean }> = [];
  const addSetting = (name: string) => {
    if (settings.some((s) => s.name === name)) return;
    const accessor = accessors.find((a) => a.name === name);
    settings.push({ name, readOnly: !!accessor?.readOnly });
  };
  for (const a of accessors.filter((a) => a.level === 0)) addSetting(a.name);
  for (const key of defaults) addSetting(key);
  for (const a of accessors.filter((a) => a.level > 0 && !a.plumbing && defaults.includes(a.name))) addSetting(a.name);
  // (for a class with no getDefaults: the accessors of its own non-plumbing levels; an element's inherited ones only as the closest)
  if (defaults.length === 0) for (const a of accessors.filter((a) => !a.plumbing && (!dom || a.level === 0 || a.name === closestInherited))) addSetting(a.name);
  const bad = flatName(missing);
  const settingsOrdered = [...settings].sort((a, b) => (flatName(b.name) !== bad ? relatedness(missing, b.name) : 0) - (flatName(a.name) !== bad ? relatedness(missing, a.name) : 0));
  if (names.length === 0 && settingsOrdered.length === 0) return null;
  return { methods: names.slice(0, 12), settings: settingsOrdered.slice(0, 8), ...(names.length > 12 || settingsOrdered.length > 8 ? { more: true } : {}) };
}

/** What a namespace of the language really has (Math, JSON, console): its own functions and values, nearest names first, then the usual order */
export function namespaceList(type: string, missing: string, scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): MemberList | null {
  const value = scope[type.slice(1)];
  if (!POPULAR[type] || value === null || (typeof value !== 'object' && typeof value !== 'function')) return null;
  const popular = POPULAR[type];
  const methods: string[] = [];
  const values: string[] = [];
  for (const name of Object.getOwnPropertyNames(value)) {
    if (!/^[A-Za-z$][\w$]*$/.test(name) || name.startsWith('_')) continue;
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (d && typeof d.value === 'function') methods.push(name);
    else if (d) values.push(name);
  }
  const order = (names: string[]) =>
    names
      .map((name, i) => ({ name, i, score: relatedness(missing, name), pop: popular.includes(name) ? popular.indexOf(name) : popular.length }))
      .sort((a, b) => b.score - a.score || a.pop - b.pop || a.i - b.i)
      .map((e) => e.name);
  const m = order(methods);
  const v = order(values);
  return m.length + v.length === 0 ? null : { methods: m.slice(0, 12), settings: v.slice(0, 8).map((name) => ({ name, readOnly: true })), ...(m.length > 12 || v.length > 8 ? { more: true } : {}) };
}

/**
 * The fact for a member that isn't there, as one sentence: what the object is and what it really has.
 * "gMinor is a Tone.PolySynth; it has no setInstruments(). Its methods: …. Its settings: …."
 * Null for an object with no class from the library or the browser to read it from (a program's own object).
 */
export function memberListText(object: string, type: string, missing: string, use: MemberUse, scope: Record<string, unknown>): string | null {
  if (type.startsWith('@')) return null;
  const list = memberList(type, missing, scope);
  if (!list) return null;
  // A list that holds the very name said to be missing is wrong about the type: no fact is better than a contradiction
  if (list.methods.includes(missing) || list.settings.some((s) => s.name === missing)) return null;
  const methods = list.methods.length ? ` Its methods: ${list.methods.map((m) => `${m}()`).join(', ')}${list.more ? ', …' : ''}.` : '';
  const settings = list.settings.length ? ` Its settings: ${list.settings.map((s) => (s.readOnly ? `${s.name} (read-only)` : s.name)).join(', ')}.` : '';
  return `${object} is ${typeLabel(type, object)}; it has no ${missing}${use === 'read' ? '' : '()'}.${methods}${settings}${midiNote(type)}`;
}

/** What to say after the list of a MIDI type: how the output is got and played */
function midiNote(type: string): string {
  if (type === 'MIDIOutput') return ` Notes play like this: ${MIDI_OUTPUT}, then ${MIDI_PLAIN_FORM}.`;
  if (type === 'MIDIAccess') return ` The output to play on is the first of its outputs (a Map): ${MIDI_OUTPUT}, then ${MIDI_PLAIN_FORM}.`;
  return '';
}

/**
 * A member that Chatty's own helpers don't have (`out.say()`, `speak.loud()`): what the helper
 * really offers, read from the runner's own helper object (the page's scope carries it as
 * __chattyHelpers), nearest names first. Null when the object is no helper, or the program declares it.
 */
export function helperListText(code: string, object: string, missing: string, scope?: Record<string, unknown>): string | null {
  const helpers = scope?.__chattyHelpers as Record<string, unknown> | undefined;
  const value = helpers?.[object];
  if (value === undefined || (typeof value !== 'object' && typeof value !== 'function')) return null;
  if (new RegExp(`(?:const|let|var|function|class)\\s+${object.replace(/\$/g, '\\$')}\\b`).test(code)) return null;
  const members = membersOfValue(value).filter((m) => m.name !== 'name' && m.name !== 'length');
  if (members.length === 0) return `${object} is a Chatty helper function with no members of its own; it has no ${missing}. Call it directly: ${object}(…).`;
  const order = (names: string[]) => names.map((name, i) => ({ name, i, score: relatedness(missing, name) })).sort((a, b) => b.score - a.score || a.i - b.i).map((e) => e.name);
  const methods = order(members.filter((m) => m.kind !== 'property').map((m) => m.name));
  const settings = order(members.filter((m) => m.kind === 'property').map((m) => m.name));
  return `${object} is Chatty's ${object} helper; it has no ${missing}().${methods.length ? ` Its methods: ${methods.slice(0, 12).map((m) => `${m}()`).join(', ')}.` : ''}${settings.length ? ` Its settings: ${settings.slice(0, 8).join(', ')}.` : ''}`;
}

/** The line a name is declared on (`const loop = …`), or null when it is not declared exactly once */
export function madeAtLine(code: string, name: string): number | null {
  const found = [...code.matchAll(new RegExp(`(?:^|[^\\w$.])(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=`, 'g'))];
  return found.length === 1 ? code.slice(0, found[0].index! + 1).split('\n').length : null;
}

/** The value a "x.m is not a function" error is about: its name and the line it is made on (null when it is not declared once) */
export function valueMadeAt(code: string, error: string): { name: string; line: number } | null {
  const missing = missingMethod(error);
  if (!missing || !/^[A-Za-z_$][\w$]*$/.test(missing.object)) return null;
  const line = madeAtLine(code, missing.object);
  return line ? { name: missing.object, line } : null;
}

/**
 * The value an error is about, when the fix may belong on the line that makes it: a class of a
 * library (new Tone.Loop) asked for a method that other classes of that library have, so the
 * class made there is the likely mistake. Null for anything else (a method a browser type lacks
 * belongs on the line that calls it).
 */
export function madeAsWrongClass(code: string, error: string, scope?: Record<string, unknown>): { name: string; line: number } | null {
  const made = valueMadeAt(code, error);
  const missing = missingMethod(error);
  if (!made || !missing || !scope) return null;
  const type = objectType(code, made.name);
  if (!type || !/^(?:Tone|THREE)\./.test(type)) return null;
  return classesWithMethod(type, missing.method, scope, 1).length > 0 ? made : null;
}

/**
 * The classes of a library (Tone.Synth, Tone.PolySynth…) that have a method, read from the real
 * prototypes of what the library exports: the simplest names first, a few of them
 */
export function classesWithMethod(type: string, method: string, scope?: Record<string, unknown>, count = 4): string[] {
  const library = type.split('.')[0];
  const exported = scope?.[library] as Record<string, unknown> | undefined;
  if (!exported) return [];
  const found: string[] = [];
  for (const key of Object.keys(exported)) {
    const candidate = `${library}.${key}`;
    if (candidate === type || typeof exported[key] !== 'function' || !/^[A-Z]/.test(key)) continue;
    if (memberKind(candidate, method, scope) === 'method') found.push(candidate);
  }
  const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').length;
  found.sort((a, b) => words(a) - words(b) || a.localeCompare(b));
  return found.length > count ? [...found.slice(0, count), `${found.length - count} more`] : found;
}

/** "x.m is not a function" for an object found by walking the page (Tone.Transport.foo): what it has, or the sure slip */
function realObjectHint(code: string, missing: { object: string; method: string }, scope?: Record<string, unknown>, use: 'call' | 'new' = 'call'): MethodHint | null {
  if (!scope) return null;
  // A helper of Chatty's that is a function (speak): what it is
  const helper = helperListText(code, missing.object, missing.method, scope);
  if (helper) return { text: helper };
  const real = realMembers(code, missing.object, scope);
  if (!real) return null;
  // The member is there, but a value and no function (Tone.Transport.bpm is a Tone.Param): what it
  // is and what it has, so the call can become one of those
  if (use === 'call' && real.members.some((m) => m.name === missing.method && m.kind === 'property')) {
    const value = valueOfPath(code, `${missing.object}.${missing.method}`, scope);
    const label = libraryClassName(value, scope);
    const own = membersOfValue(value);
    const shown = [...own.filter((m) => m.kind === 'property'), ...own.filter((m) => m.kind !== 'property')]
      .filter((m) => !/^(?:dispose|toString|valueOf|get|set|name)$/.test(m.name))
      .slice(0, 5)
      .map((m) => (m.kind === 'property' ? `.${m.name}` : `.${m.name}()`));
    if (label && shown.length) return { text: `${missing.object}.${missing.method} is ${/^[AEIOU]/.test(label.replace(/^[A-Za-z]+\./, '')) ? 'an' : 'a'} ${label}, not a function; it has ${shown.join(', ')}.` };
  }
  if (use === 'new' && real.members.some((m) => m.name === missing.method)) return null;
  const callable = real.members.filter((m) => (use === 'new' ? m.kind === 'class' : m.kind !== 'property')).map((m) => m.name);
  const fix = sureMatch(missing.method, callable, { reshaped: true, used: usedMembers(code) });
  const facts = memberFacts(missing.object, missing.method, real.members, real.namespace, use);
  const closest = closestNames(missing.method, callable, 3);
  return {
    text: facts || `${missing.object} has no ${missing.method}()${closest.length ? `. It has ${closest.map((n) => `${use === 'new' ? 'new ' : ''}${missing.object}.${n}()`).join(', ')}: use the one you meant.` : '.'}`,
    ...(fix ? { correction: { object: missing.object, from: missing.method, to: fix } } : {}),
  };
}

/**
 * The one member of an audio node (its settings are AudioParams: gain, frequency, detune…) that has
 * the method, read from a node of that type made on a silent offline context. Null when no member
 * has it, several do (an oscillator's frequency and detune), or the type isn't an audio node.
 */
export function memberWithMethod(type: string, method: string, scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): string | null {
  try {
    const Node = scope[type] as (new (context: unknown) => Record<string, unknown>) | undefined;
    const Offline = scope.OfflineAudioContext as (new (channels: number, length: number, rate: number) => unknown) | undefined;
    const Base = scope.AudioNode as { prototype?: object } | undefined;
    const Param = scope.AudioParam as (abstract new () => object) | undefined;
    if (typeof Node !== 'function' || typeof Offline !== 'function' || typeof Param !== 'function' || !Base?.prototype || !(Node.prototype instanceof (Base as unknown as new () => object))) return null;
    const sample = new Node(new Offline(1, 1, 8000));
    const owners: string[] = [];
    for (const { name, kind } of membersOfValue(Object.getPrototypeOf(sample))) {
      if (kind !== 'property') continue;
      // Only a setting (an AudioParam) counts: a node's `context` also has suspend() and resume(), and
      // gainNode.context.suspend() would stop the audio of the whole page
      const value = sample[name] as Record<string, unknown> | null | undefined;
      if (value instanceof Param && typeof value[method] === 'function') owners.push(name);
    }
    return owners.length === 1 ? owners[0] : null;
  } catch {
    return null;
  }
}

/** The program with every call of object.from renamed to object.to */
export function applyCorrection(code: string, correction: { object: string; from: string; to: string; at?: { start: number; end: number } }): string {
  if (correction.at) return code.slice(0, correction.at.start) + correction.to + code.slice(correction.at.end);
  const object = correction.object.replace(/[.$]/g, (c) => `\\${c}`);
  // (the object is the start of the path: `gain` in `gain.gain.setValueAtTime` is not the one to rename)
  return code.replace(new RegExp(`((?<![\\w$.])${object}\\s*\\.\\s*)${correction.from}\\b`, 'g'), `$1${correction.to}`);
}

/**
 * Parameter names, where they can be given reliably: the browser's functions don't expose them,
 * so only the common canvas methods are listed, and a list is used only when its length is the
 * browser's own count for that method
 */
const PARAMETER_NAMES: Record<string, string[]> = {
  'CanvasRenderingContext2D.arc': ['x', 'y', 'radius', 'startAngle', 'endAngle'],
  'CanvasRenderingContext2D.arcTo': ['x1', 'y1', 'x2', 'y2', 'radius'],
  'CanvasRenderingContext2D.ellipse': ['x', 'y', 'radiusX', 'radiusY', 'rotation', 'startAngle', 'endAngle'],
  'CanvasRenderingContext2D.rect': ['x', 'y', 'width', 'height'],
  'CanvasRenderingContext2D.fillRect': ['x', 'y', 'width', 'height'],
  'CanvasRenderingContext2D.strokeRect': ['x', 'y', 'width', 'height'],
  'CanvasRenderingContext2D.clearRect': ['x', 'y', 'width', 'height'],
  'CanvasRenderingContext2D.fillText': ['text', 'x', 'y'],
  'CanvasRenderingContext2D.strokeText': ['text', 'x', 'y'],
  'CanvasRenderingContext2D.moveTo': ['x', 'y'],
  'CanvasRenderingContext2D.lineTo': ['x', 'y'],
  'CanvasRenderingContext2D.translate': ['x', 'y'],
  'CanvasRenderingContext2D.scale': ['x', 'y'],
  'CanvasRenderingContext2D.quadraticCurveTo': ['cpx', 'cpy', 'x', 'y'],
  'CanvasRenderingContext2D.bezierCurveTo': ['cp1x', 'cp1y', 'cp2x', 'cp2y', 'x', 'y'],
};

/** The function a type's method is, read from the browser's prototype chain, or null */
function methodFunction(type: string, name: string, scope?: Record<string, unknown>): ((...args: unknown[]) => unknown) | null {
  const found: Array<(...args: unknown[]) => unknown> = [];
  for (const source of namesSources(type, scope)) {
    let target: unknown = source;
    while (target && !isRootPrototype(target)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (descriptor) {
        if (typeof descriptor.value === 'function') found.push(descriptor.value);
        break;
      }
      target = Object.getPrototypeOf(target);
    }
  }
  // An element of unknown tag has many types: the count must be the same on all that have it
  return found.length > 0 && found.every((fn) => fn.length === found[0].length) ? found[0] : null;
}

/** Whether a type's member is a method or a property, from the browser's own descriptors (null when it has none) */
export function memberKind(type: string, name: string, scope?: Record<string, unknown>): 'method' | 'property' | null {
  for (const source of namesSources(type, scope)) {
    let target: unknown = source;
    while (target && !isRootPrototype(target)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (descriptor) return typeof descriptor.value === 'function' ? 'method' : 'property';
      target = Object.getPrototypeOf(target);
    }
  }
  // Style properties live on the style object itself in some browsers
  return type === 'CSSStyleDeclaration' ? 'property' : null;
}

/**
 * A member as the coder model reads it in a hint: `object.page (a property)`, or
 * `object.fillRect(x, y, width, height) (a method)` with the parameter names where they are
 * known, else how many values it takes
 */
export function describeMember(type: string, object: string, name: string, scope?: Record<string, unknown>): string {
  const kind = memberKind(type, name, scope);
  if (kind !== 'method') return `${object}.${name} (a property)`;
  const fn = methodFunction(type, name, scope);
  const known = PARAMETER_NAMES[tableKey(type, name)];
  const params = known && fn && known.length === fn.length ? known.join(', ') : fn && fn.length > 0 ? `${fn.length} value${fn.length === 1 ? '' : 's'}` : '';
  return `${object}.${name}(${params}) (a method)`;
}

/** Member names a program uses anywhere (`.value`): what breaks a tie between near names */
export function usedMembers(code: string): string[] {
  return [...new Set(Array.from(code.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g), (m) => m[1]))];
}

/** The type's own name for the table above ('CanvasRenderingContext2D'), when the type is one */
const tableKey = (type: string, method: string) => `${type}.${method}`;

/**
 * "ctx.arc needs 5 arguments (x, y, …); this call gives 3": the facts for a call of a browser
 * method with fewer arguments than it requires. The count is `Function.prototype.length` of the
 * real method. The error points at it ("5 arguments required, but only 3 present" in Chrome,
 * "Not enough arguments" in Safari, "At least 5 arguments required" in Firefox): the calls on
 * the failing line (or, when the error names the method, anywhere) of a typed object are checked.
 * A fact only: what the missing values should be is the model's to decide.
 */
export function argumentCountFact(code: string, error: string, errorLine?: number, scope?: Record<string, unknown>): string | null {
  if (!/arguments? required|Not enough arguments|At least \d+ arguments?/i.test(error)) return null;
  const named = error.match(/Failed to execute '(\w+)'/)?.[1] ?? error.match(/\w+\.(\w+): At least \d+ arguments?/)?.[1];
  const lines = code.split('\n');
  const scoped = errorLine && errorLine <= lines.length ? lines[errorLine - 1] : null;
  const facts: string[] = [];
  const callPattern = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of (scoped ?? code).matchAll(callPattern)) {
    const [, object, method] = match;
    if (named && method !== named) continue;
    const type = objectType(code, object);
    if (!type) continue;
    const fn = methodFunction(type, method, scope);
    if (!fn || fn.length === 0) continue;
    const given = countArguments((scoped ?? code).slice(match.index! + match[0].length));
    if (given === null || given >= fn.length) continue;
    const names = PARAMETER_NAMES[tableKey(type, method)];
    const listed = names && names.length === fn.length ? ` (${names.join(', ')})` : '';
    facts.push(`${object}.${method} needs ${fn.length} argument${fn.length === 1 ? '' : 's'}${listed}; this call gives ${given}.`);
  }
  return facts.length > 0 ? [...new Set(facts)].slice(0, 3).join(' ') : null;
}

/** How many arguments the call has, given the text just after its "(" (null when spread or unclosed) */
function countArguments(rest: string): number | null {
  let depth = 0;
  let count = 0;
  let any = false;
  let quote = '';
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) {
      depth++;
      any = true;
    } else if (')]}'.includes(ch)) {
      if (depth === 0) return any ? count + 1 : 0;
      depth--;
    } else if (ch === ',' && depth === 0) count++;
    else if (ch === '.' && rest.startsWith('...', i) && depth === 0) return null;
    else if (!/\s/.test(ch)) any = true;
  }
  return null;
}
