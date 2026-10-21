import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ConversationMemoryStore } from '../src/core/memory-store.ts';
import { ConversationOrchestrator, changedLines, normalizedError, promptRules } from '../src/core/orchestrator.ts';
import { StateMachineCoordinator } from '../src/core/state-machine.ts';
import { pastProgramResult } from '../src/core/history-format.ts';
import type { ConversationMessage } from '../src/types/index.ts';

const outcome = (request: string, runtime: object) =>
  (ConversationOrchestrator.prototype as any).missingOutcome.call({ javascriptRuntime: runtime }, request, { uses: 0, heard: 0, silent: 0 }) as Promise<string | null>;
const nothing = { soundUseCount: () => 0, hasVisualContent: () => false };
const sees = { soundUseCount: () => 0, hasVisualContent: () => true };

describe('the outcome check', () => {
  it('counts sound only when it reaches the speakers, and says how to connect it when it never does', async () => {
    const asked = { soundUseCount: () => 1, hasVisualContent: () => false };
    expect(await outcome('Play a G major chord', { ...asked, soundHeardCount: () => 1, soundSilentCount: () => 0 })).toBeNull();
    expect(await outcome('Play a G major chord', { ...asked, soundHeardCount: () => 0, soundSilentCount: () => 1 })).toContain('never reached the speakers');
    // Not measured (audio paused until a tap): the request counts
    expect(await outcome('Play a G major chord', asked)).toBeNull();
  });

  it.each(['Show me the capital of France', 'List the planets', 'Write it in the form of a poem', 'Who was Ada Lovelace?'])(
    'does not fire for the spoken answer to "%s"',
    async (request) => {
      expect(await outcome(request, nothing)).toBeNull();
    }
  );

  it.each(['who won the game', 'why is the sky blue', 'speed of sound', 'nearest star', 'square root of 144', 'who invented the piano'])(
    'does not fire for a question that names something to see or hear: "%s"',
    async (request) => {
      expect(await outcome(request, nothing)).toBeNull();
    }
  );

  it('still fires for a request asked politely, or one with numbers in it', async () => {
    expect(await outcome('Can you draw a cat?', nothing)).toContain('showed nothing');
    expect(await outcome('Draw a 3x3 grid', nothing)).toContain('showed nothing');
  });

  it('takes "a minor" for music only in a musical phrase', () => {
    expect(promptRules('Can I sell alcohol to a minor', true)).not.toContain('Sound:');
    expect(promptRules('Build a blues loop in G minor', true)).toContain('Sound:');
    expect(promptRules('Play an A minor chord', true)).toContain('Sound:');
  });

  it('still fires for something that must appear', async () => {
    expect(await outcome('Make a timer', nothing)).toContain('showed nothing');
    expect(await outcome('Make a timer', sees)).toBeNull();
  });

  it('does not take organize, playlist or a notes app for sound', async () => {
    for (const request of ['Organize my day', 'Make a playlist page', 'Build a notes app']) {
      expect(promptRules(request, true)).not.toContain('Sound:');
    }
    expect(promptRules('Play a piano chord', true)).toContain('Sound:');
  });

  it('keeps the visual check when the request names sound and something visual', async () => {
    const message = await outcome('Make a piano app that plays a chord', { soundUseCount: () => 1, hasVisualContent: () => false });
    expect(message).toContain('showed nothing');
    expect(message).not.toContain('played nothing');
  });

  it('does not ask for sound from a bare play next to something visual', async () => {
    expect(await outcome('Play a game of snake', sees)).toBeNull();
  });
});

describe('prompt rules', () => {
  it('teaches real browser interfaces: fetch for facts, Web MIDI for music', () => {
    expect(promptRules('Who was Ada Lovelace?', true)).toContain('https://en.wikipedia.org/api/rest_v1/page/summary/');
    expect(promptRules('Play a drum beat', true)).toContain('navigator.requestMIDIAccess()');
    expect(promptRules('Play a drum beat', true)).not.toMatch(/out\.send|out\.loop/);
  });
});

describe('fix bookkeeping', () => {
  it('keys errors without their numbers', () => {
    expect(normalizedError('x is not defined at line 12')).toBe(normalizedError('x is not defined at line 7'));
    expect(normalizedError('x is not defined')).not.toBe(normalizedError('y is not defined'));
  });

  it('remembers what a reply changed, not its first line', () => {
    expect(changedLines('function draw() {\n  boom();\n}', 'function draw() {\n  bang();\n}')).toBe('bang();');
    expect(changedLines('a();\nb();', 'a();\nb();')).toBe('');
  });
});

describe('history of a fixed program', () => {
  it('says the version that ran without an error, not that the broken one failed', () => {
    const broken: ConversationMessage = {
      id: 'a', turnId: 't1', role: 'assistant', canonicalContent: 'Done.', rawCode: 'boom();\nspeak("Done.");',
      toolCall: { name: 'execute_javascript', arguments: {}, error: 'boom is not defined' },
    } as ConversationMessage;
    expect(pastProgramResult(broken)).toContain('it failed');
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator: new StateMachineCoordinator(),
      llmProvider: { id: 'q', modelId: 'q', contextLimit: 8192, maxOutputTokens: 512 } as any,
    });
    (orchestrator as any).correctedPrograms.set('t1', 'bang();\nspeak("Done.");');
    const { promptMessages } = (orchestrator as any).buildModelPrompt(
      'hello',
      { workingMessages: [{ id: 'u', turnId: 't1', role: 'user', canonicalContent: 'Do it' }, broken], conversationSummary: null, relevantMemories: [], resolvedReferencesNote: null, estimatedTokens: 0 },
      null,
      false
    );
    const reply = promptMessages.find((m: any) => m.role === 'assistant' && m.content.includes('Your program'));
    expect(reply.content).toContain('ran without an error');
    expect(reply.content).not.toContain('failed');
  });
});

describe('the context budget', () => {
  it('counts code at about three characters a token', () => {
    const store = new ConversationMemoryStore();
    const code = 'function f(a) { return a[0] + (a[1] * 2); }\n'.repeat(10);
    expect(store.estimateTokens(code)).toBe(Math.ceil(code.length / 3));
    expect(store.estimateTokens('Just some words in a sentence.')).toBe(Math.ceil(30 / 4));
  });

  it('drops older history, down to none, for a program shown in full', () => {
    const store = new ConversationMemoryStore();
    for (let i = 0; i < 4; i++) {
      store.addMessage({ id: `u${i}`, turnId: `t${i}`, role: 'user', canonicalContent: `request number ${i} with some words`, timestamp: i } as ConversationMessage);
      store.addMessage({ id: `a${i}`, turnId: `t${i}`, role: 'assistant', canonicalContent: `reply ${i}`, timestamp: i } as ConversationMessage);
    }
    const roomy = store.resolveContextForQuery('make it bigger', 2000, 0);
    expect(roomy.workingMessages.length).toBe(8);
    const tight = store.resolveContextForQuery('make it bigger', 2000, 5000);
    expect(tight.workingMessages.length).toBe(0);
  });
});
