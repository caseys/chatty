// ============================================================================
// What a program uses a value as, from the code: the members it reaches on it, and where it
// hands it (output.send([…]) is a MIDI output; gain.connect(output) needs an audio node). The
// browser itself says which of its types has all those members. For hints after an error: a
// value looked up as a page element but used as something else is a different mistake from a
// missing element, and the fix is different too.
// ============================================================================

import { parse, type Node } from 'acorn';
import { objectType } from './method-hints.ts';

type AnyNode = Node & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ValueUse {
  /** Members reached on it (output.send → send) */
  members: string[];
  /** Called as send() with a list (only a MIDI output's send takes a list of numbers) */
  sendsList: boolean;
  /** Handed to connect() on an audio node, which takes an audio node (or param) */
  audioInput: boolean;
}

/** The audio types connect() is called on */
const AUDIO_TYPES = /^(?:AudioContext|\w+Node)$/;

/** How a program uses the value of `name`, wherever the name appears, or null when the code doesn't parse */
export function valueUse(code: string, name: string): ValueUse | null {
  let ast: AnyNode;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as AnyNode;
  } catch {
    return null;
  }
  const members = new Set<string>();
  let sendsList = false;
  let audioInput = false;
  const visit = (node: AnyNode, parent: AnyNode | null) => {
    if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === name) {
      const member = node.property.name as string;
      members.add(member);
      if (member === 'send' && parent?.type === 'CallExpression' && parent.callee === node && parent.arguments[0]?.type === 'ArrayExpression') sendsList = true;
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'connect') {
      if ((node.arguments as AnyNode[]).some((a) => a.type === 'Identifier' && a.name === name)) {
        const on = code.slice(node.callee.object.start, node.callee.object.end);
        if (AUDIO_TYPES.test(objectType(code, on) ?? '')) audioInput = true;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && visit(child, node);
      else if (value && typeof value === 'object' && typeof (value as AnyNode).type === 'string') visit(value as AnyNode, node);
    }
  };
  visit(ast, null);
  return { members: [...members], sendsList, audioInput };
}

/**
 * The one browser type (not an element: one stood in already and lacked it) whose prototype has
 * every member, or null when none or several do. A type's Offscreen or Worker twin doesn't count
 * as another (CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D are one answer).
 */
export function browserTypeWith(members: readonly string[], scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): string | null {
  if (members.length === 0) return null;
  const found: string[] = [];
  for (const key of Object.getOwnPropertyNames(scope)) {
    if (!/^[A-Z]/.test(key) || /^(?:HTML|SVG|Element|Node|EventTarget|Document|Text|CharacterData|Object|Function)/.test(key)) continue;
    let proto: unknown;
    try {
      proto = (scope[key] as { prototype?: unknown } | undefined)?.prototype;
    } catch {
      continue;
    }
    if (!proto || typeof proto !== 'object') continue;
    if (members.every((m) => m in (proto as object))) found.push(key);
  }
  const plain = found.filter((t) => !/^(?:Offscreen|Worker)/.test(t) || !found.includes(t.replace(/^(?:Offscreen|Worker)/, '')));
  return plain.length === 1 ? plain[0] : null;
}

/** How a program gets each type, in the words of the browser's API (and the prompt's own MIDI rule) */
const HOW_TO_GET: Record<string, string> = {
  MIDIOutput: 'get one with const midi = await navigator.requestMIDIAccess() and [...midi.outputs.values()][0]',
  AudioNode: "connect sound to the audio context's destination (audioContext.destination) or to a node made from the context",
  CanvasRenderingContext2D: "draw on a canvas's 2D context: canvas.getContext('2d')",
  WebGLRenderingContext: "get it from a canvas: canvas.getContext('webgl')",
  WebGL2RenderingContext: "get it from a canvas: canvas.getContext('webgl2')",
};

/** What a value is used as, for a hint: each type with what shows it, and how to get one; null when nothing says */
export function usedAs(code: string, name: string, scope?: Record<string, unknown>): { types: string[]; text: string } | null {
  const use = valueUse(code, name);
  if (!use) return null;
  const parts: Array<{ type: string; shown: string }> = [];
  if (use.sendsList) parts.push({ type: 'MIDIOutput', shown: `a MIDI output (${name}.send([…]))` });
  if (use.audioInput) parts.push({ type: 'AudioNode', shown: `an audio node (passed to connect())` });
  const others = use.members.filter((m) => !(use.sendsList && m === 'send'));
  const type = others.length > 0 ? browserTypeWith(others, scope) : null;
  if (type && !parts.some((p) => p.type === type)) parts.push({ type, shown: `a ${type} (${others.map((m) => `.${m}`).join(', ')})` });
  if (parts.length === 0) return null;
  const how = parts.map((p) => HOW_TO_GET[p.type]).filter(Boolean);
  return {
    types: parts.map((p) => p.type),
    text: `The program uses ${name} as ${parts.map((p) => p.shown).join(' and ')}, not as a page element${how.length ? `: ${how.join('; ')}` : ''}.`,
  };
}

/** Whether every use of the value is send([…]): then it is surely a MIDI output and nothing else */
export function onlySendsLists(code: string, name: string): boolean {
  const use = valueUse(code, name);
  return !!use && use.sendsList && !use.audioInput && use.members.every((m) => m === 'send');
}
