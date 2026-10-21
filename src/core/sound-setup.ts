/**
 * What a program set up for sound, as its page reports it (the sandbox runner remembers each part
 * the program made: whether it was started, whether it reaches the output), and the step a silent
 * program is missing. A silent program is silent for a reason: nothing was started, a source was
 * never connected to the output, Tone.Transport was never started. Saying which step is missing
 * gives the model something to change; "connect each synth with .toDestination()" to a program that
 * already does gives it nothing, and it sends the program back unchanged.
 */

/** One part of the sound the program made (see trackThing in the sandbox runner) */
export interface SetupThing {
  /** 'oscillator', 'buffer source', 'audio element', 'Tone.Loop', 'Tone.Synth' */
  kind: string;
  system: 'web' | 'tone' | 'media';
  /** A source or instrument makes sound; a scheduler (a loop, a part) starts others; the rest shapes it */
  role: 'source' | 'scheduler' | 'node';
  /** Has a start() or play() that sets it going */
  starts: boolean;
  started: boolean;
  /** Whether what it makes can reach the program's output (true when it was connected to something not tracked) */
  connected: boolean;
}

export interface SoundSetup {
  things: SetupThing[];
  /** Tone.Transport, when the page has Tone: whether start() was called, and how many events were scheduled on it */
  tone: { transport: string | null; transportStarted: boolean; scheduled: number } | null;
  /** Warnings and errors Chatty's libraries (Tone.js, three.js) printed or threw for this program */
  library: string[];
}

/** What a program that never started its Transport is told to do (and what a repair looks for) */
const TRANSPORT_STEP = 'but Tone.Transport never was: call Tone.Transport.start()';

const list = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);
const unique = (names: string[]) => [...new Set(names)];
/** 'oscillator' → 'The oscillator'; 'Tone.Player' stays as it is */
const named = (kind: string) => (kind.startsWith('Tone.') ? kind : `the ${kind}`);
const capital = (text: string) => text[0].toUpperCase() + text.slice(1);

/**
 * The steps this program didn't take, each as a sentence naming the object and the call, in the
 * order they matter: Tone.Transport, parts never started, sources that never reach the output.
 */
export function missingSteps(setup: SoundSetup): string[] {
  const steps: string[] = [];
  const { things, tone } = setup;
  if (tone && tone.scheduled > 0 && !tone.transportStarted && tone.transport !== 'started') {
    const starters = unique(things.filter((t) => t.system === 'tone' && t.role === 'scheduler' && t.started).map((t) => t.kind));
    steps.push(starters.length ? `${list(starters)} ${starters.length > 1 ? 'were' : 'was'} started, ${TRANSPORT_STEP}.` : `Something was scheduled on Tone.Transport, ${TRANSPORT_STEP}.`);
  }
  const unstarted = unique(things.filter((t) => t.starts && !t.started && t.system !== 'media' && t.role !== 'node').map((t) => t.kind));
  if (unstarted.length) {
    steps.push(`${capital(list(unstarted.map(named)))} ${unstarted.length > 1 ? 'were' : 'was'} made but never started: call ${unstarted.length > 1 ? 'start() on each' : 'its start()'}.`);
  }
  const unplayed = unique(things.filter((t) => t.system === 'media' && !t.started).map((t) => t.kind));
  if (unplayed.length) {
    steps.push(`${capital(list(unplayed.map(named)))} ${unplayed.length > 1 ? 'were' : 'was'} made but never played: call ${unplayed.length > 1 ? 'play() on each' : 'its play()'}.`);
  }
  const web = unique(things.filter((t) => t.system === 'web' && t.role === 'source' && !t.connected).map((t) => t.kind));
  if (web.length) {
    steps.push(`${capital(list(web.map(named)))} ${web.length > 1 ? 'were' : 'was'} never connected to the audio context's destination: connect ${web.length > 1 ? 'each' : 'it'} with node.connect(audioContext.destination), directly or through other nodes.`);
  }
  const tones = unique(things.filter((t) => t.system === 'tone' && t.role === 'source' && !t.connected).map((t) => t.kind));
  if (tones.length) {
    steps.push(`${list(tones)} ${tones.length > 1 ? 'were' : 'was'} never connected to the output: call .toDestination() on ${tones.length > 1 ? 'each' : 'it'} (or connect it to Tone.Destination, directly or through other nodes).`);
  }
  return steps;
}

/**
 * The error for a program whose sound never came: the steps it didn't take, or null when the
 * page reports none (the generic explanation then stands).
 */
export function missingStepsError(setup: SoundSetup | null | undefined): string | null {
  if (!setup) return null;
  const steps = missingSteps(setup);
  return steps.length ? steps.join(' ') : null;
}

/** Whether an error says only that Tone.Transport was never started (the one step a repair can take) */
export function onlyTransportMissing(error: string): boolean {
  return /^(?:Something was scheduled on Tone\.Transport|(?:Tone\.\w+(?:, Tone\.\w+)* and )?Tone\.\w+ (?:was|were) started), but Tone\.Transport never was: call Tone\.Transport\.start\(\)\.$/.test(error.trim());
}

/** The program with Tone.Transport.start() at its end, or null when it already names a start of the Transport, or doesn't parse that way */
export function withTransportStart(code: string, parses: (code: string) => boolean): string | null {
  if (!/\bTone\b/.test(code) || /\bTransport\s*\.\s*start\s*\(|getTransport\s*\(\s*\)\s*\.\s*start\s*\(/.test(code)) return null;
  const started = `${code.replace(/\s+$/, '')}\nTone.Transport.start();`;
  return parses(started) ? started : null;
}

/**
 * The steps of an error made only of Tone steps (missingSteps' own sentences): whether Tone.Transport
 * was never started, which Tone instruments were never connected to the output, and which Tone
 * objects were never started. Null when the error says anything else (a Web Audio node, an audio
 * element, or words of the model's own), or nothing at all.
 */
export function toneStepsOnly(error: string): { transport: boolean; unconnected: string[]; unstarted: string[] } | null {
  const kinds = (list: string) => list.match(/Tone\.\w+/g) ?? [];
  let rest = error.trim();
  let transport = false;
  const unconnected: string[] = [];
  const unstarted: string[] = [];
  const take = (pattern: RegExp, use: (match: RegExpMatchArray) => void) => {
    rest = rest.replace(pattern, (...args) => {
      use(args as unknown as RegExpMatchArray);
      return '';
    });
  };
  take(/(?:Something was scheduled on Tone\.Transport|(?:Tone\.\w+(?:, Tone\.\w+)* and )?Tone\.\w+ (?:was|were) started), but Tone\.Transport never was: call Tone\.Transport\.start\(\)\.\s*/, () => {
    transport = true;
  });
  take(/((?:Tone\.\w+(?:, Tone\.\w+)* and )?Tone\.\w+) (?:was|were) made but never started: call (?:its start\(\)|start\(\) on each)\.\s*/, (m) => unstarted.push(...kinds(m[1])));
  take(/((?:Tone\.\w+(?:, Tone\.\w+)* and )?Tone\.\w+) (?:was|were) never connected to the output: call \.toDestination\(\) on (?:it|each) \(or connect it to Tone\.Destination, directly or through other nodes\)\.\s*/, (m) => unconnected.push(...kinds(m[1])));
  if (rest.trim() || (!transport && unconnected.length === 0 && unstarted.length === 0)) return null;
  return { transport, unconnected, unstarted };
}
