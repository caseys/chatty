/// <reference types="vite/client" />

/** The commit this build was made from (vite.config.ts) */
declare const __APP_VERSION__: string;

/** General MIDI synth on Web Audio (CommonJS, no types); see audio/software-midi.ts */
declare module 'webaudio-tinysynth' {
  const WebAudioTinySynth: new (options?: { quality?: number; useReverb?: number; voices?: number }) => unknown;
  export default WebAudioTinySynth;
}
