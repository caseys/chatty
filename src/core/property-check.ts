/**
 * Members a program uses that its objects don't have. A misspelled property doesn't throw: it
 * silently does nothing (`ctx.fillstyle = 'red'`, `el.style.backgroundColour = 'blue'`). So
 * before a program runs, every member it uses on an object of a known type (the type worked out
 * from the code, as in method-hints.ts) is checked against the browser's own names for that
 * type. A sure slip is corrected; anything else is reported, with the closest real names.
 *
 * Only objects where made-up members make no sense are checked for properties: canvas and
 * WebGL contexts, audio objects, style objects, document, Math, console, JSON. On elements,
 * which programs legitimately give properties of their own (button.count = 0), only method
 * calls are checked.
 */
import { parse } from 'acorn';
import { closestMethods, namesSources, nearMiss, objectType, typeLabel } from './method-hints.ts';

const PROPERTY_CHECKED = new Set([
  'CanvasRenderingContext2D',
  'WebGLRenderingContext',
  'WebGL2RenderingContext',
  'AudioContext',
  'OscillatorNode',
  'GainNode',
  'BiquadFilterNode',
  'CSSStyleDeclaration',
  'DOMTokenList',
  'Document',
  '@Math',
  '@console',
  '@JSON',
]);

export interface UnknownMember {
  line: number;
  object: string;
  member: string;
  type: string;
  isCall: boolean;
  /** The real name it is surely a slip of, or null */
  slip: string | null;
  closest: string[];
}

/** Every member name (property or method, own or inherited) of a browser type or known object */
export function memberNames(type: string, scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): string[] {
  const names = new Set<string>();
  if (type === 'CSSStyleDeclaration') {
    // Style properties live on instances in some browsers: ask a real one
    try {
      const doc = scope.document as Document | undefined;
      const style = doc?.createElement('div').style as unknown as Record<string, unknown> | undefined;
      if (style) for (const key in style) names.add(key);
    } catch {
      // No document here
    }
  }
  for (const source of namesSources(type, scope)) {
    let target: unknown = source;
    while (target && target !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(target)) if (key !== 'constructor') names.add(key);
      target = Object.getPrototypeOf(target);
    }
  }
  // Only names that can follow a dot ('background-color' can't)
  return [...names].filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

type AnyNode = Record<string, unknown> & { type: string; start: number; end: number };

/** A plain path like `ctx` or `document.body.style`, or null */
function pathOf(node: AnyNode, code: string): string | null {
  if (node.type === 'Identifier') return node.name as string;
  if (node.type === 'MemberExpression' && !node.computed && (node.property as AnyNode).type === 'Identifier') {
    const inner = pathOf(node.object as AnyNode, code);
    return inner ? `${inner}.${(node.property as AnyNode).name as string}` : null;
  }
  return null;
}

/** Members the program uses that their objects don't have, in order */
export function unknownMembers(code: string, scope?: Record<string, unknown>): UnknownMember[] {
  let ast: AnyNode;
  try {
    ast = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    }) as unknown as AnyNode;
  } catch {
    return [];
  }
  type Use = { node: AnyNode; object: string; member: string; isCall: boolean; isWrite: boolean };
  const uses: Use[] = [];
  const visit = (node: AnyNode, parent: AnyNode | null) => {
    if (node.type === 'MemberExpression' && !node.computed && (node.property as AnyNode).type === 'Identifier') {
      const object = pathOf(node.object as AnyNode, code);
      if (object) {
        uses.push({
          node,
          object,
          member: (node.property as AnyNode).name as string,
          isCall: parent?.type === 'CallExpression' && parent.callee === node,
          isWrite: parent?.type === 'AssignmentExpression' && parent.left === node,
        });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && visit(child, node);
      else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') visit(value as AnyNode, node);
    }
  };
  visit(ast, null);

  const types = new Map<string, string | null>();
  const namesOf = new Map<string, string[]>();
  const found: UnknownMember[] = [];
  const seen = new Set<string>();
  for (const use of uses) {
    if (!types.has(use.object)) types.set(use.object, objectType(code, use.object));
    const type = types.get(use.object);
    if (!type) continue;
    const key = `${use.object}.${use.member}`;
    if (seen.has(key)) continue;
    const checked = PROPERTY_CHECKED.has(type) || (use.isCall && /^HTML|^SVG|^element:/.test(type));
    if (!checked) continue;
    if (!namesOf.has(type)) namesOf.set(type, memberNames(type, scope));
    const names = namesOf.get(type)!;
    if (names.length === 0 || names.includes(use.member)) continue;
    seen.add(key);
    const slip = nearMiss(use.member, names);
    // A member the program sets and then uses itself is its own (Math.clamp = …; Math.clamp(x)),
    // unless it is a sure slip of a real one (style.backgroundColour). One only ever set
    // (ctx.fillColor = 'red') does nothing, and is reported.
    const same = uses.filter((u) => u.object === use.object && u.member === use.member);
    if (!slip && same.some((u) => u.isWrite) && same.some((u) => !u.isWrite)) continue;
    found.push({
      line: (use.node.loc as { start: { line: number } }).start.line,
      object: use.object,
      member: use.member,
      type,
      isCall: use.isCall,
      slip,
      closest: closestMethods(use.member, names),
    });
  }
  return found;
}

/** The program with each member renamed (object.from → object.to) */
export function renameMembers(code: string, renames: Array<{ object: string; from: string; to: string }>): string {
  let out = code;
  for (const { object, from, to } of renames) {
    const path = object.replace(/[.$]/g, (c) => `\\${c}`).replace(/\\\./g, '\\s*\\.\\s*');
    out = out.replace(new RegExp(`(\\b${path}\\s*\\.\\s*)${from}\\b`, 'g'), `$1${to}`);
  }
  return out;
}

/** The error a program gets for a member its object doesn't have */
export function unknownMemberError(issue: UnknownMember): string {
  const kind = typeLabel(issue.type, issue.object);
  const what = issue.isCall ? 'method' : 'property';
  return `${issue.object}.${issue.member} is not a ${what} of ${kind}. Its closest: ${issue.closest.join(', ')}.`;
}
