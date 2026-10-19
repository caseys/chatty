## Plan addendum: Conversation Quality and Orchestration

The following can be appended to the existing plan. It adds a layer above the model runtimes without replacing them.

# Addendum: Conversation Orchestration and Response Quality

## 1. Objective

Add a first-class conversation layer responsible for producing coherent, context-aware, natural responses. Keep this layer independent of the specific STT, LLM, and TTS implementations.

The orchestrator must support fully local inference, incremental text and speech, interruption, conversation memory, and recoverable failures. It must not require a server-side agent runtime.

## 2. Architecture

Introduce a `ConversationOrchestrator` between the UI/controller and the STT, LLM, and TTS workers.

Responsibilities:

- Maintain the authoritative conversation state and message history.
- Manage turn-taking, end-of-turn detection, and interruption.
- Build the model's context for each turn.
- Select the appropriate response strategy.
- Stream generated text to the UI and TTS subsystem.
- Manage cancellation, stale results, timeouts, and resource contention.
- Persist conversation history and summaries locally.
- Record quality and latency metrics for evaluation.

The orchestrator should be a deterministic TypeScript module. Model inference remains in dedicated workers wherever the runtime supports it.

## 3. Turn-processing pipeline

For each user turn:

1. **Capture and normalize input.** Receive the finalized transcript, preserve the original transcript, and apply conservative normalization for punctuation, capitalization, and speech-recognition artifacts. Do not silently change the user's intended meaning.
2. **Resolve context.** Identify relevant prior turns, references such as "that one" or "what about the second option?", applicable conversation summaries, and explicitly saved user preferences.
3. **Build the prompt.** Apply a concise system instruction, the model's native chat template, relevant conversation history, and the current user message. Respect the model's actual context window.
4. **Choose a response mode.** Default to direct answering. Use clarification when necessary, lightweight verification when a factual claim warrants it, and tool execution only when a supported tool is genuinely needed.
5. **Generate incrementally.** Stream text as it becomes available. Keep internal reasoning and orchestration metadata out of user-visible output.
6. **Speak in phrases.** Send completed, speech-ready phrase segments to TTS without waiting for the entire answer. Avoid splitting sentences, abbreviations, or numbers in ways that sound unnatural.
7. **Finalize the turn.** Commit the completed assistant response, update the working conversation state, and schedule any necessary summary or memory updates.

## 4. Conversation state and concurrency

Use explicit states rather than loosely coordinated Boolean flags.

Suggested states:

- `idle`
- `listening`
- `finalizing_input`
- `building_context`
- `generating`
- `speaking`
- `interrupted`
- `recovering`
- `error`

Represent the active turn with a unique `turnId` and cancellation signal. Every worker request and response must carry its turn ID and, where applicable, a sequence number.

When the user interrupts speech:

- Stop current playback immediately.
- Cancel or invalidate the current generation when supported.
- Discard late results belonging to the cancelled turn.
- Preserve the text already spoken or shown, with an explicit indication that the response was interrupted.
- Start the next turn without waiting for obsolete work to finish.

Use bounded queues and backpressure. Never allow TTS backlog or speculative model work to degrade microphone responsiveness.

The state machine describes the user-facing interaction. Worker lifecycle, model-loading state, and resource scheduling should remain separate concerns.

## 5. Context and memory

Implement three distinct memory layers:

**Working context:** Recent messages retained verbatim for reference resolution and conversational continuity.

**Conversation summary:** A compact, updated summary of older turns when the conversation exceeds the preferred context budget. Preserve decisions, unresolved questions, named entities, and important constraints rather than summarizing every turn equally.

**Long-term local memory:** Explicitly approved user preferences or facts that are useful across conversations. Keep this separate from the transcript and allow inspection, correction, and deletion.

Memory retrieval must be selective. Do not append the entire local history to every prompt. Prefer relevant excerpts and concise summaries, with a clear precedence rule when newer statements contradict older ones.

Do not infer a durable preference from a single ambiguous statement. Do not treat model-generated summaries as authoritative without validation.

## 6. Response-quality policy

Optimize for usefulness and coherence, not merely time to first token.

- Prefer a strong supported local model over an elaborate prompt wrapped around a weak model.
- Use the model's documented chat template and appropriate generation settings.
- Keep system instructions concise, explicit, and non-contradictory.
- Answer the user's actual question before adding tangential detail.
- Resolve pronouns and references from context where possible.
- Ask a concise clarification when ambiguity materially changes the answer.
- Avoid repeating information already established in the conversation.
- Distinguish known facts from uncertainty; do not fabricate sources, tool results, or remembered details.
- Use a verification pass selectively for high-impact factual answers or tasks that benefit from structured checking. Do not impose a second generation on every casual turn.
- Do not fine-tune until a repeatable evaluation set identifies specific failures that prompting, context construction, or decoding cannot adequately address.

## 7. Speech-aware generation

Text quality and spoken delivery should be coordinated without forcing the LLM to generate audio-specific markup in every response.

Maintain separate representations for:

- The canonical assistant response shown in chat.
- The speech-ready text sent to TTS.
- Phrase boundaries and playback status.

Speech normalization may expand abbreviations or format numbers for pronunciation, but must not alter the canonical response.

Start TTS when a phrase is sufficiently complete. Buffer enough audio to avoid choppy playback, while keeping interruption latency low. Support text-only output when TTS fails.

## 8. Model and runtime abstraction

Define a small provider-neutral interface around the LLM runtime. It should support, where available:

- Streaming text generation.
- Cancellation.
- Configurable generation parameters.
- Model capability and context-limit metadata.
- Structured output or tool calls when supported.
- Explicit runtime errors and timing metrics.

Do not assume all local runtimes implement the same features. Detect capabilities and use graceful fallbacks.

The orchestrator must not depend on a particular vendor's agent framework, model API, or message format internally.

## 9. Evaluation

Create a fixed conversation-quality test suite before tuning prompts or changing models. Include:

- Multi-turn context retention.
- Reference resolution and follow-up questions.
- Instruction adherence and correction handling.
- Contradictory or incomplete user input.
- Concision, relevance, and conversational naturalness.
- Factual accuracy on questions with known answers.
- Speech pronunciation and phrase-boundary quality.
- Interruption and recovery behavior.
- Memory correctness and resistance to stale context.
- Latency, memory consumption, and cancellation responsiveness.

Evaluate each candidate model and orchestration change against the same cases. Track quality and latency separately; do not accept a quality regression merely because generation starts sooner.

## 10. Implementation sequence

1. Implement the orchestrator, turn IDs, cancellation, and explicit interaction state.
2. Add prompt construction, context selection, and multi-turn tests.
3. Add bounded streaming from LLM to UI and phrase-level TTS.
4. Add conversation summaries and user-approved local memory.
5. Add selective verification and structured tool execution only where useful.
6. Benchmark alternative model runtimes and tune against the evaluation suite.

## Acceptance criteria

- A new user turn can interrupt active speech without stale audio or text leaking into the next turn.
- Follow-up questions resolve references from relevant prior conversation.
- Context remains useful as conversations grow without sending the entire transcript on every turn.
- Speech begins before the full response is generated when the runtime and TTS permit it.
- Failures in STT or TTS do not corrupt conversation history or permanently block the interaction.
- Quality improvements are measured against a repeatable multi-turn benchmark.
- The conversation layer can be tested independently of the specific model runtimes.

## One architectural decision I would make now

Keep the orchestrator small and local, with a clear interface to the LLM worker. Avoid implementing a general-purpose autonomous agent framework unless the product later needs complex tool use, planning, or multi-step workflows.

The highest-value quality improvements are likely to come from context construction, reference resolution, model selection, and turn management—not from adding more layers of agent abstraction. A library can help with individual pieces, but no candidate above removes the need for our custom voice-turn lifecycle.

There are useful building blocks that night help:

[Vercel AI SDK Logo PNG Vector (SVG) Free Download](https://images.openai.com/static-rsc-4/HsW3d8YEPPhLYrecMnxwdu9B769HQghdnpzcsNGyfUIQcatjLEjqoKbFYN2cFQRtvnwiQyIjBleZ8AMyWcNxekXBU4Nf4orX6ujX9cfCEsMugYbGo0KFNMVVlU7J8PqBB8zWlN0gddM1GV76y6Yt3r_9gqox5z8Q0kz1pTy2aNk?purpose=inline)

Vercel AI SDK + @browser-ai

Worth evaluating

Useful abstractions for streaming text, model-provider adapters, and tool calls. `@browser-ai` bridges the SDK to browser-local model runtimes such as Transformers.js and WebLLM. It is primarily an AI application layer, not a complete voice-conversation orchestrator.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://www.browser-ai.dev\&sz=32)

Browser AI

+2

[Browser AI documentation](https://www.browser-ai.dev/?utm_source=chatgpt.com) · [AI SDK documentation](https://ai-sdk.dev/?utm_source=chatgpt.com)

[xstate](https://images.openai.com/static-rsc-4/IZ4AxBUL-_1d23OaOFYFN7Qf3Ay9lqYU6-oiz2WaJr3Ej2QIVI4prX-kS7p4XVv08Q0vl3EnRPZy_xvfHE1NmWAJ42djvpPRvbO7DGvuNosDgJ75ScWjujhKCy5C8TYJ1yApYSGXFsr5lzIzgTGI63Jy2p6rPq67EslzoJMRGq8?purpose=inline)

XState

A candidate for managing explicit interaction states, cancellation, and transitions. It is not a conversation-quality framework, but could help implement the control layer without inventing our own state-machine conventions.

[XState documentation](https://stately.ai/docs?utm_source=chatgpt.com)

My recommendation: build a small, purpose-specific conversation orchestrator, borrowing useful abstractions from existing libraries rather than letting a framework dictate the architecture. Our key requirements—interruptible speech, partial transcripts, local memory, response streaming, and coordinated STT/LLM/TTS—are more specialized than a typical text-chat agent loop.
