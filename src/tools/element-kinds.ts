/**
 * What kind of element a program expects behind each id it looks up, from how it uses the result
 * (`getElementById('c').getContext('2d')` is a canvas). The sandbox uses it when an id doesn't
 * exist: it borrows an element of that kind the program made, or stands in one of that kind.
 */
import { parse } from 'acorn';

export type ElementKind = 'canvas' | 'media' | 'field' | 'dialog' | 'button';

/** Members only one kind of element has */
const KIND_OF_MEMBER: Record<string, ElementKind> = {
  getContext: 'canvas',
  toDataURL: 'canvas',
  toBlob: 'canvas',
  transferControlToOffscreen: 'canvas',
  play: 'media',
  pause: 'media',
  currentTime: 'media',
  volume: 'media',
  muted: 'media',
  paused: 'media',
  value: 'field',
  checked: 'field',
  valueAsNumber: 'field',
  selectedIndex: 'field',
  options: 'field',
  showModal: 'dialog',
  // What is typed in a form control arrives as its input and change events: a pounds converter
  // listened for 'input' on its 'lbsInput' and read this.value, a temperature converter for
  // 'change' on its 'celsius' (Qwen3.5 2B, Qwen2.5 0.5B). Key events come from any element
  // with focus, so they say nothing
  oninput: 'field',
  onchange: 'field',
};

/** Events only a form control fires (see oninput above) */
const FIELD_EVENTS = new Set(['input', 'change']);

/**
 * A click handler on an id the program calls a button (calculate-button, submitBtn): a button. A
 * tip calculator wired addEventListener('click') to its 'calculate-button' and never made it, and
 * the empty <div> that stood in could not be pressed (Qwen2.5 0.5B). Anything can be clicked, so
 * the click alone says nothing: the name has to say button too
 */
const BUTTON_NAME = /btn|button/i;

type AnyNode = Record<string, unknown> & { type: string };

/** The id a lookup names: getElementById('x') or querySelector('#x'), else null */
function lookedUpId(node: AnyNode): string | null {
  if (node.type !== 'CallExpression') return null;
  const callee = node.callee as AnyNode;
  if (callee.type !== 'MemberExpression' || callee.computed) return null;
  const method = (callee.property as AnyNode).name;
  const arg = (node.arguments as AnyNode[])[0];
  if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') return null;
  if (method === 'getElementById') return arg.value;
  if (method === 'querySelector' && /^#[\w-]+$/.test(arg.value)) return arg.value.slice(1);
  return null;
}

/** Each looked-up id whose uses all point to one kind of element */
export function elementKinds(code: string): Record<string, ElementKind> {
  let ast: AnyNode;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as unknown as AnyNode;
  } catch {
    return {};
  }
  // Variables holding a lookup (const c = document.getElementById('c'))
  const holders = new Map<string, string>();
  const walk = (node: AnyNode, visit: (n: AnyNode, parent: AnyNode | null) => void, parent: AnyNode | null = null) => {
    visit(node, parent);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && walk(child, visit, node);
      else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') walk(value as AnyNode, visit, node);
    }
  };
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && (node.id as AnyNode).type === 'Identifier' && node.init) {
      const id = lookedUpId(node.init as AnyNode);
      if (id) holders.set((node.id as AnyNode).name as string, id);
    }
  });
  const seen = new Map<string, Set<ElementKind>>();
  walk(ast, (node, parent) => {
    if (node.type !== 'MemberExpression' || node.computed) return;
    const object = node.object as AnyNode;
    const id = lookedUpId(object) ?? (object.type === 'Identifier' ? holders.get(object.name as string) : undefined);
    const member = (node.property as AnyNode).name as string;
    const event = member === 'addEventListener' && parent?.type === 'CallExpression' && parent.callee === node ? (parent.arguments as AnyNode[])[0] : undefined;
    const clicked = (event ? event.type === 'Literal' && event.value === 'click' : member === 'onclick') && !!id && BUTTON_NAME.test(id);
    const kind = !id
      ? undefined
      : clicked
        ? 'button'
        : event
          ? event.type === 'Literal' && FIELD_EVENTS.has(event.value as string)
            ? 'field'
            : undefined
          : Object.hasOwn(KIND_OF_MEMBER, member)
            ? KIND_OF_MEMBER[member]
            : undefined;
    if (!id || !kind) return;
    if (!seen.has(id)) seen.set(id, new Set());
    seen.get(id)!.add(kind);
  });
  const kinds: Record<string, ElementKind> = {};
  for (const [id, set] of seen) if (set.size === 1) kinds[id] = [...set][0];
  return kinds;
}

/**
 * The looked-up ids whose absence the program handles itself: a lookup (or the variable holding
 * one) tested for nothing (`if (!el)`, `el ?? …`, `el || …`, `el === null`, `el?.…`, `if (el)`).
 * The sandbox gives those the real answer, null, instead of a stand-in: a program that makes the
 * element when it is missing must find it missing.
 */
export function checkedIds(code: string): string[] {
  let ast: AnyNode;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as unknown as AnyNode;
  } catch {
    return [];
  }
  const holders = new Map<string, string>();
  const checked = new Set<string>();
  const walk = (node: AnyNode, visit: (n: AnyNode, parent: AnyNode | null, key: string) => void, parent: AnyNode | null = null, key = '') => {
    visit(node, parent, key);
    for (const [k, value] of Object.entries(node)) {
      if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && walk(child, visit, node, k);
      else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') walk(value as AnyNode, visit, node, k);
    }
  };
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && (node.id as AnyNode).type === 'Identifier' && node.init) {
      const id = lookedUpId(node.init as AnyNode);
      if (id) holders.set((node.id as AnyNode).name as string, id);
    }
  });
  const isNothing = (n: AnyNode) => (n.type === 'Literal' && n.value === null) || (n.type === 'Identifier' && n.name === 'undefined');
  walk(ast, (node, parent, key) => {
    const id = lookedUpId(node) ?? (node.type === 'Identifier' && key !== 'property' && key !== 'id' ? holders.get(node.name as string) : undefined);
    if (!id || !parent) return;
    const tested =
      (parent.type === 'UnaryExpression' && parent.operator === '!') ||
      ((parent.type === 'IfStatement' || parent.type === 'ConditionalExpression' || parent.type === 'WhileStatement') && key === 'test') ||
      (parent.type === 'LogicalExpression' && key === 'left') ||
      (parent.type === 'BinaryExpression' && /^[!=]==?$/.test(parent.operator as string) && isNothing((key === 'left' ? parent.right : parent.left) as AnyNode)) ||
      ((parent.type === 'MemberExpression' || parent.type === 'CallExpression') && !!parent.optional && key === (parent.type === 'MemberExpression' ? 'object' : 'callee'));
    if (tested) checked.add(id);
  });
  return [...checked];
}

/**
 * The fields a program reads but never makes, to be put on the card before it runs: their ids
 * appear nowhere in the program but in lookups (no markup or .id gives them). A tip calculator
 * read 'bill-element' and 'tip-amount-element' only in its click handler, so their stand-ins came
 * only once the button was pressed, and there was nothing to type in (Qwen2.5 0.5B)
 */
export function fieldsToMake(code: string, kinds: Record<string, ElementKind> = elementKinds(code)): string[] {
  const elsewhere = code.replace(/\b(?:getElementById\s*\(\s*|querySelector\s*\(\s*)(['"`])#?[\w-]+\1/g, '');
  return Object.entries(kinds)
    .filter(([id, kind]) => kind === 'field' && !new RegExp(`(?<![\\w-])${id.replace(/[-]/g, '\\-')}(?![\\w-])`).test(elsewhere))
    .map(([id]) => id);
}
