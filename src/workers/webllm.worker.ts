// ============================================================================
// WebLLM (MLC) engine worker. Model download, GPU loading and generation all run here;
// the page talks to it through WebWorkerMLCEngine (see runtimes/webllm-provider.ts).
// ============================================================================

import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (event: MessageEvent) => handler.onmessage(event);
