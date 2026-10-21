// ============================================================================
// Name matching for repairs: which real name a missing one surely meant (corrected without the
// model), and the closest names for a hint. One set of rules for every repair (methods, variable
// names, object keys, element ids, the blank stage), after the "did you mean" rules of compilers:
//  - Rust (find_best_match_for_name): a match ignoring case wins first, then the same words in
//    another order (bgColor / colorBg), then an edit distance of at most a third of the name
//  - TypeScript (getSpellingSuggestion): candidates whose length differs by more than about a
//    third are not considered; a difference in letter case alone costs almost nothing
//  - Ruby (did_you_mean): two candidates equally close is no suggestion at all
//  - spell checkers: the first letter is rarely where the typo is
// ============================================================================

/**
 * The one name `missing` is surely a slip of, or null. With `plural`, a plural and its singular
 * count as a slip (object keys: `drum` for `drums`); without it they never do (variable names:
 * `balls` is a list and `ball` one item of it).
 *
 * Self-contained (no outer names): it is also inlined into the sandbox page by its source.
 */
export function sureMatch(missing: string, names: readonly string[], options: { plural?: boolean } = {}): string | null {
  const flat = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '');
  const words = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[\s_-]+/)
      .filter(Boolean)
      .sort()
      .join(' ');
  // Edits between two names, a swap of neighbours counting as one (totla → total)
  const edits = (a: string, b: string) => {
    const d: number[][] = [];
    for (let i = 0; i <= a.length; i++) d.push([i, ...new Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  };
  const want = flat(missing);
  if (!want) return null;
  const isPlural = (a: string, b: string) => a === `${b}s` || a === `${b}es`;
  const pool = [...new Set(names)].filter((n) => n !== missing && flat(n));
  const one = (found: string[]) => (found.length === 1 ? found[0] : null);
  // 1. The same letters (case, _ and - aside): sure only when one name has them
  const same = pool.filter((n) => flat(n) === want);
  if (same.length > 0) return one(same);
  // 2. The same words in another order
  const sameWords = pool.filter((n) => words(n) === words(missing) && words(missing).includes(' '));
  if (sameWords.length > 0) return one(sameWords);
  // 3. A plural or singular, where that counts
  const plurals = pool.filter((n) => isPlural(want, flat(n)) || isPlural(flat(n), want));
  if (options.plural && plurals.length > 0) return one(plurals);
  // 4. Close in spelling: at most a third of the name in edits, lengths within about a third,
  // the single closest (a tie is no answer). Names under 4 letters need the same letters: an
  // edit in 3 letters (zap, map) is another word, and this answer is applied without asking
  if (want.length < 4) return null;
  const maxEdits = Math.floor(Math.max(want.length, 3) / 3);
  const maxLengthGap = Math.max(2, Math.floor(want.length * 0.34));
  let best = Infinity;
  let found: string[] = [];
  // The first letter is rarely the slip: it must match, unless the first two are swapped (oclor)
  const sameStart = (f: string) => f[0] === want[0] || (f[0] === want[1] && f[1] === want[0]);
  for (const n of pool) {
    const f = flat(n);
    if (!options.plural && plurals.includes(n)) continue;
    if (!sameStart(f)) continue;
    if (Math.abs(f.length - want.length) > maxLengthGap) continue;
    const e = edits(want, f);
    if (e > maxEdits) continue;
    if (e < best) {
      best = e;
      found = [n];
    } else if (e === best) found.push(n);
  }
  return one(found);
}

/** Lower case, without `_`, `-` and spaces */
export function flatName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, '');
}

/** The words of a name (camelCase, snake_case, kebab-case), lower case */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
}

/** Edits between two strings, a swap of neighbours counting as one */
export function editDistance(a: string, b: string): number {
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) d.push([i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * The names closest to `missing`, best first, for a hint: fewest edits (letter case and `_`/`-`
 * aside), and each word they share with it counting as three edits fewer
 */
export function closestNames(missing: string, names: readonly string[], count = 3): string[] {
  const want = flatName(missing);
  const missingWords = new Set(nameWords(missing));
  // (a different first letter counts as two more edits: it is rarely the slip)
  const score = (name: string) =>
    editDistance(want, flatName(name)) + (flatName(name)[0] === want[0] ? 0 : 2) - nameWords(name).filter((w) => missingWords.has(w)).length * 3;
  return [...new Set(names)].sort((a, b) => score(a) - score(b)).slice(0, count);
}
