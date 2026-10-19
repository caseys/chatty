import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  detectActionIntent,
  isFollowUpEdit,
  parseDurationSeconds,
  PHONE_CHAT_SYSTEM_PROMPT,
  PhoneModelSet,
  TurnRouter,
} from '../src/core/phone-pipeline.ts';
import { ConversationOrchestrator, programDraws } from '../src/core/orchestrator.ts';
import { StateMachineCoordinator } from '../src/core/state-machine.ts';
import type { PickedCall } from '../src/runtimes/needle-router.ts';
import type { LlmGenerationOptions, LlmGenerationResult, LlmRuntimeProvider } from '../src/types/index.ts';

/** Stand-in for the Needle tool picker: returns a canned pick (null = no tool). */
function fakeRouterModel(pick: PickedCall | null) {
  return { pick: async () => pick };
}
const shouldNotRun = { pick: async (): Promise<PickedCall | null> => { throw new Error('should not run'); } };

class RecordingLlm implements LlmRuntimeProvider {
  readonly id = 'recording';
  readonly contextLimit = 4096;
  readonly maxOutputTokens = 256;
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = false;
  calls: LlmGenerationOptions[] = [];
  constructor(readonly modelId: string, private readonly reply: string) {}
  async initialize(): Promise<void> {}
  async generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    this.calls.push(options);
    options.onToken?.(this.reply, 0);
    return { turnId: options.turnId, text: this.reply, aborted: false, timeToFirstTokenMs: 1, totalTimeMs: 1, tokensGenerated: 1, tokensPerSecond: 1 };
  }
  cancel(): void {}
  async reset(): Promise<void> {}
  async dispose(): Promise<void> {}
}

describe('duration parsing', () => {
  it('reads durations from the user’s words', () => {
    expect(parseDurationSeconds('set a timer for 2 minutes')).toBe(120);
    expect(parseDurationSeconds('remind me in an hour and 30 seconds')).toBe(3630);
    expect(parseDurationSeconds('ninety seconds please')).toBe(90);
    expect(parseDurationSeconds('wake me in half an hour')).toBe(1800);
    expect(parseDurationSeconds('how are you')).toBeNull();
  });
});

describe('action intent gate', () => {
  it('sends conversation straight to chat', () => {
    for (const q of ['How are you today?', 'Tell me a joke', 'I feel sad today', 'Why is the sky blue?', 'What should I cook tonight?']) {
      expect(detectActionIntent(q), q).toBeNull();
    }
  });
  it('detects timers, code and lookups', () => {
    expect(detectActionIntent('Set a timer for 5 minutes')).toBe('timer');
    expect(detectActionIntent('Draw a cat')).toBe('code');
    expect(detectActionIntent('Play twinkle twinkle little star')).toBe('code');
    expect(detectActionIntent('Make a snake game')).toBe('code');
    expect(detectActionIntent('Who was Ada Lovelace?')).toBe('lookup');
    expect(detectActionIntent('What is the capital of Peru')).toBe('lookup');
    expect(detectActionIntent('How many cups in a gallon')).toBe('lookup');
  });
});

describe('screen clearing', () => {
  it('only programs that draw wipe the screen', () => {
    expect(programDraws('speak("Hello there!");')).toBe(false);
    expect(programDraws('await playNotes("C4 E4 G4", 200); speak("Done");')).toBe(false);
    expect(programDraws('const c = document.createElement("canvas"); root.appendChild(c);')).toBe(true);
    expect(programDraws('root.innerHTML = "<h1>Hi</h1>";')).toBe(true);
  });
});

describe('follow-ups', () => {
  it('recognizes edits to what was just made', () => {
    for (const q of ['make it bigger', 'add a sun', 'change the color to blue', 'now make them faster', 'do it again but red instead']) {
      expect(isFollowUpEdit(q), q).toBe(true);
    }
  });
  it('does not treat questions or new topics as edits', () => {
    for (const q of ['tell me more about it', 'why is it red?', 'how are you', 'thanks, that is great']) {
      expect(isFollowUpEdit(q), q).toBe(false);
    }
  });
  it('continues the previous action', async () => {
    const router = new TurnRouter(shouldNotRun);
    const lastCode = { kind: 'code' as const, task: 'draw a red circle', code: 'speak("ok")' };
    expect(await router.route('make it bigger', undefined, lastCode)).toEqual({ kind: 'code', task: 'make it bigger', edit: true });
    const lastLookup = { kind: 'tool' as const, name: 'search_wikipedia', args: { query: 'Lima' } };
    expect(await router.route('what about Paris?', undefined, lastLookup)).toEqual({
      kind: 'tool',
      name: 'search_wikipedia',
      args: { query: 'Paris' },
    });
  });
});

describe('TurnRouter validation', () => {
  it('trusts the spoken duration over the model’s arithmetic', async () => {
    const router = new TurnRouter(fakeRouterModel({ name: 'set_timer', args: { message: 'Oven', seconds: 600 } }));
    expect(await router.route('Set a timer for 2 minutes to check the oven')).toEqual({
      kind: 'tool',
      name: 'set_timer',
      args: { seconds: 120, message: 'Oven' },
    });
  });

  it('uses the user’s words when the coder task echoes the tool description', async () => {
    const router = new TurnRouter(
      fakeRouterModel({ name: 'coder_agent', args: { task: 'write and run JavaScript for drawings, games, animations' } })
    );
    expect(await router.route('make a snake game')).toEqual({ kind: 'code', task: 'make a snake game' });
  });

  it('keeps the intent and uses the user’s words when the router misfires', async () => {
    expect(await new TurnRouter(fakeRouterModel(null)).route('Who was Ada Lovelace?')).toEqual({
      kind: 'tool',
      name: 'web_search',
      args: { query: 'Ada Lovelace' },
    });
    // Argument not taken from the request
    expect(await new TurnRouter(fakeRouterModel({ name: 'coder_agent', args: { task: 'play a happy tune' } })).route('play twinkle twinkle little star')).toEqual({
      kind: 'code',
      task: 'play twinkle twinkle little star',
    });
  });

  it('never calls the router model for plain chat', async () => {
    const router = new TurnRouter(shouldNotRun);
    expect(await router.route('how are you')).toEqual({ kind: 'chat' });
  });
});

describe('Orchestrator phone pipeline', () => {
  const makeOrchestrator = (routerPick: PickedCall | null) => {
    const chat = new RecordingLlm('chat', 'Doing great, thanks for asking!');
    const coder = new RecordingLlm('coder', 'speak("Here is your drawing.");');
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator: new StateMachineCoordinator(),
      llmProvider: new RecordingLlm('unused', 'unused'),
      enableSpeechOutput: false,
      // Auto-titling also calls the chat model; keep these assertions about the turn itself
      getConversationId: () => 'c1',
      shouldAutoTitle: () => false,
    });
    orchestrator.configurePhonePipeline({
      chat,
      coder,
      router: new TurnRouter(fakeRouterModel(routerPick)),
      chatSystemPrompt: PHONE_CHAT_SYSTEM_PROMPT,
    });
    return { orchestrator, chat, coder };
  };

  it('chat turns use the prose prompt on the chat model', async () => {
    const { orchestrator, chat, coder } = makeOrchestrator(null);
    const msg = await orchestrator.submitUserInput('how are you?');
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0].systemPrompt).toContain('plain text');
    expect(coder.calls).toHaveLength(0);
    expect(msg?.canonicalContent).toContain('Doing great');
  });

  it('timer turns answer without any model generation', async () => {
    const { orchestrator, chat, coder } = makeOrchestrator({ name: 'set_timer', args: { seconds: 600 } });
    const msg = await orchestrator.submitUserInput('set a timer for 2 minutes');
    expect(chat.calls).toHaveLength(0);
    expect(coder.calls).toHaveLength(0);
    expect(msg?.canonicalContent).toBe('Okay, timer set for 2 minutes.');
    expect(msg?.toolCall).toEqual({
      name: 'set_timer',
      arguments: { seconds: 120, message: '' },
      result: 'Okay, timer set for 2 minutes.',
      status: 'completed',
    });
  });

  it('coder_agent turns send the task to the coder model', async () => {
    const { orchestrator, chat, coder } = makeOrchestrator({ name: 'coder_agent', args: { task: 'draw a red circle' } });
    const msg = await orchestrator.submitUserInput('draw a red circle');
    expect(chat.calls).toHaveLength(0);
    expect(coder.calls).toHaveLength(1);
    expect(coder.calls[0].messages).toEqual([{ role: 'user', content: 'draw a red circle' }]);
    // Once the generated code runs, the message shows the executed program
    expect(msg?.toolCall?.name).toBe('javascript_runtime');
  });

  it('gives the coder the previous program when editing it', async () => {
    const chat = new RecordingLlm('chat', 'ok');
    const coder = new RecordingLlm('coder', 'root.innerHTML = "<b>circle</b>"; speak("Done.");');
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator: new StateMachineCoordinator(),
      llmProvider: new RecordingLlm('unused', 'unused'),
      enableSpeechOutput: false,
      getConversationId: () => 'c1',
      shouldAutoTitle: () => false,
    });
    orchestrator.configurePhonePipeline({
      chat,
      coder,
      router: new TurnRouter(fakeRouterModel({ name: 'coder_agent', args: { task: 'draw a red circle' } })),
      chatSystemPrompt: PHONE_CHAT_SYSTEM_PROMPT,
    });
    await orchestrator.submitUserInput('draw a red circle');
    await orchestrator.submitUserInput('make it bigger');
    expect(coder.calls).toHaveLength(2);
    expect(coder.calls[1].messages).toEqual([
      { role: 'user', content: 'draw a red circle' },
      { role: 'assistant', content: 'root.innerHTML = "<b>circle</b>"; speak("Done.");' },
      { role: 'user', content: 'make it bigger' },
    ]);
  });
});

describe('PhoneModelSet', () => {
  it('keeps Needle loaded and never holds chat and coder at once', async () => {
    const set = new PhoneModelSet();
    const loaded = new Set<string>();
    const order: string[] = [];
    let gpuPeak = 0;
    for (const key of ['needle', 'chat', 'coder'] as const) {
      const model = set[key] as unknown as { isLoaded: boolean; initialize: () => Promise<void>; dispose: () => Promise<void> };
      let isLoaded = false;
      Object.defineProperty(model, 'isLoaded', { get: () => isLoaded });
      model.initialize = async () => {
        isLoaded = true;
        loaded.add(key);
        order.push(key);
        gpuPeak = Math.max(gpuPeak, ['chat', 'coder'].filter((k) => loaded.has(k)).length);
      };
      model.dispose = async () => { isLoaded = false; loaded.delete(key); };
    }
    await set.activate('chat');
    expect(order).toEqual(['needle', 'chat']);
    await set.activate('coder');
    expect([...loaded].sort()).toEqual(['coder', 'needle']);
    await set.activate('chat');
    expect([...loaded].sort()).toEqual(['chat', 'needle']);
    expect(gpuPeak).toBe(1);
  });
});
