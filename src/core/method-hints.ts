/**
 * Missing methods. Models call methods that don't exist (ctx.fillCircle, document.body.clear,
 * clearIntreval). When a program fails with "x.m is not a function", this works out what x is
 * (from the program's own code or the globals it names), reads its real method names from the
 * browser's prototypes, and ranks the closest. A near-miss (a typo or wrong case) is corrected
 * without the model; otherwise the candidates go into the fix request, so the model picks from
 * a list instead of guessing again.
 */
import { parse, parseExpressionAt } from 'acorn';
import { closestNames, editDistance, flatName, NAME_VERBS, nameWords, sureMatch } from './fuzzy-match.ts';

/** The object and the method a "not a function" error names, or null */
export function missingMethod(error: string): { object: string; method: string } | null {
  const match = error.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*) is not a function/);
  return match ? { object: match[1], method: match[2] } : null;
}

/** What a value made by this code is: a browser type name, or a known object */
const MADE_BY: ReadonlyArray<[RegExp, string]> = [
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

/** Methods of Chatty's own objects (not browser types) */
const OWN_METHODS: Record<string, string[]> = {
  '@out': ['send', 'play', 'playNote'],
};

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
  if (top.type === 'AwaitExpression') top = top.argument;
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
  const tag = expression.match(/createElement\(\s*['"]([\w-]+)['"]/)?.[1];
  if (tag) return `element:${tag.toLowerCase()}`;
  const node = audioNodeMadeBy(expression, code);
  if (node) return node;
  for (const [made, type] of MADE_BY) if (made.test(expression)) return type;
  return null;
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
  return `a ${type}`;
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
  return [(scope[type] as { prototype?: unknown } | undefined)?.prototype];
}

/** Every member name (methods and properties) of a browser type, own and inherited (not Object's own: valueOf, toString) */
function memberNamesOf(type: string, scope?: Record<string, unknown>): string[] {
  if (OWN_METHODS[type]) return OWN_METHODS[type];
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
    while (target && target !== Object.prototype) {
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
  if (OWN_METHODS[type]) return OWN_METHODS[type];
  const names = new Set<string>();
  for (const source of namesSources(type, scope)) {
    let target: unknown = source;
    while (target && target !== Object.prototype) {
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
  for (let hops = 0; target && hops < 12 && target !== Object.prototype && target !== Function.prototype; hops++) {
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
function relatedness(missing: string, name: string): number {
  const mine = nameWords(missing);
  const shared = nameWords(name).filter((w) => w.length > 2 && mine.includes(w)).length;
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
  if (!missing) return inlineMethodHint(code, error, errorLine, scope);
  let type = objectType(code, missing.object);
  // A well-known name (Tone, Math, document) that the program declares for itself is its own
  if (type?.startsWith('@') && new RegExp(`(?:const|let|var|function|class)\\s+${missing.object.split('.')[0].replace(/\$/g, '\\$')}\\b`).test(code)) return null;
  // An object the program didn't make by a call the types know (Tone.Transport, Math, document.body):
  // what it really has, read from the page
  if (!type) return realObjectHint(code, missing, scope);
  const names = methodNames(type, scope);
  if (names.length === 0) return null;
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
    const real = realMembers(code, missing.object, scope);
    const facts = real && !fix ? memberFacts(missing.object, missing.method, real.members, real.namespace, 'call') : '';
    if (facts) return { text: facts };
  }
  return {
    text:
      `${missing.object} is ${typeName}${made ? ` (made at line ${made})` : ''}, which has no ${missing.method}(). ` +
      `${owners.length ? `${missing.method}() belongs to ${owners.join(', ')}. ` : ''}` +
      `It has ${closest.map((n) => describeMember(type, missing.object, n, scope)).join(', ')}: use the one you meant.`,
    ...(fix ? { correction: { object: missing.object, from: missing.method, to: fix } } : {}),
  };
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
function realObjectHint(code: string, missing: { object: string; method: string }, scope?: Record<string, unknown>): MethodHint | null {
  if (!scope) return null;
  const real = realMembers(code, missing.object, scope);
  if (!real) return null;
  // The member is there, but a value and no function (Tone.Transport.bpm is a Tone.Param): what it
  // is and what it has, so the call can become one of those
  if (real.members.some((m) => m.name === missing.method && m.kind === 'property')) {
    const value = valueOfPath(code, `${missing.object}.${missing.method}`, scope);
    const label = libraryClassName(value, scope);
    const own = membersOfValue(value);
    const shown = [...own.filter((m) => m.kind === 'property'), ...own.filter((m) => m.kind !== 'property')]
      .filter((m) => !/^(?:dispose|toString|valueOf|get|set|name)$/.test(m.name))
      .slice(0, 5)
      .map((m) => (m.kind === 'property' ? `.${m.name}` : `.${m.name}()`));
    if (label && shown.length) return { text: `${missing.object}.${missing.method} is ${/^[AEIOU]/.test(label.replace(/^[A-Za-z]+\./, '')) ? 'an' : 'a'} ${label}, not a function; it has ${shown.join(', ')}.` };
  }
  const callable = real.members.filter((m) => m.kind !== 'property').map((m) => m.name);
  const fix = sureMatch(missing.method, callable, { reshaped: true, used: usedMembers(code) });
  const facts = memberFacts(missing.object, missing.method, real.members, real.namespace, 'call');
  const closest = closestNames(missing.method, callable, 3);
  return {
    text: facts || `${missing.object} has no ${missing.method}()${closest.length ? `. It has ${closest.map((n) => `${missing.object}.${n}()`).join(', ')}: use the one you meant.` : '.'}`,
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
  if (OWN_METHODS[type]) return null;
  const found: Array<(...args: unknown[]) => unknown> = [];
  for (const source of namesSources(type, scope)) {
    let target: unknown = source;
    while (target && target !== Object.prototype) {
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
  if (OWN_METHODS[type]) return OWN_METHODS[type].includes(name) ? 'method' : null;
  for (const source of namesSources(type, scope)) {
    let target: unknown = source;
    while (target && target !== Object.prototype) {
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
