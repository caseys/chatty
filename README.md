# Chatty

**A local AI that answers by writing code.** Chatty runs a language model entirely in your browser. Ask it for something, by voice or by typing, and it replies with a JavaScript program that runs on the spot: it draws, animates, plays music, does the math, or builds a small app right in the chat.

**Try it: https://www.mudberry.com/chatty/**

No account and no inference server. Models download once from Hugging Face, are cached by the browser, and run on your own GPU with WebGPU. Speech recognition and speech synthesis run on-device too.

## Features

- **Replies are programs.** "Draw a night sky", "make a tip calculator", "play a blues riff", "how many seconds are in a leap year?": the model writes JavaScript, and its output is a live card in the chat. It speaks its answer with `speak()`.
- **Choice of local models.** Google Gemma 4 (E2B, E4B) on LiteRT-LM, and Qwen 2.5/3/3.5, Llama 3.2, SmolLM2, Phi-4-mini, Ministral and others on WebLLM, from 200 MB to about 5 GB. Phones get a shortlist sized for a mobile tab.
- **Voice in and out, on-device.** Whistle (Cactus Compute) for speech-to-text, Piper for text-to-speech. Speech can be switched off for a typing-only chat.
- **Sound and music.** Programs get Web Audio, Tone.js (bundled, for music) and a software Web MIDI synth, so `navigator.requestMIDIAccess()` works even on iPhone Safari.
- **Self-repair.** When a program fails, Chatty corrects sure slips itself (typos in method or property names, checked against the browser's own APIs) and otherwise runs a short fix turn with the error and the failing line.
- **Chats and memory.** Multiple conversations, kept locally, with a context meter and automatic summarizing when the window fills.
- **Installable and offline-capable.** A PWA with a service worker; once the models are cached it works without a network (apart from look-ups the program makes itself, such as Wikipedia).
- **Run log.** Every request, raw reply, program, error and correction is recorded per chat and can be copied for debugging.

## How it works

```
mic ─▶ Whistle STT ─┐                                   ┌─▶ sandboxed iframe (canvas, DOM, Web Audio, MIDI)
                    ├─▶ orchestrator ─▶ LLM worker ─────┤
keyboard ───────────┘   (prompt, memory,  (LiteRT-LM or └─▶ speak() ─▶ Piper TTS worker ─▶ speakers
                         repairs)          WebLLM, WebGPU)
```

- **`src/core/`**: the engine (`voice-assistant-engine.ts`), the conversation orchestrator and system prompt (`orchestrator.ts`), conversation memory, model registry and caching, settings, and the repair helpers (`line-fix.ts`, `error-hints.ts`, `method-hints.ts`, `property-check.ts`).
- **`src/runtimes/`**: model providers. `llm-provider.ts` (LiteRT-LM, Gemma), `webllm-provider.ts` (WebLLM/MLC), `onnx-llm-provider.ts` (Transformers.js), `stt-provider.ts` (Whistle), `tts-provider.ts` (Piper).
- **`src/workers/`**: every model runs in its own Web Worker so the page stays responsive; a worker is terminated to free its memory.
- **`src/tools/`**: the program sandbox (`javascript-runtime.ts`) with its helpers (`speak`, `playNotes`, `root`, a MIDI output), and loop protection so an infinite loop can't freeze the page.
- **`src/audio/`**: one shared `AudioContext` for capture, playback, voice activity detection and the MIDI synth.
- **`src/main.ts`** drives the app UI (`index.html`); `src/debug.ts` drives a debug console (`debug.html`) with telemetry, a memory inspector and benchmarks.

The page is cross-origin isolated (COOP/COEP) so the WebAssembly runtimes can use threads.

The design specs and the evaluation guide are in [docs/](docs/README.md).

## Browser and device support

| | Status |
|---|---|
| Chrome / Edge on desktop (Windows, macOS, Linux) | Supported. Needs WebGPU. Gemma 4 E4B and the larger WebLLM models want a GPU with several GB of memory. |
| Safari on iPhone / iPad | Works with the phone model list (Qwen3 0.6B by default). iOS kills tabs that use too much memory, so larger models can crash the page. |
| Chrome on Android | Phone model list; Gemma 4 E2B by default on devices that report at least 4 GB of memory. |
| Firefox, other browsers | Untested. Without WebGPU no model can run. |

A secure context (HTTPS or `localhost`) is required for WebGPU, the microphone, OPFS and the service worker.

## Running locally

Requires Node 22.18 or newer.

```bash
npm install
npm run dev        # http://localhost:5173/chatty/
```

The app is served under `/chatty/` (Vite's `base`, set in `vite.config.ts`). The dev server sends the COOP/COEP headers the app needs. The first visit downloads a model, which can take a while.

Useful URL parameters for testing: `?stt=native` uses the browser's own speech recognition instead of Whistle, and `?pipeline=split` turns on the older multi-model phone pipeline.

```bash
npm run build      # type-checks, then builds to dist/
npm run preview    # serves dist/ at http://localhost:4173/chatty/
```

## Testing

```bash
npx vitest run     # unit tests (jsdom), also: npm test
npx tsc --noEmit   # type-check, also: npm run typecheck
npm run replay     # replays real failed turns through the repair pipeline and writes tests/replay/report.md
```

The replay corpus is `tests/replay/cases.json`, built from run logs copied out of the app (see `tests/replay/report.md` for how to add cases). [docs/everyday-eval.md](docs/everyday-eval.md) describes a 24-request evaluation that runs against the real models in the browser.

## Deploying

`dist/` is a static site; any web server works if it:

1. serves over **HTTPS**,
2. sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` on every response,
3. serves `.wasm` as `application/wasm`,
4. serves the app at Vite's `base` path (`/chatty/` unless you change it), with `sw.js` and the manifests not cached.

[docs/deploy-nginx.md](docs/deploy-nginx.md) has a complete Nginx setup.

`npm run deploy` (`scripts/deploy.sh`) tests, builds, backs up the live copy over SSH, rsyncs `dist/`, and checks the live bundle matches. Override the target with `DEPLOY_HOST`, `DEPLOY_PATH` and `DEPLOY_URL`.

## Limitations

- **Big first download.** Models range from about 200 MB to 5 GB and are fetched from Hugging Face on first use.
- **Small models are limited.** Phone-sized models often misread requests or write programs that fail; the larger desktop models do much better.
- **The sandbox is not a security boundary.** Programs run in an iframe with `allow-scripts allow-same-origin`, so they can reach the page. They are written by a local model for the person using it, not taken from anyone else.
- **English only** for speech in and out.
- **Memory limits on phones.** iPhone Safari may reload the page if a model is too large for the device.

## License

Copyright 2026 Casey. Licensed under the [Apache License, Version 2.0](LICENSE).
