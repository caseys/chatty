/**
 * A running record of what happened in each chat, as text: each request and what was sent to the
 * model for it, the model's whole reply, every program as it ran, its speak() and clear() calls,
 * its errors, and every retry or correction with its reason and the reply it threw away. A later
 * program or a fix replaces what the card and the chat show; this keeps all of it. One log per
 * chat (the last 300 entries each, for the 20 most recent chats), in localStorage (chatty_run_logs).
 */
export type RunLogEntryKind =
  | 'request'
  | 'sent'
  | 'reply'
  | 'program'
  | 'speak'
  | 'clear'
  | 'imagined'
  | 'console'
  | 'error'
  | 'retry'
  | 'discarded';

const KEY = 'chatty_run_logs';
const MAX_ENTRIES = 300;
const MAX_CHATS = 20;
/** Multi-line entries: the text starts on the next line */
const BLOCK_KINDS = new Set<RunLogEntryKind>(['sent', 'program', 'discarded', 'reply', 'console']);

let logs: Record<string, string[]> | null = null;
let currentChat = () => 'default';

function load(): Record<string, string[]> {
  if (logs) return logs;
  try {
    localStorage.removeItem('chatty_run_log'); // the old single log, shared by every chat
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    logs = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    logs = {};
  }
  return logs!;
}

/** Which chat new entries belong to (the engine's active conversation) */
export function setRunLogChat(chatId: () => string | null | undefined): void {
  currentChat = () => chatId() || 'default';
}

export function appendRunLog(kind: RunLogEntryKind, text: string): void {
  const time = new Date().toTimeString().slice(0, 8);
  const body = BLOCK_KINDS.has(kind) ? `\n${text}` : text ? ` ${text}` : '';
  const all = load();
  const chat = currentChat();
  // The chat just written to moves to the end, so the oldest chats are the ones dropped
  const log = all[chat] ?? [];
  delete all[chat];
  all[chat] = log;
  log.push(`[${time}] ${kind}${kind === 'clear' ? '()' : ':'}${body}`);
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
  for (const old of Object.keys(all).slice(0, Math.max(0, Object.keys(all).length - MAX_CHATS))) delete all[old];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked: the log still lives for this page
  }
}

/** This chat's log as one string, oldest first */
export function runLogText(): string {
  return (load()[currentChat()] ?? []).join('\n');
}
