import WebAudioTinySynth from "webaudio-tinysynth";

type MidiAccessOptions = {
  sysex?: boolean;
};

type PortConnection = "open" | "closed" | "pending";

interface TinySynthApi {
  getAudioContext(): AudioContext;
  setTsMode(mode: number): void;
  send(data: number[], timestamp?: number): void;
  reset(): void;
}

interface SoftwareMidiPortLike extends EventTarget {
  readonly id: string;
  readonly manufacturer: string | null;
  readonly name: string;
  readonly type: "output";
  readonly version: string | null;
  readonly state: "connected";
  readonly connection: PortConnection;

  onstatechange:
    | ((event: SoftwareMIDIConnectionEvent) => void)
    | null;

  open(): Promise<SoftwareMIDIOutput>;
  close(): Promise<SoftwareMIDIOutput>;
}

export class SoftwareMIDIConnectionEvent extends Event {
  constructor(public readonly port: SoftwareMidiPortLike) {
    super("statechange");
  }
}

abstract class StateChangeTarget extends EventTarget {
  private handler:
    | ((event: SoftwareMIDIConnectionEvent) => void)
    | null = null;

  get onstatechange() {
    return this.handler;
  }

  set onstatechange(
    handler:
      | ((event: SoftwareMIDIConnectionEvent) => void)
      | null,
  ) {
    if (this.handler) {
      this.removeEventListener(
        "statechange",
        this.handler as EventListener,
      );
    }

    this.handler = handler;

    if (handler) {
      this.addEventListener(
        "statechange",
        handler as EventListener,
      );
    }
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
  context: AudioContext;
  resumeFromCurrentCall(): void;
}

export class SoftwareMIDIOutput
  extends StateChangeTarget
  implements SoftwareMidiPortLike
{
  readonly id = "software-tinysynth";
  readonly manufacturer = "Browser Software";
  readonly name = "WebAudio TinySynth";
  readonly type = "output" as const;
  readonly version = "1.0";
  readonly state = "connected" as const;

  private _connection: PortConnection = "closed";
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
    // Invoke resume immediately, while a calling Play action
    // may still have transient user activation on iOS.
    this.runtime.resumeFromCurrentCall();
    this.setConnection("open");
    return this;
  }

  async close(): Promise<this> {
    this.clear();
    this.setConnection("closed");
    return this;
  }

  send(
    data: Iterable<number> | ArrayLike<number>,
    timestamp = 0,
  ): void {
    if (!Number.isFinite(timestamp)) {
      throw new TypeError("Invalid MIDI timestamp");
    }

    // Validate the complete batch before dispatching any part.
    const messages = parseMidiMessages(data);

    if (messages.some((message) => message[0] === 0xF0)) {
      throw new DOMException(
        "System Exclusive is not supported.",
        "InvalidAccessError",
      );
    }

    this.runtime.resumeFromCurrentCall();
    this.setConnection("open");

    const now = performance.now();
    const deadline = timestamp <= now ? now : timestamp;

    if (deadline <= now) {
      // Flush older queued messages first to preserve ordering.
      this.dispatchDueMessages();

      for (const message of messages) {
        this.dispatchMessage(message);
      }

      this.scheduleNext();
      return;
    }

    for (const message of messages) {
      this.queue.push({
        timestamp: deadline,
        sequence: this.sequence++,
        message,
      });
    }

    this.queue.sort(
      (a, b) =>
        a.timestamp - b.timestamp ||
        a.sequence - b.sequence,
    );

    this.scheduleNext();
  }

  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.queue = [];

    // A cleared future note-off must not leave an already
    // sounding note stuck. Release sustain and silence voices.
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

    const delay = Math.max(
      0,
      next.timestamp - performance.now(),
    );

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.dispatchDueMessages();
      this.scheduleNext();
    }, delay);
  }

  private dispatchDueMessages(): void {
    const now = performance.now();

    while (
      this.queue.length > 0 &&
      this.queue[0].timestamp <= now
    ) {
      const item = this.queue.shift()!;
      this.dispatchMessage(item.message);
    }
  }

  private dispatchMessage(message: number[]): void {
    const status = message[0];

    // Channel voice messages (notes, controllers, program
    // changes, pitch bend, aftertouch).
    if (status >= 0x80 && status <= 0xEF) {
      this.runtime.synth.send(message);
      return;
    }

    // MIDI System Reset.
    if (status === 0xFF) {
      this.stopAllVoices();
      this.runtime.synth.reset();
    }

    // Other system messages don't generate sound in this
    // software-only output.
  }

  private stopAllVoices(): void {
    for (let channel = 0; channel < 16; channel++) {
      // Release sustain first, then stop all voices.
      this.runtime.synth.send([0xB0 | channel, 64, 0]);
      this.runtime.synth.send([0xB0 | channel, 120, 0]);
    }
  }
}

export class SoftwareMIDIAccess extends StateChangeTarget {
  readonly sysexEnabled = false;
  readonly inputs: ReadonlyMap<string, never> = new Map();
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

function toByteArray(
  data: Iterable<number> | ArrayLike<number>,
): number[] {
  if (
    data != null &&
    typeof (data as Iterable<number>)[Symbol.iterator] === "function"
  ) {
    return Array.from(data as Iterable<number>);
  }

  const arrayLike = data as ArrayLike<number>;

  return Array.from(
    { length: arrayLike.length },
    (_, index) => arrayLike[index],
  );
}

function parseMidiMessages(
  data: Iterable<number> | ArrayLike<number>,
): number[][] {
  const bytes = toByteArray(data);

  if (
    bytes.length === 0 ||
    bytes.some(
      (byte) =>
        !Number.isInteger(byte) || byte < 0 || byte > 255,
    )
  ) {
    throw new TypeError("Invalid MIDI data");
  }

  const messages: number[][] = [];
  let index = 0;

  while (index < bytes.length) {
    const status = bytes[index];

    if (status < 0x80) {
      throw new TypeError(
        "Running status and incomplete MIDI messages are not supported.",
      );
    }

    if (status === 0xF0) {
      const end = bytes.indexOf(0xF7, index + 1);

      if (end < 0) {
        throw new TypeError("Unterminated System Exclusive message");
      }

      const message = bytes.slice(index, end + 1);

      if (message.slice(1, -1).some((byte) => byte >= 0x80)) {
        throw new TypeError("Invalid System Exclusive data");
      }

      messages.push(message);
      index = end + 1;
      continue;
    }

    let length: number;

    if (status <= 0xEF) {
      const command = status & 0xF0;
      length =
        command === 0xC0 || command === 0xD0 ? 2 : 3;
    } else {
      switch (status) {
        case 0xF1:
        case 0xF3:
          length = 2;
          break;
        case 0xF2:
          length = 3;
          break;
        case 0xF6:
        case 0xF8:
        case 0xFA:
        case 0xFB:
        case 0xFC:
        case 0xFE:
        case 0xFF:
          length = 1;
          break;
        default:
          throw new TypeError("Unsupported or invalid MIDI status");
      }
    }

    const message = bytes.slice(index, index + length);

    if (
      message.length !== length ||
      message.slice(1).some((byte) => byte >= 0x80)
    ) {
      throw new TypeError("Incomplete or invalid MIDI message");
    }

    messages.push(message);
    index += length;
  }

  return messages;
}

export function installSoftwareMidiPolyfill(
  options: { force?: boolean } = {},
): void {
  if (typeof navigator === "undefined") return;

  type NavigatorWithMidi = Navigator & {
    requestMIDIAccess?: (
      options?: MidiAccessOptions,
    ) => Promise<SoftwareMIDIAccess>;
  };

  const nav = navigator as NavigatorWithMidi;

  // Preserve native Web MIDI by default when it exists.
  if (nav.requestMIDIAccess && !options.force) return;

  let access: SoftwareMIDIAccess | undefined;

  const requestMIDIAccess = async (
    accessOptions: MidiAccessOptions = {},
  ): Promise<SoftwareMIDIAccess> => {
    if (accessOptions.sysex) {
      throw new DOMException(
        "System Exclusive is not supported by this software output.",
        "NotSupportedError",
      );
    }

    if (!access) {
      const synth = new WebAudioTinySynth({
        quality: 1,
        useReverb: 0,
        voices: 32,
      }) as unknown as TinySynthApi;

      // The adapter handles the Web MIDI performance-clock
      // queue itself and sends messages to TinySynth when due.
      synth.setTsMode(0);

      const context = synth.getAudioContext();

      const runtime: SynthRuntime = {
        synth,
        context,
        resumeFromCurrentCall() {
          if (context.state === "running") return;

          try {
            // Call directly, not from a later timer callback.
            void context.resume().catch(() => {});
          } catch {
            // A closed context cannot be resumed.
          }
        },
      };

      access = new SoftwareMIDIAccess(
        new SoftwareMIDIOutput(runtime),
      );
    }

    return access;
  };

  Object.defineProperty(nav, "requestMIDIAccess", {
    value: requestMIDIAccess,
    configurable: true,
    writable: true,
  });
}


/* example */

installSoftwareMidiPolyfill();

const access = await navigator.requestMIDIAccess();
const output = access.outputs.get("software-tinysynth");

if (!output) {
  throw new Error("Software MIDI output unavailable");
}

await output.open();

// C major chord
const now = performance.now();

output.send([0x90, 60, 100], now);
output.send([0x90, 64, 100], now);
output.send([0x90, 67, 100], now);

// Release it 500 ms later
output.send([0x80, 60, 0], now + 500);
output.send([0x80, 64, 0], now + 500);
output.send([0x80, 67, 0], now + 500);

// Cancel future messages and silence any active voices.
output.clear();