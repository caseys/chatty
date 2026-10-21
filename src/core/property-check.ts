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
import { closestMembers, describeMember, memberKind, namesSources, nearMiss, objectType, typeLabel, usedMembers } from './method-hints.ts';
import { sureMatch } from './fuzzy-match.ts';

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
  /** Where the member's name is written, at every use of object.member (for renameMembers) */
  spans: Array<{ start: number; end: number }>;
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

/**
 * Whether a type is one of the browser's audio nodes (its prototype chain reaches AudioNode's):
 * every one gets the property check, since a made-up member on a node does nothing, silently
 */
function isAudioNodeType(type: string, scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): boolean {
  const ctor: unknown = scope[type];
  const base: unknown = scope.AudioNode;
  return typeof ctor === 'function' && typeof base === 'function' && ctor.prototype instanceof base;
}

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
    const checked = PROPERTY_CHECKED.has(type) || isAudioNodeType(type, scope) || (use.isCall && /^HTML|^SVG|^element:/.test(type));
    if (!checked) continue;
    if (!namesOf.has(type)) namesOf.set(type, memberNames(type, scope));
    const names = namesOf.get(type)!;
    if (names.length === 0 || names.includes(use.member)) continue;
    seen.add(key);
    // A slip, or the name reshaped (val for value, page for getPage) when the kind fits: a
    // method for a call, a property for a read or a write
    const reshaped = sureMatch(use.member, names, { reshaped: true, used: usedMembers(code) });
    const slip = nearMiss(use.member, names) ?? (reshaped && (memberKind(type, reshaped, scope) === 'method') === use.isCall ? reshaped : null);
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
      closest: closestMembers(type, use.member, use.isCall, scope),
      spans: same.map((u) => ({ start: (u.node.property as AnyNode).start, end: (u.node.property as AnyNode).end })),
    });
  }
  return found;
}

/**
 * The program with each member renamed (object.from → object.to): at the uses the parser found
 * when they are given, else wherever the text occurs
 */
export function renameMembers(code: string, renames: Array<{ object: string; from: string; to: string; spans?: Array<{ start: number; end: number }> }>): string {
  const edits = renames.flatMap(({ to, spans }) => (spans ?? []).map((span) => ({ ...span, to })));
  let out = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.to + out.slice(e.end);
  for (const { object, from, to, spans } of renames) {
    if (spans) continue;
    const path = object.replace(/[.$]/g, (c) => `\\${c}`).replace(/\\\./g, '\\s*\\.\\s*');
    out = out.replace(new RegExp(`(\\b${path}\\s*\\.\\s*)${from}\\b`, 'g'), `$1${to}`);
  }
  return out;
}

/** The error a program gets for a member its object doesn't have */
export function unknownMemberError(issue: UnknownMember, scope?: Record<string, unknown>): string {
  const kind = typeLabel(issue.type, issue.object);
  const what = issue.isCall ? `${issue.member}()` : issue.member;
  const has = issue.closest.map((n) => describeMember(issue.type, issue.object, n, scope)).join(', ');
  return `${issue.object} is ${kind}, which has no ${what}. It has ${has}: use the one you meant.`;
}

/**
 * Assignments that do nothing: a write to a property the browser gives only a getter
 * (`canvas.clientWidth = 300`, `ctx.canvas = c`), and a literal value a style property can't
 * take (`el.style.display = 'flexbox'`, checked with CSS.supports). Both are silent (or a
 * TypeError in strict mode) in the sandbox, so they are found before the program runs. A
 * `fix` (an edit to the code) is given only when one answer is clear.
 */
export interface AssignmentIssue {
  line: number;
  object: string;
  member: string;
  kind: 'read-only' | 'invalid-value';
  /** The error text for the fix request */
  message: string;
  fix?: { start: number; end: number; text: string; note: string };
}

type Descriptor = { get?: unknown; set?: unknown; writable?: boolean } | undefined;

/** How a type's member can be written: the first descriptor along each prototype chain */
export function writability(type: string, member: string, scope?: Record<string, unknown>): 'read-only' | 'writable' | 'unknown' {
  const kinds: string[] = [];
  for (const source of namesSources(type, scope)) {
    let target: unknown = source;
    while (target && target !== Object.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(target, member) as Descriptor;
      if (descriptor) {
        const getterOnly = !!descriptor.get && !descriptor.set;
        kinds.push(getterOnly ? 'read-only' : 'writable');
        break;
      }
      target = Object.getPrototypeOf(target);
    }
  }
  // An element of unknown tag spans many types: read-only only where every type that has it says so
  if (kinds.length === 0) return 'unknown';
  return kinds.every((k) => k === 'read-only') ? 'read-only' : 'writable';
}

/** The writable member a read-only size/position name stands for (clientWidth → width) */
function writableCounterpart(type: string, member: string, scope?: Record<string, unknown>): string | null {
  if (type === 'HTMLElement') return null;
  const stem = member.match(/^(?:client|offset|scroll|natural)([A-Z]\w*)$/)?.[1];
  if (!stem) return null;
  const counterpart = stem[0].toLowerCase() + stem.slice(1);
  return writability(type, counterpart, scope) === 'writable' ? counterpart : null;
}

/** Common keyword values of style properties, checked against CSS.supports before use */
const STYLE_KEYWORDS: Record<string, string[]> = {
  display: ['none', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'contents', 'table', 'flow-root'],
  position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
  visibility: ['visible', 'hidden', 'collapse'],
  overflow: ['visible', 'hidden', 'scroll', 'auto', 'clip'],
  textAlign: ['left', 'right', 'center', 'justify', 'start', 'end'],
  flexDirection: ['row', 'row-reverse', 'column', 'column-reverse'],
  flexWrap: ['nowrap', 'wrap', 'wrap-reverse'],
  justifyContent: ['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly', 'start', 'end'],
  alignItems: ['stretch', 'flex-start', 'flex-end', 'center', 'baseline', 'start', 'end'],
  cursor: ['auto', 'default', 'pointer', 'text', 'move', 'grab', 'grabbing', 'not-allowed', 'crosshair', 'wait'],
  whiteSpace: ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line'],
  textTransform: ['none', 'capitalize', 'uppercase', 'lowercase'],
  boxSizing: ['content-box', 'border-box'],
  pointerEvents: ['auto', 'none'],
  userSelect: ['auto', 'none', 'text', 'all'],
  fontStyle: ['normal', 'italic', 'oblique'],
  textDecoration: ['none', 'underline', 'overline', 'line-through'],
};

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Assignments to read-only properties and to style properties with values they can't take */
export function unusableAssignments(code: string, scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): AssignmentIssue[] {
  let ast: AnyNode;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, locations: true }) as unknown as AnyNode;
  } catch {
    return [];
  }
  const assignments: AnyNode[] = [];
  const visit = (node: AnyNode) => {
    if (node.type === 'AssignmentExpression') assignments.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && visit(child);
      else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') visit(value as AnyNode);
    }
  };
  visit(ast);
  const supports = (scope.CSS as { supports?: (property: string, value: string) => boolean } | undefined)?.supports;
  const issues: AssignmentIssue[] = [];
  for (const assignment of assignments) {
    const left = assignment.left as AnyNode;
    if (left.type !== 'MemberExpression' || left.computed || (left.property as AnyNode).type !== 'Identifier') continue;
    const object = pathOf(left.object as AnyNode, code);
    if (!object) continue;
    const member = (left.property as AnyNode).name as string;
    const type = objectType(code, object);
    if (!type || type.startsWith('@')) continue;
    const line = (left.loc as { start: { line: number } }).start.line;
    const property = left.property as AnyNode;
    if (writability(type, member, scope) === 'read-only') {
      const counterpart = writableCounterpart(type, member, scope);
      issues.push({
        line,
        object,
        member,
        kind: 'read-only',
        message: `${object}.${member} can only be read (${typeLabel(type, object)} gives it a getter and no setter), so writing to it changes nothing.${counterpart ? ` The property to write is ${counterpart}.` : ''}`,
        ...(counterpart && assignment.operator === '='
          ? { fix: { start: property.start, end: property.end, text: counterpart, note: `${object}.${member} → ${object}.${counterpart}` } }
          : {}),
      });
      continue;
    }
    if (type !== 'CSSStyleDeclaration' || !supports || !/^[a-z][a-zA-Z]*$/.test(member)) continue;
    const right = assignment.right as AnyNode;
    const literal =
      right.type === 'Literal' && typeof right.value === 'string'
        ? (right.value as string)
        : right.type === 'TemplateLiteral' && (right.expressions as AnyNode[]).length === 0
          ? (((right.quasis as AnyNode[])[0].value as { cooked: string }).cooked)
          : null;
    const value = literal?.replace(/\s*!important\s*$/i, '').trim();
    if (!value) continue;
    try {
      // The property must be one the browser knows (anything else is an unknown member's business)
      if (!supports(kebab(member), 'inherit') || supports(kebab(member), value)) continue;
      const candidates = (STYLE_KEYWORDS[member] ?? []).filter((candidate) => supports(kebab(member), candidate));
      const near = nearMiss(value, candidates);
      issues.push({
        line,
        object,
        member,
        kind: 'invalid-value',
        message: `'${value}' is not a valid ${kebab(member)} value (${object}.${member}), so the browser ignores it.${candidates.length ? ` Values it accepts include: ${candidates.slice(0, 8).join(', ')}.` : ''}`,
        ...(near ? { fix: { start: right.start, end: right.end, text: `'${near}'`, note: `${object}.${member} = '${value}' → '${near}'` } } : {}),
      });
    } catch {
      // CSS.supports refused its input: nothing to say
    }
  }
  return issues;
}

/** The program with the fixes of these issues applied (by position) */
export function applyAssignmentFixes(code: string, issues: AssignmentIssue[]): string {
  let out = code;
  const fixes = issues.flatMap((issue) => (issue.fix ? [issue.fix] : [])).sort((a, b) => b.start - a.start);
  for (const fix of fixes) out = out.slice(0, fix.start) + fix.text + out.slice(fix.end);
  return out;
}
