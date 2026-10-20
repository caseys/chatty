#!/usr/bin/env node
// Extract replay cases from run logs into tests/replay/cases.json (merging with what is there).
//   node tests/replay/extract.mjs [file-or-dir ...]
// Inputs: *.jsonl Claude Code transcripts (pasted logs in user messages) and plain-text logs
// (the run log's "copy" link output). With no arguments: every file in tests/replay/logs/.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'cases.json');
const HEADER = /^\[(\d\d:\d\d:\d\d)\] ([a-z]+)(\(\))?:?(?: (.*))?$/;
const KINDS = new Set(['request', 'sent', 'reply', 'program', 'speak', 'clear', 'imagined', 'console', 'error', 'retry', 'discarded']);

/** Split log text into [{kind, text}] entries */
export function parseLog(text) {
  const entries = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = HEADER.exec(line);
    if (m && KINDS.has(m[2])) {
      cur = { kind: m[2], text: m[4] ?? '', block: m[4] === undefined && m[2] !== 'clear' };
      entries.push(cur);
    } else if (cur && cur.block) cur.text += (cur.text ? '\n' : '') + line;
  }
  for (const e of entries) e.text = e.text.replace(/\s+$/, '');
  return entries;
}

/** Cases from one log: a program with its reply (if any) and the first error before the next program/request */
export function casesFromLog(text) {
  const entries = parseLog(text);
  const out = [];
  let reply = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === 'request') reply = null;
    else if (e.kind === 'reply') {
      if (reply) out.push({ reply }); // a reply that never became a program (talk-only, discarded)
      reply = e.text;
    } else if (e.kind === 'program') {
      const c = { program: e.text };
      if (reply) c.reply = reply;
      reply = null;
      for (let j = i + 1; j < entries.length; j++) {
        const n = entries[j];
        if (n.kind === 'program' || n.kind === 'request' || n.kind === 'reply') break;
        if (n.kind === 'error') {
          const m = /^line (\d+): (.*)$/s.exec(n.text);
          c.error = m ? m[2] : n.text;
          if (m) c.errorLine = Number(m[1]);
          break;
        }
      }
      out.push(c);
    }
  }
  if (reply) out.push({ reply });
  return out;
}

function segments(file) {
  const raw = readFileSync(file, 'utf8');
  if (!file.endsWith('.jsonl')) return [raw];
  const segs = [];
  for (const l of raw.split('\n')) {
    if (!l.includes('] program:') && !l.includes('] reply:')) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (o.type !== 'user') continue;
    const c = o.message?.content;
    segs.push(typeof c === 'string' ? c : (c ?? []).map((x) => (typeof x === 'string' ? x : x.text ?? '')).join('\n'));
  }
  return segs;
}

function files(args) {
  const list = args.length ? args : [join(here, 'logs')];
  const out = [];
  for (const a of list) {
    if (!existsSync(a)) continue;
    if (statSync(a).isDirectory()) for (const f of readdirSync(a).sort()) out.push(join(a, f));
    else out.push(a);
  }
  return out.filter((f) => !f.endsWith('.gitkeep'));
}

const key = (c) => JSON.stringify([c.reply ?? null, c.program ?? null, c.error ?? null, c.errorLine ?? null]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : [];
  const seen = new Map(existing.map((c) => [key(c), c]));
  // A program seen both with and without an error keeps the error variant only
  const found = [];
  for (const f of files(process.argv.slice(2))) for (const s of segments(f)) found.push(...casesFromLog(s));
  let added = 0;
  for (const c of found) {
    if (!seen.has(key(c))) { seen.set(key(c), c); added++; }
  }
  // Drop error-less duplicates of a (reply, program) pair that also has an errored variant
  const withErr = new Set([...seen.values()].filter((c) => c.error).map((c) => JSON.stringify([c.reply ?? null, c.program ?? null])));
  const cases = [...seen.values()].filter((c) => c.error || !withErr.has(JSON.stringify([c.reply ?? null, c.program ?? null])));
  cases.forEach((c, i) => { c.id = c.id ?? `case-${String(i + 1).padStart(3, '0')}`; });
  const ordered = cases.map(({ id, reply, program, error, errorLine }) => {
    const o = { id };
    if (reply !== undefined) o.reply = reply;
    if (program !== undefined) o.program = program;
    if (error !== undefined) o.error = error;
    if (errorLine !== undefined) o.errorLine = errorLine;
    return o;
  });
  writeFileSync(OUT, JSON.stringify(ordered, null, 1) + '\n');
  console.log(`${ordered.length} cases (${added} new) -> ${OUT}`);
}
