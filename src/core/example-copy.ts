// ============================================================================
// A music program that copied the prompt's example instead of playing what was asked: the
// example's notes (C4, E4, G4, C5, see midi-form.ts) or its instrument ("piano") where the request
// names another. Sound is heard, so the outcome check would pass it; these say what's wrong.
// ============================================================================

import { INSTRUMENT_PROGRAMS } from '../audio/software-midi.ts';
import { MIDI_EXAMPLE_NOTES } from './midi-form.ts';

const QUOTE = `["'\`]`;
/** The example's notes in order, as quoted values in a list or in send()'s arguments */
const EXAMPLE_NOTES = new RegExp(MIDI_EXAMPLE_NOTES.map((note) => `${QUOTE}${note}${QUOTE}`).join('\\s*,\\s*'));
/** Requests the example's notes would answer: they name a note, a C chord or an arpeggio */
const ASKS_FOR_EXAMPLE = /\b[a-g][#b]?\d\b|\bc\s*(?:major|maj|chord)\b|\barpeggio/i;

/** The fact for a program that plays the example's notes, or null */
export function copiedExampleNotes(code: string, request: string): string | null {
  if (!EXAMPLE_NOTES.test(code) || ASKS_FOR_EXAMPLE.test(request)) return null;
  return `The program plays the example's notes (${MIDI_EXAMPLE_NOTES.join(', ')}), not the music asked for ("${request.trim()}"): put the notes of that music in the list, in order.`;
}

/** Instrument names, longest first, so "electric guitar" is found before "guitar" */
const NAMES = Object.keys(INSTRUMENT_PROGRAMS).sort((a, b) => b.length - a.length);

/** The instrument a request names, if any: a General MIDI name, or drums */
function requestedInstrument(request: string): string | null {
  const text = request.toLowerCase();
  if (/\bdrums?\b|\bdrum ?(?:beat|kit|loop)\b|\bpercussion\b/.test(text)) return 'drums';
  return NAMES.find((name) => new RegExp(`\\b${name}s?\\b`).test(text)) ?? null;
}

/** The fact for a program that plays another instrument than the request names, or null */
export function wrongInstrument(code: string, request: string): string | null {
  const wanted = requestedInstrument(request);
  if (!wanted) return null;
  // The first value of send(): text, or a name the program sets to text (const instrument = "violin")
  const valueOf = (name: string) => new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`).exec(code)?.[1];
  const used = [...code.matchAll(/\.send\(\s*(?:["'`]([^"'`]+)["'`]|([A-Za-z_$][\w$]*)\s*,)/g)]
    .map((m) => m[1] ?? valueOf(m[2]))
    .filter((name): name is string => !!name)
    .map((name) => name.toLowerCase().trim());
  // Only the plain form names its instrument; raw bytes say nothing here
  if (used.length === 0) return null;
  if (used.some((name) => name === wanted || name.includes(wanted) || wanted.includes(name))) return null;
  const playing = [...new Set(used)].map((name) => `"${name}"`).join(', ');
  return `The request asks for ${wanted}, but the program plays ${playing}: the first value of output.send() is the instrument.`;
}

/**
 * The hint's output line copied wrong ("output = [...]await navigator.requestMIDIAccess().outputs.values()[0];"):
 * a line that names requestMIDIAccess and outputs but doesn't parse can only mean the hint's own line, so it
 * becomes that line, keeping the program's name for the output and how it declared it. Null when nothing changes.
 */
export function restoreMidiOutputLine(code: string, parses: (code: string) => boolean): { code: string; line: number } | null {
  if (parses(code)) return null;
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/requestMIDIAccess/.test(line) || !/\boutputs\b/.test(line) || parses(line.replace(/\bawait\b/g, ''))) continue;
    const target = /^(\s*)(?:(const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (!target) continue;
    const [, indent, declared, name] = target;
    const fixed = `${indent}${declared ? `${declared} ` : ''}${name} = [...(await navigator.requestMIDIAccess()).outputs.values()][0];`;
    const candidate = [...lines.slice(0, i), fixed, ...lines.slice(i + 1)].join('\n');
    if (parses(candidate)) return { code: candidate, line: i + 1 };
  }
  return null;
}

/** The fact for a program that sends the example's empty list of notes, copied as it is, or null */
export function emptyExampleNotes(code: string, request: string): string | null {
  const empty =
    /\[\s*\/\*[^*]*\bnotes\b[^*]*\*\/\s*\]/.test(code) || /\b(?:const|let|var)\s+notes\s*=\s*\[\s*\]/.test(code) || /\.send\s*\(\s*["'`][^"'`]*["'`]\s*,\s*\[\s*\]/.test(code);
  if (!empty || !/\.send\s*\(/.test(code)) return null;
  const drums = requestedInstrument(request) === 'drums';
  return `The list of notes is empty (the example's placeholder), so nothing plays: fill it with the notes of "${request.trim()}", in order${
    drums ? ', as drum sounds ("kick", "snare", "hihat") with "drums" as the instrument' : ' (note names like "C4")'
  }.`;
}

/** Every instrument a request names (General MIDI names, longest first so "electric guitar" isn't also "guitar"; drums) */
function requestedInstruments(request: string): string[] {
  let text = request.toLowerCase();
  const found: string[] = [];
  if (/\bdrums?\b|\bdrum ?(?:beat|kit|loop)\b|\bpercussion\b/.test(text)) found.push('drums');
  for (const name of NAMES) {
    const re = new RegExp(`\\b${name}s?\\b`, 'g');
    if (re.test(text)) {
      found.push(name);
      text = text.replace(re, ' ');
    }
  }
  return [...new Set(found)];
}

/**
 * The instrument the request names, where the program plays another: when the request names exactly one
 * instrument and the program sends to exactly one other ("violin" copied from the hint for a flute song, a
 * made-up "General MIDI Instrument Library"), that one is what was asked for. The text is changed where it
 * is written: in send() or where the program sets the name it passes. Null when there's no single answer.
 */
export function useRequestedInstrument(code: string, request: string): { code: string; from: string; to: string } | null {
  const asked = requestedInstruments(request);
  if (asked.length !== 1) return null;
  const to = asked[0];
  const sends = [...code.matchAll(/\.send\(\s*(?:(["'`])([^"'`]*)\1|([A-Za-z_$][\w$]*)\s*,)/g)];
  if (sends.length === 0) return null;
  // Where each one's text is written: in send(), or where its name is set
  const spots = sends.map((m) => {
    if (m[3] === undefined) return { text: m[2], start: (m.index ?? 0) + m[0].indexOf(m[1]) + 1 };
    const set = new RegExp(`\\b(?:const|let|var)\\s+${m[3]}\\s*=\\s*(["'\`])([^"'\`]*)\\1`).exec(code);
    return set ? { text: set[2], start: set.index + set[0].indexOf(set[1]) + 1 } : null;
  });
  if (spots.some((spot) => spot === null)) return null;
  const texts = new Set(spots.map((spot) => spot!.text.toLowerCase().trim()));
  if (texts.size !== 1) return null;
  const [from] = [...texts];
  if (from === to || from.includes(to) || (to.includes(from) && from !== '')) return null;
  // Each place once (two sends may share the name they pass), last first so earlier positions stay right
  const starts = [...new Set(spots.map((spot) => spot!.start))].sort((a, b) => b - a);
  let out = code;
  for (const start of starts) out = out.slice(0, start) + to + out.slice(start + spots.find((s) => s!.start === start)!.text.length);
  return { code: out, from, to };
}
