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

  send(data: Iterable<number> | ArrayLike<number>, timestamp = 0): void {
    if (!Number.isFinite(timestamp)) throw new TypeError('Invalid MIDI timestamp');
    // Validate the whole batch before sending any of it
    const messages = parseMidiMessages(data);
    if (messages.some((message) => message[0] === 0xf0)) {
      throw new DOMException('System Exclusive is not supported.', 'InvalidAccessError');
    }

    this.runtime.resumeFromCurrentCall();
    this.setConnection('open');

    const now = this.runtime.now();
    const deadline = timestamp <= now ? now : timestamp;
    if (deadline <= now) {
      // Older queued messages first, to keep the order
      this.dispatchDueMessages();
      for (const message of messages) this.dispatchMessage(message);
      this.scheduleNext();
      return;
    }

    for (const message of messages) {
      this.queue.push({ timestamp: deadline, sequence: this.sequence++, message });
    }
    this.queue.sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence);
    this.scheduleNext();
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

function toByteArray(data: Iterable<number> | ArrayLike<number>): number[] {
  if (data != null && typeof (data as Iterable<number>)[Symbol.iterator] === 'function') {
    return Array.from(data as Iterable<number>);
  }
  const arrayLike = data as ArrayLike<number>;
  return Array.from({ length: arrayLike.length }, (_, index) => arrayLike[index]);
}

export function parseMidiMessages(data: Iterable<number> | ArrayLike<number>): number[][] {
  const bytes = toByteArray(data);
  if (bytes.length === 0 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new TypeError('Invalid MIDI data');
  }

  const messages: number[][] = [];
  let index = 0;
  while (index < bytes.length) {
    const status = bytes[index];
    if (status < 0x80) {
      throw new TypeError('Running status and incomplete MIDI messages are not supported.');
    }

    if (status === 0xf0) {
      const end = bytes.indexOf(0xf7, index + 1);
      if (end < 0) throw new TypeError('Unterminated System Exclusive message');
      const message = bytes.slice(index, end + 1);
      if (message.slice(1, -1).some((byte) => byte >= 0x80)) throw new TypeError('Invalid System Exclusive data');
      messages.push(message);
      index = end + 1;
      continue;
    }

    let length: number;
    if (status <= 0xef) {
      const command = status & 0xf0;
      length = command === 0xc0 || command === 0xd0 ? 2 : 3;
    } else {
      switch (status) {
        case 0xf1:
        case 0xf3:
          length = 2;
          break;
        case 0xf2:
          length = 3;
          break;
        case 0xf6:
        case 0xf8:
        case 0xfa:
        case 0xfb:
        case 0xfc:
        case 0xfe:
        case 0xff:
          length = 1;
          break;
        default:
          throw new TypeError('Unsupported or invalid MIDI status');
      }
    }

    const message = bytes.slice(index, index + length);
    if (message.length !== length || message.slice(1).some((byte) => byte >= 0x80)) {
      throw new TypeError('Incomplete or invalid MIDI message');
    }
    messages.push(message);
    index += length;
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
