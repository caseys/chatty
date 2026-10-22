/**
 * A running record of what happened in each chat, as text: each request and what was sent to the
 * model for it, the model's whole reply, every program as it ran, its speak() and clear() calls,
 * its errors, and every retry or correction with its reason and the reply it threw away. A later
 * program or a fix replaces what the card and the chat show; this keeps all of it. One log per
 * chat (the last 300 entries each, for the 20 most recent chats), in localStorage: one key per
 * chat (chatty_run_log:<chat>) and a small index of the chat ids, oldest first. Only the active
 * chat's entries are held in memory; the other chats are read from storage when asked for.
 */
export type RunLogEntryKind =
  | 'request'
  | 'rules'
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

const KEY_PREFIX = 'chatty_run_log:';
const INDEX_KEY = 'chatty_run_log_index';
/** The old single key holding every chat's log */
const OLD_KEY = 'chatty_run_logs';
const MAX_ENTRIES = 300;
const MAX_CHATS = 20;
/** Multi-line entries: the text starts on the next line */
const BLOCK_KINDS = new Set<RunLogEntryKind>(['sent', 'program', 'discarded', 'reply', 'console']);

/** The chat being written to: the only log held in memory */
let active: { chat: string; entries: string[] } | null = null;
let migrated = false;
/** Entries appended so far this page-load: lets a view tell whether the log has changed */
let appended = 0;
let currentChat = () => 'default';

const chatKey = (chat: string) => KEY_PREFIX + chat;

function readIndex(): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]');
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function readChat(chat: string): string[] {
  try {
    const entries = JSON.parse(localStorage.getItem(chatKey(chat)) ?? '[]');
    return Array.isArray(entries) ? entries.filter((e): e is string => typeof e === 'string').slice(-MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

function removeChat(chat: string): void {
  try {
    localStorage.removeItem(chatKey(chat));
  } catch {
    // Storage blocked: nothing to remove
  }
}

/** The old single key (every chat in one string) becomes one key per chat, once */
function migrate(): void {
  if (migrated) return;
  migrated = true;
  try {
    localStorage.removeItem('chatty_run_log'); // the older log shared by every chat
    const old = localStorage.getItem(OLD_KEY);
    if (old === null) return;
    // Removed first: while it stays, its copy would fill the storage the new keys need
    localStorage.removeItem(OLD_KEY);
    const parsed: unknown = JSON.parse(old);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const ids: string[] = [];
    for (const [chat, entries] of Object.entries(parsed).slice(-MAX_CHATS)) {
      if (!Array.isArray(entries)) continue;
      try {
        localStorage.setItem(chatKey(chat), JSON.stringify(entries.filter((e) => typeof e === 'string').slice(-MAX_ENTRIES)));
        ids.push(chat);
      } catch {
        break; // no room for more
      }
    }
    localStorage.setItem(INDEX_KEY, JSON.stringify(ids));
  } catch {
    // Unreadable or storage blocked: the old log is not carried over
  }
}

/** The active chat's entries: read from storage when the chat has changed since the last call */
function activeLog(): string[] {
  migrate();
  const chat = currentChat();
  if (active?.chat !== chat) active = { chat, entries: readChat(chat) };
  return active.entries;
}

/**
 * Writes the chat's log (and the index when this chat is not already the newest in it). Only this
 * chat's string is built. When the storage is full, the oldest other chats are dropped one at a
 * time and the same string is written again, until it fits or this chat is the only one left.
 */
function save(chat: string, entries: string[]): void {
  let json: string;
  try {
    json = JSON.stringify(entries);
  } catch {
    return;
  }
  const stored = readIndex();
  const ids = stored.filter((id) => id !== chat);
  ids.push(chat);
  while (ids.length > MAX_CHATS) removeChat(ids.shift()!);
  let indexChanged = stored.length !== ids.length || stored[stored.length - 1] !== chat;
  for (;;) {
    try {
      if (indexChanged) localStorage.setItem(INDEX_KEY, JSON.stringify(ids));
      localStorage.setItem(chatKey(chat), json);
      return;
    } catch {
      // Storage full or blocked: the log still lives for this page
      if (ids.length <= 1) return;
      removeChat(ids.shift()!);
      indexChanged = true;
    }
  }
}

/** Which chat new entries belong to (the engine's active conversation) */
export function setRunLogChat(chatId: () => string | null | undefined): void {
  currentChat = () => chatId() || 'default';
}

export function appendRunLog(kind: RunLogEntryKind, text: string): void {
  const time = new Date().toTimeString().slice(0, 8);
  const body = BLOCK_KINDS.has(kind) ? `\n${text}` : text ? ` ${text}` : '';
  const log = activeLog();
  appended++;
  log.push(`[${time}] ${kind}${kind === 'clear' ? '()' : ':'}${body}`);
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
  save(active!.chat, log);
}

/** Changes whenever an entry is appended (to any chat) */
export function runLogVersion(): number {
  return appended;
}

/** This chat's log as one string, oldest first */
export function runLogText(): string {
  return activeLog().join('\n');
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

/** Adds how often each repair fired in one chat's log to the tally */
function addToTally(tally: RepairTally, log: string[]): void {
  for (const entry of log) {
    const m = /^\[[^\]]*\] (imagined|retry|discarded):\s?([\s\S]*)$/.exec(entry);
    if (!m) continue;
    const kind = m[1] as keyof RepairTally;
    const key = (kind === 'imagined' ? imaginedKind : kind === 'retry' ? retryKind : discardedKind)(m[2].trim());
    tally[kind][key] = (tally[kind][key] ?? 0) + 1;
  }
}

/** Count how often each repair fired across the given logs (oldest to newest entries, any chats) */
export function tallyRepairs(all: Record<string, string[]>): RepairTally {
  const tally: RepairTally = { imagined: {}, retry: {}, discarded: {} };
  for (const log of Object.values(all)) addToTally(tally, log);
  return tally;
}

/** Tally across every chat's log in storage, one chat read at a time (none is kept) */
export function repairTally(): RepairTally {
  const tally: RepairTally = { imagined: {}, retry: {}, discarded: {} };
  const here = activeLog(); // (this also moves an old single-key log into per-chat keys)
  const chat = active!.chat;
  const ids = readIndex();
  for (const id of ids) addToTally(tally, id === chat ? here : readChat(id));
  if (!ids.includes(chat)) addToTally(tally, here); // not saved (storage full or blocked)
  return tally;
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
