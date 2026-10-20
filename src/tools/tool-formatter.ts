// ============================================================================
// Tool Summary Formatter for Chatty
// Generates compact, clean summary lines for tool calls made by the model
// and summary lines for tool results or execution errors.
// ============================================================================

import type { ConversationMessage } from '../types/index.ts';

/**
 * Formats tool arguments compactly into a single clean line.
 */
export function formatToolArguments(args: Record<string, unknown>, maxLength = 70): string {
  if (!args || typeof args !== 'object' || Object.keys(args).length === 0) {
    return '';
  }

  const entries = Object.entries(args);
  const parts: string[] = [];

  for (const [key, val] of entries) {
    let strVal: string;
    if (typeof val === 'string') {
      const clean = val.replace(/\s+/g, ' ').trim();
      strVal = clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
    } else if (typeof val === 'object' && val !== null) {
      try {
        const clean = JSON.stringify(val);
        strVal = clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
      } catch {
        strVal = '[Object]';
      }
    } else {
      strVal = String(val);
    }

    if (entries.length === 1) {
      parts.push(`${key}: ${strVal}`);
    } else {
      parts.push(`${key}: ${strVal}`);
    }
  }

  return parts.join(', ');
}

/**
 * Formats a tool execution outcome (result or error) into a concise summary line.
 */
export function formatToolResultSummary(
  result: unknown,
  error?: string,
  maxLength = 85
): { isError: boolean; summary: string } {
  if (error) {
    const cleanErr = String(error).replace(/\s+/g, ' ').trim();
    return {
      isError: true,
      summary: cleanErr.length > maxLength ? `${cleanErr.slice(0, maxLength)}…` : cleanErr,
    };
  }

  if (result === undefined || result === null) {
    return { isError: false, summary: 'Completed' };
  }

  // Handle PlayMusicResult object structure
  if (typeof result === 'object' && result !== null && 'played' in (result as Record<string, unknown>)) {
    const r = result as { played: string; count: number; instrument?: string; description?: string };
    const desc = r.description && r.description !== 'Melody' ? ` (${r.description})` : '';
    return {
      isError: false,
      summary: `Played ${r.count} notes: ${r.played}${desc}`,
    };
  }

  // Handle JavascriptExecutionResult object structure
  if (typeof result === 'object' && result !== null && 'success' in (result as Record<string, unknown>)) {
    const res = result as {
      success: boolean;
      output?: unknown;
      error?: string;
      logs?: string[];
      hasVisualOutput?: boolean;
    };

    if (!res.success || res.error) {
      const err = String(res.error || 'Execution failed').replace(/\s+/g, ' ').trim();
      return {
        isError: true,
        summary: err.length > maxLength ? `${err.slice(0, maxLength)}…` : err,
      };
    }

    if (
      res.output !== undefined &&
      res.output !== null &&
      res.output !== 'undefined' &&
      res.output !== 'use strict'
    ) {
      let outStr =
        typeof res.output === 'object' ? JSON.stringify(res.output) : String(res.output);
      outStr = outStr.replace(/\s+/g, ' ').trim();
      return {
        isError: false,
        summary: outStr.length > maxLength ? `${outStr.slice(0, maxLength)}…` : outStr,
      };
    }

    if (res.hasVisualOutput) {
      return { isError: false, summary: 'Rendered visual output to canvas' };
    }

    if (res.logs && res.logs.length > 0) {
      const logStr = res.logs.join('; ').replace(/\s+/g, ' ').trim();
      return {
        isError: false,
        summary: logStr.length > maxLength ? `${logStr.slice(0, maxLength)}…` : logStr,
      };
    }

    return { isError: false, summary: 'Completed' };
  }

  // Handle Wikipedia and Instant Answer result objects
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;
    if (obj.error) {
      const err = String(obj.error).replace(/\s+/g, ' ').trim();
      return {
        isError: true,
        summary: err.length > maxLength ? `${err.slice(0, maxLength)}…` : err,
      };
    }
    if (obj.answer) {
      const ans = String(obj.answer).replace(/\s+/g, ' ').trim();
      return {
        isError: false,
        summary: ans.length > maxLength ? `${ans.slice(0, maxLength)}…` : ans,
      };
    }
    if (obj.summary) {
      const titlePrefix = obj.title ? `${obj.title}: ` : '';
      const text = `${titlePrefix}${String(obj.summary)}`.replace(/\s+/g, ' ').trim();
      return {
        isError: false,
        summary: text.length > maxLength ? `${text.slice(0, maxLength)}…` : text,
      };
    }
  }

  // Generic objects or primitives
  let outStr = typeof result === 'object' ? JSON.stringify(result) : String(result);
  outStr = outStr.replace(/\s+/g, ' ').trim();
  return {
    isError: false,
    summary: outStr.length > maxLength ? `${outStr.slice(0, maxLength)}…` : outStr,
  };
}

/**
 * Creates a compact DOM card displaying the tool call made and its result / error summary line.
 */
export function createToolSummaryElement(
  toolCall: NonNullable<ConversationMessage['toolCall']>,
  onToolClick?: () => void
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'chat-tool-summary-card';

  const isVisualOrCodeTool =
    toolCall.name === 'coder_agent' ||
    toolCall.name === 'browser_agent' ||
    toolCall.name === 'javascript_runtime' ||
    toolCall.name === 'draw_graphics';

  if (isVisualOrCodeTool && onToolClick) {
    container.classList.add('clickable');
    container.title = 'Click to view in Coder Agent Overlay';
    container.setAttribute('role', 'button');
    container.setAttribute('tabindex', '0');
    container.addEventListener('click', onToolClick);
    container.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToolClick();
      }
    });
  }

  // 1. Tool Call line: [icon] [tool_name] [(args)]
  const callLine = document.createElement('div');
  callLine.className = 'tool-summary-line tool-call-line';

  const iconSpan = document.createElement('span');
  iconSpan.className = 'tool-summary-icon';
  let toolIcon = '🔧';
  if (toolCall.name === 'coder_agent' || toolCall.name === 'browser_agent') toolIcon = '💻';
  else if (toolCall.name === 'play_music') toolIcon = '🎵';
  else if (toolCall.name === 'draw_graphics') toolIcon = '🎨';
  else if (toolCall.name === 'javascript_runtime') toolIcon = '⚡';
  else if (toolCall.name === 'wikipedia') toolIcon = '📖';
  else if (toolCall.name === 'instant_answers') toolIcon = '💡';
  iconSpan.textContent = toolIcon;
  iconSpan.setAttribute('aria-hidden', 'true');
  callLine.appendChild(iconSpan);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'tool-summary-name';
  nameSpan.textContent = toolCall.name;
  callLine.appendChild(nameSpan);

  const argsSummary = formatToolArguments(toolCall.arguments);
  if (argsSummary) {
    const argsSpan = document.createElement('span');
    argsSpan.className = 'tool-summary-args';
    argsSpan.textContent = `(${argsSummary})`;
    callLine.appendChild(argsSpan);
  }

  container.appendChild(callLine);

  // 2. Summary line of result or error
  const resultLine = document.createElement('div');
  const status =
    toolCall.status ??
    (toolCall.error
      ? 'failed'
      : toolCall.result !== undefined
        ? 'completed'
        : 'running');

  if (status === 'running') {
    resultLine.className = 'tool-summary-line tool-result-line status-running';
    resultLine.innerHTML = `
      <span class="tool-result-bullet" aria-hidden="true">⏳</span>
      <span class="tool-result-text">Executing tool…</span>
    `;
  } else {
    const { isError, summary } = formatToolResultSummary(toolCall.result, toolCall.error);
    const escapedSummary = summary
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    if (isError) {
      resultLine.className = 'tool-summary-line tool-result-line status-error';
      resultLine.innerHTML = `
        <span class="tool-result-bullet" aria-hidden="true">✕</span>
        <span class="tool-result-text">Error: ${escapedSummary}</span>
      `;
    } else {
      resultLine.className = 'tool-summary-line tool-result-line status-success';
      resultLine.innerHTML = `
        <span class="tool-result-bullet" aria-hidden="true">✓</span>
        <span class="tool-result-text">Result: ${escapedSummary}</span>
      `;
    }
  }

  container.appendChild(resultLine);
  return container;
}

/**
 * Returns the balanced `{...}` JSON object substring starting at `start` (which must be `{`),
 * respecting JSON strings and escapes. For unterminated input returns the remainder.
 */
function extractBalancedObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export { stripToolCallMarkup } from '../core/speech-normalizer.ts';
import { stripToolCallMarkup } from '../core/speech-normalizer.ts';

/**
 * Detects if a streaming text chunk contains an in-flight or completed tool call block.
 */
export function parseStreamingToolCall(text: string): {
  toolName: string;
  args: Record<string, unknown>;
  cleanText: string;
} | null {
  // 1. Fenced code block: ```tool_call or ```json
  const fencedMatch = text.match(/```(?:tool_call|json)\s*\n([\s\S]*?)(?:\n```|$)/i);
  if (fencedMatch) {
    const preText = stripToolCallMarkup(text.slice(0, fencedMatch.index));
    const jsonChunk = fencedMatch[1].trim();

    try {
      const parsed = JSON.parse(jsonChunk);
      const toolName = String(parsed.name || parsed.tool || 'tool');
      const args = (parsed.arguments || parsed.args || {}) as Record<string, unknown>;
      return { toolName, args, cleanText: preText };
    } catch {
      const nameMatch = jsonChunk.match(/"name"\s*:\s*"([^"]+)"/);
      const codeMatch = jsonChunk.match(/"code"\s*:\s*"([^"]*)"?/);
      if (nameMatch) {
        return {
          toolName: nameMatch[1],
          args: codeMatch ? { code: codeMatch[1] } : {},
          cleanText: preText,
        };
      }
    }
  }

  // 2. Native tag or bare call syntax: <|tool_call>call:func{args} or call:func{args}
  const callMatch = text.match(/(?:<\|tool_call>|<tool_call>)?\s*call:(\w+)\s*(?=\{)/i);
  const callBody = callMatch ? extractBalancedObject(text, callMatch.index! + callMatch[0].length) : null;
  if (callMatch && callBody) {
    const preText = stripToolCallMarkup(text.slice(0, callMatch.index));
    try {
      const toolName = callMatch[1];
      const args = JSON.parse(callBody);
      return { toolName, args, cleanText: preText };
    } catch {
      return { toolName: callMatch[1], args: {}, cleanText: preText };
    }
  }

  // 3. Native tag with JSON: <|tool_call>{"name": "...", "arguments": {...}}
  const tagJsonMatch = text.match(/(?:<\|tool_call>|<tool_call>)\s*(?=\{)/i);
  const tagJsonBody = tagJsonMatch ? extractBalancedObject(text, tagJsonMatch.index! + tagJsonMatch[0].length) : null;
  if (tagJsonMatch && tagJsonBody) {
    const preText = stripToolCallMarkup(text.slice(0, tagJsonMatch.index));
    try {
      const parsed = JSON.parse(tagJsonBody);
      const toolName = String(parsed.name || parsed.tool || 'tool');
      const args = (parsed.arguments || parsed.args || {}) as Record<string, unknown>;
      return { toolName, args, cleanText: preText };
    } catch {}
  }

  // 4. Bare JSON object: {"name": "...", "arguments": {...}}
  const jsonMatch = text.match(/\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(?=\{)/i);
  const jsonBody = jsonMatch ? extractBalancedObject(text, jsonMatch.index!) : null;
  if (jsonMatch && jsonBody) {
    const preText = stripToolCallMarkup(text.slice(0, jsonMatch.index));
    try {
      const parsed = JSON.parse(jsonBody);
      const toolName = String(parsed.name || parsed.tool || 'tool');
      const args = (parsed.arguments || parsed.args || {}) as Record<string, unknown>;
      return { toolName, args, cleanText: preText };
    } catch {}
  }

  return null;
}
