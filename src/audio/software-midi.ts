// ============================================================================
// Web MIDI for programs, in software: a General MIDI synth (webaudio-tinysynth) on Chatty's
// shared audio. iPhone Safari has no Web MIDI, and desktop Web MIDI only reaches plugged-in
// devices (behind a permission prompt), so programs get this output on every device.
// The sandbox's navigator.requestMIDIAccess calls softwareMidiAccess (javascript-runtime.ts).
// ============================================================================

type MidiAccessOptions = {
  sysex?: boolean;
};

type PortConnection = 'open' | 'closed' | 'pending';

interface TinySynthApi {
  setAudioContext(context: AudioContext, destination?: AudioNode): void;
  setTsMode(mode: number): void;
  send(data: number[], timestamp?: number): void;
  reset(): void;
}

interface SoftwareMidiPortLike extends EventTarget {
  readonly id: string;
  readonly manufacturer: string | null;
  readonly name: string;
  readonly type: 'output';
  readonly version: string | null;
  readonly state: 'connected';
  readonly connection: PortConnection;
  onstatechange: ((event: SoftwareMIDIConnectionEvent) => void) | null;
  open(): Promise<SoftwareMIDIOutput>;
  close(): Promise<SoftwareMIDIOutput>;
}

export class SoftwareMIDIConnectionEvent extends Event {
  constructor(public readonly port: SoftwareMidiPortLike) {
    super('statechange');
  }
}

abstract class StateChangeTarget extends EventTarget {
  private handler: ((event: SoftwareMIDIConnectionEvent) => void) | null = null;

  get onstatechange() {
    return this.handler;
  }

  set onstatechange(handler: ((event: SoftwareMIDIConnectionEvent) => void) | null) {
    if (this.handler) this.removeEventListener('statechange', this.handler as EventListener);
    this.handler = handler;
    if (handler) this.addEventListener('statechange', handler as EventListener);
  }

  protected emitStateChange(port: SoftwareMidiPortLike) {
    this.dispatchEvent(new SoftwareMIDIConnectionEvent(port));
  }
}

interface ScheduledMessage {
  timestamp: number;
  sequence: number;
  message: number[];
}

interface SynthRuntime {
  synth: TinySynthApi;
  resumeFromCurrentCall(): void;
  /** The program's clock (its performance.now()), which its send() timestamps are on */
  now(): number;
}

export class SoftwareMIDIOutput extends StateChangeTarget implements SoftwareMidiPortLike {
  readonly id = 'software-tinysynth';
  readonly manufacturer = 'Browser Software';
  readonly name = 'WebAudio TinySynth';
  readonly type = 'output' as const;
  readonly version = '1.0';
  readonly state = 'connected' as const;

  private _connection: PortConnection = 'closed';
  private access?: SoftwareMIDIAccess;
  private queue: ScheduledMessage[] = [];
  // Instrument name -> channel, for the friendly send() form
  private channels = new Map<string, number>();
  private floodSecond = -1;
  // When each channel:note was last started (recent), to skip exact repeats
  private noteStarts = new Map<string, number[]>();
  private floodCount = 0;
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly runtime: SynthRuntime) {
    super();
  }

  get connection(): PortConnection {
    return this._connection;
  }

  attachAccess(access: SoftwareMIDIAccess): void {
    this.access = access;
  }

  async open(): Promise<this> {
    // Resume right away, while the calling action may still count as a user gesture on iOS
    this.runtime.resumeFromCurrentCall();
    this.setConnection('open');
    return this;
  }

  async close(): Promise<this> {
    this.clear();
    this.setConnection('closed');
    return this;
  }

  /**
   * Plays MIDI at `timestamp` (the program's performance.now() ms; past or 0 means now). Takes raw
   * bytes ([0x90, 60, 100]), read forgivingly, and a friendlier form small models get right more
   * often: [instrument, notes, velocity, durationMs, stepMs] (or the same as an object).
   * - instrument: a name ('piano', 'bass', 'strings', 'drums'...) or GM number; each gets its own
   *   channel and program change on first use, drums always channel 9
   * - notes: 'G3', 60, a chord name ('G major', 'Am7'), a scale name ('G pentatonic down'), drum
   *   names ('kick', 'snare', 'hihat'), or an array of these
   * - an array of up to 4 notes plays together (a chord); 5 or more, or a scale, play one after
   *   another every stepMs (default: the duration)
   * - durationMs stops each note by itself (under 20 it's taken as seconds)
   */
  /** Names small models invent for send() ("piano.play([...])"): the same thing */
  play(data: unknown, timestamp: unknown = 0, ...rest: unknown[]): void {
    this.send(data, timestamp, ...rest);
  }

  playNote(data: unknown, timestamp: unknown = 0, ...rest: unknown[]): void {
    this.send(data, timestamp, ...rest);
  }

  /**
   * Plays notes. The plain form is send(instrument, notes, duration, time) (with a velocity
   * before the duration when there are five values); the Web MIDI form send([…], time) and
   * raw bytes work too.
   */
  send(data: unknown, time: unknown = 0, ...rest: unknown[]): void {
    let timestamp = Number(time);
    // send('piano', 'G major', 500, start): the values as arguments, not in an array
    if (typeof data === 'string' && !/^\s*\d+\s*$/.test(data)) {
      const args = [data, time, ...rest];
      const [instrument, notes] = args;
      const [velocity, duration, at] = args.length >= 5 ? [args[2], args[3], args[4]] : [undefined, args[2], args[3]];
      data = [instrument, notes, velocity, duration];
      timestamp = Number(at ?? 0);
    }
    // Forgiving, like the rest of the sandbox: a bad time plays now, bad bytes are fixed or skipped
    if (!Number.isFinite(timestamp)) timestamp = 0;
    const now = this.runtime.now();
    const items = toItems(data);
    const objectTime = timeOf(data);
    if (!timestamp && objectTime !== undefined) timestamp = objectTime;
    // ['flute', note, 100, 500, start + i * beat]: the time written as a fifth value (it reads like
    // a clock time, near now) instead of as send()'s second argument
    const fifth = Number(items[4]);
    if (!timestamp && typeof items[0] === 'string' && Number.isFinite(fifth) && fifth > 0 && fifth >= now - 1000) {
      timestamp = fifth;
      items[4] = undefined;
    }
    const events = this.readEvents(items);
    if (events.length === 0) return;
    // A runaway loop (setInterval every few ms) would bury the music: at most 400 notes a second
    const second = Math.floor(now / 1000);
    if (second !== this.floodSecond) {
      this.floodSecond = second;
      this.floodCount = 0;
    }
    this.floodCount += events.length;
    if (this.floodCount > 400) return;

    this.runtime.resumeFromCurrentCall();
    this.setConnection('open');

    const deadline = timestamp <= now ? now : timestamp;
    // A loop that overlaps itself schedules the same notes at the same moments again: a note
    // already starting within 30 ms on the same channel is skipped (with its stop)
    const skipped = new Set<string>();
    // A time more than a second gone is a loop replaying old times (start never moved on):
    // playing those notes now would pile them up, so they're dropped
    const stale = timestamp > 0 && timestamp < now - 1000;
    for (const { offset, message } of events) {
      const at = deadline + offset;
      const command = message[0] & 0xf0;
      const key = `${message[0] & 0x0f}:${message[1]}`;
      if (stale && command === 0x90 && timestamp + offset < now - 1000) {
        skipped.add(key);
        continue;
      }
      if (command === 0x90 && message[2] > 0) {
        const times = (this.noteStarts.get(key) ?? []).filter((t) => t > now - 10_000);
        if (times.some((t) => Math.abs(t - at) < 30)) {
          skipped.add(key);
          continue;
        }
        times.push(at);
        this.noteStarts.set(key, times);
      } else if (command === 0x80 && skipped.has(key)) {
        continue;
      }
      this.schedule(message, at, now);
    }
  }

  private schedule(message: number[], deadline: number, now: number): void {
    if (deadline <= now) {
      // Older queued messages first, to keep the order
      this.dispatchDueMessages();
      this.dispatchMessage(message);
      this.scheduleNext();
      return;
    }
    this.queue.push({ timestamp: deadline, sequence: this.sequence++, message });
    this.queue.sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence);
    this.scheduleNext();
  }

  /** One send()'s messages, each at an offset (ms) from its time. */
  private readEvents(items: unknown[]): { offset: number; message: number[] }[] {
    if (items.length === 0) return [];

    // Raw bytes, where notes may be names and a chord an array: [0x90, ['C4', 'E4'], 100]
    if (typeof items[0] !== 'string' || /^\d+$/.test(items[0].trim())) {
      const status = Number(items[0]);
      const drums = (status & 0x0f) === 9 || status === 9;
      const notes = Array.isArray(items[1]) ? items[1] : [items[1]];
      const expanded = items.length > 1 ? notes.map((note) => [items[0], note, ...items.slice(2)]) : [items];
      return expanded
        .flatMap((message) =>
          parseMidiMessages(message.map((value) => (typeof value === 'string' ? (readNotes(value, drums, -1).notes[0] ?? -1) : Number(value))))
        )
        .map((message) => ({ offset: 0, message }));
    }

    let [, , velocity, duration] = items;
    const [instrument, notes, , , step] = items;
    // [instrument, notes, durationMs]: a third value above 127 can only be a duration
    if (duration === undefined && Number(velocity) > 127) {
      duration = velocity;
      velocity = undefined;
    }
    const { channel, drums, program } = this.channelFor(String(instrument));
    const level0 = velocity === undefined || !Number.isFinite(Number(velocity)) ? 100 : Math.max(0, Math.min(127, Math.round(Number(velocity))));
    // A named pattern ('boom-chuck', 'walking G major') plays a whole 4/4 bar over the duration
    const pattern = typeof notes === 'string' ? barPattern(notes, drums) : null;
    if (pattern) {
      let barMs = Number(duration) > 0 ? Number(duration) : 2000;
      if (barMs < 20) barMs *= 1000; // seconds
      const beatMs = barMs / 4;
      return pattern.flatMap(({ beat, note, beats }) => {
        const offset = beat * beatMs;
        const on = { offset, message: [0x90 | channel, note, level0] };
        return drums ? [on] : [on, { offset: offset + beats * beatMs * 0.95, message: [0x80 | channel, note, 0] }];
      });
    }
    let { notes: numbers, sequence } = readNotes(notes, drums, program);
    // Arguments out of place (['bass', 'walking', 'G', beat]): the notes are the first readable
    // value after the instrument, and the numbers that follow are velocity, then duration
    if (numbers.length === 0) {
      const rest = items.slice(1);
      const at = rest.findIndex((item) => typeof item !== 'number' && readNotes(item, drums, program).notes.length > 0);
      if (at >= 0) {
        ({ notes: numbers, sequence } = readNotes(rest[at], drums, program));
        const values = rest.slice(at + 1).filter((item): item is number => typeof item === 'number');
        velocity = values.find((v) => v <= 127);
        duration = values.find((v) => v > 127) ?? (velocity === undefined ? values[0] : values[1]);
      }
    }
    const level =
      velocity === undefined || !Number.isFinite(Number(velocity)) ? 100 : Math.max(0, Math.min(127, Math.round(Number(velocity))));
    // No duration: one beat at 120 bpm, so a note never rings on forever
    let ms = Number(duration) > 0 ? Number(duration) : DEFAULT_NOTE_MS;
    if (ms > 0 && ms < 20) ms *= 1000; // seconds
    const stepMs = Number(step) > 0 ? Number(step) : sequence ? ms || 300 : 0;

    const events: { offset: number; message: number[] }[] = [];
    numbers.forEach((note, i) => {
      const offset = i * stepMs;
      events.push({ offset, message: [0x90 | channel, note, level] });
      if (ms > 0 && level > 0 && !drums) events.push({ offset: offset + ms, message: [0x80 | channel, note, 0] });
    });
    return events;
  }

  /** The channel for an instrument name: drums 9, others their own, picked (and set up) on first use. */
  private channelFor(name: string): { channel: number; drums: boolean; program: number } {
    const key = normalizeName(name);
    if (DRUM_KITS.has(key) || /\bdrum|percussion/.test(key)) return { channel: 9, drums: true, program: -1 };
    const program = instrumentProgram(key);
    let channel = this.channels.get(key);
    if (channel === undefined) {
      channel = FREE_CHANNELS[this.channels.size % FREE_CHANNELS.length];
      this.channels.set(key, channel);
      this.dispatchMessage([0xc0 | channel, program]);
    }
    return { channel, drums: false, program };
  }

  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue = [];
    // A cleared note-off must not leave a note sounding: release sustain and silence voices
    this.stopAllVoices();
  }

  private setConnection(next: PortConnection): void {
    if (this._connection === next) return;
    this._connection = next;
    this.emitStateChange(this);
    this.access?.notifyPortStateChange(this);
  }

  private scheduleNext(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const next = this.queue[0];
    if (!next) return;
    const delay = Math.max(0, next.timestamp - this.runtime.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.dispatchDueMessages();
      this.scheduleNext();
    }, delay);
  }

  private dispatchDueMessages(): void {
    const now = this.runtime.now();
    while (this.queue.length > 0 && this.queue[0].timestamp <= now) {
      this.dispatchMessage(this.queue.shift()!.message);
    }
  }

  private dispatchMessage(message: number[]): void {
    const status = message[0];
    // Channel voice messages: notes, controllers, program changes, pitch bend, aftertouch
    if (status >= 0x80 && status <= 0xef) {
      this.runtime.synth.send(message);
      return;
    }
    // System Reset
    if (status === 0xff) {
      this.stopAllVoices();
      this.runtime.synth.reset();
    }
    // Other system messages make no sound here
  }

  private stopAllVoices(): void {
    for (let channel = 0; channel < 16; channel++) {
      this.runtime.synth.send([0xb0 | channel, 64, 0]);
      this.runtime.synth.send([0xb0 | channel, 120, 0]);
    }
  }
}

export class SoftwareMIDIAccess extends StateChangeTarget {
  readonly sysexEnabled = false;
  readonly inputs: ReadonlyMap<string, never> = new Map<string, never>();
  readonly outputs: ReadonlyMap<string, SoftwareMIDIOutput>;

  constructor(output: SoftwareMIDIOutput) {
    super();
    this.outputs = new Map([[output.id, output]]);
    output.attachAccess(this);
  }

  notifyPortStateChange(port: SoftwareMidiPortLike): void {
    this.emitStateChange(port);
  }
}

// ---- Names for the friendly send() form ----

/** General MIDI programs by common name (a name containing one of these also matches it) */
const INSTRUMENT_PROGRAMS: Record<string, number> = {
  piano: 0,
  'grand piano': 0,
  keys: 0,
  keyboard: 0,
  'electric piano': 4,
  'e piano': 4,
  epiano: 4,
  rhodes: 4,
  harpsichord: 6,
  celesta: 8,
  glockenspiel: 9,
  'music box': 10,
  vibraphone: 11,
  vibes: 11,
  marimba: 12,
  xylophone: 13,
  bells: 14,
  organ: 16,
  'church organ': 19,
  accordion: 21,
  harmonica: 22,
  guitar: 25,
  'nylon guitar': 24,
  'classical guitar': 24,
  'acoustic guitar': 25,
  'jazz guitar': 26,
  'electric guitar': 27,
  'clean guitar': 27,
  'lead guitar': 29,
  'overdrive guitar': 29,
  'distortion guitar': 30,
  bass: 33,
  'acoustic bass': 32,
  'upright bass': 32,
  'double bass': 32,
  'electric bass': 33,
  'bass guitar': 33,
  'fretless bass': 35,
  'slap bass': 36,
  'synth bass': 38,
  violin: 40,
  fiddle: 40,
  viola: 41,
  cello: 42,
  contrabass: 43,
  harp: 46,
  timpani: 47,
  strings: 48,
  'string section': 48,
  orchestra: 48,
  choir: 52,
  voice: 53,
  vocals: 53,
  trumpet: 56,
  trombone: 57,
  tuba: 58,
  horn: 60,
  'french horn': 60,
  brass: 61,
  sax: 65,
  saxophone: 65,
  'soprano sax': 64,
  'alto sax': 65,
  'tenor sax': 66,
  'baritone sax': 67,
  oboe: 68,
  bassoon: 70,
  clarinet: 71,
  piccolo: 72,
  flute: 73,
  recorder: 74,
  'pan flute': 75,
  whistle: 78,
  ocarina: 79,
  synth: 80,
  lead: 80,
  'square lead': 80,
  'saw lead': 81,
  pad: 88,
  'warm pad': 89,
  sitar: 104,
  banjo: 105,
  koto: 107,
  kalimba: 108,
  bagpipe: 109,
  'steel drums': 114,
};
const INSTRUMENT_NAMES_LONGEST_FIRST = Object.keys(INSTRUMENT_PROGRAMS).sort((a, b) => b.length - a.length);
const DRUM_KITS = new Set(['drums', 'drum', 'drum kit', 'kit', 'percussion', 'beat', 'rhythm']);
const DRUM_NOTES: Record<string, number> = {
  kick: 36,
  'bass drum': 36,
  rim: 37,
  rimshot: 37,
  snare: 38,
  clap: 39,
  hihat: 42,
  'closed hihat': 42,
  'pedal hihat': 44,
  openhat: 46,
  'open hihat': 46,
  tom: 45,
  'low tom': 41,
  'mid tom': 45,
  'high tom': 48,
  crash: 49,
  ride: 51,
  tambourine: 54,
  cowbell: 56,
  shaker: 70,
};
// Words small models use for drum sounds, checked in order
const DRUM_WORDS: [RegExp, number][] = [
  [/open.*hat/, 46],
  [/hat|hh|chick/, 42],
  [/kick|boom|bass ?drum|bd\b/, 36],
  [/snare|chuck|back ?beat|sd\b/, 38],
  [/clap/, 39],
  [/rim/, 37],
  [/crash|cymbal/, 49],
  [/ride/, 51],
  [/floor|low tom/, 41],
  [/tom/, 45],
  [/tamb/, 54],
  [/cowbell/, 56],
  [/shak/, 70],
];
// Channel 9 is the drums
const FREE_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
const PITCH_CLASSES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11, 12],
  minor: [0, 2, 3, 5, 7, 8, 10, 12],
  'major pentatonic': [0, 2, 4, 7, 9, 12],
  'minor pentatonic': [0, 3, 5, 7, 10, 12],
  blues: [0, 3, 5, 6, 7, 10, 12],
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, ' ').replace(/hi hat/g, 'hihat').replace(/\s+/g, ' ').trim();
}

function instrumentProgram(key: string): number {
  if (/^\d+$/.test(key)) return Math.min(127, Number(key));
  const singular = key.replace(/s$/, '');
  // Exact name first, then a name inside it ('acoustic grand piano'), then a shortened one ('string')
  const match =
    INSTRUMENT_NAMES_LONGEST_FIRST.find((name) => key === name || singular === name) ??
    INSTRUMENT_NAMES_LONGEST_FIRST.find((name) => key.includes(name)) ??
    INSTRUMENT_NAMES_LONGEST_FIRST.find((name) => singular.length >= 5 && name.startsWith(singular));
  return match === undefined ? 0 : INSTRUMENT_PROGRAMS[match];
}

const isBassProgram = (program: number) => program >= 32 && program <= 39;

function drumNote(text: string): number | null {
  const key = normalizeName(text);
  if (DRUM_NOTES[key] !== undefined) return DRUM_NOTES[key];
  return DRUM_WORDS.find(([pattern]) => pattern.test(key))?.[1] ?? null;
}

const clampNote = (n: number) => Math.max(0, Math.min(127, Math.round(n)));

/** The MIDI number of a letter, accidental and octave ('G', '#', 3 → 55). */
function pitch(letter: string, accidental: string | undefined, octave: number): number {
  const shift = accidental === '#' || accidental === '♯' ? 1 : accidental ? -1 : 0;
  return (octave + 1) * 12 + PITCH_CLASSES[letter.toLowerCase()] + shift;
}

/** Chord tones by chord-quality word, e.g. '' or 'major' → [0, 4, 7], 'm7' → [0, 3, 7, 10] */
function chordIntervals(quality: string): number[] | null {
  if (quality === 'M7') return [0, 4, 7, 11];
  const q = quality.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^(maj ?7|major ?7(th)?|Δ7?)$/.test(q)) return [0, 4, 7, 11];
  if (/^(m ?7|min ?7|minor ?7(th)?|-7)$/.test(q)) return [0, 3, 7, 10];
  if (/^(m7b5|ø7?|half ?dim(inished)?)$/.test(q)) return [0, 3, 6, 10];
  if (/^(dim ?7|diminished ?7(th)?)$/.test(q)) return [0, 3, 6, 9];
  if (/^(7|dom ?7|dominant( ?7(th)?)?)$/.test(q)) return [0, 4, 7, 10];
  if (/^(9|dom ?9)$/.test(q)) return [0, 4, 7, 10, 14];
  if (/^(add ?9)$/.test(q)) return [0, 4, 7, 14];
  if (/^(dim|diminished|°)$/.test(q)) return [0, 3, 6];
  if (/^(aug|augmented|\+)$/.test(q)) return [0, 4, 8];
  if (/^sus ?2$/.test(q)) return [0, 2, 7];
  if (/^(sus ?4?|suspended)$/.test(q)) return [0, 5, 7];
  if (/^(6|maj ?6|major ?6(th)?)$/.test(q)) return [0, 4, 7, 9];
  if (/^(m ?6|min ?6|minor ?6(th)?)$/.test(q)) return [0, 3, 7, 9];
  if (/^(m|min|minor|-)$/.test(q)) return [0, 3, 7];
  if (/^(maj|major|triad|)$/.test(q)) return [0, 4, 7];
  return null;
}

/**
 * Note numbers for one value: 60, 'G3' (octave optional), a chord name ('G major', 'Am7',
 * 'C chord'), a scale name ('G major pentatonic descending', 'E blues'), or a drum name on drums.
 * Bass notes are kept in bass range; `scale` says they're meant one after another.
 */
function noteValues(value: unknown, drums: boolean, program: number): { notes: number[]; scale: boolean } {
  const none = { notes: [], scale: false };
  if (typeof value === 'number') return Number.isFinite(value) ? { notes: [clampNote(value)], scale: false } : none;
  if (typeof value !== 'string') return none;
  const text = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return { notes: [clampNote(Number(text))], scale: false };
  if (drums) {
    const hit = drumNote(text);
    return hit === null ? none : { notes: [hit], scale: false };
  }
  const bass = isBassProgram(program);
  // The accidental sits right after the letter ('Bbm' is B-flat minor; 'B blues' has none)
  const root = /^([a-g])(#|♯|b|♭)?(-?\d)?\s*(.*)$/i.exec(text);
  if (!root) return none;
  const [, letter, accidental] = root;
  let octaveText: string | undefined = root[3];
  let rest = root[4];
  // 'E7 chord' / 'C9 chord': the digit is the chord, not an octave
  if (/^chord$/i.test(rest.trim()) && octaveText && ['6', '7', '9'].includes(octaveText)) {
    rest = `${octaveText} chord`;
    octaveText = undefined;
  }

  // Scales: 'G pentatonic', 'E minor pentatonic down', 'C major scale', 'A blues'
  if (/pentatonic|blues|scale/i.test(rest)) {
    const minor = /\bminor\b|\bmin\b|^m\b/i.test(rest);
    const type = /blues/i.test(rest) ? 'blues' : /pentatonic/i.test(rest) ? (minor ? 'minor pentatonic' : 'major pentatonic') : minor ? 'minor' : 'major';
    const base = pitch(letter, accidental, octaveText === undefined ? (bass ? 2 : 4) : Number(octaveText));
    const notes = SCALES[type].map((step) => clampNote(base + step));
    if (/down|descend|falling|reverse/i.test(rest)) notes.reverse();
    return { notes: bass ? notes.map(toBassRange) : notes, scale: true };
  }

  // Chords: a quality word after the root, or the word "chord"
  const chordWord = /\bchord\b/i.test(rest);
  const quality = rest.replace(/\bchord\b/i, '').trim();
  if (quality !== '' || chordWord) {
    const intervals = chordIntervals(quality);
    if (!intervals) return none;
    const base = pitch(letter, accidental, octaveText === undefined ? (bass ? 2 : 3) : Number(octaveText));
    const notes = intervals.map((step) => clampNote(base + step));
    return { notes: bass ? notes.map(toBassRange) : notes, scale: false };
  }

  const note = clampNote(pitch(letter, accidental, octaveText === undefined ? (bass ? 2 : 4) : Number(octaveText)));
  return { notes: [bass ? toBassRange(note) : note], scale: false };
}

/** A note's length when send() gives none: one beat at 120 bpm */
const DEFAULT_NOTE_MS = 500;

type PatternNote = { beat: number; note: number; beats: number };

/**
 * One 4/4 bar of a named pattern, in beats: drum grooves ('boom-chuck', 'rock', 'shuffle',
 * 'four on the floor') and walking bass lines ('walking G major'). Musical knowledge lives here
 * instead of in the prompt, so a program only has to name what it wants.
 */
function barPattern(text: string, drums: boolean): PatternNote[] | null {
  const key = normalizeName(text).replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  if (drums) {
    const kick = drumNote('kick') ?? 36;
    const snare = drumNote('snare') ?? 38;
    const hat = drumNote('hihat') ?? 42;
    const hit = (beat: number, note: number) => ({ beat, note, beats: 0.25 });
    if (/^(boom ?chuck|oom ?pah)( beat| groove| pattern)?$/.test(key)) return [hit(0, kick), hit(1, snare), hit(2, kick), hit(3, snare)];
    if (/^(rock|back ?beat|basic|pop)( beat| groove| pattern)?$/.test(key)) {
      return [0, 1, 2, 3, 0.5, 1.5, 2.5, 3.5].map((b) => hit(b, hat)).concat([hit(0, kick), hit(2, kick), hit(1, snare), hit(3, snare)]);
    }
    if (/^(shuffle|swing)( beat| groove| pattern)?$/.test(key)) {
      return [0, 1, 2, 3].flatMap((b) => [hit(b, hat), hit(b + 2 / 3, hat)]).concat([hit(0, kick), hit(2, kick), hit(1, snare), hit(3, snare)]);
    }
    if (/^(four on the floor|disco|house)( beat| groove| pattern)?$/.test(key)) {
      return [0, 1, 2, 3].flatMap((b) => [hit(b, kick), hit(b + 0.5, hat)]).concat([hit(1, snare), hit(3, snare)]);
    }
    return null;
  }
  const walking = /^walking(?: bass)?(?: line)?(?: in| on)? ([a-g](?:#|b)?.*)$/i.exec(key);
  if (!walking) return null;
  const chord = /^([a-g])(#|b)?\s*(.*)$/i.exec(walking[1]);
  if (!chord) return null;
  const intervals = chordIntervals(chord[3].replace(/\b(chord|bass|line)\b/g, '').trim()) ?? [0, 4, 7];
  const minor = intervals[1] === 3;
  // One note per beat stepping through the chord: root, third, fifth, then the sixth (seventh in minor)
  const steps = [0, intervals[1], intervals[2], minor ? 10 : 9];
  const root = pitch(chord[1], chord[2], 2);
  return steps.map((step, beat) => ({ beat, note: toBassRange(clampNote(root + step)), beats: 1 }));
}

/** Bass notes written an octave or two too high are brought down into bass range. */
function toBassRange(note: number): number {
  let n = note;
  while (n >= 60) n -= 12;
  return n;
}

/** All the notes of a send(): one value or an array; 5+ notes, or a scale, are a melody. */
function readNotes(value: unknown, drums: boolean, program: number): { notes: number[]; sequence: boolean } {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const notes: number[] = [];
  let sequence = false;
  for (const item of values) {
    const read = noteValues(item, drums, program);
    notes.push(...read.notes);
    if (read.scale) sequence = true;
  }
  if (Array.isArray(value) && !drums && values.length >= 5) sequence = true;
  return { notes, sequence };
}

/** A note as a MIDI number: 60, 'C4' (middle C), 'F#3', 'Bb2', or a drum name on drums. */
export function noteNumber(value: unknown, drums = false): number | null {
  return noteValues(value, drums, -1).notes[0] ?? null;
}

/** send()'s data as a list, accepting the object form {instrument, notes, velocity, duration}. */
function toItems(data: unknown): unknown[] {
  if (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as { length?: unknown }).length !== 'number') {
    const o = data as Record<string, unknown>;
    if (o.instrument !== undefined || o.notes !== undefined || o.note !== undefined || o.chord !== undefined) {
      return [
        o.instrument ?? 'piano',
        o.notes ?? o.note ?? o.chord ?? o.scale,
        o.velocity ?? o.loudness ?? o.volume,
        o.duration ?? o.durationMs ?? o.length,
        o.step ?? o.stepMs ?? o.gap,
      ];
    }
  }
  try {
    return Array.from(data as ArrayLike<unknown>);
  } catch {
    return [];
  }
}

/** A time given inside the object form ({..., time}). */
function timeOf(data: unknown): number | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const o = data as Record<string, unknown>;
  const time = Number(o.time ?? o.at ?? o.when ?? o.start);
  return Number.isFinite(time) ? time : undefined;
}

function toByteArray(data: Iterable<number> | ArrayLike<number>): number[] {
  if (data != null && typeof (data as Iterable<number>)[Symbol.iterator] === 'function') {
    return Array.from(data as Iterable<number>);
  }
  const arrayLike = data as ArrayLike<number>;
  return Array.from({ length: arrayLike.length }, (_, index) => arrayLike[index]);
}

/** A message's length from its status byte, or 0 for status bytes that never make sound here. */
function messageLength(status: number): number {
  if (status >= 0x80 && status <= 0xef) {
    const command = status & 0xf0;
    return command === 0xc0 || command === 0xd0 ? 2 : 3;
  }
  switch (status) {
    case 0xf1:
    case 0xf3:
      return 2;
    case 0xf2:
      return 3;
    case 0xf6:
    case 0xf8:
    case 0xfa:
    case 0xfb:
    case 0xfc:
    case 0xfe:
    case 0xff:
      return 1;
    default:
      return 0;
  }
}

/**
 * The messages in one send(), read forgivingly. Small models get MIDI bytes slightly wrong, and a
 * strict port throws, which stops the whole program before a note plays. So: a bare channel
 * number (9 for drums) is a note-on on that channel; a program change written with a velocity
 * ([0xC0, 60, 100], 3 bytes where a real one has 2) is the note-on it was meant to be; other
 * extra data bytes are dropped; a missing velocity is 100 for a note-on and 0 for a note-off;
 * SysEx and anything unreadable is skipped.
 */
export function parseMidiMessages(data: Iterable<number> | ArrayLike<number>): number[][] {
  const bytes = toByteArray(data)
    .map((byte) => Math.round(Number(byte)))
    .filter((byte) => Number.isFinite(byte) && byte >= 0 && byte <= 255);

  const messages: number[][] = [];
  let index = 0;
  while (index < bytes.length) {
    let status = bytes[index];
    if (status === 0xf0) {
      // SysEx: skipped
      const end = bytes.indexOf(0xf7, index + 1);
      index = end < 0 ? bytes.length : end + 1;
      continue;
    }
    if (status < 16) status = 0x90 | status; // a bare channel number: note-on
    // A program change with a note and a velocity after it: a note-on
    if ((status & 0xf0) === 0xc0 && bytes[index + 1] < 0x80 && bytes[index + 2] < 0x80) status = 0x90 | (status & 0x0f);
    const length = messageLength(status);
    if (length === 0) {
      index++; // a stray data byte, or a status that makes no sound
      continue;
    }

    const message = [status];
    let next = index + 1;
    while (message.length < length && next < bytes.length && bytes[next] < 0x80) message.push(bytes[next++]);
    const command = status & 0xf0;
    if (message.length === length - 1 && (command === 0x90 || command === 0x80)) {
      message.push(command === 0x90 ? 100 : 0);
    }
    if (message.length === length) messages.push(message);
    // Data bytes left over after the message are dropped
    while (next < bytes.length && bytes[next] < 0x80) next++;
    index = next;
  }
  return messages;
}

// One synth per audio context, re-pointed at each program's output node
let current: { context: AudioContext; destination: AudioNode; synth: TinySynthApi } | null = null;
const liveOutputs = new Set<SoftwareMIDIOutput>();

async function synthOn(context: AudioContext, destination: AudioNode): Promise<TinySynthApi> {
  if (current?.context === context) {
    if (current.destination !== destination) {
      current.synth.setAudioContext(context, destination);
      current.destination = destination;
    }
    return current.synth;
  }
  const { default: WebAudioTinySynth } = await import('webaudio-tinysynth');
  // TinySynth creates its own AudioContext while it's constructed: hand it the shared one, which
  // the user's tap already unlocked (a context of its own can stay silent on iOS)
  const scope = window as unknown as { AudioContext: unknown };
  const nativeAudioContext = scope.AudioContext;
  scope.AudioContext = function SharedAudioContext() {
    return context;
  };
  let synth: TinySynthApi;
  try {
    synth = new WebAudioTinySynth({ quality: 1, useReverb: 0, voices: 32 }) as TinySynthApi;
  } finally {
    scope.AudioContext = nativeAudioContext;
  }
  // Timing is handled here (the queue above), so TinySynth plays each message as it arrives
  synth.setTsMode(0);
  synth.setAudioContext(context, destination);
  current = { context, destination, synth };
  return synth;
}

/**
 * A MIDIAccess for one program: one software output, playing into `destination` on `context`.
 * `now` is the program's own performance.now(), which its timestamps use.
 */
export async function softwareMidiAccess(
  context: AudioContext,
  destination: AudioNode,
  now: () => number,
  options: MidiAccessOptions = {}
): Promise<SoftwareMIDIAccess> {
  if (options.sysex) {
    throw new DOMException('System Exclusive is not supported by this software output.', 'NotSupportedError');
  }
  const synth = await synthOn(context, destination);
  const output = new SoftwareMIDIOutput({
    synth,
    now,
    resumeFromCurrentCall() {
      if (context.state !== 'running') void context.resume().catch(() => {});
    },
  });
  liveOutputs.add(output);
  return new SoftwareMIDIAccess(output);
}

/** The screen was wiped or a new program started: drop queued notes and stop sounding ones. */
export function silenceSoftwareMidi(): void {
  for (const output of liveOutputs) output.clear();
  liveOutputs.clear();
}
