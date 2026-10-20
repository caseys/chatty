# High-Level Technical Specification: Fully Client-Side Voice Assistant

## 1. Project goals

Build a privacy-first conversational voice assistant that runs entirely in a standard web browser, without a backend inference service, API keys, or per-request operating costs.

The application should support:

- Local speech recognition, language-model inference, and speech synthesis.
- Streaming text and audio responses with low perceived latency.
- Natural interruption: the user can begin speaking while the assistant is responding.
- Adaptive model selection based on actual browser capabilities and available resources.
- Persistent local model caching and offline operation after initial downloads.
- Graceful degradation on browsers and devices that cannot run the full pipeline.
- A responsive interface that remains interactive during inference.

Architecture principle: the main thread coordinates the experience; dedicated Workers handle inference and processing where supported; a shared audio subsystem manages capture and playback. A scheduler coordinates resource-intensive tasks rather than assuming every stage can run at full speed simultaneously.

## 2. System architecture

### Browser UI + Conversation Controller

Conversation state · turn lifecycle · permissions · scheduling · cancellation

Message Bus + Resource Scheduler

Bounded queues · priorities · backpressure · request IDs

STT Worker

VAD · resampling · speech recognition · transcript events

LLM Worker

Prompt assembly · WebGPU inference · streamed tokens

TTS Worker

Text buffering · phonemization · speech synthesis

Model Manager

Model discovery · downloads · validation · storage

### Audio Subsystem

Microphone capture · AudioContext · PCM buffering · playback scheduling · interruption

The diagram represents logical components, not a requirement to create exactly four Workers. Worker placement should follow the capabilities and constraints of the selected libraries.

The main thread must never run a long synchronous inference or audio-processing operation. All stages communicate through asynchronous messages, transferable buffers where appropriate, and explicit lifecycle events.

## 3. Component specifications

### 3.1 Speech-to-text (STT)

Preferred candidate: Whistle by Cactus Compute, using the `cactus-needle` browser/WASM integration.

Whistle offers a compact speech-recognition model, word timestamps, and support for streaming audio in its underlying engine. Its browser integration must be validated separately from its native execution paths.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://huggingface.co\&sz=32)

Hugging Face

+1



Responsibilities:

- Capture microphone audio through `getUserMedia` and the Web Audio API.
- Resample audio to the recognizer's required format, initially targeting 16 kHz mono PCM.
- Perform voice activity detection (VAD) to detect speech onset, pauses, and utterance completion.
- Emit partial and finalized transcripts, with timestamps when available.
- Support configurable language selection and automatic detection only where supported by the engine.
- Release audio buffers promptly and avoid unnecessary copies.

The STT Worker should emit structured events rather than raw strings alone:

- `speech_started`
- `partial_transcript`
- `final_transcript`
- `speech_ended`
- `error`

The controller should distinguish a partial transcript from a committed user message. Partial results may inform the UI, but must not trigger duplicate LLM responses.

### 3.2 Large language model (LLM)

Preferred candidate: LiteRT-LM JavaScript API, running a web-compatible Gemma model through WebGPU.

Google documents browser inference and streamed text generation through `@litert-lm/core`. The web API is an early-preview technology, so the initial implementation must verify its actual model compatibility, Worker deployment, cancellation behavior, and performance.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://developers.google.cn\&sz=32)

Google for Developers

+2



Responsibilities:

- Maintain the active conversation and construct prompts.
- Accept finalized user transcripts and optional typed messages.
- Generate responses incrementally.
- Send text chunks to the UI and TTS pipeline as they become available.
- Enforce context-window and output-token limits.
- Support cancellation, reset, and conversation-history trimming.
- Dispose of model resources when changing models or recovering from failures.

Initial model strategy:

- Small: Gemma 4 E2B, where compatible.
- Standard: Gemma 4 E4B, where compatible.
- Fallback: a smaller validated model or text-only mode if the preferred runtime cannot initialize.

The model registry must identify the exact artifact, quantization, runtime version, context configuration, license, and supported browser deployment. Do not assume that similarly named model variants are interchangeable.

The LLM Worker should expose a stable interface independent of the chosen engine. This makes it possible to replace LiteRT-LM later without rewriting the conversation controller.

### 3.3 Text-to-speech (TTS)

Preferred candidate: Piper-compatible speech synthesis through a browser-compatible ONNX Runtime Web or sherpa-onnx implementation.

The exact library and model combination must be selected based on verified browser support, voice quality, model size, phonemization dependencies, and incremental synthesis capabilities.

Responsibilities:

- Accept text chunks from the LLM.
- Buffer text until a suitable phrase boundary.
- Convert text into phonemes using a compatible local phonemizer.
- Generate speech locally.
- Return PCM audio chunks and their format metadata.
- Support cancellation and discard pending audio for interrupted turns.

The TTS interface should support incremental production even if the initial implementation synthesizes one complete phrase at a time. Do not require every backend to provide sample-by-sample streaming.

Voice assets should be independent of the LLM model registry, allowing users to change voices without redownloading the language model.

### 3.4 Audio subsystem

The audio subsystem owns microphone capture and output playback.

Responsibilities:

- Maintain a coordinated `AudioContext` lifecycle.
- Handle permission requests and browser autoplay restrictions.
- Manage audio capture, resampling, and playback buffers.
- Schedule consecutive PCM chunks without gaps where possible.
- Handle device changes, suspension, resumption, and page visibility changes.
- Stop playback immediately when a response is interrupted.

Prefer one shared audio controller over independent playback logic in each Worker. Workers process audio data; the browser's audio subsystem manages actual device access and playback.

### 3.5 Model manager

The model manager handles model discovery, download, verification, caching, and initialization.

Each model artifact should have a manifest containing:

- Unique model ID and version.
- Download URL and expected size.
- Integrity hash.
- Runtime compatibility and required capabilities.
- Quantization and expected memory requirements.
- Supported languages and task capabilities.
- License and attribution information.

Model loading should be an explicit lifecycle, not a side effect of opening the chat screen.

## 4. Adaptive hardware and model selection

The application should choose its model at runtime using a combination of capability detection, resource estimates, and empirical benchmarks.

| Device profile               | Initial strategy                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Constrained mobile           | Smallest validated model; conservative context and output limits                          |
| Typical mobile / laptop      | E2B-class model if it meets latency and memory budgets                                    |
| High-memory desktop          | E4B-class model or a larger validated alternative                                         |
| Unsupported or failed WebGPU | Smaller compatible backend if available; otherwise text-only or a clear unsupported state |

These are starting strategies, not fixed hardware guarantees.

### Initialization procedure

1. Detect required browser APIs and WebGPU availability.
2. Query GPU limits, including storage-buffer binding limits.
3. Check storage quota and persistent-storage availability.
4. Select candidates using model metadata and conservative memory estimates.
5. Load the candidate and run a short inference test.
6. Measure initialization time and generation throughput.
7. Fall back to a smaller candidate if loading or performance checks fail.

Account for model weights, KV cache, temporary tensors, runtime allocations, and other active pipeline stages. Do not use `navigator.deviceMemory` or a GPU buffer limit as the sole indicator of model capacity.

Store successful capability and benchmark results locally where appropriate, but revalidate after browser, runtime, or model changes.

## 5. Streaming and scheduling

The application must support a pipeline in which the LLM can generate text while TTS is synthesizing and playing an earlier phrase.

### Text and audio flow

Finalized user transcript

LLM inference → streamed text chunks

Sentence buffer → ready-to-speak phrases

Text stream

Render tokens as they arrive

Speech stream

Synthesize and queue phrases

AudioContext playback with interruption support

### Queue policy

Every queue must be bounded.

- LLM generation should be throttled or paused when downstream processing falls behind, where the runtime permits.
- TTS should maintain a small amount of audio ahead of playback rather than buffering the entire response.
- Audio capture must not be starved by model inference.
- Canceled turns must not leave pending text, audio, or callbacks that affect subsequent turns.
- Large audio buffers should use transferable `ArrayBuffer` objects when ownership can safely be transferred.

Use request and turn identifiers in every message so the controller can reject stale results.

### Interruption policy

When the user interrupts the assistant:

1. Cancel active LLM generation.
2. Cancel pending TTS work.
3. Clear queued audio and stop scheduled playback.
4. Preserve or reset microphone capture as appropriate.
5. Start a new turn without waiting for obsolete tasks to finish.
6. Ignore any late results from the canceled turn.

Test whether each selected inference runtime supports true cancellation. If not, define how the controller isolates stale work and prevents it from blocking the next response.

## 6. Storage, downloads, and offline operation

Use separate storage mechanisms for different purposes.

| Storage       | Responsibility                                                 |
| ------------- | -------------------------------------------------------------- |
| Cache Storage | Application shell and versioned static assets                  |
| OPFS          | Large model artifacts and binary files, where supported        |
| IndexedDB     | Manifests, download state, settings, and conversation metadata |

### Download lifecycle

Model downloads should be independent of chat initialization.

1. Show the selected model, download size, and required storage.
2. Download in resumable chunks where the server and browser support it.
3. Track download progress and persist the completed-chunk manifest.
4. Verify the artifact's integrity before loading it.
5. Move or finalize it into its persistent location.
6. Initialize the model and run a small inference test.
7. Mark the model as ready for offline use only after successful validation.

Handle interrupted downloads, insufficient storage, corrupted artifacts, quota failures, and competing tabs. Use a cross-tab coordination mechanism to avoid downloading or initializing the same model unnecessarily.

### Storage lifecycle

- Request persistent storage when appropriate.
- Check `navigator.storage.estimate()` before large downloads.
- Allow users to remove downloaded models and voices.
- Keep the active model available when possible during model upgrades.
- Avoid retaining duplicate versions unnecessarily.
- Do not assume cached files are permanently retained by the browser.

Offline requirement: after the application shell and all required models are downloaded, the complete voice interaction loop must work without network access. Verify this by testing with the network disabled, not merely by checking that models exist in storage.

## 7. Conversation state and lifecycle management

Represent the application as coordinated state machines rather than unrelated Boolean flags.

Maintain separate state for:

- Conversation turn: idle, processing input, generating, completed, canceled, or failed.
- Microphone: unavailable, requesting permission, listening, or stopped.
- Playback: stopped, buffering, playing, or interrupted.
- Model runtime: unloaded, downloading, initializing, ready, or failed.
- Application lifecycle: foregrounded, backgrounded, or recovering.

The UI should derive its presentation from these states.

Every turn needs a unique ID and cancellation signal. Workers should have explicit initialization, shutdown, and recovery protocols. A crashed Worker must not leave the application permanently stuck in a loading state.

Conversation history should be bounded by the selected model's context budget. Implement history trimming and, if needed, local summarization without assuming that a summary preserves every detail of the original conversation.

## 8. Privacy and security

The application should operate without transmitting microphone audio, transcripts, prompts, or generated responses to a server.

Requirements:

- Request microphone access only after an explicit user action.
- Keep audio and inference processing local.
- Do not add remote analytics containing conversation content.
- Avoid logging raw audio, transcripts, prompts, or responses.
- Explain that model and application downloads require network access on first use.
- Make stored conversation history and downloaded assets manageable by the user.
- Validate model artifacts before execution or loading.
- Pin and audit runtime dependencies.
- Apply a restrictive Content Security Policy and appropriate cross-origin isolation headers when required by the selected WASM runtime.
- Avoid evaluating generated model text as executable code or HTML.

The browser still controls microphone permissions, storage retention, GPU access, and page lifecycle. The application must handle those constraints explicitly.

## 9. Error handling and fallback behavior

Failures should be handled by the component that owns them, with recovery coordinated by the controller.

| Failure                      | Expected behavior                                              |
| ---------------------------- | -------------------------------------------------------------- |
| WebGPU unavailable           | Try a compatible alternative backend or enter text-only mode   |
| Model download interrupted   | Preserve verified progress and resume                          |
| Integrity check fails        | Reject the artifact and permit a fresh download                |
| Model initialization fails   | Release partial resources and try a smaller compatible model   |
| Microphone permission denied | Keep typed input available                                     |
| AudioContext suspended       | Request a valid user gesture to resume it                      |
| TTS fails                    | Continue displaying generated text                             |
| GPU device lost              | Cancel affected work and attempt controlled reinitialization   |
| Storage quota exceeded       | Explain the space requirement and offer model cleanup          |
| Worker crashes               | Recreate the Worker and restore the minimum required state     |
| User interrupts speech       | Cancel generation and playback without a page reload           |
| Page is backgrounded         | Suspend or reduce work where appropriate and recover on return |

A failure in one optional subsystem should not take down the entire application. For example, the text conversation should remain usable when TTS is unavailable.

## 10. Performance and observability

Measure performance locally and use aggregate, privacy-preserving telemetry only if explicitly enabled.

Track:

| Metric                   | Definition                                                |
| ------------------------ | --------------------------------------------------------- |
| First-use readiness      | Time until the selected model is ready                    |
| Warm initialization      | Time to restore a cached model                            |
| STT finalization latency | End of speech to finalized transcript                     |
| LLM time to first token  | Prompt submission to first output token                   |
| First-audio latency      | End of user speech to first audible response              |
| Generation throughput    | Output tokens per second                                  |
| TTS real-time factor     | Speech synthesis time divided by generated audio duration |
| Interruption latency     | User interrupt to cessation of audible output             |
| Peak memory              | Observed or estimated peak resource consumption           |
| Recovery time            | Failure detection to restored usable state                |

Measure cold and warm starts separately. Benchmark representative utterance lengths, languages, context sizes, and concurrent pipeline loads.

Optimize first for responsive interaction, then for throughput. In particular, test whether concurrent STT, LLM, and TTS execution actually improves user experience on each device class.

## 11. Testing strategy

### Functional testing

- Typed and spoken conversations.
- Partial and finalized transcripts.
- Long responses and phrase-level speech synthesis.
- Interruptions during generation and playback.
- Conversation reset and context trimming.
- Model switching and voice switching.
- Offline operation after initial setup.

### Compatibility testing

Test actual supported versions of:

- Chrome and Edge on desktop.
- Safari on macOS.
- Safari on iOS.
- Other target browsers only after verifying their required WebGPU, WASM, Worker, and audio capabilities.

### Resource testing

- Low-memory devices and large model downloads.
- Simultaneous audio capture and inference.
- Long conversations with growing context.
- Backgrounding and restoring the page.
- GPU device loss and Worker crashes.
- Interrupted downloads, quota exhaustion, and corrupted cache entries.

### Acceptance criteria

The first release should meet these conditions:

- No long-running synchronous inference on the main thread.
- No network requests containing conversation content.
- No unbounded text or audio queues.
- Interruptions reliably stop stale output.
- Cached models can be loaded without network access.
- Model selection and fallback work on unsupported hardware.
- Text interaction remains available when speech components fail.
- Performance is measured end to end on representative devices.

## 12. Implementation roadmap

1. Phase 1 — Runtime proof of concept

   Load one web-compatible Gemma artifact with LiteRT-LM, stream tokens, and verify whether the selected runtime works in a dedicated Worker. Establish a baseline for initialization, memory use, and token throughput.
2. Phase 2 — Voice input

   Integrate Whistle, microphone capture, resampling, VAD, and finalized transcripts. Validate supported languages and actual browser Worker behavior.
3. Phase 3 — Voice output

   Integrate Piper-compatible TTS, phrase buffering, PCM playback, and cancellation. Measure first-audio latency before adding more complex concurrency.
4. Phase 4 — Full-duplex orchestration

   Add the controller, state machines, bounded queues, interruption handling, request IDs, and resource scheduler. Test under simultaneous inference and audio workloads.
5. Phase 5 — Model management and offline support

   Implement resumable downloads, manifests, integrity checks, OPFS/IndexedDB storage, quota management, and verified offline startup.
6. Phase 6 — Adaptive deployment

   Add capability-based model selection, runtime benchmarks, fallback behavior, and browser/device compatibility tests.
7. Phase 7 — Production hardening

   Validate privacy guarantees, dependency security, recovery behavior, storage lifecycle, and end-to-end performance. Release only the model/runtime combinations that pass the acceptance tests.

## 13. Initial technology choices

| Component              | Initial choice                                                   |
| ---------------------- | ---------------------------------------------------------------- |
| Application            | TypeScript, modern browser APIs                                  |
| STT                    | Whistle / `cactus-needle` WASM                                   |
| LLM                    | LiteRT-LM JavaScript API + compatible Gemma artifact             |
| TTS                    | Piper-compatible browser implementation                          |
| Inference acceleration | WebGPU where supported                                           |
| CPU processing         | WASM and Workers where supported                                 |
| Audio                  | Web Audio API                                                    |
| Persistent models      | OPFS, with compatible storage fallbacks                          |
| Metadata and state     | IndexedDB                                                        |
| Static assets          | Cache Storage and a versioned application shell                  |
| Coordination           | Typed Worker messages, request IDs, cancellation, bounded queues |

These are initial selections, not hard dependencies. Each engine should sit behind a small application-owned interface so that an incompatible or superseded runtime can be replaced without redesigning the application.

The primary implementation risk is not the overall architecture; it is whether the selected model runtimes and browser APIs work together reliably, especially on mobile Safari. Resolve that with a narrow end-to-end prototype before investing in adaptive model selection or a sophisticated download manager.