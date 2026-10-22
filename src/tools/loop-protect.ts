// ============================================================================
// Loop protect: instruments agent-generated JS so a synchronous infinite loop
// throws instead of freezing the (same-origin) host page.
// ============================================================================

import { parse, type Node } from 'acorn';

export const LOOP_TIME_LIMIT_MS = 1500;

type AnyNode = Node & Record<string, unknown>;

const LOOP_TYPES = new Set([
  'WhileStatement',
  'DoWhileStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
]);
const STATEMENT_LIST_PARENTS = new Set(['Program', 'BlockStatement', 'StaticBlock', 'SwitchCase']);
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

interface Insertion {
  pos: number;
  order: number;
  text: string;
}

/**
 * Returns `code` with a time guard inserted into every loop body.
 * If the code does not parse, it is returned unchanged.
 */
export function loopProtect(code: string, limitMs: number = LOOP_TIME_LIMIT_MS): string {
  let ast: Node;
  try {
    ast = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    return code;
  }

  const inserts: Insertion[] = [];
  let counter = 0;
  let order = 0;
  const add = (pos: number, text: string) => inserts.push({ pos, order: order++, text });

  // `chain` is set while walking a label chain (`a: b: for ...`): the timer must be
  // declared before the outermost label, whose parent decides if a block is needed.
  interface Chain {
    root: AnyNode;
    parent: AnyNode | null;
  }

  // A loop that waits (an await in it, outside the functions it makes) gives the page back each
  // time it waits, so the time spent waiting is no freeze: its timer starts again after every
  // await. A tune played note by note (`for (…) { …; await new Promise((r) => setTimeout(r, 400)); }`)
  // was stopped as an endless loop after 1.5 seconds. A `for await` waits at every turn.
  const waitsIn = (node: AnyNode): boolean => {
    if (node.type === 'AwaitExpression') return true;
    for (const key of Object.keys(node)) {
      const val = node[key];
      for (const child of Array.isArray(val) ? val : [val]) {
        if (!child || typeof child !== 'object' || typeof (child as AnyNode).type !== 'string') continue;
        if (FUNCTION_TYPES.has((child as AnyNode).type)) continue;
        if (waitsIn(child as AnyNode)) return true;
      }
    }
    return false;
  };

  // `loops`: the timers of the waiting loops the node is in, inside the same function
  const visit = (node: AnyNode, parent: AnyNode | null, chain: Chain | null, loops: string[]): void => {
    let inner = FUNCTION_TYPES.has(node.type) ? [] : loops;
    // (closing braces go in after what is inside: an await ending where the loop ends closes first)
    const closings: number[] = [];
    if (LOOP_TYPES.has(node.type)) {
      const id = `__lp${++counter}`;
      const waits = !!node.await || waitsIn(node);
      const body = node.body as AnyNode;
      const guard = node.await ? `${id} = Date.now();` : `if (Date.now() - ${id} > ${limitMs}) throw new Error('Loop exceeded ${limitMs}ms — possible infinite loop');`;
      if (body.type === 'BlockStatement') {
        add(body.start + 1, guard);
      } else {
        add(body.start, `{ ${guard} `);
        closings.push(body.end);
      }
      const root = chain?.root ?? node;
      const rootParent = chain ? chain.parent : parent;
      const decl = waits ? `let ${id} = Date.now(), ${id}w;` : `const ${id} = Date.now();`;
      if (rootParent && STATEMENT_LIST_PARENTS.has(rootParent.type)) {
        add(root.start, `${decl} `);
      } else {
        add(root.start, `{ ${decl} `);
        closings.push(root.end);
      }
      if (waits) inner = [...loops, id];
    }
    if (node.type === 'AwaitExpression' && loops.length > 0) {
      // (its value kept: the innermost loop's spare name holds it while the timers start again)
      const held = `${loops[loops.length - 1]}w`;
      add(node.start, `(${held} = `);
      closings.push(-1);
    }

    for (const key of Object.keys(node)) {
      const val = node[key];
      const children = Array.isArray(val) ? val : [val];
      for (const child of children) {
        if (!child || typeof child !== 'object' || typeof (child as AnyNode).type !== 'string') continue;
        const c = child as AnyNode;
        let next: Chain | null = null;
        if (c.type === 'LabeledStatement' || LOOP_TYPES.has(c.type)) {
          if (node.type === 'LabeledStatement' && key === 'body' && chain) next = chain;
          else if (c.type === 'LabeledStatement') next = { root: c, parent: node };
        }
        visit(c, node, next, inner);
      }
    }
    for (const at of closings) {
      if (at === -1) add(node.end, `, ${loops.join(' = ')} = Date.now(), ${loops[loops.length - 1]}w)`);
      else add(at, ' }');
    }
  };

  visit(ast as AnyNode, null, null, []);

  if (inserts.length === 0) return code;
  // Apply from the end; for equal positions later-registered goes first at that offset
  // when applied in reverse so that registration order is preserved in the output.
  inserts.sort((a, b) => b.pos - a.pos || b.order - a.order);
  let out = code;
  for (const ins of inserts) out = out.slice(0, ins.pos) + ins.text + out.slice(ins.pos);
  return out;
}
