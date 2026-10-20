/**
 * Missing methods. Models call methods that don't exist (ctx.fillCircle, document.body.clear,
 * clearIntreval). When a program fails with "x.m is not a function", this works out what x is
 * (from the program's own code or the globals it names), reads its real method names from the
 * browser's prototypes, and ranks the closest. A near-miss (a typo or wrong case) is corrected
 * without the model; otherwise the candidates go into the fix request, so the model picks from
 * a list instead of guessing again.
 */

/** The object and the method a "not a function" error names, or null */
export function missingMethod(error: string): { object: string; method: string } | null {
  const match = error.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*) is not a function/);
  return match ? { object: match[1], method: match[2] } : null;
}

/** What a value made by this code is: a browser type name, or a known object */
const MADE_BY: ReadonlyArray<[RegExp, string]> = [
  [/getContext\(\s*['"]2d['"]/, 'CanvasRenderingContext2D'],
  [/getContext\(\s*['"](?:webgl2|experimental-webgl|webgl)['"]/, 'WebGLRenderingContext'],
  [/new\s+(?:window\.)?(?:webkit)?AudioContext\b|AudioContext\s*\|\|/, 'AudioContext'],
  [/\.createOscillator\(/, 'OscillatorNode'],
  [/\.createGain\(/, 'GainNode'],
  [/\.createBiquadFilter\(/, 'BiquadFilterNode'],
  [/createElement\(\s*['"]canvas['"]/, 'HTMLCanvasElement'],
  [/(?:getElementById|querySelector|createElement|closest)\(|\.(?:parentElement|firstElementChild|lastElementChild)\b/, 'HTMLElement'],
  [/\.classList\s*;?\s*$/, 'DOMTokenList'],
  [/\.style\s*;?\s*$/, 'CSSStyleDeclaration'],
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
};

/** Methods of Chatty's own objects (not browser types) */
const OWN_METHODS: Record<string, string[]> = {
  '@out': ['send', 'play', 'playNote'],
};

/** The type (or named object) the object expression refers to in this program, or null */
export function objectType(code: string, object: string): string | null {
  if (NAMED[object]) return NAMED[object];
  for (const [made, type] of MADE_BY) if (made.test(object)) return type;
  const last = object.split('.').pop() ?? object;
  if (last === 'classList') return 'DOMTokenList';
  if (last === 'style') return 'CSSStyleDeclaration';
  if (last === 'body' || last === 'parentElement') return 'HTMLElement';
  // What the program assigned to it: `const ctx = canvas.getContext('2d')`
  const name = object.replace(/^this\./, '').replace(/[.$]/g, (c) => `\\${c}`);
  const assignment = code.match(new RegExp(`(?:^|[^\\w$.])${name}\\s*=(?!=)\\s*([^;\\n]+)`, 'm'));
  if (!assignment) return null;
  for (const [made, type] of MADE_BY) if (made.test(assignment[1])) return type;
  return null;
}

/** Every method name of a browser type or known object (own and inherited) */
export function methodNames(type: string, scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): string[] {
  if (OWN_METHODS[type]) return OWN_METHODS[type];
  let target: unknown = type.startsWith('@') ? scope[type.slice(1)] : (scope[type] as { prototype?: unknown } | undefined)?.prototype;
  const names = new Set<string>();
  while (target && target !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(target)) {
      if (key === 'constructor' || key.startsWith('_')) continue;
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor && typeof descriptor.value === 'function') names.add(key);
    }
    target = Object.getPrototypeOf(target);
  }
  return [...names];
}

function distance(a: string, b: string): number {
  // Edits between two names, a swap of neighbours counting as one (totla → total)
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Words of a camelCase name: fillCircle → fill, circle */
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_]+/).filter(Boolean);

/** The real methods closest to the missing one, best first */
export function closestMethods(missing: string, names: string[], count = 3): string[] {
  const lower = missing.toLowerCase();
  const missingWords = new Set(words(missing));
  const score = (name: string) => {
    const shared = words(name).filter((w) => missingWords.has(w)).length;
    return distance(lower, name.toLowerCase()) - shared * 3;
  };
  return [...names].sort((a, b) => score(a) - score(b)).slice(0, count);
}

/** The one real method a missing name is surely a slip of (wrong case, a typo), or null */
export function nearMiss(missing: string, names: string[]): string | null {
  const lower = missing.toLowerCase();
  const sameLetters = names.filter((name) => name.toLowerCase() === lower);
  if (sameLetters.length === 1) return sameLetters[0];
  if (missing.length < 5) return null;
  const close = names.filter((name) => distance(lower, name.toLowerCase()) <= 2);
  return close.length === 1 ? close[0] : null;
}

export interface MethodHint {
  /** A sentence for the fix request: what the object is and its closest methods */
  text: string;
  /** A slip that can be corrected without the model */
  correction?: { object: string; from: string; to: string };
}

/** Help for a "not a function" error: the candidates, and a correction when it's a slip */
export function methodHint(code: string, error: string, scope?: Record<string, unknown>): MethodHint | null {
  const missing = missingMethod(error);
  if (!missing) return null;
  const type = objectType(code, missing.object);
  if (!type) return null;
  const names = methodNames(type, scope);
  if (names.length === 0) return null;
  const typeName = type.startsWith('@') ? missing.object : `a ${type}`;
  const fix = nearMiss(missing.method, names);
  const closest = closestMethods(missing.method, names);
  return {
    text: `${missing.object} is ${typeName}, which has no ${missing.method}(). Its closest methods: ${closest.map((n) => `${n}()`).join(', ')}.`,
    ...(fix ? { correction: { object: missing.object, from: missing.method, to: fix } } : {}),
  };
}

/** The program with every call of object.from renamed to object.to */
export function applyCorrection(code: string, correction: { object: string; from: string; to: string }): string {
  const object = correction.object.replace(/[.$]/g, (c) => `\\${c}`);
  return code.replace(new RegExp(`(\\b${object}\\s*\\.\\s*)${correction.from}\\b`, 'g'), `$1${correction.to}`);
}
