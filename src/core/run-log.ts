/**
 * A running record of what programs did, as text: each request, the model's whole reply, every program as it ran, its
 * speak() and clear() calls, its errors, and every retry with its reason and the reply it threw away. A later program or a fix replaces what the card and
 * the chat show; this keeps all of it. Kept in localStorage (chatty_run_log, the last 300 entries).
 */
export type RunLogEntryKind = 'request' | 'reply' | 'program' | 'speak' | 'clear' | 'console' | 'error' | 'retry' | 'discarded';

const KEY = 'chatty_run_log';
const MAX_ENTRIES = 300;
let entries: string[] | null = null;

function load(): string[] {
  if (entries) return entries;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    entries = Array.isArray(parsed) ? parsed.filter((e) => typeof e === 'string') : [];
  } catch {
    entries = [];
  }
  return entries;
}

export function appendRunLog(kind: RunLogEntryKind, text: string): void {
  const time = new Date().toTimeString().slice(0, 8);
  const body = kind === 'program' || kind === 'discarded' || kind === 'reply' || kind === 'console' ? `\n${text}` : text ? ` ${text}` : '';
  const log = load();
  log.push(`[${time}] ${kind}${kind === 'clear' ? '()' : ':'}${body}`);
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
  try {
    localStorage.setItem(KEY, JSON.stringify(log));
  } catch {
    // Storage full or blocked: the log still lives for this page
  }
}

/** The whole log as one string, oldest first */
export function runLogText(): string {
  return load().join('\n');
}
