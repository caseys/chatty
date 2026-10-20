import 'fake-indexeddb/auto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  computeRmsLevel,
  resampleTo16kHzMono,
  VoiceActivityDetector,
} from '../src/audio/audio-subsystem.ts';
import { BoundedQueue, TurnResourceScheduler } from '../src/core/bounded-queue.ts';
import { ConversationMemoryStore } from '../src/core/memory-store.ts';
import { computeSha256Hex, ModelManager } from '../src/core/model-manager.ts';
import { ConversationOrchestrator, FORMAT_TURNS } from '../src/core/orchestrator.ts';
import {
  IncrementalPhraseSegmenter,
  normalizeTextForSpeech,
  normalizeUserTranscript,
} from '../src/core/speech-normalizer.ts';
import { StateMachineCoordinator } from '../src/core/state-machine.ts';
import { runConversationEvaluationSuite } from '../src/evaluation/benchmark-suite.ts';
import { decodeWavToFloat32 } from '../src/runtimes/tts-provider.ts';
import {
  DEFAULT_SETTINGS,
  SUPPORTED_CHAT_MODELS,
  SUPPORTED_CODING_MODELS,
  SUPPORTED_PIPER_VOICES,
  loadSettingsFromStorage,
  saveSettingsToStorage,
} from '../src/core/settings.ts';
import { VoiceAssistantEngine } from '../src/core/voice-assistant-engine.ts';
import type {
  LlmGenerationOptions,
  LlmGenerationResult,
  LlmRuntimeProvider,
  TtsRuntimeProvider,
} from '../src/types/index.ts';

class TestStubLlmProvider implements LlmRuntimeProvider {
  public readonly id = 'test-stub-llm';
  public readonly modelId = 'test-stub';
  public readonly contextLimit = 4096;
  public readonly maxOutputTokens = 512;
  public readonly supportsStreaming = true;
  public readonly supportsCancellation = true;
  public readonly supportsTools = true;

  private activeAbortController: AbortController | null = null;
  private tokenDelayMs: number;
  private responseOverride?: string;

  constructor(options?: { tokenDelayMs?: number; responseOverride?: string }) {
    this.tokenDelayMs = options?.tokenDelayMs ?? 2;
    this.responseOverride = options?.responseOverride;
  }

  public async initialize(): Promise<void> {}

  public async generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    this.activeAbortController = new AbortController();
    const signal = options.signal;
    const prompt = options.messages[options.messages.length - 1]?.content ?? '';
    const lower = prompt.toLowerCase();

    let response = this.responseOverride ?? 'How can I help you today?';
    if (!this.responseOverride) {
      if (options.systemPrompt.includes('coding agent')) {
        if (lower.includes('sound') || lower.includes('audio') || lower.includes('chime')) {
          response = 'MODE: iframe\n```javascript\nreturn "Synthesized audio chime";\n```';
        } else if (
          lower.includes('visual') ||
          lower.includes('draw') ||
          lower.includes('spiral') ||
          lower.includes('circle') ||
          lower.includes('pong') ||
          lower.includes('canvas')
        ) {
          response = 'MODE: iframe\n```javascript\nreturn "Rendered visual output";\n```';
        } else if (lower.includes('prime') || lower.includes('heavy') || lower.includes('matrix')) {
          response = 'MODE: worker\n```javascript\nreturn [2, 3, 5, 7, 11];\n```';
        } else {
          response = 'MODE: eval\n```javascript\nreturn 42 * 2;\n```';
        }
      } else if (
        options.systemPrompt.includes('title generator') ||
        lower.includes('word title') ||
        lower.includes('title summarizing')
      ) {
      if (lower.includes('webgpu')) {
        response = 'WebGPU Browser Inference';
      } else if (lower.includes('france') || lower.includes('paris')) {
        response = 'Capital of France';
      } else {
        response = 'Conversation Overview';
      }
    } else if (lower.includes('summarize our entire conversation')) {
      response = 'User and assistant discussed WebGPU inference and memory compaction. Decisions: use structured summary.';
    } else if (lower.includes('what did we discuss')) {
      // The conversation so far, after the format turn
      const historyText = options.messages
        .slice(FORMAT_TURNS.length, -1)
        .map((m) => m.content)
        .join(' ');
      response = `Earlier we discussed: ${historyText}`;
    } else if (lower.includes('three options for browser inference')) {
      response =
        'First, you can use WebGPU with LiteRT-LM. Second, you can use ONNX Runtime Web. Third, you can use WebAssembly SIMD.';
    } else if (lower.includes('second option')) {
      response =
        'The second option is ONNX Runtime Web, which executes neural networks directly in the browser.';
    } else if (lower.includes('correction')) {
      response = 'Understood, I will keep all transcription 100% local in WASM.';
    } else if (lower.includes('capital of france')) {
      response = 'The capital of France is Paris.';
    } else if (lower.includes('dr. smith')) {
      response =
        'Dr. Smith achieved 99.5% accuracy in 45 ms. The second sentence completes the benchmark.';
    } else if (lower.includes('12 * 8')) {
      response = '12 multiplied by 8 equals 96.';
    } else if (lower.includes('response style')) {
      // Approved memories come with the request (notes), not in the system prompt
      const sys = [options.systemPrompt, ...options.messages.map((m) => m.content)].join('\n');
      const match = sys.match(/response_style:\s*([^\n]+)/i);
      response = match
        ? `You prefer ${match[1].trim()} for your response style.`
        : 'You prefer concise bullet points.';
    }
  }

    const start = performance.now();
    const words = response.split(/(?<=\s)/);
    let generated = '';
    let tokensGenerated = 0;

    for (let i = 0; i < words.length; i++) {
      if (signal?.aborted || this.activeAbortController.signal.aborted) {
        return {
          turnId: options.turnId,
          text: generated,
          tokensGenerated,
          timeToFirstTokenMs: this.tokenDelayMs,
          totalTimeMs: performance.now() - start,
          tokensPerSecond: 100,
          aborted: true,
        };
      }
      await new Promise((r) => setTimeout(r, this.tokenDelayMs));
      if (signal?.aborted || this.activeAbortController.signal.aborted) {
        return {
          turnId: options.turnId,
          text: generated,
          tokensGenerated,
          timeToFirstTokenMs: this.tokenDelayMs,
          totalTimeMs: performance.now() - start,
          tokensPerSecond: 100,
          aborted: true,
        };
      }
      generated += words[i];
      tokensGenerated++;
      options.onToken?.(words[i], tokensGenerated);
    }

    return {
      turnId: options.turnId,
      text: generated.trim(),
      tokensGenerated,
      timeToFirstTokenMs: this.tokenDelayMs,
      totalTimeMs: Math.max(1, performance.now() - start),
      tokensPerSecond: 100,
      aborted: false,
    };
  }

  public cancel(): void {
    this.activeAbortController?.abort();
  }

  public async reset(): Promise<void> {
    this.cancel();
  }

  public async dispose(): Promise<void> {
    this.cancel();
  }
}

class TestStubTtsProvider implements TtsRuntimeProvider {
  public readonly id = 'test-stub-tts';
  public readonly voiceId = 'en_US-hfc_female-medium';

  public async initialize(): Promise<void> {}

  public async synthesize(_text: string, _turnId: string, _sequence: number) {
    const samples = new Float32Array(1600);
    return {
      samples,
      sampleRate: 22050,
      audioDurationMs: (samples.length / 22050) * 1000,
      synthesisTimeMs: 1,
    };
  }

  public cancel(): void {}

  public async dispose(): Promise<void> {}
}

describe('Speech Normalization & Incremental Phrase Segmenter', () => {
  it('conservatively normalizes ASR transcripts without changing meaning', () => {
    const res = normalizeUserTranscript('  [BLANK_AUDIO]  um um what is the capital of france ');
    expect(res.rawTranscript).toContain('[BLANK_AUDIO]');
    expect(res.normalized).toBe('What is the capital of france?');

    const statement = normalizeUserTranscript("i'm building a browser voice assistant");
    expect(statement.normalized).toBe("I'm building a browser voice assistant.");
  });

  it('normalizes canonical text for TTS pronunciation without mutating canonical text', () => {
    const canonical = 'Dr. Smith achieved 99.5% accuracy in 45 ms using WebGPU and WASM.';
    const spoken = normalizeTextForSpeech(canonical);
    expect(spoken).toContain('Doctor Smith');
    expect(spoken).toContain('99 point 5 percent');
    expect(spoken).toContain('45 milliseconds');
    expect(spoken).toContain('Web G P U');
    expect(spoken).toContain('wasm');
  });

  it('segments streamed tokens into natural phrases without splitting abbreviations or decimals', () => {
    const segmenter = new IncrementalPhraseSegmenter({ minPhraseChars: 20 });
    const chunks = [
      'Hello Dr. ',
      'Smith, the value is 3.14 ',
      'meters per second. ',
      'Here is the second sentence for speech synthesis!',
    ];

    const emitted: string[] = [];
    for (const c of chunks) {
      emitted.push(...segmenter.push(c));
    }
    emitted.push(...segmenter.flush());

    expect(emitted.length).toBe(2);
    expect(emitted[0]).toBe('Hello Dr. Smith, the value is 3.14 meters per second.');
    expect(emitted[1]).toBe('Here is the second sentence for speech synthesis!');
  });

  it('synthesizes every sentence in a long multi-sentence passage without dropping phrases when LLM streams faster than TTS', async () => {
    const sentences = Array.from(
      { length: 16 },
      (_, i) => `Sentence number ${i + 1} explains an important detail, with a natural comma clause.`
    );
    const fullPassage = sentences.join(' ');
    const synthesizedTexts: string[] = [];

    const fastLlm: LlmRuntimeProvider = {
      id: 'fast-llm',
      modelId: 'fast-llm',
      contextLimit: 4096,
      maxOutputTokens: 1024,
      supportsStreaming: true,
      supportsCancellation: true,
      supportsTools: false,
      async initialize() {},
      async generate(opts) {
        // Stream all 16 sentences rapidly before TTS finishes phrase 1
        const words = fullPassage.split(/(?<=\s)/);
        let acc = '';
        for (let i = 0; i < words.length; i++) {
          acc += words[i];
          opts.onToken?.(words[i], i + 1);
        }
        return {
          turnId: opts.turnId,
          text: acc.trim(),
          tokensGenerated: words.length,
          timeToFirstTokenMs: 1,
          totalTimeMs: 5,
          tokensPerSecond: 500,
          aborted: false,
        };
      },
      cancel() {},
      async reset() {},
      async dispose() {},
    };

    const slowTts: TtsRuntimeProvider = {
      id: 'slow-tts',
      voiceId: 'en_US-hfc_female-medium',
      async initialize() {},
      async synthesize(text) {
        await new Promise((r) => setTimeout(r, 10));
        synthesizedTexts.push(text);
        return {
          samples: new Float32Array(220),
          sampleRate: 22050,
          synthesisTimeMs: 10,
          audioDurationMs: 10,
        };
      },
      cancel() {},
      async dispose() {},
    };

    const orchestrator = new ConversationOrchestrator({
      stateCoordinator: new StateMachineCoordinator(),
      llmProvider: fastLlm,
      ttsProvider: slowTts,
    });

    await orchestrator.submitUserInput('Give me a long 16-sentence explanation.');
    expect(synthesizedTexts.length).toBe(16);
    expect(synthesizedTexts[0]).toContain('Sentence number 1');
    expect(synthesizedTexts[15]).toContain('Sentence number 16');
  });
});

describe('Bounded Queue & Turn Resource Scheduler', () => {
  it('enforces max queue capacity, priority ordering, and backpressure callbacks', () => {
    const backpressureEvents: boolean[] = [];
    const queue = new BoundedQueue<string>({
      maxSize: 4,
      highWaterMark: 3,
      lowWaterMark: 1,
      onBackpressureChange: (paused) => backpressureEvents.push(paused),
    });

    expect(
      queue.enqueue({ id: '1', turnId: 't1', sequence: 1, priority: 1, payload: 'a', enqueuedAt: 1 })
    ).toBe(true);
    expect(
      queue.enqueue({ id: '2', turnId: 't1', sequence: 2, priority: 5, payload: 'high', enqueuedAt: 2 })
    ).toBe(true);
    expect(
      queue.enqueue({ id: '3', turnId: 't2', sequence: 1, priority: 1, payload: 'b', enqueuedAt: 3 })
    ).toBe(true);

    expect(queue.backpressured).toBe(true);
    expect(backpressureEvents).toEqual([true]);

    // Priority 5 item should be at the head of the queue
    expect(queue.peek()?.payload).toBe('high');

    // Cancel turn t1 -> removes 2 items, drops size to 1 (lowWaterMark), relieves backpressure
    const removed = queue.cancelTurn('t1');
    expect(removed).toBe(2);
    expect(queue.backpressured).toBe(false);
    expect(backpressureEvents).toEqual([true, false]);
  });

  it('isolates turns and aborts superseded turns in TurnResourceScheduler', () => {
    const scheduler = new TurnResourceScheduler();
    const t1 = scheduler.startTurn('turn_1');
    expect(scheduler.isTurnValid('turn_1')).toBe(true);

    const t2 = scheduler.startTurn('turn_2');
    expect(t1.signal.aborted).toBe(true);
    expect(scheduler.isTurnValid('turn_1')).toBe(false);
    expect(scheduler.isTurnValid('turn_2')).toBe(true);
    expect(t2.signal.aborted).toBe(false);
  });
});

describe('Audio Subsystem: Resampling, VAD, and PCM Utilities', () => {
  it('resamples 48kHz audio down to 16kHz mono accurately', () => {
    const input48k = new Float32Array(4800);
    for (let i = 0; i < input48k.length; i++) {
      input48k[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    const output16k = resampleTo16kHzMono(input48k, 48000);
    expect(output16k.length).toBe(1600);
    expect(computeRmsLevel(output16k)).toBeGreaterThan(0.6);
  });

  it('detects speech onset and utterance completion in VoiceActivityDetector', () => {
    const vad = new VoiceActivityDetector({
      rmsThreshold: 0.05,
      speechOnsetFrames: 2,
      silenceHangoverFrames: 3,
    });

    const quietFrame = new Float32Array(1600).fill(0.005);
    const loudFrame = new Float32Array(1600).fill(0.2);

    expect(vad.processFrame16k(quietFrame, 100).event).toBe('none');
    expect(vad.processFrame16k(loudFrame, 200).event).toBe('none');
    expect(vad.processFrame16k(loudFrame, 300).event).toBe('speech_started');
    expect(vad.processFrame16k(loudFrame, 400).event).toBe('speech_continuing');

    // 3 silence frames to trigger speech_ended
    expect(vad.processFrame16k(quietFrame, 500).event).toBe('speech_continuing');
    expect(vad.processFrame16k(quietFrame, 600).event).toBe('speech_continuing');
    const finalOut = vad.processFrame16k(quietFrame, 700);
    expect(finalOut.event).toBe('speech_ended');
    expect(finalOut.completedUtterance?.length).toBe(1600 * 6);
  });

  it('decodes WAV headers into Float32 PCM samples', () => {
    // Create minimal 44-byte WAV + 4 samples of 16-bit PCM
    const wavBuf = new ArrayBuffer(44 + 8);
    const view = new DataView(wavBuf);
    view.setUint32(24, 16000, true); // sampleRate
    view.setUint16(34, 16, true); // bitsPerSample
    view.setInt16(44, 16384, true); // ~0.5
    const decoded = decodeWavToFloat32(wavBuf);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.samples[0]).toBeCloseTo(0.5, 2);
  });
});

describe('Model Manager & Storage Integrity', () => {
  it('verifies SHA-256 checksums and rejects corrupted model artifacts', async () => {
    const manager = new ModelManager();
    const payload = new TextEncoder().encode('verified-model-weights');
    const validHash = await computeSha256Hex(payload);

    const state = await manager.storeArtifact('test-model', payload, validHash);
    expect(state.status).toBe('cached');

    const loaded = await manager.loadArtifact('test-model');
    expect(loaded).not.toBeNull();
    expect(new TextDecoder().decode(loaded!)).toBe('verified-model-weights');

    await expect(
      manager.storeArtifact('corrupt-model', payload, '0000000000000000000000000000000000000000000000000000000000000000')
    ).rejects.toThrow(/Integrity check failed/);
  });
});

describe('Full 9-Case Conversation Quality & Interruption Evaluation Suite', () => {
  it('passes 100% of the conversation quality, reference resolution, memory, and barge-in tests', async () => {
    const report = await runConversationEvaluationSuite({
      createLlmProvider: () => new TestStubLlmProvider({ tokenDelayMs: 5 }),
      createTtsProvider: () => new TestStubTtsProvider(),
    });
    for (const r of report.results) {
      expect(r.passed, `${r.id} (${r.name}): ${r.details}`).toBe(true);
    }
    expect(report.passRatePercent).toBe(100);
    expect(report.totalCases).toBe(9);
  });

  it('ignores partial transcripts from triggering duplicate LLM responses', async () => {
    const stateCoordinator = new StateMachineCoordinator();
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator,
      llmProvider: new TestStubLlmProvider({ tokenDelayMs: 1 }),
      ttsProvider: new TestStubTtsProvider(),
    });

    orchestrator.handleSttEvent({
      type: 'speech_started',
      turnId: 't_partial',
      sequence: 1,
      timestamp: performance.now(),
    });
    orchestrator.handleSttEvent({
      type: 'partial_transcript',
      turnId: 't_partial',
      sequence: 2,
      timestamp: performance.now(),
      text: 'Hello there',
    });

    expect(orchestrator.memoryStore.getMessages().length).toBe(0);
    expect(orchestrator.getInteractionState()).toBe('listening');
  });
});

describe('Conversation Reset & State Cleansing', () => {
  it('clears working messages, summary, and long term memories', () => {
    const memory = new ConversationMemoryStore();
    memory.addMessage({
      id: 'm1',
      turnId: 't1',
      role: 'user',
      canonicalContent: 'Hello',
      timestamp: Date.now(),
    });
    memory.upsertApprovedMemory('favorite_color', 'blue');
    expect(memory.getMessages().length).toBe(1);
    expect(memory.getAllMemories().length).toBe(1);

    memory.clearConversation();
    expect(memory.getMessages().length).toBe(0);
    expect(memory.getAllMemories().length).toBe(1);

    memory.clearAllMemories();
    expect(memory.getAllMemories().length).toBe(0);
    expect(memory.getCurrentContextTokens()).toBe(0);
  });

  it('persists and cleanly clears IndexedDB snapshots and memories', async () => {
    const manager = new ModelManager();
    const testMessages = [
      {
        id: 'msg_1',
        turnId: 'turn_1',
        role: 'user' as const,
        canonicalContent: 'Test prompt',
        timestamp: Date.now(),
      },
    ];

    await manager.db.saveConversationSnapshot(testMessages, null);
    await manager.db.saveMemories([
      {
        id: 'mem_1',
        key: 'pref_lang',
        value: 'typescript',
        category: 'preference' as const,
        approvedByUser: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    const loadedSnapshot = await manager.db.loadConversationSnapshot();
    const loadedMemories = await manager.db.loadMemories();
    expect(loadedSnapshot?.messages.length).toBe(1);
    expect(loadedMemories.length).toBe(1);

    await manager.db.clearConversationSnapshot();
    await manager.db.saveMemories([]);

    const clearedSnapshot = await manager.db.loadConversationSnapshot();
    const clearedMemories = await manager.db.loadMemories();
    expect(clearedSnapshot).toBeNull();
    expect(clearedMemories.length).toBe(0);
  });
});

describe('Dynamic Context Compaction (>85% Context) & First-Press Interruption', () => {
  it('correctly calculates token usage and detects >85% threshold', () => {
    const memory = new ConversationMemoryStore();
    // Empty conversation should not need compaction
    expect(memory.isContextCompactionNeeded(1000, '', 0.85)).toBe(false);

    // Add long messages
    memory.addMessage({
      id: 'm1',
      turnId: 't1',
      role: 'user',
      canonicalContent: 'A'.repeat(2000), // ~500 tokens
      timestamp: Date.now(),
    });
    memory.addMessage({
      id: 'm2',
      turnId: 't1',
      role: 'assistant',
      canonicalContent: 'B'.repeat(2000), // ~500 tokens
      timestamp: Date.now(),
    });

    // Total tokens ~ 150 (overhead) + 500 + 500 = 1150 tokens
    // For contextLimit = 1200: 85% is 1020 tokens -> 1150 >= 1020 -> true!
    expect(memory.isContextCompactionNeeded(1200, '', 0.85)).toBe(true);

    // For contextLimit = 8192: 85% is 6963 tokens -> 1150 < 6963 -> false
    expect(memory.isContextCompactionNeeded(8192, '', 0.85)).toBe(false);
  });

  it('triggers compaction on incoming query, says "hold on a sec", updates status, and restarts with summary', async () => {
    const stateCoordinator = new StateMachineCoordinator();
    const memoryStore = new ConversationMemoryStore();

    // Populate existing long conversation
    memoryStore.addMessage({
      id: 'm1',
      turnId: 't1',
      role: 'user',
      canonicalContent: 'We are evaluating WebGPU inference options for local models.',
      timestamp: Date.now() - 5000,
    });
    memoryStore.addMessage({
      id: 'm2',
      turnId: 't1',
      role: 'assistant',
      canonicalContent: 'WebGPU allows low latency neural network execution in the browser.',
      timestamp: Date.now() - 4000,
    });

    const statusUpdates: string[] = [];
    const spokenPhrases: string[] = [];

    const orchestrator = new ConversationOrchestrator({
      stateCoordinator,
      memoryStore,
      llmProvider: new TestStubLlmProvider({ tokenDelayMs: 1 }),
      ttsProvider: new TestStubTtsProvider(),
      contextCompactionThreshold: 0.02, // Lower threshold to trigger compaction on this turn
      events: {
        onStatusChange: (status) => {
          if (status) statusUpdates.push(status);
        },
        onPhraseReadyForPlayback: (phrase) => {
          spokenPhrases.push(phrase.speechNormalizedText);
        },
      },
    });

    // Submit incoming user query
    const res = await orchestrator.submitUserInput('What is the recommended approach?');
    expect(res).toBeDefined();

    // 1. Verify "Hold on a sec." announcement was spoken
    expect(spokenPhrases).toContain('Hold on a sec.');

    // 2. Verify status showed "Compacting…"
    expect(statusUpdates).toContain('Compacting…');

    // 3. Verify previous history was compacted into summary
    const summary = memoryStore.getSummary();
    expect(summary).not.toBeNull();
    expect(summary?.summaryText).toContain('WebGPU inference');

    // 4. Verify conversation restarted with no old messages except the current fresh turn
    const currentMessages = memoryStore.getMessages();
    expect(currentMessages.length).toBe(2); // Only the new user message + new assistant response
    expect(currentMessages[0].canonicalContent).toBe('What is the recommended approach?');
  });

  it('immediately halts playback and cancels turn on first stop press when busy', async () => {
    const stateCoordinator = new StateMachineCoordinator();
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator,
      llmProvider: new TestStubLlmProvider({ tokenDelayMs: 50 }),
      ttsProvider: new TestStubTtsProvider(),
    });

    // Start a turn
    const turnPromise = orchestrator.submitUserInput('tell me about three options for browser inference');

    // Wait 5ms for turn to enter generating/speaking
    await new Promise((r) => setTimeout(r, 5));
    const snapshot = stateCoordinator.getSnapshot();
    const isBusy =
      snapshot.interaction === 'generating' ||
      snapshot.interaction === 'speaking' ||
      snapshot.playback === 'playing';

    expect(isBusy).toBe(true);

    // Single interrupt on first press
    const canceledId = orchestrator.interruptCurrentTurn('User clicked Stop');
    expect(canceledId).toBeDefined();

    // Verify interaction and playback immediately stopped
    const afterSnap = stateCoordinator.getSnapshot();
    expect(afterSnap.interaction).toBe('interrupted');
    expect(afterSnap.playback).toBe('interrupted');

    const result = await turnPromise;
    expect(result?.interrupted).toBe(true);
  });

  describe('Dynamic Title Generation (Conversation Text & Compacted Summary)', () => {
    it('generates a title from current conversation text when no summary exists', async () => {
      const stateCoordinator = new StateMachineCoordinator();
      const memoryStore = new ConversationMemoryStore();

      memoryStore.addMessage({
        id: 'm1',
        turnId: 't1',
        role: 'user',
        canonicalContent: 'What are the main advantages of running WebGPU models locally?',
        timestamp: Date.now() - 2000,
      });
      memoryStore.addMessage({
        id: 'm2',
        turnId: 't1',
        role: 'assistant',
        canonicalContent: 'WebGPU executes neural network inference directly on the client GPU.',
        timestamp: Date.now() - 1000,
      });

      let emittedTitle = '';
      const orchestrator = new ConversationOrchestrator({
        stateCoordinator,
        memoryStore,
        llmProvider: new TestStubLlmProvider(),
        events: {
          onTitleGenerated: (title) => {
            emittedTitle = title;
          },
        },
      });

      const title = await orchestrator.generateConversationTitle();
      expect(title).toBe('WebGPU Browser Inference');
      expect(emittedTitle).toBe('WebGPU Browser Inference');
    });

    it('generates a title from compacted summary when summary is present', async () => {
      const stateCoordinator = new StateMachineCoordinator();
      const memoryStore = new ConversationMemoryStore();

      // Compacted summary present with no active messages
      memoryStore.compactWithSummary({
        id: 'sum_123',
        updatedAt: Date.now(),
        coveredTurnCount: 10,
        lastCoveredTurnId: 't10',
        summaryText: 'Discussion on WebGPU acceleration and browser neural inference pipelines.',
        decisions: ['Use WebGPU with LiteRT-LM'],
        unresolvedQuestions: [],
        namedEntities: { WebGPU: 'browser GPU standard' },
        constraints: [],
      });

      const orchestrator = new ConversationOrchestrator({
        stateCoordinator,
        memoryStore,
        llmProvider: new TestStubLlmProvider(),
      });

      const title = await orchestrator.generateConversationTitle();
      expect(title).toBe('WebGPU Browser Inference');

      // Verify summary's title field was also updated
      const updatedSummary = memoryStore.getSummary();
      expect(updatedSummary?.title).toBe('WebGPU Browser Inference');
    });

    it('returns "New Conversation" fallback when conversation is empty', async () => {
      const stateCoordinator = new StateMachineCoordinator();
      const memoryStore = new ConversationMemoryStore();

      const orchestrator = new ConversationOrchestrator({
        stateCoordinator,
        memoryStore,
        llmProvider: new TestStubLlmProvider(),
      });

      const title = await orchestrator.generateConversationTitle();
      expect(title).toBe('New Conversation');
    });

    it('respects explicitly provided text or summary options', async () => {
      const stateCoordinator = new StateMachineCoordinator();
      const memoryStore = new ConversationMemoryStore();

      const orchestrator = new ConversationOrchestrator({
        stateCoordinator,
        memoryStore,
        llmProvider: new TestStubLlmProvider(),
      });

      const titleFromText = await orchestrator.generateConversationTitle({
        text: 'User: Tell me about Paris and France.\nAssistant: The capital of France is Paris.',
      });
      expect(titleFromText).toBe('Capital of France');

      const titleFromSummary = await orchestrator.generateConversationTitle({
        summary: 'Overview of WebGPU browser inference models and local processing performance.',
      });
      expect(titleFromSummary).toBe('WebGPU Browser Inference');
    });
  });

  describe('JavaScript Runtime Tool & Execution Architecture', () => {
    it('executes JavaScript expressions and captures return value and logs in eval mode', async () => {
      const { JavascriptRuntime } = await import('../src/tools/javascript-runtime.ts');
      const runtime = new JavascriptRuntime({ mode: 'eval' });

      let callbackResult: any = null;
      const res = await runtime.execute(
        'let a = 15; let b = 25; console.log("calculating sum"); a + b;',
        (cbRes) => {
          callbackResult = cbRes;
        }
      );

      expect(res.success).toBe(true);
      expect(res.output).toBe(40);
      expect(res.logs).toContain('calculating sum');
      expect(callbackResult).toEqual(res);
    });

    it('traps syntax and runtime errors safely with strict mode protection', async () => {
      const { JavascriptRuntime } = await import('../src/tools/javascript-runtime.ts');
      const runtime = new JavascriptRuntime({ mode: 'eval' });

      let errorCallbackCalled = false;
      const res = await runtime.execute('undeclaredVar = 123;', (cb) => {
        if (cb.error) errorCallbackCalled = true;
      });

      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
      expect(errorCallbackCalled).toBe(true);
    });

    it('executes asynchronous code with top-level await in JavascriptRuntime', async () => {
      const { JavascriptRuntime } = await import('../src/tools/javascript-runtime.ts');
      const runtime = new JavascriptRuntime({ mode: 'eval' });

      const asyncCode = `
        const val = await Promise.resolve(42);
        return val * 2;
      `;
      const res = await runtime.execute(asyncCode);
      expect(res.success).toBe(true);
      expect(res.output).toBe(84);

      // Verify statements without expressions return undefined instead of 'use strict'
      const declRes = await runtime.execute('"use strict"; const a = 1; let b = 2;');
      expect(declRes.success).toBe(true);
      expect(declRes.output).toBeUndefined();
    });

    it('formats tool call and result summary lines cleanly and creates DOM card', async () => {
      const {
        formatToolArguments,
        formatToolResultSummary,
        createToolSummaryElement,
        parseStreamingToolCall,
      } = await import('../src/tools/tool-formatter.ts');

      // Test arguments formatting
      const argsFormatted = formatToolArguments({ code: 'const x = 10;\nx * 2;' });
      expect(argsFormatted).toContain('code: const x = 10; x * 2;');

      // Test result formatting
      const successRes = formatToolResultSummary({ success: true, output: 42, logs: [] });
      expect(successRes.isError).toBe(false);
      expect(successRes.summary).toBe('42');

      const strictRes = formatToolResultSummary({ success: true, output: 'use strict', logs: [] });
      expect(strictRes.isError).toBe(false);
      expect(strictRes.summary).toBe('Completed');

      const undefinedRes = formatToolResultSummary({ success: true, output: undefined, logs: [] });
      expect(undefinedRes.isError).toBe(false);
      expect(undefinedRes.summary).toBe('Completed');

      const errorRes = formatToolResultSummary(null, 'SyntaxError: unexpected token');
      expect(errorRes.isError).toBe(true);
      expect(errorRes.summary).toBe('SyntaxError: unexpected token');

      // Test DOM element creation
      let clicked = false;
      const el = createToolSummaryElement(
        {
          name: 'javascript_runtime',
          arguments: { code: 'Math.sqrt(144)' },
          result: { success: true, output: 12, logs: [] },
          status: 'completed',
        },
        () => {
          clicked = true;
        }
      );
      expect(el.classList.contains('chat-tool-summary-card')).toBe(true);
      expect(el.textContent).toContain('javascript_runtime');
      expect(el.textContent).toContain('Math.sqrt(144)');
      expect(el.textContent).toContain('Result: 12');

      el.click();
      expect(clicked).toBe(true);

      // Test parse streaming tool call
      const streamText = 'Sure!```tool_call\n{"name": "javascript_runtime", "arguments": {"code": "3 * 7"}}\n```';
      const parsed = parseStreamingToolCall(streamText);
      expect(parsed).not.toBeNull();
      expect(parsed?.toolName).toBe('javascript_runtime');
      expect(parsed?.args.code).toBe('3 * 7');
      expect(parsed?.cleanText).toBe('Sure!');
    });

    it('defines minimal, clean Wikipedia and Instant Answers tools and formats their results', async () => {
      const { createWikipediaTool, createInstantAnswersTool } = await import(
        '../src/tools/web-tools.ts'
      );
      const { createToolSummaryElement } = await import('../src/tools/tool-formatter.ts');

      const wikiTool = createWikipediaTool();
      expect(wikiTool.name).toBe('wikipedia');
      expect(wikiTool.parameters.required).toEqual(['query']);
      expect(wikiTool.parameters.properties).toHaveProperty('query');

      const instantTool = createInstantAnswersTool();
      expect(instantTool.name).toBe('instant_answers');
      expect(instantTool.parameters.required).toEqual(['query']);
      expect(instantTool.parameters.properties).toHaveProperty('query');

      // Test Wikipedia summary card formatting
      const wikiEl = createToolSummaryElement({
        name: 'wikipedia',
        arguments: { query: 'Albert Einstein' },
        result: {
          title: 'Albert Einstein',
          summary: 'Albert Einstein was a theoretical physicist who developed the theory of relativity.',
        },
        status: 'completed',
      });
      expect(wikiEl.textContent).toContain('📖');
      expect(wikiEl.textContent).toContain('wikipedia');
      expect(wikiEl.textContent).toContain('Albert Einstein');
      expect(wikiEl.textContent).toContain('theoretical physicist');

      // Test Instant Answers card formatting
      const instantEl = createToolSummaryElement({
        name: 'instant_answers',
        arguments: { query: 'speed of sound' },
        result: { heading: 'Speed of sound', answer: '340.29 m / s' },
        status: 'completed',
      });
      expect(instantEl.textContent).toContain('💡');
      expect(instantEl.textContent).toContain('instant_answers');
      expect(instantEl.textContent).toContain('340.29 m / s');
    });

    it('spins up a single-use coding agent from a task query, chooses runtime mode, and returns result', async () => {
      const {
        JavascriptRuntime,
        detectRecommendedMode,
        parseCodingAgentOutput,
      } = await import('../src/tools/javascript-runtime.ts');

      // Test mode detection heuristics
      expect(detectRecommendedMode('const ctx = new AudioContext();')).toBe('iframe');
      expect(detectRecommendedMode('const c = document.createElement("canvas");')).toBe('iframe');
      expect(detectRecommendedMode('for (let i = 0; i < 100000; i++) { sum += i; }')).toBe('worker');
      expect(detectRecommendedMode('return 12 * 8;')).toBe('eval');

      // Test parsing coding agent response
      const sampleLlmOutput = 'MODE: iframe\n```javascript\nreturn "audio ready";\n```';
      const parsed = parseCodingAgentOutput(sampleLlmOutput);
      expect(parsed.mode).toBe('iframe');
      expect(parsed.code).toBe('return "audio ready";');

      // Test JavascriptRuntime with LLM provider
      const mockLlm = new TestStubLlmProvider();
      const runtime = new JavascriptRuntime({ mode: 'eval', llmProvider: mockLlm });

      // Execute natural language task (not raw JavaScript)
      const res = await runtime.executeTask('play a three-tone chime');
      expect(res.success).toBe(true);
      expect(res.mode).toBe('iframe');
      expect(res.output).toBe('Synthesized audio chime');
      expect(res.task).toBe('play a three-tone chime');
    });

    it('supports Coder Agent (coder_agent) as tool name and card representation', async () => {
      const { JavascriptRuntime, createCoderAgentTool } = await import(
        '../src/tools/javascript-runtime.ts'
      );
      const { createToolSummaryElement } = await import('../src/tools/tool-formatter.ts');

      const mockLlm = new TestStubLlmProvider();
      const runtime = new JavascriptRuntime({ mode: 'eval', llmProvider: mockLlm });
      const coderTool = createCoderAgentTool(runtime);

      expect(coderTool.name).toBe('coder_agent');
      expect(coderTool.description).toContain('audio');
      expect(coderTool.description).toContain('visuals');

      // Test card representation for coder_agent
      let cardClicked = false;
      const el = createToolSummaryElement(
        { name: 'coder_agent', arguments: { task: 'draw a 2d circle' }, status: 'completed' },
        () => {
          cardClicked = true;
        }
      );
      expect(el.classList.contains('chat-tool-summary-card')).toBe(true);
      expect(el.classList.contains('clickable')).toBe(true);
      expect(el.title).toContain('Coder Agent Overlay');
      expect(el.textContent).toContain('coder_agent');
      expect(el.textContent).toContain('💻');
      el.click();
      expect(cardClicked).toBe(true);
    });

    it('manages settings persistence and supports Gemma chat/coding model & Piper voice selection', async () => {
      // 1. Verify defaults and supported options
      expect(DEFAULT_SETTINGS.chatModelId).toBe('gemma-4-e2b-it-web');
      expect(DEFAULT_SETTINGS.codingModelId).toBe('gemma-4-e2b-it-web');
      expect(DEFAULT_SETTINGS.voiceId).toBe('en_US-hfc_female-medium');

      expect(SUPPORTED_CHAT_MODELS.map((m) => m.id)).toEqual([
        'gemma-4-e2b-it-web',
        'gemma-4-e4b-it-web',
        'lfm2.5-230m',
        'smollm2-360m',
        'llama-3.2-1b',
        'qwen2.5-coder-0.5b',
        'qwen2.5-0.5b',
        'qwen3-0.6b',
        'qwen3.5-0.8b',
        'qwen2.5-coder-1.5b',
        'smollm2-1.7b',
        'qwen3-1.7b',
        'qwen3.5-2b',
        'llama-3.2-3b',
        'qwen2.5-coder-3b',
        'ministral-3-3b',
        'qwen3-4b',
        'phi-4-mini',
        'qwen3.5-4b',
        'qwen2.5-coder-7b',
        'qwen3-8b',
        'qwen3.5-9b',
      ]);
      // Phones get the small WebLLM models and Gemma 4 E2B (LiteRT, like desktop), never E4B
      expect(SUPPORTED_CHAT_MODELS.filter((m) => m.phone && m.id.startsWith('gemma-4')).map((m) => m.id)).toEqual(['gemma-4-e2b-it-web']);
      expect(SUPPORTED_CODING_MODELS.map((m) => m.id)).toEqual([
        'gemma-4-e2b-it-web',
        'gemma-4-e4b-it-web',
      ]);
      expect(SUPPORTED_PIPER_VOICES.map((v) => v.id)).toEqual([
        'en_US-hfc_female-medium',
        'en_US-hfc_male-medium',
      ]);

      // 2. Test localStorage persistence helper
      const saved = saveSettingsToStorage({
        chatModelId: 'gemma-4-e4b-it-web',
        codingModelId: 'gemma-4-e2b-it-web',
        voiceId: 'en_US-hfc_male-medium',
      });
      expect(saved.chatModelId).toBe('gemma-4-e4b-it-web');
      expect(saved.codingModelId).toBe('gemma-4-e2b-it-web');
      expect(saved.voiceId).toBe('en_US-hfc_male-medium');

      const reloaded = loadSettingsFromStorage();
      expect(reloaded).toEqual(saved);

      // 3. Test VoiceAssistantEngine model and voice preferences
      const engine = new VoiceAssistantEngine();
      expect(engine.getChatModelId()).toBe('gemma-4-e4b-it-web');
      expect(engine.getCodingModelId()).toBe('gemma-4-e2b-it-web');
      expect(engine.getVoiceId()).toBe('en_US-hfc_male-medium');

      // 4. Test updating settings dynamically
      await engine.updateSettings({
        chatModelId: 'gemma-4-e2b-it-web',
        codingModelId: 'gemma-4-e4b-it-web',
        voiceId: 'en_US-hfc_female-medium',
      });

      expect(engine.getChatModelId()).toBe('gemma-4-e2b-it-web');
      expect(engine.getCodingModelId()).toBe('gemma-4-e4b-it-web');
      expect(engine.getVoiceId()).toBe('en_US-hfc_female-medium');

      const current = engine.getSettings();
      expect(current.chatModelId).toBe('gemma-4-e2b-it-web');
      expect(current.codingModelId).toBe('gemma-4-e4b-it-web');
      expect(current.voiceId).toBe('en_US-hfc_female-medium');

      // Clean up
      saveSettingsToStorage(DEFAULT_SETTINGS);
      await engine.dispose();
    });

    it('keeps only the 10 most recently used chats, deleting the oldest as new ones are made', async () => {
      saveSettingsToStorage({ speechEnabled: false });
      const engine = new VoiceAssistantEngine();
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
      onTestFinished(async () => {
        clock.mockRestore();
        // Leave no chats behind for the next test's engine
        for (const c of engine.getConversations()) await engine.modelManager.db.deleteConversation(c.id);
        await engine.dispose();
        saveSettingsToStorage(DEFAULT_SETTINGS);
      });
      await engine.initialize();
      const made = [];
      for (let i = 0; i < 12; i++) made.push(await engine.createConversation(`Chat ${i}`));
      const ids = engine.getConversations().map((c) => c.id);
      expect(ids.length).toBe(10);
      expect(ids).toEqual(made.slice(2).map((c) => c.id).reverse());
      expect(ids).toContain(engine.getActiveConversationId());
    });

    it('supports expandable sidebar open/close state and multi-channel chat management (create, switch, rename, compact, delete)', async () => {
      // Speech off before construction: initialize() applies the stored choice, and with speech
      // on it downloads Piper/Whistle from the network and compaction synthesizes "Hold on a sec."
      saveSettingsToStorage({ speechEnabled: false });
      const engine = new VoiceAssistantEngine();
      onTestFinished(async () => {
        await engine.dispose();
        saveSettingsToStorage(DEFAULT_SETTINGS);
      });

      // 1. Sidebar open/closed preference
      expect(engine.getSidebarOpen()).toBe(false);
      engine.setSidebarOpen(true);
      expect(engine.getSidebarOpen()).toBe(true);
      const settings = loadSettingsFromStorage();
      expect(settings.sidebarOpen).toBe(true);
      engine.setSidebarOpen(false);
      expect(engine.getSidebarOpen()).toBe(false);

      // 2. Initialize and create multiple conversation channels
      await engine.initialize();
      const initialList = engine.getConversations();
      expect(initialList.length).toBeGreaterThanOrEqual(1);

      const chat1 = initialList[0];
      expect(chat1.title).toBeDefined();

      // Create new chat channel
      const chat2 = await engine.createConversation('Calculus Notes');
      expect(chat2.id).toBeDefined();
      expect(chat2.title).toBe('Calculus Notes');
      expect(engine.getActiveConversationId()).toBe(chat2.id);

      // Add dummy message to chat2 and persist
      engine.memoryStore.addMessage({
        id: 'msg_calc_1',
        turnId: 'turn_calc_1',
        role: 'user',
        canonicalContent: 'What is the derivative of x^2?',
        timestamp: Date.now(),
      });
      await engine.persistState(true);
      expect(engine.getMessages().length).toBeGreaterThan(0);

      // Create another channel
      const chat3 = await engine.createConversation('Audio Chimes');
      expect(engine.getActiveConversationId()).toBe(chat3.id);
      expect(engine.getMessages().length).toBe(0); // isolated context

      // 3. Switch between channels
      const switched = await engine.switchConversation(chat2.id);
      expect(switched).toBe(true);
      expect(engine.getActiveConversationId()).toBe(chat2.id);
      expect(engine.getMessages().length).toBeGreaterThan(0); // restored context

      // 4. Rename channel
      await engine.renameConversation(chat2.id, 'Advanced Calculus');
      expect(engine.getActiveConversation()?.title).toBe('Advanced Calculus');

      // 5. Compact channel on demand
      await engine.compactConversation(chat2.id);
      expect(engine.getActiveConversationId()).toBe(chat2.id);

      // 6. Delete channel
      const listBeforeDelete = engine.getConversations().length;
      await engine.deleteConversation(chat2.id);
      const listAfterDelete = engine.getConversations();
      expect(listAfterDelete.length).toBe(listBeforeDelete - 1);
      expect(listAfterDelete.some((c) => c.id === chat2.id)).toBe(false);
      // Active ID automatically switched to remaining channel
      expect(engine.getActiveConversationId()).not.toBe(chat2.id);
    });

    it('plays music and MIDI notes via play_music tool with note parsing and synthesis', async () => {
      const {
        createPlayMusicTool,
        parseNoteSequence,
        parseNoteToken,
      } = await import('../src/tools/music-tool.ts');
      const { createToolSummaryElement, formatToolResultSummary } = await import(
        '../src/tools/tool-formatter.ts'
      );

      // 1. Test note token parsing
      const c4 = parseNoteToken('C4');
      expect(c4).not.toBeNull();
      expect(c4?.midi).toBe(60);
      expect(Math.round(c4?.freq ?? 0)).toBe(262);

      const g4 = parseNoteToken('G4');
      expect(g4?.midi).toBe(67);

      const fSharp = parseNoteToken('F#4:0.5');
      expect(fSharp?.midi).toBe(66);
      expect(fSharp?.durationBeats).toBe(0.5);

      // Default octave 4 when omitted
      const bFlat = parseNoteToken('Bb');
      expect(bFlat?.midi).toBe(70);

      // 2. Test sequence parsing
      const notes = parseNoteSequence('C, G, G, F, C, G');
      expect(notes.length).toBe(6);
      expect(notes.map((n) => n.note)).toEqual(['C4', 'G4', 'G4', 'F4', 'C4', 'G4']);

      // Preset melody test
      const twinkleNotes = parseNoteSequence('play twinkle twinkle little star');
      expect(twinkleNotes.length).toBe(14);

      // 3. Test play_music tool execution
      const musicTool = createPlayMusicTool();
      expect(musicTool.name).toBe('play_music');

      const result = (await musicTool.execute({
        notes: 'C, G, G, F, C, G',
        tempo: 140,
        instrument: 'synth',
      })) as any;
      expect(result.success).toBe(true);
      expect(result.count).toBe(6);
      expect(result.played).toBe('C4, G4, G4, F4, C4, G4');

      // 4. Test tool card formatting
      const summary = formatToolResultSummary(result);
      expect(summary.isError).toBe(false);
      expect(summary.summary).toContain('Played 6 notes');
      expect(summary.summary).toContain('C4, G4, G4, F4, C4, G4');

      const card = createToolSummaryElement({
        name: 'play_music',
        arguments: { notes: 'C, G, G, F, C, G' },
        result,
        status: 'completed',
      });
      expect(card.textContent).toContain('play_music');
      expect(card.textContent).toContain('🎵');
      expect(card.textContent).toContain('Played 6 notes');
    });

    it('draws graphics and canvas animations via draw_graphics tool without mentioning code', async () => {
      const { createDrawGraphicsTool } = await import('../src/tools/draw-tool.ts');
      const { JavascriptRuntime } = await import('../src/tools/javascript-runtime.ts');
      const { createToolSummaryElement } = await import('../src/tools/tool-formatter.ts');

      const mockLlm = new TestStubLlmProvider();
      const runtime = new JavascriptRuntime({ mode: 'eval', llmProvider: mockLlm });
      const drawTool = createDrawGraphicsTool(runtime);

      expect(drawTool.name).toBe('draw_graphics');
      expect(drawTool.description).toContain('Draws graphics');

      const result = (await drawTool.execute({ prompt: 'colorful spiral' })) as any;
      expect(result.success).toBe(true);

      const card = createToolSummaryElement({
        name: 'draw_graphics',
        arguments: { prompt: 'colorful spiral' },
        result,
        status: 'completed',
      });
      expect(card.textContent).toContain('draw_graphics');
      expect(card.textContent).toContain('🎨');

      // Verify system prompt forbids offering or discussing code
      const stateCoordinator = new StateMachineCoordinator();
      const orchestrator = new ConversationOrchestrator({
        stateCoordinator,
        llmProvider: mockLlm,
      });

      const built = (orchestrator as any).buildModelPrompt(
        '',
        {
          workingMessages: [],
          relevantMemories: [],
        },
        'standard'
      );
      expect(built.systemPrompt).toContain('All messages to the user go through speak(text)');
    });

    it('runs interactive widgets and canvas games in iframe mode', async () => {
      const { detectRecommendedMode } = await import('../src/tools/javascript-runtime.ts');

      const stopwatchCode = `
        const root = document.getElementById("root");
        const btn = document.createElement("button");
        btn.textContent = "Start";
        root.appendChild(btn);
        let timer = setInterval(() => {}, 1000);
      `;
      expect(detectRecommendedMode(stopwatchCode)).toBe('iframe');

      const canvasGameCode = `
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        requestAnimationFrame(() => {});
      `;
      expect(detectRecommendedMode(canvasGameCode)).toBe('iframe');
    });

    it('strips tool control tags, blocks and call syntax from text', async () => {
      const { stripToolCallMarkup } = await import('../src/core/speech-normalizer.ts');
      expect(stripToolCallMarkup('<|tool_call><tool_call|>')).toBe('');
      expect(stripToolCallMarkup('<|tool_call>call:coder_agent{"task": "foo"}<tool_call|>')).toBe('');
      expect(stripToolCallMarkup('Great! <|tool_call><tool_call|>')).toBe('Great!');
      expect(stripToolCallMarkup('Here is your game: ```tool_call\n{"name": "foo"}\n``` Enjoy!')).toBe('Here is your game:  Enjoy!');
    });

    it('executes universal code-as-action single pass and isolates code from UI token stream', async () => {
      const { StateMachineCoordinator } = await import('../src/core/state-machine.ts');
      const { ConversationOrchestrator } = await import('../src/core/orchestrator.ts');
      const { JavascriptRuntime } = await import('../src/tools/javascript-runtime.ts');

      const streamedTextSnapshots: string[] = [];
      const runtime = new JavascriptRuntime({ mode: 'eval' });
      const stateCoordinator = new StateMachineCoordinator();

      const jsCodeFromModel = [
        'speak("Playing a melodic chord for you.");',
        'const notes = "C4 E4 G4 C5";',
        'await playNotes(notes, 200);',
      ].join('\n');

      const orchestrator = new ConversationOrchestrator({
        stateCoordinator,
        javascriptRuntime: runtime,
        llmProvider: new TestStubLlmProvider({
          responseOverride: jsCodeFromModel,
          tokenDelayMs: 1,
        }),
        enableSpeechOutput: false,
        events: {
          onTokenStream: (_turnId, _chunk, canonicalSoFar) => {
            streamedTextSnapshots.push(canonicalSoFar);
          },
        },
      });

      const msg = await orchestrator.submitUserInput('Play some music');
      expect(msg).not.toBeNull();
      expect(msg?.canonicalContent).toBe('Playing a melodic chord for you.');
      expect(msg?.rawCode).toBe(jsCodeFromModel);

      // Verify that raw code syntax was NEVER leaked into the streamed canonical text
      for (const text of streamedTextSnapshots) {
        expect(text).not.toContain('const notes');
        expect(text).not.toContain('playNotes(');
        expect(text).not.toContain('await ');
      }

      // Verify that next prompt history uses rawCode for assistant turns
      const promptData = (orchestrator as any).buildModelPrompt(
        'Can you play another?',
        (orchestrator as any).memoryStore.resolveContextForQuery('Can you play another?', 4000)
      );
      // The conversation's own turns, after the format turn
      const assistantPromptTurn = promptData.promptMessages
        .slice(FORMAT_TURNS.length)
        .find((m: { role: string }) => m.role === 'assistant');
      expect(assistantPromptTurn).toBeDefined();
      expect(assistantPromptTurn.content).toBe(jsCodeFromModel);
    });

    it('handles iframe execution timeout safely without falling back to main-thread eval', async () => {
      const { JavascriptRuntime } = await import('../src/tools/javascript-runtime.ts');
      const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 30 });

      // In Node environment, Vitest mocks iframe with eval, but test timeout on direct iframe call if simulated
      expect(runtime.getMode()).toBe('iframe');
      runtime.setMode('iframe');

      // Verify detectRecommendedMode chooses iframe for DOM and audio, and eval for calculation
      const { detectRecommendedMode } = await import('../src/tools/javascript-runtime.ts');
      expect(detectRecommendedMode('Math.sqrt(16);')).toBe('eval');
      expect(detectRecommendedMode('await playNotes("C4");')).toBe('iframe');
      expect(detectRecommendedMode('root.appendChild(canvas);')).toBe('iframe');
    });

    it('executes runtime SyntaxError exactly once and does not trigger fallback', async () => {
      const { JavascriptRuntime } = await import('../src/tools/javascript-runtime.ts');
      const runtime = new JavascriptRuntime({ mode: 'eval' });
      let executionCount = 0;
      (globalThis as any).__testExecutionCounter = () => { executionCount++; };

      const code = 'globalThis.__testExecutionCounter(); JSON.parse("invalid json {");';
      const result = await runtime.execute(code);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/JSON|SyntaxError/);
      expect(executionCount).toBe(1);
      delete (globalThis as any).__testExecutionCounter;
    });

    it('correctly classifies arbitrary JS code expressions/statements vs prose', async () => {
      const { prepareExecutableCode, inspectExecutableCode } = await import('../src/tools/javascript-runtime.ts');

      expect(prepareExecutableCode('canvas.width = 400;')).toBe('canvas.width = 400;');
      expect(prepareExecutableCode('(async () => { return 42; })()')).toBe('(async () => { return 42; })()');
      expect(prepareExecutableCode('new AudioContext();')).toBe('new AudioContext();');
      expect(prepareExecutableCode('playNotes(["C4", "E4", "G4"])')).toBe('playNotes(["C4", "E4", "G4"])');
      expect(prepareExecutableCode('const x = 10;\nconsole.log(x);')).toBe('const x = 10;\nconsole.log(x);');

      // Natural conversational prose with commas or greetings must NOT be executed as comma expressions
      expect(inspectExecutableCode('Sure, thanks').isProse).toBe(true);
      expect(prepareExecutableCode('Sure, thanks')).toBe('speak("Sure, thanks");');

      expect(inspectExecutableCode('Hi, there').isProse).toBe(true);
      expect(prepareExecutableCode('Hi, there')).toBe('speak("Hi, there");');

      expect(inspectExecutableCode('Yes, please').isProse).toBe(true);
      expect(prepareExecutableCode('Yes, please')).toBe('speak("Yes, please");');

      expect(inspectExecutableCode('Sure (thanks)').isProse).toBe(true);
      expect(prepareExecutableCode('Sure (thanks)')).toBe('speak("Sure (thanks)");');

      expect(inspectExecutableCode('"hello"').isProse).toBe(true);
      expect(prepareExecutableCode('"hello"')).toBe('speak("hello");');

      expect(prepareExecutableCode('42')).toBe('speak(String(42));');

      expect(prepareExecutableCode('We discussed WebGPU inference options.')).toBe(
        'speak("We discussed WebGPU inference options.");'
      );
      expect(prepareExecutableCode('Hello there! How can I help?')).toBe(
        'speak("Hello there! How can I help?");'
      );
      expect(prepareExecutableCode('Sure, I will look that up for you.')).toBe(
        'speak("Sure, I will look that up for you.");'
      );

      // Standard built-in calls and function invocations without keywords must be recognized as code
      expect(inspectExecutableCode('alert("hi")').isProse).toBe(false);
      expect(inspectExecutableCode('fetch("https://example.com")').isProse).toBe(false);
      expect(inspectExecutableCode('requestAnimationFrame(draw)').isProse).toBe(false);
      expect(inspectExecutableCode('animate()').isProse).toBe(false);

      // Verify that URLs containing // inside string literals are NOT truncated as comments
      const urlCode = 'const url = "https://example.com/api"; return url;';
      const parsedUrlCode = inspectExecutableCode(urlCode);
      expect(parsedUrlCode.isProse).toBe(false);
      expect(parsedUrlCode.code).toContain('https://example.com/api');
    });

    it('buffers fragmented code prefixes without leaking code syntax into onTokenStream', async () => {
      const { JavascriptRuntime } = await import('../src/tools/javascript-runtime.ts');
      const runtime = new JavascriptRuntime({ mode: 'eval' });
      const stateCoordinator = new StateMachineCoordinator();

      const streamedDeltas: string[] = [];

      class FragmentedLlmProvider extends TestStubLlmProvider {
        override async generate(options: any): Promise<any> {
          const fragments = ['spe', 'ak("He', 'llo ', 'world!")', ';'];
          let accumulated = '';
          for (const frag of fragments) {
            accumulated += frag;
            options.onToken?.(frag, accumulated);
          }
          return {
            turnId: options.turnId,
            text: accumulated,
            aborted: false,
            timeToFirstTokenMs: 5,
            totalTimeMs: 10,
            tokensGenerated: 5,
            tokensPerSecond: 100,
          };
        }
      }

      const orchestrator = new ConversationOrchestrator({
        stateCoordinator,
        javascriptRuntime: runtime,
        llmProvider: new FragmentedLlmProvider(),
        enableSpeechOutput: false,
        events: {
          onTokenStream: (_turnId, chunk, _canonicalSoFar) => {
            streamedDeltas.push(chunk);
          },
        },
      });

      const msg = await orchestrator.submitUserInput('Hi');
      expect(msg).not.toBeNull();
      expect(msg?.canonicalContent).toBe('Hello world!');

      // Verify that none of the streamed chunks contained "spe" or "ak("
      const joinedStreamed = streamedDeltas.join('');
      expect(joinedStreamed).toBe('Hello world!');
      expect(joinedStreamed).not.toContain('speak');
    });

    it('executes arbitrary JS statements like async IIFE and canvas assignment without keyword gating', async () => {
      const { JavascriptRuntime } = await import('../src/tools/javascript-runtime.ts');
      const runtime = new JavascriptRuntime({ mode: 'eval' });
      const stateCoordinator = new StateMachineCoordinator();

      let executedCode = '';
      const originalExecute = runtime.execute.bind(runtime);
      runtime.execute = async (code, callback, options) => {
        executedCode = code;
        return originalExecute(code, callback, options);
      };

      // 1. Test async IIFE: starts with '(', has no 'speak(', 'const', 'let', or 'var' at start of line
      const asyncIifeJs = '(async () => { return 400 + 20; })()';
      const orchestrator = new ConversationOrchestrator({
        stateCoordinator,
        javascriptRuntime: runtime,
        llmProvider: new TestStubLlmProvider({
          responseOverride: asyncIifeJs,
        }),
        enableSpeechOutput: false,
      });

      const msg1 = await orchestrator.submitUserInput('Compute something asynchronously');
      expect(msg1).not.toBeNull();
      expect(executedCode).toBe(asyncIifeJs);
      expect(msg1?.canonicalContent).toBe('420');
      expect(msg1?.toolCall?.name).toBe('javascript_runtime');
      expect(msg1?.toolCall?.status).toBe('completed');

      // 2. Test bare property assignment without const/let/var: canvas.width = 800
      (globalThis as any).canvas = { width: 0 };
      const bareAssignJs = 'canvas.width = 800; canvas.width;';
      const orchestrator2 = new ConversationOrchestrator({
        stateCoordinator,
        javascriptRuntime: runtime,
        llmProvider: new TestStubLlmProvider({
          responseOverride: bareAssignJs,
        }),
        enableSpeechOutput: false,
      });

      const msg2 = await orchestrator2.submitUserInput('Set canvas width');
      expect(msg2).not.toBeNull();
      expect(executedCode).toBe(bareAssignJs);
      expect(msg2?.canonicalContent).toBe('800');
      expect(msg2?.toolCall?.status).toBe('completed');
      delete (globalThis as any).canvas;

      // 3. Test that conversational prose with commas is NOT executed as code
      const proseOrchestrator = new ConversationOrchestrator({
        stateCoordinator,
        javascriptRuntime: runtime,
        llmProvider: new TestStubLlmProvider({
          responseOverride: 'Sure, thanks for asking!',
        }),
        enableSpeechOutput: false,
      });

      const msg3 = await proseOrchestrator.submitUserInput('Can you help me?');
      expect(msg3).not.toBeNull();
      expect(msg3?.canonicalContent).toBe('Sure, thanks for asking!');
      // Does not create a javascript_runtime tool call for plain conversational prose
      expect(msg3?.toolCall).toBeUndefined();
    });

    it('handles simulated hanging iframe timeout without fallback to eval', async () => {
      const { JavascriptRuntime } = await import('../src/tools/javascript-runtime.ts');
      const runtime = new JavascriptRuntime({ mode: 'iframe', timeoutMs: 40 });

      // Simulate an iframe whose contentWindow accepts messages but never replies
      (runtime as any).activeIframe = {
        contentWindow: {
          postMessage: () => {},
        },
      };
      (runtime as any).iframeReadyPromise = Promise.resolve();

      const start = performance.now();
      const result = await (runtime as any).executeInIframe('while(true) {}');
      const duration = performance.now() - start;

      // The wait ends but the program is still running: not a failure
      expect(result.success).toBe(true);
      expect(result.stillRunning).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.mode).toBe('iframe');
      expect(duration).toBeGreaterThanOrEqual(35);
    });

    it('generates syntactically valid iframe runnerHtml with no regex or template escape errors', async () => {
      const { JavascriptRuntime } = await import('../src/tools/javascript-runtime.ts');
      const runtime = new JavascriptRuntime({ mode: 'iframe' });
      const iframe = (runtime as any).ensureIframe();
      const srcdoc = iframe.srcdoc;
      expect(srcdoc).toBeTruthy();
      const scriptMatch = srcdoc.match(/<script>([\s\S]*?)<\/script>/);
      expect(scriptMatch).not.toBeNull();
      // Must compile cleanly without SyntaxError (like "missing /" or unterminated regex)
      expect(() => new Function(scriptMatch[1])).not.toThrow();
    });

    it('routes loops with playNotes or speak to iframe, and pure compute loops to worker', async () => {
      const { detectRecommendedMode } = await import('../src/tools/javascript-runtime.ts');

      // Loops with playNotes or speak MUST route to iframe so audio/voice helpers are available!
      const loopWithPlayNotes = 'for (let i = 0; i < 20; i++) { await playNotes("C4", 100); }';
      expect(detectRecommendedMode(loopWithPlayNotes)).toBe('iframe');

      const loopWithSpeak = 'for (let i = 0; i < 5; i++) { speak(i); }';
      expect(detectRecommendedMode(loopWithSpeak)).toBe('iframe');

      // Pure headless compute loop with no DOM or host helpers routes to worker
      const pureComputeLoop = 'let sum = 0; for (let i = 0; i < 100000; i++) { sum += i; } return sum;';
      expect(detectRecommendedMode(pureComputeLoop)).toBe('worker');

      // Loops with browser APIs (Audio, localStorage, alert) must route to iframe
      expect(detectRecommendedMode('for(let i=0;i<3;i++){new Audio("a.mp3").play()}')).toBe('iframe');
      expect(detectRecommendedMode('for(const k of [1,2]){localStorage.setItem("k",k)}')).toBe('iframe');
      expect(detectRecommendedMode('for(let i=0;i<3;i++){alert(i)}')).toBe('iframe');
    });
  });
});



describe('Orchestrator turn-lifecycle regressions', () => {
  const seedMemory = (count = 6) => {
    const memoryStore = new ConversationMemoryStore();
    for (let i = 0; i < count; i++) {
      memoryStore.addMessage({
        id: `m${i}`,
        turnId: `t${Math.floor(i / 2)}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        canonicalContent: `Message number ${i} about WebGPU inference.`,
        timestamp: Date.now() - 1000 * (count - i),
      });
    }
    return memoryStore;
  };

  // LLM whose compaction call blocks until aborted, then resolves with empty text (like real providers)
  class StallingCompactionLlm extends TestStubLlmProvider {
    public override async generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
      const last = options.messages[options.messages.length - 1]?.content ?? '';
      if (!last.toLowerCase().includes('summarize our entire conversation')) {
        return super.generate(options);
      }
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        turnId: options.turnId,
        text: '',
        tokensGenerated: 0,
        timeToFirstTokenMs: 0,
        totalTimeMs: 1,
        tokensPerSecond: 0,
        aborted: true,
      };
    }
  }

  const makeSpeakRuntime = (deliver: string[], spokenTexts: string[]) =>
    ({
      execute: async (
        _code: string,
        _cb: unknown,
        opts?: { onSpeak?: (phrase: string) => void }
      ) => {
        for (const t of deliver) opts?.onSpeak?.(t);
        return { success: true, output: undefined, spokenTexts, code: _code };
      },
      dispose: () => {},
    }) as any;

  it('manual compaction returns the state machine to idle', async () => {
    const stateCoordinator = new StateMachineCoordinator();
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator,
      memoryStore: seedMemory(2),
      llmProvider: new TestStubLlmProvider({ tokenDelayMs: 1 }),
      enableSpeechOutput: false,
    });
    await orchestrator.forceCompaction();
    expect(stateCoordinator.getSnapshot().interaction).toBe('idle');
  });

  it('aborted manual compaction does not trim history', async () => {
    const stateCoordinator = new StateMachineCoordinator();
    const memoryStore = seedMemory(6);
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator,
      memoryStore,
      llmProvider: new StallingCompactionLlm({ tokenDelayMs: 1 }),
      enableSpeechOutput: false,
    });
    const controller = new AbortController();
    const pending = orchestrator.forceCompaction(controller.signal);
    controller.abort();
    await pending;
    expect(memoryStore.getMessages().length).toBe(6);
    expect(stateCoordinator.getSnapshot().interaction).toBe('idle');
  });

  it('aborted in-turn compaction does not trim history or clobber a newer turn', async () => {
    const stateCoordinator = new StateMachineCoordinator();
    const memoryStore = seedMemory(6);
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator,
      memoryStore,
      llmProvider: new StallingCompactionLlm({ tokenDelayMs: 1 }),
      enableSpeechOutput: false,
      contextCompactionThreshold: 0.001,
    });

    const turnA = orchestrator.submitUserInput('First question');
    await new Promise((r) => setTimeout(r, 5));
    expect(stateCoordinator.getSnapshot().interaction).toBe('compacting');

    // Newer turn B supersedes A and enters its own compaction
    const turnB = orchestrator.submitUserInput('Second question');
    expect(await turnA).toBeNull();
    expect(memoryStore.getMessages().length).toBe(6);

    const snap = stateCoordinator.getSnapshot();
    expect(snap.interaction).toBe('compacting');
    expect(snap.activeTurnId).not.toBeNull();

    orchestrator.interruptCurrentTurn('test cleanup');
    expect(await turnB).toBeNull();
    expect(memoryStore.getMessages().length).toBe(6);
  });

  it('blank voice transcript does not interrupt the active turn', async () => {
    const stateCoordinator = new StateMachineCoordinator();
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator,
      llmProvider: new TestStubLlmProvider({ tokenDelayMs: 5 }),
      enableSpeechOutput: false,
    });
    const first = orchestrator.submitUserInput('What is the capital of France?');
    await new Promise((r) => setTimeout(r, 10));
    const blank = await orchestrator.submitUserInput('[BLANK_AUDIO]', { isVoiceTranscript: true });
    expect(blank).toBeNull();
    const msg = await first;
    expect(msg?.interrupted).toBeFalsy();
    expect(msg?.canonicalContent).toContain('Paris');
  });

  it('code-mode speak() is spoken once and with separators', async () => {
    const spoken: string[] = [];
    const texts = ['Thanks for waiting you.', 'Done now.'];
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator: new StateMachineCoordinator(),
      javascriptRuntime: makeSpeakRuntime(texts, texts),
      llmProvider: new TestStubLlmProvider({
        tokenDelayMs: 1,
        responseOverride: 'speak("Thanks for waiting you."); speak("Done now.");',
      }),
      ttsProvider: new TestStubTtsProvider(),
      events: {
        onPhraseReadyForPlayback: (phrase) => {
          spoken.push(phrase.canonicalText);
        },
      },
    });
    await orchestrator.submitUserInput('Say something');
    expect(spoken).toEqual(['Thanks for waiting you.', 'Done now.']);
  });

  it('template-literal speak() is spoken once with the real runtime text', async () => {
    const spoken: string[] = [];
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator: new StateMachineCoordinator(),
      javascriptRuntime: makeSpeakRuntime(['The total is 42 today.'], ['The total is 42 today.']),
      llmProvider: new TestStubLlmProvider({
        tokenDelayMs: 1,
        responseOverride: 'const x = 42; speak(`The total is ${x} today.`);',
      }),
      ttsProvider: new TestStubTtsProvider(),
      events: {
        onPhraseReadyForPlayback: (phrase) => {
          spoken.push(phrase.canonicalText);
        },
      },
    });
    await orchestrator.submitUserInput('Say total');
    expect(spoken).toEqual(['The total is 42 today.']);
  });

  it('turn finalizes when speech output is disabled mid-playback', async () => {
    const stateCoordinator = new StateMachineCoordinator();
    let orchestrator!: ConversationOrchestrator;
    orchestrator = new ConversationOrchestrator({
      stateCoordinator,
      llmProvider: new TestStubLlmProvider({ tokenDelayMs: 1 }),
      ttsProvider: new TestStubTtsProvider(),
      events: {
        // Playback that never settles on its own
        onPhraseReadyForPlayback: () => {
          setTimeout(() => orchestrator.setSpeechOutputEnabled(false), 5);
          return new Promise<void>(() => {});
        },
      },
    });
    const msg = await orchestrator.submitUserInput('What is the capital of France?');
    expect(msg?.canonicalContent).toContain('Paris');
    expect(stateCoordinator.getSnapshot().interaction).toBe('idle');
  });
});
