import { parse, type Node } from 'acorn';
import { enclosingFunction } from './line-fix.ts';
import { methodNames } from './method-hints.ts';

/**
 * Fill-in-the-blank fixing. A tiny model asked to rewrite a failing line copies it back; asked
 * "replace THIS expression with:" it has one small thing to do. The blank is the expression the
 * error names, found with the parser: an undeclared name, the receiver of a missing method, the
 * value that was undefined or null, what isn't a constructor or iterable. Everything comes from
 * the error message (Chrome, Safari and Firefox wording), the acorn AST and the page's ids.
 */

export interface Blank {
  /** 1-based line in the program */
  line: number;
  /** The failing expression's source */
  text: string;
  /** Char offsets in the program of every occurrence to replace (same expression, same scope) */
  spans: Array<{ start: number; end: number }>;
  /** Short plain description: "bill is not declared", "this has no play()" */
  why: string;
}

type AnyNode = Node & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OPTIONS = { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, locations: true } as const;

/** How near the reported line a failing node may be (a wrapper can shift lines a little) */
const NEAR = 3;

interface Tree {
  ast: AnyNode;
  nodes: AnyNode[];
  parent: Map<AnyNode, AnyNode>;
  key: Map<AnyNode, string>;
  /** Names each scope node declares */
  scopes: Map<AnyNode, Set<string>>;
  /** Identifiers that declare (not refer to) a name */
  bindings: Set<AnyNode>;
}

const isNode = (v: unknown): v is AnyNode => !!v && typeof v === 'object' && typeof (v as AnyNode).type === 'string';

function analyse(code: string): Tree | null {
  let ast: AnyNode;
  try {
    ast = parse(code, OPTIONS) as unknown as AnyNode;
  } catch {
    return null;
  }
  const tree: Tree = { ast, nodes: [], parent: new Map(), key: new Map(), scopes: new Map(), bindings: new Set() };
  const visit = (node: AnyNode) => {
    tree.nodes.push(node);
    for (const [k, value] of Object.entries(node)) {
      if (k === 'loc') continue;
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (!isNode(child)) continue;
        tree.parent.set(child, node);
        tree.key.set(child, k);
        visit(child);
      }
    }
  };
  visit(ast);
  const up = (node: AnyNode, test: (n: AnyNode) => boolean): AnyNode => {
    let at = tree.parent.get(node);
    while (at && !test(at)) at = tree.parent.get(at);
    return at ?? ast;
  };
  const isFunction = (n: AnyNode) => /Function/.test(n.type);
  const isBlock = (n: AnyNode) => ['BlockStatement', 'Program', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'StaticBlock'].includes(n.type) || isFunction(n);
  const declare = (scope: AnyNode, id: AnyNode | null | undefined) => {
    if (!id) return;
    const names = tree.scopes.get(scope) ?? new Set<string>();
    tree.scopes.set(scope, names);
    const bind = (p: AnyNode | null) => {
      if (!p) return;
      if (p.type === 'Identifier') {
        names.add(p.name);
        tree.bindings.add(p);
      } else if (p.type === 'ObjectPattern') p.properties.forEach((prop: AnyNode) => bind(prop.type === 'RestElement' ? prop.argument : prop.value));
      else if (p.type === 'ArrayPattern') p.elements.forEach((e: AnyNode | null) => bind(e));
      else if (p.type === 'RestElement') bind(p.argument);
      else if (p.type === 'AssignmentPattern') bind(p.left);
    };
    bind(id);
  };
  for (const node of tree.nodes) {
    if (node.type === 'VariableDeclarator') {
      const declaration = tree.parent.get(node)!;
      declare(declaration.kind === 'var' ? up(node, (n) => isFunction(n) || n.type === 'Program') : up(node, isBlock), node.id);
    } else if (node.type === 'FunctionDeclaration') {
      declare(up(node, (n) => isFunction(n) || n.type === 'Program'), node.id);
    } else if (node.type === 'ClassDeclaration') {
      declare(up(node, isBlock), node.id);
    }
    if (isFunction(node)) {
      node.params.forEach((p: AnyNode) => declare(node, p));
      if (node.type === 'FunctionExpression' && node.id) declare(node, node.id);
    }
    if (node.type === 'ClassExpression' && node.id) declare(node, node.id);
    if (node.type === 'CatchClause' && node.param) declare(node, node.param);
  }
  return tree;
}

/** The scope node that declares `name` as seen from `node`, or null when nothing does */
function resolve(tree: Tree, node: AnyNode, name: string): AnyNode | null {
  let at: AnyNode | undefined = node;
  while (at) {
    if (tree.scopes.get(at)?.has(name)) return at;
    at = tree.parent.get(at);
  }
  return null;
}

/** An identifier that refers to a binding (not a property name, a declaration or a label) */
function isReference(tree: Tree, node: AnyNode): boolean {
  if (node.type !== 'Identifier' || tree.bindings.has(node)) return false;
  const parent = tree.parent.get(node);
  const key = tree.key.get(node);
  if (!parent) return false;
  if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return false;
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && key === 'key' && !parent.computed) return false;
  // `{ bill }`: the name is also the key, so it can't be replaced on its own
  if (parent.type === 'Property' && parent.shorthand) return false;
  if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type) && key === 'label') return false;
  return true;
}

/** Written to rather than read: `a = 1`, `a++`, `for (a of b)`, `[a, b] = c` */
function isTarget(tree: Tree, node: AnyNode): boolean {
  let at: AnyNode = node;
  for (;;) {
    const parent = tree.parent.get(at);
    if (!parent) return false;
    const key = tree.key.get(at);
    if (parent.type === 'AssignmentExpression' && key === 'left') return true;
    if (parent.type === 'UpdateExpression') return true;
    if ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && key === 'left') return true;
    if (parent.type === 'ObjectPattern' || parent.type === 'ArrayPattern' || parent.type === 'RestElement') return true;
    if (parent.type === 'AssignmentPattern' && key === 'left') return true;
    if (parent.type === 'Property' && key === 'value' && tree.parent.get(parent)?.type === 'ObjectPattern') return true;
    return false;
  }
}

const startLine = (node: AnyNode) => (node.loc?.start.line as number) ?? 0;
/** The line a node's failure happens on: a member's property, else its start */
const failLine = (node: AnyNode) => (node.type === 'MemberExpression' ? startLine(node.property) : startLine(node));

/** Source with whitespace gone and quotes unified, for comparing the program's text with an error's */
const strip = (text: string) => text.replace(/\s+/g, '').replace(/["'`]/g, "'");

/** How the browser words an expression in a message: arguments become (...), other values (intermediate value) */
function render(node: AnyNode): string {
  switch (node.type) {
    case 'Identifier':
      return node.name;
    case 'ThisExpression':
      return 'this';
    case 'Super':
      return 'super';
    case 'MemberExpression':
      return `${render(node.object)}${node.computed ? '[...]' : `.${node.property.name}`}`;
    case 'CallExpression':
      return `${render(node.callee)}(...)`;
    case 'ChainExpression':
      return render(node.expression);
    default:
      return '(intermediate value)';
  }
}

/** Does an expression node match the text an error message gives for it? */
function matches(code: string, node: AnyNode, text: string): boolean {
  if (strip(code.slice(node.start, node.end)) === strip(text)) return true;
  const wanted = text.replace(/\s+/g, '').replace(/\[[^\]]*\]/g, '[...]');
  const parts = wanted.split('(intermediatevalue)').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`).test(render(node).replace(/\s+/g, ''));
}

/** Nodes of a type, nearest the reported line first (and within NEAR of it), in source order among equals */
function near<T extends AnyNode>(tree: Tree, errorLine: number | undefined, test: (n: AnyNode) => boolean, lineOfNode: (n: AnyNode) => number = startLine): T[] {
  const found = tree.nodes.filter(test).filter((n) => !errorLine || Math.abs(lineOfNode(n) - errorLine) <= NEAR);
  return found.sort((a, b) => (errorLine ? Math.abs(lineOfNode(a) - errorLine) - Math.abs(lineOfNode(b) - errorLine) : 0) || a.start - b.start) as T[];
}

/** Message text with the "Uncaught TypeError: " prefix gone */
const bare = (error: string) => error.trim().replace(/^(?:Uncaught\s+)?(?:\w*Error:\s*)?/, '');

const GLOBAL_OBJECTS = new Set(['this', 'document', 'window', 'globalThis', 'console', 'Math', 'JSON', 'Object', 'Array', 'Date', 'Promise', 'navigator', 'location', 'localStorage']);

/** Every occurrence of an expression in the scope around `node`, resolving to the same binding */
function occurrences(tree: Tree, code: string, node: AnyNode): Array<{ start: number; end: number }> {
  const text = code.slice(node.start, node.end);
  const functions: AnyNode[] = [];
  for (let at = tree.parent.get(node); at; at = tree.parent.get(at)) if (/Function/.test(at.type)) functions.push(at);
  const root = functions[0] ?? tree.ast;
  const leftmost = (n: AnyNode): AnyNode => (n.type === 'MemberExpression' ? leftmost(n.object) : n.type === 'CallExpression' ? leftmost(n.callee) : n);
  const binding = (n: AnyNode) => {
    const head = leftmost(n);
    return head.type === 'Identifier' ? resolve(tree, head, head.name) : undefined;
  };
  const wanted = binding(node);
  const spans: Array<{ start: number; end: number }> = [];
  for (const other of tree.nodes) {
    if (other.start < root.start || other.end > root.end || other.type !== node.type || code.slice(other.start, other.end) !== text) continue;
    if (other.type === 'Identifier' && !isReference(tree, other)) continue;
    if (isTarget(tree, other)) continue;
    if (binding(other) !== wanted) continue;
    spans.push({ start: other.start, end: other.end });
  }
  return spans;
}

function blankOf(tree: Tree, code: string, node: AnyNode, why: string, line = failLine(node)): Blank {
  return { line, text: code.slice(node.start, node.end), spans: occurrences(tree, code, node), why };
}

/** The undeclared name: every reference to it that nothing declares */
function undeclared(tree: Tree, code: string, name: string, errorLine?: number): Blank | null {
  const refs = tree.nodes.filter((n) => isReference(tree, n) && n.name === name && !isTarget(tree, n) && resolve(tree, n, name) === null);
  // `typeof name` doesn't throw, so that is never the failing one
  const reads = refs.filter((n) => !(tree.parent.get(n)?.type === 'UnaryExpression' && tree.parent.get(n)!.operator === 'typeof'));
  if (reads.length === 0) return null;
  const sorted = [...reads].sort((a, b) => (errorLine ? Math.abs(startLine(a) - errorLine) - Math.abs(startLine(b) - errorLine) : 0) || a.start - b.start);
  // Only the references in the failing one's function: a name offered for the blank must be visible
  // at every place it goes (the others are found when they fail)
  const fnOf = (n: AnyNode) => {
    for (let at = tree.parent.get(n); at; at = tree.parent.get(at)) if (/Function/.test(at.type)) return at;
    return null;
  };
  const home = fnOf(sorted[0]);
  return {
    line: startLine(sorted[0]),
    text: name,
    spans: reads.filter((n) => fnOf(n) === home).sort((a, b) => a.start - b.start).map((n) => ({ start: n.start, end: n.end })),
    why: `${name} is not declared`,
  };
}

/** The expression the error names, on or near errorLine, or null when the error doesn't name one. */
export function findBlank(code: string, error: string, errorLine?: number): Blank | null {
  const tree = analyse(code);
  if (!tree) return null;
  const message = bare(error);
  const line = errorLine && errorLine >= 1 ? errorLine : undefined;

  // An undefined name
  const name = message.match(/^([A-Za-z_$][\w$]*) is not defined/)?.[1] ?? message.match(/Can't find variable: ([A-Za-z_$][\w$]*)/)?.[1];
  if (name) return undeclared(tree, code, name, line);

  // A missing method: "a.b.m is not a function", "(In 'a.b.m()', 'a.b.m' is undefined)"
  const safariCallee = message.match(/\(In '.*', '(.+)' is (?:undefined|null)\)/)?.[1];
  const notFunction = safariCallee ?? (/\(near '\.\.\./.test(message) ? undefined : message.match(/^(.+?) is not a function/)?.[1]);
  if (notFunction) {
    const calls = near<AnyNode>(tree, line, (n) => n.type === 'CallExpression' && matches(code, n.callee, notFunction));
    for (const call of calls) {
      const callee = call.callee as AnyNode;
      if (callee.type === 'MemberExpression') {
        const method = callee.computed ? '' : `${callee.property.name}()`;
        const receiver = callee.object as AnyNode;
        if (receiver.type === 'Super') continue;
        return blankOf(tree, code, receiver, method ? `${code.slice(receiver.start, receiver.end)} has no ${method}` : `${code.slice(receiver.start, receiver.end)} lacks that method`, failLine(callee));
      }
      if (callee.type === 'Identifier') return blankOf(tree, code, callee, `${callee.name} is not a function`);
    }
    return null;
  }

  // Reading or setting a property of nothing
  const reading =
    message.match(/Cannot (?:read|set) propert(?:y|ies) of (undefined|null)(?: \((?:reading|setting) '([^']*)'\))?/) ??
    message.match(/Cannot read property '([^']*)' of (undefined|null)/) ??
    message.match(/^(undefined|null) is not an object \(evaluating '(.+)'\)/) ??
    message.match(/can't access property "([^"]*)", (.+?) is (undefined|null)/);
  if (reading) {
    let kind: string;
    let property: string | undefined;
    let object: string | undefined;
    if (reading[0].startsWith("can't")) [property, object, kind] = [reading[1], reading[2], reading[3]];
    else if (/^Cannot read property/.test(reading[0])) [property, kind] = [reading[1], reading[2]];
    else if (/^(?:undefined|null) is not an object/.test(reading[0])) [kind, property] = [reading[1], reading[2]];
    else [kind, property] = [reading[1], reading[2]];
    const members = (n: AnyNode) =>
      n.type === 'MemberExpression' && !n.optional && !GLOBAL_OBJECTS.has(render(n.object)) && n.object.type !== 'Literal' && n.object.type !== 'TemplateLiteral';
    let wanted: AnyNode[];
    if (object !== undefined) {
      wanted = near<AnyNode>(tree, line, (n) => members(n) && matches(code, n.object, object!), failLine);
    } else if (property !== undefined && /^[\w$]+$/.test(property) && !/\(/.test(property)) {
      // "reading 'p'": the member with that property name
      wanted = near<AnyNode>(tree, line, (n) => members(n) && (n.computed ? code.slice(n.property.start, n.property.end).replace(/['"]/g, '') === property : n.property.name === property), failLine);
    } else if (property !== undefined) {
      // Safari's "evaluating 'a.b.p'" (or with a call at the end): the whole member's text
      const text = property.replace(/\(.*\)$/, '');
      wanted = near<AnyNode>(tree, line, (n) => members(n) && matches(code, n, text), failLine);
      if (wanted.length === 0) wanted = near<AnyNode>(tree, line, (n) => members(n) && matches(code, n, property!), failLine);
    } else {
      wanted = [];
    }
    if (wanted.length === 0) return null;
    // Several on one line: the first whose object isn't a plain name the program declared as a literal
    const member = wanted[0];
    return blankOf(tree, code, member.object, `${code.slice(member.object.start, member.object.end)} is ${kind}`, failLine(member));
  }

  // Destructuring nothing: "Cannot destructure property 'x' of 'obj' as it is undefined."
  const destructure = message.match(/Cannot destructure (?:property '[^']*' of )?'([^']+)' as it is (undefined|null)/);
  if (destructure) {
    const inits = near<AnyNode>(tree, line, (n) => n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && !!n.init && matches(code, n.init, destructure[1]));
    return inits.length ? blankOf(tree, code, inits[0].init, `${code.slice(inits[0].init.start, inits[0].init.end)} is ${destructure[2]}`) : null;
  }

  // Not a constructor: "Foo is not a constructor", Safari "… (evaluating 'new Foo()')"
  if (/is not a constructor/.test(message)) {
    const evaluating = message.match(/\(evaluating '(.+)'\)/)?.[1];
    const named = message.match(/^(.+?) is not a constructor/)?.[1] ?? '';
    const news = near<AnyNode>(tree, line, (n) => n.type === 'NewExpression' && (evaluating ? strip(code.slice(n.start, n.end)) === strip(evaluating) : matches(code, n.callee, named)));
    return news.length ? blankOf(tree, code, news[0].callee, `${code.slice(news[0].callee.start, news[0].callee.end)} is not a constructor`) : null;
  }

  // Not iterable: where a for-of, spread or array destructuring takes its values
  if (/is not iterable|Spread syntax requires|undefined is not a function \(near '\.\.\./.test(message)) {
    const iterables = (n: AnyNode): AnyNode | null => {
      if (n.type === 'ForOfStatement') return n.right;
      if (n.type === 'SpreadElement') return n.argument;
      if (n.type === 'VariableDeclarator' && n.id.type === 'ArrayPattern') return n.init;
      return null;
    };
    const near1 = message.match(/near '\.\.\.(.+?)\.\.\.'/)?.[1];
    let named = message.match(/^(.+?) is not iterable/)?.[1];
    if (named && /^(?:undefined|null|object null|\[object Object\]|object)$/.test(named)) named = undefined;
    if (!named && near1) named = near1.includes(' of ') ? near1.split(' of ').slice(1).join(' of ') : undefined;
    const places = near<AnyNode>(tree, line, (n) => !!iterables(n));
    const targets = places.map((n) => iterables(n)!).filter((n) => !!n);
    const chosen = named ? targets.filter((n) => matches(code, n, named!)) : targets.filter((n) => failLine(n) === (line ?? failLine(n)));
    // Without a name, only a line with exactly one place that could be it
    if (named ? chosen.length === 0 : chosen.length !== 1) return null;
    return blankOf(tree, code, chosen[0], `${code.slice(chosen[0].start, chosen[0].end)} is not iterable`);
  }

  return null;
}

/** The part of the program a choice list is built from */
function nodeAt(tree: Tree, span: { start: number; end: number }): AnyNode | null {
  let found: AnyNode | null = null;
  for (const n of tree.nodes) if (n.start === span.start && n.end === span.end && /Expression$|Identifier|Literal/.test(n.type)) found = n;
  return found;
}

/** Edit distance (a swap of neighbours counts once) */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** 0 for the same word, up to 3 for unrelated, between a wanted word and a candidate name */
function closeness(wanted: string | null, name: string): number {
  if (!wanted) return 3;
  const a = wanted.toLowerCase().replace(/[-_]/g, '');
  const b = name.toLowerCase().replace(/[-_]/g, '');
  if (!a || !b) return 3;
  if (a === b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  return distance(a, b) <= Math.max(2, Math.floor(a.length / 3)) ? 2 : 3;
}

/** The word a blank stands for: its name, or the id inside a lookup, or the last name in its path */
function keyWord(text: string): string | null {
  const id = text.match(/(?:getElementById\(\s*['"`]([^'"`]+)|querySelector(?:All)?\(\s*['"`]#([\w-]+))/);
  if (id) return id[1] ?? id[2];
  const names = text.match(/[A-Za-z_$][\w$]*/g);
  return names ? names[names.length - 1] : null;
}

const HELPERS = ['out', 'speak', 'clear', 'root'];
/** Methods of Chatty's own `out` */
const OUT_METHODS = ['send', 'play', 'playNote'];

/** Does an element type in this browser have this method or property? */
function elementHas(member: string): boolean {
  const g = globalThis as unknown as Record<string, { prototype?: object } | undefined>;
  const types = ['HTMLElement', 'Element', 'Node', 'EventTarget'];
  if (types.some((t) => g[t]?.prototype && member in g[t]!.prototype!)) return true;
  return methodNames('HTMLElement').includes(member);
}

/**
 * Candidate expressions for the blank, grounded in the program and page: names declared where the
 * blank is, element lookups for the page's ids (`.value` for inputs, the element otherwise), and
 * Chatty's helpers when they fit. Deduped, best first, at most 6.
 */
export function blankChoices(code: string, blank: Blank, page: { ids: string[]; fields?: string[] }): string[] {
  const tree = analyse(code);
  const node = tree && blank.spans[0] ? nodeAt(tree, blank.spans[0]) : null;
  const parent = node && tree ? tree.parent.get(node) : undefined;
  const key = node && tree ? tree.key.get(node) : undefined;
  const role = !parent ? 'value'
    : parent.type === 'NewExpression' && key === 'callee' ? 'constructor'
    : parent.type === 'MemberExpression' && key === 'object' ? 'receiver'
    : parent.type === 'CallExpression' && key === 'callee' ? 'callee'
    : parent.type === 'ForOfStatement' || parent.type === 'SpreadElement' ? 'iterable'
    : 'value';
  const member = role === 'receiver' && parent && !parent.computed ? (parent.property.name as string) : null;
  // Used in arithmetic (`bill * tip`, `-bill`, `bill + 1`): a field's text has to become a number
  const other = parent?.type === 'BinaryExpression' ? (key === 'left' ? parent.right : parent.left) : null;
  const textual = (n: AnyNode | null | undefined) => !!n && ((n.type === 'Literal' && typeof n.value === 'string') || n.type === 'TemplateLiteral');
  const numeric =
    (parent?.type === 'BinaryExpression' &&
      (/^(?:-|\*|\/|%|\*\*|<|>|<=|>=)$/.test(parent.operator as string) || (parent.operator === '+' && !textual(other)))) ||
    (parent?.type === 'UnaryExpression' && /^[-+]$/.test(parent.operator as string)) ||
    (parent?.type === 'AssignmentExpression' && /^(?:-=|\*=|\/=)$/.test(parent.operator as string));
  const word = keyWord(blank.text);
  // A name made by a lookup (`const el = document.getElementById('volumn')` ) stands for the id in it
  let lookupWord: string | null = null;
  if (tree && node?.type === 'Identifier') {
    const scope = resolve(tree, node, node.name);
    const declarator = scope ? tree.nodes.find((n) => n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === node.name && resolve(tree, n.id, node.name) === scope) : undefined;
    const init = declarator?.init ? code.slice(declarator.init.start, declarator.init.end) : '';
    if (/getElementById|querySelector/.test(init)) lookupWord = keyWord(init);
  }
  const scored: Array<{ expr: string; score: number; order: number }> = [];
  let order = 0;
  const add = (expr: string, score: number) => scored.push({ expr, score, order: order++ });

  // Names declared where the blank is (functions and classes only where one is called or constructed)
  if (tree && node) {
    const seen = new Set<string>();
    for (let at: AnyNode | undefined = node; at; at = tree.parent.get(at)) {
      for (const declared of tree.scopes.get(at) ?? []) {
        if (seen.has(declared) || declared === blank.text) continue;
        seen.add(declared);
        const binding = tree.nodes.find((n) => n.type === 'Identifier' && n.name === declared && tree.bindings.has(n) && resolve(tree, n, declared) === at);
        const owner = binding ? tree.parent.get(binding) : undefined;
        // A const/let/class not yet made where the blank is (declared by the failing statement
        // itself, or later): using it there throws
        // (including names a destructuring pattern declares: `const { a } = b`)
        if (owner?.type === 'ClassDeclaration' && owner.end >= blank.spans[0].start) continue;
        let declarator: AnyNode | undefined = binding;
        while (declarator && declarator.type !== 'VariableDeclarator' && !/Function|Program/.test(declarator.type)) declarator = tree.parent.get(declarator);
        if (declarator?.type === 'VariableDeclarator' && declarator.end >= blank.spans[0].start) {
          const declaration = tree.parent.get(declarator);
          if (declaration?.type === 'VariableDeclaration' && declaration.kind !== 'var') continue;
        }
        // Declared by a function or class declaration (its name), not one of its parameters
        const callable = (owner?.type === 'FunctionDeclaration' || owner?.type === 'ClassDeclaration') && owner.id === binding;
        if (callable !== (role === 'constructor' || role === 'callee')) continue;
        add(callable && role === 'callee' ? declared : declared, closeness(word, declared) + 0.5);
      }
    }
  }

  // The page's elements
  if (role !== 'constructor' && role !== 'callee' && role !== 'iterable') {
    const fields = new Set(page.fields ?? []);
    const wantsElement = member !== null && elementHas(member);
    for (const id of page.ids) {
      const close = Math.min(closeness(word, id), closeness(lookupWord, id));
      const lookup = `document.getElementById('${id}')`;
      // Reading a value (`bill * 2`, `bill.toFixed(2)`) wants what is in the field; a receiver of element members wants the element
      const asValue = fields.has(id) && !wantsElement && (member === null || member in String.prototype || member in Number.prototype);
      // Without knowing which ids are inputs, a close match offers both
      const value = numeric ? `Number(${lookup}.value)` : `${lookup}.value`;
      if (!page.fields && close <= 2 && !wantsElement) {
        add(value, close + 0.1);
        add(lookup, close + 0.2);
      } else {
        // Where a value is used (`'Total: ' + x`, `x * 2`), an element that holds no value is rarely meant
        add(asValue ? value : lookup, close + (asValue || wantsElement ? 0 : role === 'value' && member === null ? 2.2 : 0.2));
      }
    }
  }

  // Chatty's helpers
  if (role !== 'iterable') {
    for (const helper of HELPERS) {
      const close = closeness(word, helper);
      const fits = (helper === 'out' && member !== null && OUT_METHODS.includes(member)) || (helper === 'root' && member !== null && elementHas(member));
      if (close <= 2 && word && word !== helper) add(helper, close);
      else if (fits) add(helper, 1);
    }
  }

  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  const result: string[] = [];
  for (const { expr } of scored) if (expr !== blank.text && !result.includes(expr)) result.push(expr);
  return result.slice(0, 6);
}

/** Types that read the same with or without brackets around them when put in place of another expression */
const PLAIN = new Set(['Identifier', 'MemberExpression', 'CallExpression', 'ThisExpression', 'Literal', 'TemplateLiteral', 'ArrayExpression', 'ChainExpression']);

/**
 * The program with every span of the blank replaced by expr, or null if the result doesn't parse or
 * expr is not a single expression. Anything but a plain expression goes in brackets.
 */
export function fillBlank(code: string, blank: Blank, expr: string): string | null {
  const text = expr.trim();
  if (!text || blank.spans.length === 0) return null;
  let body: AnyNode[];
  try {
    body = (parse(`(\n${text}\n)`, OPTIONS) as unknown as { body: AnyNode[] }).body;
  } catch {
    return null;
  }
  if (body.length !== 1 || body[0].type !== 'ExpressionStatement') return null;
  const inner = body[0].expression as AnyNode;
  // A negative number or a comma sequence needs its brackets too
  const plain = PLAIN.has(inner.type) && !(inner.type === 'Literal' && /^[-+]/.test(text)) && !/^\s*\{/.test(text);
  const replacement = plain ? text : `(${text})`;
  const spans = [...blank.spans].sort((a, b) => b.start - a.start);
  let result = code;
  let previous = Infinity;
  for (const span of spans) {
    if (span.start < 0 || span.end > code.length || span.end > previous || code.slice(span.start, span.end) !== blank.text) return null;
    result = result.slice(0, span.start) + replacement + result.slice(span.end);
    previous = span.start;
  }
  try {
    parse(result, OPTIONS);
  } catch {
    return null;
  }
  return result;
}

/** A longer declaration than this is shown as its first and last line */
const LONG = 14;
/** A statement longer than this is narrowed to the function around the line */
const WIDE = 30;

/**
 * The short context a fix shows: the function around the line (or the top-level statement), and
 * the top-level declarations it uses, in program order, with "// …" where code is left out.
 */
export function focusedContext(code: string, line: number): { text: string; lineInContext: number } {
  const whole = { text: code, lineInContext: line };
  const tree = analyse(code);
  if (!tree || line < 1) return whole;
  const lines = code.split('\n');
  const statements = tree.ast.body as AnyNode[];
  const around = statements.find((s) => s.loc!.start.line <= line && s.loc!.end.line >= line);
  if (!around) return whole;
  let unit = { start: around.loc!.start.line, end: around.loc!.end.line };
  if (unit.end - unit.start + 1 > WIDE) {
    const fn = enclosingFunction(code, line);
    if (fn && fn.end - fn.start < unit.end - unit.start) unit = { start: fn.start, end: fn.end };
  }
  // Names the unit refers to that nothing inside it declares, and the top-level declarations of them
  const inside = tree.nodes.filter((n) => n.loc && n.loc.start.line >= unit.start && n.loc.end.line <= unit.end);
  const used = new Set<string>();
  for (const n of inside) {
    if (n.type === 'Identifier' && isReference(tree, n)) {
      const scope = resolve(tree, n, n.name);
      if (scope === null || scope === tree.ast) used.add(n.name);
    }
  }
  type Piece = { start: number; end: number; short: boolean };
  const pieces: Piece[] = [];
  for (const s of statements) {
    const s0 = s.loc!.start.line;
    const e0 = s.loc!.end.line;
    if (s0 >= unit.start && e0 <= unit.end) continue;
    const declares =
      s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration' ? [s.id?.name]
      : s.type === 'VariableDeclaration' ? s.declarations.flatMap((d: AnyNode) => [...boundNames(d.id)])
      : [];
    if (declares.some((n: string | undefined) => n && used.has(n))) pieces.push({ start: s0, end: e0, short: e0 - s0 + 1 > LONG });
  }
  pieces.push({ start: unit.start, end: unit.end, short: false });
  pieces.sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let lineInContext = 1;
  let cursor = 1;
  for (const piece of pieces) {
    // Anything between the last piece and this one, other than blank lines, is left out
    if (lines.slice(cursor - 1, piece.start - 1).some((l) => l.trim())) out.push('// …');
    if (piece.start <= line && line <= piece.end) lineInContext = out.length + (line - piece.start) + 1;
    if (piece.short) out.push(lines[piece.start - 1], `${lines[piece.start - 1].match(/^\s*/)![0]}  // …`, lines[piece.end - 1]);
    else out.push(...lines.slice(piece.start - 1, piece.end));
    cursor = piece.end + 1;
  }
  if (lines.slice(cursor - 1).some((l) => l.trim())) out.push('// …');
  return { text: out.join('\n'), lineInContext };
}

function* boundNames(pattern: AnyNode | null): Generator<string> {
  if (!pattern) return;
  if (pattern.type === 'Identifier') yield pattern.name;
  else if (pattern.type === 'ObjectPattern') for (const p of pattern.properties) yield* boundNames(p.type === 'RestElement' ? p.argument : p.value);
  else if (pattern.type === 'ArrayPattern') for (const e of pattern.elements) yield* boundNames(e);
  else if (pattern.type === 'RestElement') yield* boundNames(pattern.argument);
  else if (pattern.type === 'AssignmentPattern') yield* boundNames(pattern.left);
}

/** The context with the failing line between ERROR marker comments */
function markedContext(code: string, blank: Blank, error: string): { fenced: string; failing: string } {
  const context = focusedContext(code, blank.line);
  const lines = context.text.split('\n');
  const at = context.lineInContext;
  const failing = lines[at - 1]?.trim() ?? '';
  const problem = error.trim().replace(/\.+$/, '');
  const indent = lines[at - 1]?.match(/^\s*/)?.[0] ?? '';
  if (at >= 1 && at <= lines.length) lines.splice(at - 1, 1, `${indent}// >>> ERROR: ${problem}`, lines[at - 1], `${indent}// <<< ERROR`);
  return { fenced: ['```js', lines.join('\n'), '```'].join('\n'), failing };
}

function requestHead(task: string, error: string, facts?: string): string[] {
  const about = task.replace(/\s+/g, ' ').trim().replace(/[.!?:,;\s]+$/, '').slice(0, 200);
  return [...(about ? [`This program was written for: ${about}`] : []), `It failed at the marked line: ${error.trim().replace(/\.+$/, '')}`, ...(facts ? [facts] : [])];
}

/** The fill-in-the-blank request: the task, the error, the focused context, then what to replace */
export function blankRequest(task: string, code: string, blank: Blank, error: string, facts?: string): string {
  const { fenced, failing } = markedContext(code, blank, error);
  return [...requestHead(task, error, facts), fenced, `In this line: ${failing}`, `${blank.why}. Replace \`${blank.text}\` with one JavaScript expression:`].join('\n');
}

/** The multiple-choice request: the same context, lettered expressions, and the letter to reply with */
export function choiceRequest(task: string, code: string, blank: Blank, error: string, choices: string[], facts?: string): string {
  const { fenced, failing } = markedContext(code, blank, error);
  return [
    ...requestHead(task, error, facts),
    fenced,
    `In this line: ${failing}`,
    `${blank.why}. These expressions are available:`,
    ...choices.slice(0, 26).map((choice, i) => `${String.fromCharCode(65 + i)}. ${choice}`),
    `Reply with the letter of the expression that belongs in place of \`${blank.text}\`.`,
  ].join('\n');
}
