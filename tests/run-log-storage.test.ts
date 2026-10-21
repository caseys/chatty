import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RunLog = typeof import('../src/core/run-log.ts');

/** A fresh copy of the module (it keeps the active chat and the migration flag at module level) */
async function freshRunLog(chat = 'a'): Promise<RunLog & { setChat(id: string): void }> {
  vi.resetModules();
  const log = await import('../src/core/run-log.ts');
  let current = chat;
  log.setRunLogChat(() => current);
  return Object.assign(log, { setChat: (id: string) => void (current = id) });
}

const chatKey = (id: string) => `chatty_run_log:${id}`;
const index = () => JSON.parse(localStorage.getItem('chatty_run_log_index') ?? '[]') as string[];
const stored = (id: string) => JSON.parse(localStorage.getItem(chatKey(id)) ?? '[]') as string[];

describe('run log storage: one key per chat', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('writes each chat to its own key with an index of chat ids, oldest first', async () => {
    const log = await freshRunLog('a');
    log.appendRunLog('request', 'draw a circle');
    log.setChat('b');
    log.appendRunLog('request', 'play a tune');
    log.setChat('a');
    log.appendRunLog('error', 'boom');
    expect(index()).toEqual(['b', 'a']);
    expect(stored('a').map((e) => e.replace(/^\[[^\]]*\] /, ''))).toEqual(['request: draw a circle', 'error: boom']);
    expect(stored('b')).toHaveLength(1);
    expect(localStorage.getItem('chatty_run_logs')).toBeNull();
  });

  it('reads the log of the chat in use, and a chat switched back to', async () => {
    const log = await freshRunLog('a');
    log.appendRunLog('request', 'one');
    log.setChat('b');
    expect(log.runLogText()).toBe('');
    log.appendRunLog('request', 'two');
    expect(log.runLogText()).toContain('request: two');
    expect(log.runLogText()).not.toContain('one');
    log.setChat('a');
    expect(log.runLogText()).toContain('request: one');
    expect(log.runLogText()).not.toContain('two');
    // a new page load reads it back from storage
    const again = await freshRunLog('a');
    expect(again.runLogText()).toContain('request: one');
  });

  it('writes only the chat being appended to: no string holds two chats', async () => {
    const log = await freshRunLog('a');
    log.appendRunLog('request', 'AAAA');
    log.setChat('b');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    log.appendRunLog('request', 'BBBB');
    log.appendRunLog('request', 'BBBB again');
    const written = set.mock.calls.filter(([k]) => k !== 'chatty_run_log_index').map(([, v]) => v);
    expect(written).toHaveLength(2);
    for (const v of written) expect(v).not.toContain('AAAA');
    // the index is written only when it changes (the first append moved b to the end)
    expect(set.mock.calls.filter(([k]) => k === 'chatty_run_log_index')).toHaveLength(1);
    set.mockRestore();
  });

  it('keeps the last 300 entries of a chat and the 20 most recent chats', async () => {
    const log = await freshRunLog('c0');
    for (let i = 0; i < 305; i++) log.appendRunLog('request', `r${i}`);
    expect(stored('c0')).toHaveLength(300);
    expect(log.runLogText().startsWith('[')).toBe(true);
    expect(log.runLogText()).toContain('request: r304');
    expect(log.runLogText()).not.toContain('request: r4\n');
    for (let c = 1; c < 24; c++) {
      log.setChat(`c${c}`);
      log.appendRunLog('request', 'x');
    }
    expect(index()).toEqual(Array.from({ length: 20 }, (_, i) => `c${i + 4}`));
    expect(localStorage.getItem(chatKey('c0'))).toBeNull();
    expect(localStorage.getItem(chatKey('c3'))).toBeNull();
    expect(localStorage.getItem(chatKey('c4'))).not.toBeNull();
    // writing to an older chat again makes it the newest, so it outlives the ones before it
    log.setChat('c4');
    log.appendRunLog('request', 'again');
    log.setChat('new');
    log.appendRunLog('request', 'x');
    expect(index()).toHaveLength(20);
    expect(index()).toContain('c4');
    expect(index()).not.toContain('c5');
  });
});

describe('run log storage: the repair tally across chats', () => {
  beforeEach(() => localStorage.clear());

  it('counts every chat in storage, reading them when asked for, and keeps none', async () => {
    const log = await freshRunLog('a');
    log.appendRunLog('imagined', 'ctx.fillstyle → ctx.fillStyle: corrected before running');
    log.appendRunLog('retry', 'the program failed (Error at line 4: x is not defined): asking the model to fix the marked line');
    log.setChat('b');
    log.appendRunLog('imagined', 'gfx.strokestyle → gfx.strokeStyle: corrected before running');
    log.appendRunLog('discarded', '// The fix came back as chat, so nothing was run:\nreply');
    log.setChat('c');
    log.appendRunLog('retry', 'the program failed (Error at line 9: y is not defined): asking the model to fix the marked line');
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const tally = log.repairTally();
    expect(tally.imagined['… → … (before running)']).toBe(2);
    expect(tally.retry['the program failed']).toBe(2);
    expect(Object.values(tally.discarded)).toEqual([1]);
    // the other chats were read from storage for this
    expect(get.mock.calls.map(([k]) => k)).toEqual(expect.arrayContaining([chatKey('a'), chatKey('b')]));
    get.mockRestore();
    expect(log.formatRepairTally(tally)).toContain('fixed … → … (before running) ×2');
    // a new page load counts the same
    const again = await freshRunLog('c');
    expect(again.repairTally()).toEqual(tally);
  });

  it('counts the active chat from memory when it could not be saved', async () => {
    const full = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => full.get(k) ?? null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: (k: string) => void full.delete(k),
    });
    const log = await freshRunLog('a');
    log.appendRunLog('retry', 'the program failed (Error): asking');
    expect(log.runLogText()).toContain('retry:');
    expect(log.repairTally().retry).toEqual({ 'the program failed': 1 });
    vi.unstubAllGlobals();
  });

  it('changes its version with every appended entry (so a view can tell when to count again)', async () => {
    const log = await freshRunLog('a');
    const before = log.runLogVersion();
    log.appendRunLog('request', 'x');
    expect(log.runLogVersion()).toBe(before + 1);
  });
});

describe('run log storage: the old single key', () => {
  beforeEach(() => localStorage.clear());

  it('moves into one key per chat on first load, and is removed', async () => {
    const old = {
      a: ['[10:00:00] request: first', '[10:00:01] retry: the program failed (Error): asking'],
      b: ['[11:00:00] request: second'],
    };
    localStorage.setItem('chatty_run_logs', JSON.stringify(old));
    localStorage.setItem('chatty_run_log', 'older still');
    const log = await freshRunLog('b');
    expect(log.runLogText()).toBe('[11:00:00] request: second');
    expect(localStorage.getItem('chatty_run_logs')).toBeNull();
    expect(localStorage.getItem('chatty_run_log')).toBeNull();
    expect(index()).toEqual(['a', 'b']);
    expect(stored('a')).toEqual(old.a);
    expect(log.repairTally().retry).toEqual({ 'the program failed': 1 });
    log.appendRunLog('error', 'later');
    expect(stored('b')).toHaveLength(2);
    // migrated once: a second load changes nothing
    const again = await freshRunLog('a');
    expect(again.runLogText()).toBe(old.a.join('\n'));
  });

  it('keeps the newest 20 chats and 300 entries each, and survives a damaged old key', async () => {
    const old: Record<string, string[]> = {};
    for (let c = 0; c < 25; c++) old[`c${c}`] = Array.from({ length: 310 }, (_, i) => `[00:00:00] request: ${c}-${i}`);
    localStorage.setItem('chatty_run_logs', JSON.stringify(old));
    const log = await freshRunLog('c24');
    expect(log.runLogText().split('\n')).toHaveLength(300);
    expect(index()).toEqual(Array.from({ length: 20 }, (_, i) => `c${i + 5}`));
    expect(localStorage.getItem(chatKey('c0'))).toBeNull();

    localStorage.clear();
    localStorage.setItem('chatty_run_logs', '{not json');
    const damaged = await freshRunLog('a');
    expect(damaged.runLogText()).toBe('');
    damaged.appendRunLog('request', 'works');
    expect(stored('a')).toHaveLength(1);
    expect(localStorage.getItem('chatty_run_logs')).toBeNull();
  });
});

describe('run log storage: when the storage is full', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A localStorage that refuses a write once keys and values together pass `limit` characters */
  function limitedStorage(limit: number) {
    const data = new Map<string, string>();
    const size = () => [...data].reduce((n, [k, v]) => n + k.length + v.length, 0);
    const writes: number[] = [];
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem(k: string, v: string) {
        const before = data.get(k);
        data.set(k, v);
        if (size() > limit) {
          if (before === undefined) data.delete(k);
          else data.set(k, before);
          throw new DOMException('full', 'QuotaExceededError');
        }
        writes.push(v.length);
      },
      removeItem: (k: string) => void data.delete(k),
    };
    vi.stubGlobal('localStorage', storage);
    return { data, writes };
  }

  it('drops the oldest chats, one at a time, and writes the same string again', async () => {
    const { data, writes } = limitedStorage(1700);
    const log = await freshRunLog('a');
    const filler = 'x'.repeat(250);
    for (const id of ['a', 'b', 'c']) {
      log.setChat(id);
      log.appendRunLog('request', filler);
    }
    expect([...data.keys()].filter((k) => k.startsWith('chatty_run_log:'))).toHaveLength(3);
    // chat d outgrows the space: a and b go, c and d stay
    log.setChat('d');
    for (let i = 0; i < 4; i++) log.appendRunLog('request', filler);
    expect(data.has(chatKey('a'))).toBe(false);
    expect(data.has(chatKey('b'))).toBe(false);
    expect(data.has(chatKey('d'))).toBe(true);
    expect(JSON.parse(data.get(chatKey('d'))!)).toHaveLength(4);
    expect(data.has(chatKey('c'))).toBe(true);
    expect(JSON.parse(data.get('chatty_run_log_index')!)).toEqual(expect.not.arrayContaining(['a']));
    expect(JSON.parse(data.get('chatty_run_log_index')!).at(-1)).toBe('d');
    // no string written was larger than one chat's
    expect(Math.max(...writes)).toBeLessThan(1700);
  });

  it('keeps the active chat in memory when even it alone does not fit, and never throws', async () => {
    limitedStorage(200);
    const log = await freshRunLog('a');
    expect(() => {
      for (let i = 0; i < 5; i++) log.appendRunLog('request', 'y'.repeat(100));
    }).not.toThrow();
    expect(log.runLogText().split('\n')).toHaveLength(5);
  });

  it('does not throw when localStorage is missing', async () => {
    vi.stubGlobal('localStorage', undefined);
    const log = await freshRunLog('a');
    log.appendRunLog('request', 'still logged');
    expect(log.runLogText()).toContain('still logged');
    expect(log.repairTally().retry).toEqual({});
  });
});
