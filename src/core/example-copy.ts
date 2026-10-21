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
  const used = [...code.matchAll(/\.send\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1].toLowerCase().trim());
  // Only the plain form names its instrument; raw bytes say nothing here
  if (used.length === 0) return null;
  if (used.some((name) => name === wanted || name.includes(wanted) || wanted.includes(name))) return null;
  const playing = [...new Set(used)].map((name) => `"${name}"`).join(', ');
  return `The request asks for ${wanted}, but the program plays ${playing}: the first value of output.send() is the instrument.`;
}
