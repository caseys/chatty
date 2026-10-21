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
  /** An instrument: how many notes the program played on it (calls of triggerAttack and triggerAttackRelease) */
  notes?: number;
  /** Of those notes, how many were given a time already in the past on Tone's clock (a literal 0) */
  past?: number;
  /** A loop, part or sequence: whether it has a callback (given when it was made, or set after) */
  hasCallback?: boolean;
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
/** The same, for a program whose loops and parts were made and nothing was scheduled (or started) yet */
const TRANSPORT_ALONE = 'Tone.Transport was never started: call Tone.Transport.start().';
const NO_NOTE = 'No note was ever played: nothing called triggerAttackRelease() (or triggerAttack()) on an instrument.';
const PAST_NOTES = "Every note was scheduled in the past: the time in triggerAttackRelease(note, duration, time) is seconds on Tone's clock (Tone.now() is the present, so 0 is long gone): leave it out, or pass Tone.now() plus an offset.";

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
  const schedulers = things.filter((t) => t.system === 'tone' && t.role === 'scheduler');
  const transportRuns = !!tone && (tone.transportStarted || tone.transport === 'started');
  if (tone && tone.scheduled > 0 && !transportRuns) {
    const starters = unique(things.filter((t) => t.system === 'tone' && t.role === 'scheduler' && t.started).map((t) => t.kind));
    steps.push(starters.length ? `${list(starters)} ${starters.length > 1 ? 'were' : 'was'} started, ${TRANSPORT_STEP}.` : `Something was scheduled on Tone.Transport, ${TRANSPORT_STEP}.`);
  } else if (tone && schedulers.length > 0 && !transportRuns) {
    // Loops or parts made, and nothing on the Transport: it is what runs them
    steps.push(TRANSPORT_ALONE);
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
  // What the program made and never gave anything to play: loops without a callback, instruments no note was played on
  // (a loop with a callback may still play them: its notes come when the Transport runs)
  const empty = unique(schedulers.filter((t) => t.hasCallback === false).map((t) => t.kind));
  if (empty.length) {
    steps.push(`${list(empty)} ${empty.length > 1 ? 'have' : 'has'} no callback, so ${empty.length > 1 ? 'they have' : 'it has'} nothing to play: give it one, such as new Tone.Loop((time) => { … synth.triggerAttackRelease(note, duration, time) … }, "4n").`);
  }
  const instruments = things.filter((t) => t.system === 'tone' && typeof t.notes === 'number');
  const loopsPlay = schedulers.some((t) => t.hasCallback !== false);
  if (instruments.length > 0 && instruments.every((t) => t.notes === 0) && !loopsPlay) steps.push(NO_NOTE);
  // Notes were played, every one at a time that had already gone by
  const played = instruments.reduce((sum, t) => sum + (t.notes ?? 0), 0);
  const past = instruments.reduce((sum, t) => sum + (t.past ?? 0), 0);
  if (played > 0 && past >= played) steps.push(PAST_NOTES);
  return steps;
}

/** What the program made, as a count by kind: "5 instruments (Tone.PolySynth ×3, Tone.PluckSynth, Tone.MetalSynth) and 1 Tone.Loop" */
function madeSummary(things: SetupThing[]): string {
  const count = (items: SetupThing[]) => {
    const kinds = new Map<string, number>();
    for (const item of items) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
    return [...kinds].map(([kind, n]) => (n > 1 ? `${kind} ×${n}` : kind)).join(', ');
  };
  const parts: string[] = [];
  const instruments = things.filter((t) => t.system === 'tone' && typeof t.notes === 'number');
  const others = things.filter((t) => t.role === 'source' && !instruments.includes(t) && t.system !== 'media');
  const schedulers = things.filter((t) => t.role === 'scheduler');
  if (instruments.length) parts.push(`${instruments.length} instrument${instruments.length > 1 ? 's' : ''} (${count(instruments)})`);
  if (others.length) parts.push(`${others.length} ${others.length > 1 ? 'sources' : 'source'} (${count(others)})`);
  if (schedulers.length) parts.push(schedulers.length === 1 ? `1 ${schedulers[0].kind}` : `${schedulers.length} loops, parts or sequences (${count(schedulers)})`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '');
}

/**
 * The error for a program whose sound never came: the steps it didn't take, or null when the
 * page reports none (the generic explanation then stands).
 */
export function missingStepsError(setup: SoundSetup | null | undefined): string | null {
  if (!setup) return null;
  const steps = missingSteps(setup);
  if (steps.length === 0) return null;
  // What was made goes first when several things are missing, or what is missing is that nothing plays
  // (a loop with no callback, no note): a single plain step (the Transport never started) reads best alone
  const made = steps.length > 1 || steps.some((step) => step === NO_NOTE || step === PAST_NOTES || /no callback/.test(step)) ? madeSummary(setup.things) : '';
  return `${made ? `The program made ${made}, but nothing is heard. ` : ''}${steps.join(' ')}`;
}

/**
 * What the next try is told when the last fix left the same things missing: its changes (the
 * declarations moved about) touched none of them. One sentence for the first thing missing.
 */
export function sameShortfallNote(error: string): string | null {
  const text = error.replace(/^The program made .*?, but nothing is heard\.\s*/, '');
  if (text.includes(PAST_NOTES)) return 'The last fix still gave the notes a time in the past: leave the time out, or pass Tone.now() plus an offset.';
  if (text.includes(NO_NOTE)) return 'The last fix still made no notes: add the triggerAttackRelease calls, inside the callback of a Tone.Loop when they repeat.';
  if (/have? no callback/.test(text)) return 'The last fix still left a loop with no callback: give it one that plays notes.';
  if (/never connected to the output/.test(text)) return 'The last fix still left the instruments unconnected: call .toDestination() on each.';
  if (/never started: call/.test(text) || /Tone\.Transport (?:was )?never/.test(text)) return 'The last fix still did not start what plays: start the loop with start(0), and Tone.Transport with Tone.Transport.start().';
  return null;
}

/** Whether an error says only that Tone.Transport was never started (the one step a repair can take) */
export function onlyTransportMissing(error: string): boolean {
  const text = error.trim().replace(/^The program made .*?, but nothing is heard\.\s*/, '');
  return /^(?:Something was scheduled on Tone\.Transport|(?:Tone\.\w+(?:, Tone\.\w+)* and )?Tone\.\w+ (?:was|were) started), but Tone\.Transport never was: call Tone\.Transport\.start\(\)\.$|^Tone\.Transport was never started: call Tone\.Transport\.start\(\)\.$/.test(text);
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
  let rest = error.trim().replace(/^The program made .*?, but nothing is heard\.\s*/, '');
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
  take(/Tone\.Transport was never started: call Tone\.Transport\.start\(\)\.\s*/, () => {
    transport = true;
  });
  take(/((?:Tone\.\w+(?:, Tone\.\w+)* and )?Tone\.\w+) (?:was|were) made but never started: call (?:its start\(\)|start\(\) on each)\.\s*/, (m) => unstarted.push(...kinds(m[1])));
  take(/((?:Tone\.\w+(?:, Tone\.\w+)* and )?Tone\.\w+) (?:was|were) never connected to the output: call \.toDestination\(\) on (?:it|each) \(or connect it to Tone\.Destination, directly or through other nodes\)\.\s*/, (m) => unconnected.push(...kinds(m[1])));
  if (rest.trim() || (!transport && unconnected.length === 0 && unstarted.length === 0)) return null;
  return { transport, unconnected, unstarted };
}
