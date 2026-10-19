// ============================================================================
// Music & MIDI Playback Tool for Chatty
// Plays musical note sequences, melodies, chords, and Web MIDI in the browser
// via Web Audio API synthesis and optional Web MIDI hardware outputs.
// ============================================================================

import type { ToolDefinition } from '../types/index.ts';

export interface NoteEvent {
  note: string;       // e.g. "C4", "G4", "F#4"
  midi: number;       // e.g. 60 for C4
  freq: number;       // e.g. 261.63 Hz
  durationBeats: number; // Duration in beats (default 1.0)
}

export interface PlayMusicResult {
  success: boolean;
  played: string;
  count: number;
  instrument: string;
  tempo: number;
  description?: string;
  midiOutputsCount?: number;
  error?: string;
}

const SEMITONE_MAP: Record<string, number> = {
  c: 0,
  'c#': 1,
  db: 1,
  d: 2,
  'd#': 3,
  eb: 3,
  e: 4,
  f: 5,
  'f#': 6,
  gb: 6,
  g: 7,
  'g#': 8,
  ab: 8,
  a: 9,
  'a#': 10,
  bb: 10,
  b: 11,
};

const MELODY_PRESETS: Record<string, string> = {
  twinkle: 'C4, C4, G4, G4, A4, A4, G4:2, F4, F4, E4, E4, D4, D4, C4:2',
  'happy birthday': 'C4:0.75, C4:0.25, D4, C4, F4, E4:2, C4:0.75, C4:0.25, D4, C4, G4, F4:2',
  scale: 'C4, D4, E4, F4, G4, A4, B4, C5:2',
  fanfare: 'C4, E4, G4, C5:2, G4, C5:2',
  arpeggio: 'C4, E4, G4, C5, G4, E4, C4:2',
  chime: 'E4, G#4, B4, E5:2',
  'ode to joy': 'E4, E4, F4, G4, G4, F4, E4, D4, C4, C4, D4, E4, E4:1.5, D4:0.5, D4:2',
  blues: 'C4, Eb4, F4, F#4, G4, Bb4, C5:2',
};

/**
 * Parses a single note token (e.g. "C4", "G", "F#4:0.5", "60", "A4:2") into a NoteEvent.
 */
export function parseNoteToken(token: string, defaultOctave = 4): NoteEvent | null {
  const clean = token.trim();
  if (!clean) return null;

  // Split optional duration: e.g. "C4:0.5" -> notePart="C4", durPart="0.5"
  const [notePart, durPart] = clean.split(':');
  const durationBeats = durPart ? Math.max(0.1, parseFloat(durPart) || 1.0) : 1.0;

  // 1. Numeric MIDI note (e.g. "60")
  if (/^\d+$/.test(notePart)) {
    const midi = parseInt(notePart, 10);
    if (midi >= 0 && midi <= 127) {
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const oct = Math.floor(midi / 12) - 1;
      const noteName = `${noteNames[midi % 12]}${oct}`;
      return { note: noteName, midi, freq, durationBeats };
    }
  }

  // 2. Letter note (e.g. "C", "F#4", "Bb3")
  const match = notePart.match(/^([a-gA-G][#b]?)(-?\d+)?$/);
  if (!match) return null;

  const letter = match[1].toLowerCase();
  const semitone = SEMITONE_MAP[letter];
  if (semitone === undefined) return null;

  const octave = match[2] !== undefined ? parseInt(match[2], 10) : defaultOctave;
  const midi = (octave + 1) * 12 + semitone;
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const formattedName = `${letter.toUpperCase()}${octave}`;

  return { note: formattedName, midi, freq, durationBeats };
}

/**
 * Parses a sequence of notes from a string or array into NoteEvents.
 */
export function parseNoteSequence(input: string | string[], defaultOctave = 4): NoteEvent[] {
  let tokens: string[] = [];
  if (Array.isArray(input)) {
    tokens = input.map(String);
  } else if (typeof input === 'string') {
    // Check if input references a preset melody name
    const lower = input.toLowerCase().trim();
    for (const [presetName, presetNotes] of Object.entries(MELODY_PRESETS)) {
      if (lower.includes(presetName)) {
        return parseNoteSequence(presetNotes, defaultOctave);
      }
    }
    // Delimit by commas, semicolons, or whitespace
    tokens = input.split(/[,;\s]+/).filter(Boolean);
  }

  const events: NoteEvent[] = [];
  for (const t of tokens) {
    const ev = parseNoteToken(t, defaultOctave);
    if (ev) events.push(ev);
  }
  return events;
}

/**
 * Sends MIDI Note On / Note Off events to all connected Web MIDI outputs if available.
 */
async function sendWebMidiNotes(
  notes: NoteEvent[],
  tempo: number
): Promise<number> {
  if (
    typeof navigator === 'undefined' ||
    typeof (navigator as unknown as { requestMIDIAccess?: () => Promise<any> }).requestMIDIAccess !== 'function'
  ) {
    return 0;
  }

  try {
    const midiAccess = await (navigator as any).requestMIDIAccess();
    const outputs = Array.from((midiAccess.outputs as Map<string, any>).values());
    if (outputs.length === 0) return 0;

    const secondsPerBeat = 60 / tempo;
    const now = performance.now();
    let currentOffsetSec = 0;

    for (const n of notes) {
      const noteDurationSec = n.durationBeats * secondsPerBeat;
      const startMs = now + currentOffsetSec * 1000;
      const endMs = startMs + noteDurationSec * 900; // slightly staccato for clean separation

      for (const out of outputs) {
        try {
          out.send([0x90, n.midi, 100], startMs);
          out.send([0x80, n.midi, 0], endMs);
        } catch {
          // Output send error, continue
        }
      }

      currentOffsetSec += noteDurationSec;
    }

    return outputs.length;
  } catch {
    return 0;
  }
}

/**
 * Synthesizes note events via Web Audio API with ADSR gain envelope.
 */
async function synthesizeWebAudioNotes(
  audioCtx: AudioContext,
  notes: NoteEvent[],
  tempo: number,
  instrument = 'synth'
): Promise<void> {
  if (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted') {
    await audioCtx.resume();
  }

  const secondsPerBeat = 60 / tempo;
  let startTime = audioCtx.currentTime + 0.05;

  const oscType: OscillatorType =
    instrument === 'organ'
      ? 'square'
      : instrument === 'piano' || instrument === 'bell'
      ? 'sine'
      : 'triangle';

  for (const n of notes) {
    const durationSec = n.durationBeats * secondsPerBeat;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = oscType;
    osc.frequency.setValueAtTime(n.freq, startTime);

    // ADSR Envelope
    const attackTime = 0.02;
    const decayTime = instrument === 'bell' ? durationSec * 0.8 : 0.05;
    const sustainGain = instrument === 'bell' ? 0.01 : 0.22;
    const releaseTime = 0.04;

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(0.3, startTime + attackTime);
    gain.gain.exponentialRampToValueAtTime(sustainGain, startTime + attackTime + decayTime);
    gain.gain.setValueAtTime(sustainGain, startTime + durationSec - releaseTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(startTime);
    osc.stop(startTime + durationSec);

    startTime += durationSec;
  }
}

/**
 * Helper to parse and play notes via Web Audio synthesis and Web MIDI.
 */
export async function playNotesHelper(
  notesRaw: string,
  tempo = 120,
  instrument = 'synth',
  audioContextAccessor?: () => Promise<AudioContext | null> | AudioContext | null
): Promise<PlayMusicResult> {
  const cleanTempo = Math.max(40, Math.min(300, Number(tempo) || 120));
  const cleanInstrument = String(instrument || 'synth').toLowerCase();

  let noteEvents = parseNoteSequence(notesRaw);
  if (noteEvents.length === 0) {
    noteEvents = parseNoteSequence('C4, E4, G4, C5');
  }

  const playedNames = noteEvents.map((n) => n.note).join(', ');

  // 1. Play MIDI via Web MIDI if outputs are connected
  let midiCount = 0;
  try {
    midiCount = await sendWebMidiNotes(noteEvents, cleanTempo);
  } catch {
    // Non-blocking Web MIDI fallback
  }

  // 2. Synthesize audio via Web Audio API
  try {
    let audioCtx: AudioContext | null = null;
    let ownsContext = false;
    if (audioContextAccessor) {
      audioCtx = await audioContextAccessor();
    }

    if (!audioCtx) {
      const Ctor =
        (typeof window !== 'undefined' &&
          (window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)) ||
        (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
      if (Ctor) {
        audioCtx = new Ctor();
        ownsContext = true;
      }
    }

    if (audioCtx) {
      try {
        await synthesizeWebAudioNotes(audioCtx, noteEvents, cleanTempo, cleanInstrument);
      } catch (err) {
        if (ownsContext) void audioCtx.close().catch(() => {});
        throw err;
      }
      if (ownsContext) {
        // Close the self-created context once the scheduled notes have finished playing.
        const ctx = audioCtx;
        const totalSec = noteEvents.reduce((sum, n) => sum + n.durationBeats * (60 / cleanTempo), 0);
        setTimeout(() => void ctx.close().catch(() => {}), (totalSec + 0.5) * 1000);
      }
    }
  } catch (err) {
    console.error('[MusicTool] Web Audio playback failed:', err);
  }

  return {
    success: true,
    played: playedNames,
    count: noteEvents.length,
    instrument: cleanInstrument,
    tempo: cleanTempo,
    midiOutputsCount: midiCount,
  };
}

/**
 * Creates the standard `play_music` tool definition for Chatty.
 */
export function createPlayMusicTool(
  audioContextAccessor?: () => Promise<AudioContext | null> | AudioContext | null
): ToolDefinition {
  return {
    name: 'play_music',
    description:
      'Plays melodies, musical notes, chords, and MIDI in the browser. Call this whenever the user asks to play music, play a tune, play notes, or play MIDI.',
    parameters: {
      type: 'object',
      properties: {
        notes: {
          type: 'string',
          description:
            'Notes to play (e.g. "C4, E4, G4", "C, G, G, F, C, G", or song name like "twinkle", "fanfare")',
        },
        instrument: {
          type: 'string',
          description: 'Instrument or timbre: "synth", "piano", "organ", "flute", "bell", "midi"',
        },
        tempo: {
          type: 'number',
          description: 'Tempo in beats per minute (default 120)',
        },
        description: {
          type: 'string',
          description: 'Brief title or description of the melody (e.g. "Fanfare", "Lullaby")',
        },
      },
      required: [],
    },
    execute: async (args: Record<string, unknown>): Promise<PlayMusicResult> => {
      const anyStr = Object.values(args).find(
        (v) => typeof v === 'string' && v.trim().length > 0
      ) as string | undefined;
      const notesRaw = String(
        args.notes || args.melody || args.sequence || args.song || args.tune || args.prompt || ''
      ).trim();
      const descRaw = String(
        args.description || args.title || args.name || args.song || args.tune || anyStr || ''
      ).trim();
      const tempo = Math.max(40, Math.min(300, Number(args.tempo) || 120));
      const instrument = String(args.instrument || 'synth').toLowerCase();

      const inputNotes = notesRaw || descRaw || 'C4, E4, G4, C5';
      const res = await playNotesHelper(inputNotes, tempo, instrument, audioContextAccessor);
      res.description = descRaw || 'Melody';
      return res;
    },
  };
}
