// ============================================================================
// Where a reply has started going round in circles in its code: the same const, let, class or
// function declared a third time in one scope (a third `function updateDrawingArea`, a third
// `const synth = …` in one function). Ordinary code never declares a name twice in one scope
// (const, let and class can't, and a function written twice is already a slip), so a third time
// means the model is looping and the rest of the reply is more of the same. Works on a reply still
// streaming in: the code is read with the forgiving parser, so an unfinished last line is fine.
// ============================================================================

import { parse as parseLoose } from 'acorn-loose';

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };

const DECLARATION_LINE = /^[ \t]*(?:export[ \t]+)?(?:(?:async[ \t]+)?function\*?[ \t]+([A-Za-z_$][\w$]*)|class[ \t]+([A-Za-z_$][\w$]*)|(?:const|let)[ \t]+([A-Za-z_$][\w$]*))/gm;

/** The code of a reply: what follows its first fence (up to a closing fence), or all of it */
function codeOf(reply: string): { code: string; offset: number } {
  const open = reply.match(/```[\w-]*[^\S\n]*\n/);
  if (!open || open.index === undefined) return { code: reply, offset: 0 };
  const offset = open.index + open[0].length;
  const close = reply.indexOf('\n```', offset - 1);
  return { code: reply.slice(offset, close >= 0 ? close + 1 : reply.length), offset };
}

/** The names a statement list declares with const, let, function or class, each with where it starts */
function declared(statement: AstNode): Array<{ name: string; start: number }> {
  if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
    const id = statement.id as AstNode | null;
    return id && id.type === 'Identifier' ? [{ name: id.name as string, start: statement.start }] : [];
  }
  if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
    return (statement.declarations as AstNode[])
      .map((d) => d.id as AstNode)
      .filter((id) => id.type === 'Identifier')
      .map((id) => ({ name: id.name as string, start: statement.start }));
  }
  return [];
}

/**
 * Where to stop a reply that declares the same name a third time in one scope: the start of the
 * line that begins the third declaration (in the reply's own text), with the name; null when the
 * reply hasn't done that
 */
export function redeclaredCut(reply: string): { index: number; name: string } | null {
  const { code, offset } = codeOf(reply);
  // Cheap first: a name the code's declaration lines give at least three times
  const counts = new Map<string, number>();
  let thrice = false;
  for (const m of code.matchAll(DECLARATION_LINE)) {
    const name = m[1] ?? m[2] ?? m[3];
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    if (n >= 3) thrice = true;
  }
  if (!thrice) return null;

  let tree: AstNode;
  try {
    tree = parseLoose(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true }) as unknown as AstNode;
  } catch {
    return null;
  }
  let first: { start: number; name: string } | null = null;
  const scope = (statements: AstNode[]) => {
    const seen = new Map<string, number>();
    for (const statement of statements) {
      for (const { name, start } of declared(statement)) {
        const n = (seen.get(name) ?? 0) + 1;
        seen.set(name, n);
        if (n === 3 && (!first || start < first.start)) first = { start, name };
      }
    }
  };
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const n = node as AstNode;
    if (typeof n.type !== 'string') return;
    if ((n.type === 'Program' || n.type === 'BlockStatement' || n.type === 'StaticBlock') && Array.isArray(n.body)) scope(n.body as AstNode[]);
    if (n.type === 'SwitchCase') scope(n.consequent as AstNode[]);
    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      visit(n[key]);
    }
  };
  visit(tree);
  if (!first) return null;
  const found = first as { start: number; name: string };
  // The start of that line, so the cut leaves no half line behind
  const lineStart = code.lastIndexOf('\n', found.start - 1) + 1;
  return { index: offset + lineStart, name: found.name };
}
