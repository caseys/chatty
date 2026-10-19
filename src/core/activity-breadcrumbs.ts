// ============================================================================
// Crash breadcrumbs for work after loading. Each heavy step (generating, running the program,
// speaking, clearing the screen, transcribing) is recorded while it runs, so if the page is
// killed mid-step (iOS does this when memory runs out) the next visit can say which step.
// A normal close or reload clears the record (see the engine's pagehide handler).
// ============================================================================

const ACTIVITY_KEY = 'chatty_activity';

function read(): string[] {
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function write(list: string[]): void {
  try {
    if (list.length) localStorage.setItem(ACTIVITY_KEY, JSON.stringify(list));
    else localStorage.removeItem(ACTIVITY_KEY);
  } catch {
    // Storage unavailable
  }
}

/** Runs `work`, recorded as in progress until it settles. */
export async function withActivity<T>(label: string, work: () => Promise<T>): Promise<T> {
  write([...read(), label]);
  try {
    return await work();
  } finally {
    const list = read();
    const at = list.lastIndexOf(label);
    if (at >= 0) list.splice(at, 1);
    write(list);
  }
}

/** What was in progress when the last visit ended abnormally ("running the program and speaking"). */
export function readInterruptedActivity(): string | null {
  const unique = [...new Set(read())];
  if (unique.length === 0) return null;
  return unique.length === 1 ? unique[0] : `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

export function clearActivity(): void {
  write([]);
}
