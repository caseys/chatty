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
import { parse, parseExpressionAt } from 'acorn';
import { analyse, resolve, type Tree } from './blank-fix.ts';
import { closestMembers, CONTEXT_2D_METHODS, describeMember, memberKind, namesSources, nearMiss, objectType, typeLabel, usedMembers } from './method-hints.ts';
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
 * Drawing calls and settings made on a canvas element itself (`canvas.beginPath()`, `canvas.fillStyle
 * = 'red'`): they belong to its 2D context, which the same element gives back (`canvas.getContext
 * ("2d")`, always the same one). The browser's own types say which names are the context's alone
 * (the context has them, the element does not). Only objects the program made as canvas elements;
 * every use of such a name on them goes through the context at once (the errors name one at a
 * time). Kept only when the result parses.
 */
export function moveToContext(code: string, scope?: Record<string, unknown>): { code: string; moved: Array<{ object: string; members: string[] }> } {
  const none = { code, moved: [] as Array<{ object: string; members: string[] }> };
  if (!/\bgetContext\b|createElement\s*\(\s*['"]canvas['"]|<canvas/.test(code)) return none;
  const element = new Set(memberNames('HTMLCanvasElement', scope));
  const real = memberNames('CanvasRenderingContext2D', scope).filter((name) => !element.has(name));
  // (where the browser lacks the type, the methods every context has)
  const contextOnly = new Set(real.length > 0 ? real : [...CONTEXT_2D_METHODS]);
  contextOnly.delete('canvas');
  let ast: AnyNode;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as unknown as AnyNode;
  } catch {
    return none;
  }
  const spots: Array<{ at: number; object: string; member: string }> = [];
  // A method is the context's when it is called, a setting when it is read or written: `canvas.scale
  // = 2` (a number kept on the element, named like the method) is neither
  const kindOf = (member: string) => (real.length > 0 ? memberKind('CanvasRenderingContext2D', member, scope) : 'method');
  const visit = (node: AnyNode, parent: AnyNode | null) => {
    if (node.type === 'MemberExpression' && !node.computed && (node.property as AnyNode).type === 'Identifier' && (node.object as AnyNode).type === 'Identifier') {
      const object = (node.object as AnyNode).name as string;
      const member = (node.property as AnyNode).name as string;
      const called = parent?.type === 'CallExpression' && parent.callee === node;
      if (contextOnly.has(member) && kindOf(member) === (called ? 'method' : 'property')) spots.push({ at: (node.object as AnyNode).end, object, member });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && visit(child, node);
      else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') visit(value as AnyNode, node);
    }
  };
  visit(ast, null);
  const canvases = new Map<string, boolean>();
  const isCanvas = (object: string) => {
    if (!canvases.has(object)) canvases.set(object, ['HTMLCanvasElement', 'element:canvas'].includes(objectType(code, object) ?? ''));
    return canvases.get(object)!;
  };
  const chosen = spots.filter((spot) => isCanvas(spot.object));
  if (chosen.length === 0) return none;
  let fixed = code;
  for (const spot of [...chosen].sort((a, b) => b.at - a.at)) fixed = `${fixed.slice(0, spot.at)}.getContext("2d")${fixed.slice(spot.at)}`;
  const moved = new Map<string, Set<string>>();
  for (const spot of chosen) moved.set(spot.object, (moved.get(spot.object) ?? new Set()).add(spot.member));
  try {
    parse(fixed, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch {
    return none;
  }
  return { code: fixed, moved: [...moved].map(([object, members]) => ({ object, members: [...members] })) };
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

/** The named colors of CSS (each is checked against the browser's own CSS.supports before it is used) */
const COLOR_NAMES = (
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan ' +
  'darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey ' +
  'darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink ' +
  'indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
  'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
  'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise ' +
  'palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray ' +
  'slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
).split(' ');

/** Words a model puts in front of a color name to ask for another shade of it ('deeppurple', 'dark purple', 'bright-red') */
const SHADE_WORDS = ['deep', 'dark', 'light', 'bright', 'pale', 'vivid'];

/**
 * A color name made of a shade word and a CSS color that isn't a CSS color itself ('deeppurple':
 * CSS has purple, darkviolet and deeppink, no deeppurple), as the color alone ('purple'), the one
 * name the browser knows that the value says. The case, spaces, hyphens and underscores don't
 * matter ('Deep Purple'). Null when the value isn't that shape or the browser doesn't know the rest.
 */
function colorWithoutShade(value: string, known: (name: string) => boolean): string | null {
  const flat = value.toLowerCase().replace(/[\s_-]+/g, '');
  for (const shade of SHADE_WORDS) {
    const base = flat.startsWith(shade) ? flat.slice(shade.length) : '';
    if (base && COLOR_NAMES.includes(base) && known(base)) return base;
  }
  return null;
}

/** The canvas context's color properties (they take any CSS color, and keep their old value for one the browser doesn't know) */
const CANVAS_COLOR_PROPS = new Set(['fillStyle', 'strokeStyle', 'shadowColor']);

/** Names a color expression may use besides the program's own */
const COLOR_MATH = new Set(['Math', 'Number', 'parseInt', 'parseFloat', 'Infinity', 'NaN']);

/**
 * A CSS color function whose arguments are written as JavaScript inside quotes
 * (`'rgb(255, 255, 255 - 255 * (i / 60))'`, where a template literal was meant) as that template
 * literal (`` `rgb(255, 255, ${255 - 255 * (i / 60)})` ``): each argument that is not a plain number
 * or percentage becomes a `${…}` of the expression it parses as. Only when every such argument is
 * one whole expression whose names the program has in scope (or Math's), and the result parses.
 */
function colorTemplate(value: string, assignment: { start: number; end: number }, tree: Tree | null): string | null {
  const call = value.match(/^(rgba?|hsla?)\(([^`$]*)\)$/i);
  if (!call || !tree) return null;
  // The same assignment in the scope analysis's own tree (its scopes are looked up from there)
  const at = tree.nodes.find((n) => n.type === 'AssignmentExpression' && n.start === assignment.start && n.end === assignment.end);
  if (!at) return null;
  // The arguments, split at the commas outside brackets
  const args: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < call[2].length; i++) {
    const ch = call[2][i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      args.push(call[2].slice(from, i));
      from = i + 1;
    }
  }
  args.push(call[2].slice(from));
  if (depth !== 0 || args.length < 3 || args.length > 4) return null;
  let computed = 0;
  const parts: string[] = [];
  for (const arg of args.map((a) => a.trim())) {
    if (/^[\d.]+%?$/.test(arg)) {
      parts.push(arg);
      continue;
    }
    let expression: AnyNode;
    try {
      expression = parseExpressionAt(arg, 0, { ecmaVersion: 'latest' }) as unknown as AnyNode;
    } catch {
      return null;
    }
    if (expression.end !== arg.length) return null;
    // Every name in it is the program's own (or Math's)
    let known = true;
    const visit = (node: AnyNode, parent: AnyNode | null) => {
      if (node.type === 'Identifier' && !(parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)) {
        if (!COLOR_MATH.has(node.name as string) && !resolve(tree, at, node.name as string)) known = false;
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) for (const c of child) c && typeof c.type === 'string' && visit(c, node);
        else if (child && typeof child === 'object' && typeof (child as AnyNode).type === 'string') visit(child as AnyNode, node);
      }
    };
    visit(expression, null);
    if (!known) return null;
    computed++;
    parts.push(`\${${arg}}`);
  }
  return computed > 0 ? `\`${call[1]}(${parts.join(', ')})\`` : null;
}

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
  // el.setAttribute('fill', 'whit'): the SVG and HTML color attributes, as the style properties are
  const colorCalls: AnyNode[] = [];
  const visitCalls = (node: AnyNode) => {
    const callee = node.callee as AnyNode | undefined;
    if (node.type === 'CallExpression' && callee?.type === 'MemberExpression' && !callee.computed && (callee.property as AnyNode).name === 'setAttribute') colorCalls.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && visitCalls(child);
      else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') visitCalls(value as AnyNode);
    }
  };
  visitCalls(ast);
  visit(ast);
  const supports = (scope.CSS as { supports?: (property: string, value: string) => boolean } | undefined)?.supports;
  const issues: AssignmentIssue[] = [];
  for (const call of colorCalls) {
    const [name, value] = call.arguments as AnyNode[];
    if (!supports || name?.type !== 'Literal' || value?.type !== 'Literal' || typeof name.value !== 'string' || typeof value.value !== 'string') continue;
    if (!/^(?:fill|stroke|stop-color|flood-color|lighting-color|color|bgcolor)$/i.test(name.value)) continue;
    try {
      if (supports('color', value.value)) continue;
      const named = nearMiss(value.value, COLOR_NAMES.filter((candidate) => supports('color', candidate))) ?? colorWithoutShade(value.value, (candidate) => supports('color', candidate));
      if (!named) continue;
      const object = pathOf((call.callee as AnyNode).object as AnyNode, code) ?? 'el';
      issues.push({
        line: (call.loc as { start: { line: number } }).start.line,
        object,
        member: name.value,
        kind: 'invalid-value',
        message: `'${value.value}' is not a color the browser knows (${object}.setAttribute('${name.value}')), so it is ignored. '${named}' is.`,
        fix: { start: value.start, end: value.end, text: `'${named}'`, note: `${object}.setAttribute('${name.value}', '${value.value}') → '${named}'` },
      });
    } catch {
      // CSS.supports refused its input
    }
  }
  // (the program's scopes, read when a color needs them)
  let tree: Tree | null | undefined;
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
    const canvasColor = type === 'CanvasRenderingContext2D' && CANVAS_COLOR_PROPS.has(member);
    if ((type !== 'CSSStyleDeclaration' && !canvasColor) || !supports || !/^[a-z][a-zA-Z]*$/.test(member)) continue;
    const right = assignment.right as AnyNode;
    const literal =
      right.type === 'Literal' && typeof right.value === 'string'
        ? (right.value as string)
        : right.type === 'TemplateLiteral' && (right.expressions as AnyNode[]).length === 0
          ? (((right.quasis as AnyNode[])[0].value as { cooked: string }).cooked)
          : null;
    const value = literal?.replace(/\s*!important\s*$/i, '').trim();
    if (!value) continue;
    if (canvasColor) {
      // A canvas color the browser doesn't know is ignored without a word
      try {
        if (supports('color', value)) continue;
      } catch {
        continue;
      }
      tree = tree === undefined ? analyse(code) : tree;
      const template = colorTemplate(value, assignment, tree);
      if (template) {
        issues.push({
          line,
          object,
          member,
          kind: 'invalid-value',
          message: `'${value}' is not a color the browser knows (${object}.${member}): it is JavaScript inside quotes, so the browser ignores it.`,
          fix: { start: right.start, end: right.end, text: template, note: `${object}.${member} = '${value}' → ${template}: JavaScript in a color needs a template literal` },
        });
        continue;
      }
      // A named color one slip away (whit for white)
      const named = nearMiss(value, COLOR_NAMES.filter((name) => supports('color', name))) ?? colorWithoutShade(value, (name) => supports('color', name));
      if (named) {
        issues.push({
          line,
          object,
          member,
          kind: 'invalid-value',
          message: `'${value}' is not a color the browser knows (${object}.${member}), so it is ignored. '${named}' is.`,
          fix: { start: right.start, end: right.end, text: `'${named}'`, note: `${object}.${member} = '${value}' → '${named}'` },
        });
      }
      continue;
    }
    try {
      // The property must be one the browser knows (anything else is an unknown member's business)
      if (!supports(kebab(member), 'inherit') || supports(kebab(member), value)) continue;
      const candidates = (STYLE_KEYWORDS[member] ?? []).filter((candidate) => supports(kebab(member), candidate));
      // (a color property: backgroundColor, fill, stroke, and background when it is a single word)
      const colored = /(?:color|^fill|^stroke)$/i.test(member) || (member === 'background' && /^[A-Za-z]+$/.test(value));
      const near = nearMiss(value, colored ? COLOR_NAMES.filter((name) => supports(kebab(member), name)) : candidates) ?? (colored ? colorWithoutShade(value, (name) => supports(kebab(member), name)) : null);
      // (a color function with JavaScript in its arguments: a template literal was meant)
      tree = tree === undefined ? analyse(code) : tree;
      const template = near || !colored ? null : colorTemplate(value, assignment, tree);
      issues.push({
        line,
        object,
        member,
        kind: 'invalid-value',
        message: `'${value}' is not a valid ${kebab(member)} value (${object}.${member}), so the browser ignores it.${candidates.length ? ` Values it accepts include: ${candidates.slice(0, 8).join(', ')}.` : ''}`,
        ...(near ? { fix: { start: right.start, end: right.end, text: `'${near}'`, note: `${object}.${member} = '${value}' → '${near}'` } } : {}),
        ...(template ? { fix: { start: right.start, end: right.end, text: template, note: `${object}.${member} = '${value}' → ${template}: JavaScript in a color needs a template literal` } } : {}),
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
