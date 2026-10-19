import type {
  AppLifecycleState,
  InteractionState,
  MicrophoneState,
  ModelRuntimeState,
  PlaybackState,
  TurnState,
} from '../types/index.ts';

export interface CoordinatedStateSnapshot {
  interaction: InteractionState;
  turn: TurnState;
  activeTurnId: string | null;
  microphone: MicrophoneState;
  playback: PlaybackState;
  models: {
    stt: ModelRuntimeState;
    llm: ModelRuntimeState;
    tts: ModelRuntimeState;
  };
  lifecycle: AppLifecycleState;
  lastError: string | null;
}

const VALID_INTERACTION_TRANSITIONS: Record<InteractionState, InteractionState[]> = {
  idle: ['listening', 'finalizing_input', 'building_context', 'compacting', 'recovering', 'error'],
  listening: ['finalizing_input', 'compacting', 'idle', 'interrupted', 'recovering', 'error'],
  finalizing_input: ['building_context', 'compacting', 'idle', 'interrupted', 'recovering', 'error'],
  building_context: ['generating', 'compacting', 'idle', 'interrupted', 'recovering', 'error'],
  compacting: ['building_context', 'generating', 'idle', 'interrupted', 'recovering', 'error'],
  generating: ['speaking', 'idle', 'interrupted', 'recovering', 'error'],
  speaking: ['idle', 'listening', 'interrupted', 'generating', 'recovering', 'error'],
  interrupted: ['listening', 'finalizing_input', 'building_context', 'compacting', 'idle', 'recovering', 'error'],
  recovering: ['idle', 'error'],
  error: ['recovering', 'idle', 'listening', 'building_context', 'compacting'],
};

export type StateChangeListener = (snapshot: CoordinatedStateSnapshot, prev: CoordinatedStateSnapshot) => void;

export class StateMachineCoordinator {
  private state: CoordinatedStateSnapshot = {
    interaction: 'idle',
    turn: 'idle',
    activeTurnId: null,
    microphone: 'stopped',
    playback: 'stopped',
    models: {
      stt: 'unloaded',
      llm: 'unloaded',
      tts: 'unloaded',
    },
    lifecycle: 'foregrounded',
    lastError: null,
  };

  private listeners = new Set<StateChangeListener>();

  getSnapshot(): CoordinatedStateSnapshot {
    return {
      ...this.state,
      models: { ...this.state.models },
    };
  }

  subscribe(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transitionInteraction(next: InteractionState, turnId?: string | null, errorMsg?: string): boolean {
    const current = this.state.interaction;
    if (current !== next) {
      const allowed = VALID_INTERACTION_TRANSITIONS[current] ?? [];
      if (!allowed.includes(next)) {
        // Allow forced transition to error, interrupted, or idle for safety
        if (next !== 'error' && next !== 'interrupted' && next !== 'idle') {
          return false;
        }
      }
    }

    const prev = this.getSnapshot();
    this.state.interaction = next;
    if (turnId !== undefined) {
      this.state.activeTurnId = turnId;
    }
    if (errorMsg !== undefined) {
      this.state.lastError = errorMsg;
    } else if (next === 'idle' || next === 'listening') {
      this.state.lastError = null;
    }

    // Synchronize turn state
    switch (next) {
      case 'idle':
        if (this.state.turn === 'generating' || this.state.turn === 'processing_input') {
          this.state.turn = 'completed';
        }
        break;
      case 'listening':
      case 'finalizing_input':
      case 'building_context':
        this.state.turn = 'processing_input';
        break;
      case 'generating':
      case 'speaking':
        this.state.turn = 'generating';
        break;
      case 'interrupted':
        this.state.turn = 'canceled';
        this.state.playback = 'interrupted';
        break;
      case 'error':
        this.state.turn = 'failed';
        break;
    }

    this.notify(prev);
    return true;
  }

  setTurnState(turn: TurnState, turnId?: string | null): void {
    const prev = this.getSnapshot();
    this.state.turn = turn;
    if (turnId !== undefined) {
      this.state.activeTurnId = turnId;
    }
    this.notify(prev);
  }

  setMicrophoneState(microphone: MicrophoneState): void {
    if (this.state.microphone === microphone) return;
    const prev = this.getSnapshot();
    this.state.microphone = microphone;
    this.notify(prev);
  }

  setPlaybackState(playback: PlaybackState): void {
    if (this.state.playback === playback) return;
    const prev = this.getSnapshot();
    this.state.playback = playback;
    this.notify(prev);
  }

  setModelState(task: 'stt' | 'llm' | 'tts', runtimeState: ModelRuntimeState): void {
    if (this.state.models[task] === runtimeState) return;
    const prev = this.getSnapshot();
    this.state.models[task] = runtimeState;
    this.notify(prev);
  }

  setLifecycleState(lifecycle: AppLifecycleState): void {
    if (this.state.lifecycle === lifecycle) return;
    const prev = this.getSnapshot();
    this.state.lifecycle = lifecycle;
    this.notify(prev);
  }

  private notify(prev: CoordinatedStateSnapshot): void {
    const current = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(current, prev);
    }
  }
}
