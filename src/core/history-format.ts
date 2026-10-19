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
 * A past assistant reply as the code-writing model should see it: what it said, as a speak()
 * call (keeping the code-only reply format), plus a summary line instead of any program body.
 */
export function compactAssistantContent(msg: ConversationMessage): string {
  const code = msg.rawCode || msg.rawLlmOutput || '';
  const said = (msg.canonicalContent || '').trim();
  if (!code) return said;
  const speakLine = said ? `speak(${JSON.stringify(said)});` : '';
  // Talk-only replies are already short: keep them as they were
  if (!programDraws(code) && code.length <= Math.max(200, speakLine.length * 2)) return code;
  const lines = code.split('\n').length;
  const did = programDraws(code) ? 'built something on screen' : 'ran a program';
  return `${speakLine}\n// (Earlier program omitted: ${did}, ${lines} lines.)`.trim();
}
