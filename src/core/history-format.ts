// ============================================================================
// How past turns appear in the model's history.
// Generated programs can be thousands of tokens; replaying them every turn bloats the
// context. Past programs are shown as a one-line summary of what they did, and only the
// program being edited is shown in full (by the orchestrator, for revision requests).
// ============================================================================

import type { ConversationMessage } from '../types/index.ts';

/** True when generated code builds something on screen (vs. only speaking/playing/looking up). */
export function programDraws(code: string): boolean {
  return /\b(root|document|canvas|getContext|createElement|innerHTML|appendChild|append|insertAdjacentHTML|svg|WebGL|THREE)\b/.test(code);
}

/** True for code that only speaks (desktop replies to plain chat are speak("...") programs). */
export function isTalkOnly(code: string): boolean {
  return code.replace(/speak\(\s*(["'`])(?:\\.|(?!\1)[\s\S])*\1\s*\)\s*;?/g, '').trim() === '';
}

/**
 * A past program as the model sees it in the chat history: what happened when it ran (shown on
 * screen, played sound, ran cleanly or failed with which error) and what it said, as the program's
 * output and not as a speak() call the model wrote (small models copy those lines forward). The
 * code itself stays out (only a program being edited is shown). A talk-only reply is the model
 * chatting and stays a speak() call.
 */
export function pastProgramResult(msg: ConversationMessage): string {
  const code = msg.rawCode || msg.rawLlmOutput || '';
  const said = (msg.canonicalContent || '').trim();
  if (!code || isTalkOnly(code)) return code || said;
  const result = (msg.toolCall?.result ?? {}) as { error?: string; hasVisualOutput?: boolean; success?: boolean };
  const did: string[] = [];
  if (programDraws(code) || result.hasVisualOutput) did.push('showed something on screen');
  if (/\bout\s*\.\s*send\b|AudioContext|requestMIDIAccess|playNotes|\bTone\s*\.|\.play\(/.test(code)) did.push('played sound');
  const error = msg.toolCall?.error || result.error;
  const outcome = error ? `it failed: ${String(error).slice(0, 140)}` : msg.toolCall ? 'it ran without an error' : 'it ran';
  // Chatty's own fallback text for a program that said nothing (fromProgram === false) isn't the program's
  const output = said && msg.fromProgram !== false ? ` It said: ${JSON.stringify(said.slice(0, 300))}.` : '';
  return `// (Your program ${did.length ? did.join(' and ') : 'ran'}, ${code.split('\n').length} lines; ${outcome}.${output})`;
}

