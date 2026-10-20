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

export interface RepairTally {
  /** Corrections made without the model, by kind of change */
  imagined: Record<string, number>;
  /** Retries, by reason */
  retry: Record<string, number>;
  /** Replies or fixes thrown away, by reason */
  discarded: Record<string, number>;
}

/** A word that is code rather than English: camelCase, snake_case, dotted, called, quoted, digits, one letter */
const codeLike = (w: string) => /[A-Z_$.()'"`\d]/.test(w) || (w.length === 1 && !/[aAI]/.test(w));

/** "ctx.fillstyle → ctx.fillStyle: corrected before running" → "… → … (before running)": the kind of change, names left out */
function imaginedKind(text: string): string {
  let note = text.replace(/\n[\s\S]*$/, '');
  let when = '';
  const suffix = /: corrected( before running| and run again| by a test run)?(?: \((?:candidate \d+|it ran, the best of \d+|it got further, the best of \d+)\))?\s*$/.exec(note);
  if (suffix) {
    note = note.slice(0, suffix.index);
    if (suffix[1]?.includes('before')) when = ' (before running)';
    else if (suffix[1]?.includes('test run')) when = ' (by a test run)';
  }
  const parts = note.split(' → ');
  // A lone plain word stays when the other side says more ("… was a promise → await"); names are left out
  const lone = parts.every((p) => p.trim().split(/\s+/).length === 1);
  const side = (s: string) => {
    const words = s.trim().split(/\s+/);
    if (words.length === 1) return lone || codeLike(words[0]) ? '…' : words[0];
    return words.map((w) => (codeLike(w) ? '…' : w)).join(' ').replace(/(… ?){2,}/g, '… ');
  };
  return (parts.length > 1 ? parts.map(side).join(' → ') : side(note)).slice(0, 60) + when;
}

const retryKind = (text: string) => text.replace(/\n[\s\S]*$/, '').split(/ \(|: /)[0].slice(0, 80);

function discardedKind(text: string): string {
  const first = text.split('\n')[0];
  if (!first.startsWith('// ')) return 'a reply thrown away';
  return first.slice(3).split(/: |\.\s/)[0].replace(/[.:]$/, '').slice(0, 80);
}

/** Count how often each repair fired across the given logs (oldest to newest entries, any chats) */
export function tallyRepairs(all: Record<string, string[]>): RepairTally {
  const tally: RepairTally = { imagined: {}, retry: {}, discarded: {} };
  for (const log of Object.values(all)) {
    for (const entry of log) {
      const m = /^\[[^\]]*\] (imagined|retry|discarded):\s?([\s\S]*)$/.exec(entry);
      if (!m) continue;
      const kind = m[1] as keyof RepairTally;
      const key = (kind === 'imagined' ? imaginedKind : kind === 'retry' ? retryKind : discardedKind)(m[2].trim());
      tally[kind][key] = (tally[kind][key] ?? 0) + 1;
    }
  }
  return tally;
}

/** Tally across every chat's log in storage */
export function repairTally(): RepairTally {
  return tallyRepairs(load());
}

/** One compact line: "Repairs across chats: fixed … → … ×3; retry the program failed ×2; discarded … ×1" */
export function formatRepairTally(tally: RepairTally, max = 8): string {
  const parts: string[] = [];
  const labels: Record<keyof RepairTally, string> = { imagined: 'fixed', retry: 'retry', discarded: 'discarded' };
  for (const kind of Object.keys(labels) as Array<keyof RepairTally>) {
    for (const [key, n] of Object.entries(tally[kind])) parts.push(`${labels[kind]} ${key} ×${n}`);
  }
  if (parts.length === 0) return 'Repairs across chats: none yet';
  const sorted = parts.sort((a, b) => Number(b.split('×')[1]) - Number(a.split('×')[1]));
  const shown = sorted.slice(0, max);
  return `Repairs across chats: ${shown.join('; ')}${sorted.length > max ? `; +${sorted.length - max} more` : ''}`;
}
