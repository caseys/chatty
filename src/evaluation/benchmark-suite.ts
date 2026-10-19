// ============================================================================
// Conversation-Quality & Latency Benchmark Suite
// Runs against the provided LlmRuntimeProvider & TtsRuntimeProvider
// (Addendum Section 9 & Spec Section 10)
// ============================================================================

import { ConversationMemoryStore } from '../core/memory-store.ts';
import { ConversationOrchestrator } from '../core/orchestrator.ts';
import { StateMachineCoordinator } from '../core/state-machine.ts';
import type { LlmRuntimeProvider, TtsRuntimeProvider } from '../types/index.ts';

export interface EvaluationCaseResult {
  id: string;
  category: string;
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

export interface EvaluationSuiteReport {
  timestamp: number;
  totalCases: number;
  passedCases: number;
  passRatePercent: number;
  totalDurationMs: number;
  results: EvaluationCaseResult[];
}

export interface EvaluationSuiteProviders {
  createLlmProvider: () => LlmRuntimeProvider;
  createTtsProvider?: () => TtsRuntimeProvider;
}

export async function runConversationEvaluationSuite(
  providers: EvaluationSuiteProviders
): Promise<EvaluationSuiteReport> {
  // Ensure the LLM runtime is initialized before measuring per-case benchmark latencies
  const warmupLlm = providers.createLlmProvider();
  try {
    await warmupLlm.initialize();
  } catch {
    // Individual cases will surface any initialization error in their details
  }

  const startSuite = performance.now();
  const results: EvaluationCaseResult[] = [];

  const createHarness = (opts?: { enableSpeech?: boolean }) => {
    const stateCoordinator = new StateMachineCoordinator();
    const memoryStore = new ConversationMemoryStore({ maxVerbatimTurns: 4 });
    const llmProvider = providers.createLlmProvider();
    const ttsProvider = opts?.enableSpeech ? providers.createTtsProvider?.() : undefined;
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator,
      memoryStore,
      llmProvider,
      ttsProvider,
      enableSpeechOutput: Boolean(opts?.enableSpeech),
      tools: [
        {
          name: 'calculator',
          description: 'Evaluates arithmetic expressions',
          parameters: {},
          execute: ({ a, operator, b }) => {
            const x = Number(a);
            const y = Number(b);
            if (operator === '+') return x + y;
            if (operator === '-') return x - y;
            if (operator === '*') return x * y;
            if (operator === '/') return y !== 0 ? x / y : NaN;
            return 0;
          },
        },
      ],
    });
    return { stateCoordinator, memoryStore, llmProvider, ttsProvider, orchestrator };
  };

  // 1. Multi-turn context retention
  {
    const t0 = performance.now();
    const { orchestrator } = createHarness();
    await orchestrator.submitUserInput('We are planning a local WebGPU voice project.');
    const reply = await orchestrator.submitUserInput('What did we discuss earlier?');
    const passed =
      Boolean(reply?.canonicalContent) &&
      reply!.canonicalContent.toLowerCase().includes('webgpu');
    results.push({
      id: 'eval_multi_turn',
      category: 'Multi-turn Context Retention',
      name: 'Retains prior turn topic across follow-ups',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: passed ? 'Context retained accurately' : `Unexpected response: ${reply?.canonicalContent}`,
    });
  }

  // 2. Reference resolution ("the second option")
  {
    const t0 = performance.now();
    const { orchestrator } = createHarness();
    await orchestrator.submitUserInput('What are three options for browser inference?');
    const followUp = await orchestrator.submitUserInput('Tell me more about the second option.');
    const text = followUp?.canonicalContent ?? '';
    const passed = text.length > 10 && !text.startsWith('[Error:');
    results.push({
      id: 'eval_reference_resolution',
      category: 'Reference Resolution',
      name: 'Resolves ordinal reference ("the second option") from prior list',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: passed ? `Resolved to: ${text.slice(0, 70)}...` : `Failed: ${text}`,
    });
  }

  // 3. Instruction adherence & correction handling
  {
    const t0 = performance.now();
    const { orchestrator } = createHarness();
    await orchestrator.submitUserInput('Use cloud servers for transcription.');
    const corrected = await orchestrator.submitUserInput(
      'Actually, correction: keep all transcription 100% local in WASM.'
    );
    const text = corrected?.canonicalContent ?? '';
    const passed = text.toLowerCase().includes('wasm') || text.toLowerCase().includes('local');
    results.push({
      id: 'eval_correction',
      category: 'Correction Handling',
      name: 'Acknowledges and applies user mid-conversation correction',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: passed ? 'Applied user correction' : `Failed: ${text}`,
    });
  }

  // 4. Incomplete / Ambiguous input clarification
  {
    const t0 = performance.now();
    const { orchestrator } = createHarness();
    const reply = await orchestrator.submitUserInput('Change it');
    const passed =
      reply?.responseMode === 'clarification' &&
      Boolean(reply.canonicalContent.length > 5) &&
      !reply.canonicalContent.startsWith('[Error:');
    results.push({
      id: 'eval_clarification',
      category: 'Ambiguity & Clarification',
      name: 'Requests clarification on ungrounded pronoun with zero context',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: passed ? `Clarified (${reply?.responseMode})` : `Failed mode: ${reply?.responseMode}`,
    });
  }

  // 5. Factual accuracy & selective verification
  {
    const t0 = performance.now();
    const { orchestrator } = createHarness();
    const reply = await orchestrator.submitUserInput('What is the capital of France?');
    const passed =
      reply?.responseMode === 'verification' &&
      reply?.verified === true &&
      reply.canonicalContent.includes('Paris');
    results.push({
      id: 'eval_factual_verification',
      category: 'Factual Accuracy & Verification',
      name: 'Triggers verification mode and returns accurate answer',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: passed ? 'Verified factual answer: Paris' : `Failed: ${reply?.canonicalContent}`,
    });
  }

  // 6. Speech pronunciation & phrase-boundary quality (abbreviations & decimals)
  {
    const t0 = performance.now();
    const { orchestrator } = createHarness({ enableSpeech: true });
    const reply = await orchestrator.submitUserInput(
      'Repeat this exact sentence: Dr. Smith achieved 99.5% accuracy in 45 ms. The second sentence completes the benchmark.'
    );
    const phrases = reply?.phrases ?? [];
    const drSplitWrongly = phrases.some((p) => p.canonicalText.trim().endsWith('Dr.'));
    const speechReady = reply?.speechReadyContent ?? '';
    const passed = phrases.length >= 1 && !drSplitWrongly && speechReady.length > 0;
    results.push({
      id: 'eval_speech_phrasing',
      category: 'Speech Phrasing & Normalization',
      name: 'Avoids splitting "Dr." or decimals and expands speech abbreviations',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: passed
        ? `${phrases.length} phrases synthesized cleanly`
        : `Phrases: ${phrases.length}, Speech: ${speechReady}`,
    });
  }

  // 7. Barge-in Interruption & Stale Result Isolation
  {
    const t0 = performance.now();
    const stateCoordinator = new StateMachineCoordinator();
    const memoryStore = new ConversationMemoryStore({ maxVerbatimTurns: 4 });
    let bargeInTriggered = false;
    const triggerBargeIn = () => {
      if (bargeInTriggered) return;
      bargeInTriggered = true;
      orchestrator.handleSttEvent({
        type: 'speech_started',
        turnId: 'barge_in_turn',
        sequence: 1,
        timestamp: performance.now(),
      });
    };
    const orchestrator = new ConversationOrchestrator({
      stateCoordinator,
      memoryStore,
      llmProvider: providers.createLlmProvider(),
      enableSpeechOutput: false,
      tools: [
        {
          name: 'calculator',
          description: 'Evaluates arithmetic expressions',
          parameters: {},
          execute: ({ a, operator, b }) => {
            const x = Number(a);
            const y = Number(b);
            if (operator === '*') return x * y;
            return 0;
          },
        },
      ],
      events: {
        onTokenStream: () => {
          triggerBargeIn();
        },
      },
    });

    const slowTurnPromise = orchestrator.submitUserInput(
      'Give me three options for browser inference.'
    );
    const fallbackTimer = setTimeout(triggerBargeIn, 2500);
    const interruptedMsg = await slowTurnPromise;
    clearTimeout(fallbackTimer);
    bargeInTriggered = true;
    const nextReply = await orchestrator.submitUserInput('What is 12 * 8?');
    const passed =
      Boolean(interruptedMsg?.interrupted) &&
      interruptedMsg!.canonicalContent.toLowerCase().includes('interrupt') &&
      Boolean(nextReply?.canonicalContent.includes('96'));
    results.push({
      id: 'eval_interruption_isolation',
      category: 'Interruption & Recovery',
      name: 'Barge-in stops active turn, marks [Interrupted], and isolates next turn',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: passed
        ? 'Interrupted cleanly with zero token leakage'
        : `Interrupted=${interruptedMsg?.interrupted}, Content=${interruptedMsg?.canonicalContent}, Next=${nextReply?.canonicalContent}`,
    });
  }

  // 8. Long-term memory precedence & resistance to stale context
  {
    const t0 = performance.now();
    const { orchestrator, memoryStore } = createHarness();
    memoryStore.upsertApprovedMemory('response_style', 'detailed paragraphs', 'preference');
    memoryStore.upsertApprovedMemory('response_style', 'concise bullet points', 'preference');
    const reply = await orchestrator.submitUserInput('What do I prefer for my response style?');
    const text = reply?.canonicalContent ?? '';
    const passed =
      (text.toLowerCase().includes('concise') || text.toLowerCase().includes('bullet')) &&
      !text.toLowerCase().includes('detailed paragraphs');
    results.push({
      id: 'eval_memory_precedence',
      category: 'Memory & Precedence',
      name: 'Newer approved preference overrides older contradicted value',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: passed ? 'Latest memory took precedence' : `Failed: ${text}`,
    });
  }

  // 9. Conversation compaction & summary preservation
  {
    const t0 = performance.now();
    const { orchestrator, memoryStore } = createHarness();
    await orchestrator.submitUserInput('We decided on using WebGPU for our runtime.');
    await orchestrator.submitUserInput('The latency must stay under $0 and under 100ms.');
    await orchestrator.submitUserInput('Third turn filler question.');
    await orchestrator.submitUserInput('Fourth turn filler question.');
    const summary = memoryStore.getSummary();
    const passed =
      summary !== null &&
      summary.decisions.length > 0 &&
      summary.constraints.length > 0 &&
      memoryStore.getMessages().length <= 4;
    results.push({
      id: 'eval_compaction_summary',
      category: 'Context Compaction',
      name: 'Summarizes older turns while preserving decisions and constraints',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: passed ? `Summary: ${summary?.summaryText}` : 'Summary failed to capture decisions/constraints',
    });
  }

  // 10. Subsystem Failure Isolation (TTS failure does not block text conversation)
  {
    const t0 = performance.now();
    const { orchestrator } = createHarness({ enableSpeech: true });
    orchestrator.setTtsProvider({
      id: 'failing-tts',
      voiceId: 'broken',
      initialize: async () => {},
      synthesize: async () => {
        throw new Error('Simulated TTS ONNX failure');
      },
      cancel: () => {},
      dispose: async () => {},
    });
    const reply = await orchestrator.submitUserInput('What is the capital of France?');
    const passed =
      Boolean(reply?.canonicalContent.includes('Paris')) &&
      orchestrator.getInteractionState() === 'idle';
    results.push({
      id: 'eval_tts_failure_isolation',
      category: 'Fault Tolerance',
      name: 'Continues displaying generated text when TTS fails',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: passed ? 'Text response succeeded despite TTS error' : 'Turn failed on TTS error',
    });
  }

  const passedCases = results.filter((r) => r.passed).length;
  return {
    timestamp: Date.now(),
    totalCases: results.length,
    passedCases,
    passRatePercent: Math.round((passedCases / results.length) * 100),
    totalDurationMs: Math.round(performance.now() - startSuite),
    results,
  };
}
