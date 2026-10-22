// ============================================================================
// WebLLM (MLC) engine worker. Model download, GPU loading and generation all run here, and this is
// the only place WebLLM's library (6 MB) is loaded: the page talks to it through the messages in
// webllm-protocol.ts (see runtimes/webllm-client.ts and runtimes/webllm-provider.ts).
// ============================================================================

import { deleteModelAllInfoInCache, MLCEngine, prebuiltAppConfig, type AppConfig } from '@mlc-ai/web-llm';
import { customModelRecords } from '../runtimes/custom-models.ts';
import { createWebLlmHost, type WebLlmEngine } from './webllm-host.ts';
import type { WebLlmEvent, WebLlmRequest } from './webllm-protocol.ts';

// Pacing for iPhone and iPad Safari, which kills the tab when the GPU work of a load piles up (a
// model read back from the cache comes as fast as storage allows, one weight piece straight after
// another). The page sends the pause before loading starts (none elsewhere):
//  - each weight piece waits that long before it is read, so the one before can be freed
//  - the shaders are built one at a time (WebLLM starts them all at once), a moment apart, and
//    the first waits longest: the model's working memory has just been set aside then
let paceMs = 0;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const readBytes = Response.prototype.arrayBuffer;
Response.prototype.arrayBuffer = async function (this: Response): Promise<ArrayBuffer> {
  if (paceMs > 0 && /params_shard_\d+\.bin/.test(this.url)) await pause(paceMs);
  return readBytes.call(this);
};

type PipelineBuilder = { prototype: { createComputePipelineAsync: (this: unknown, descriptor: unknown) => Promise<unknown> } };
const Device = (globalThis as unknown as { GPUDevice?: PipelineBuilder }).GPUDevice;
if (Device) {
  const build = Device.prototype.createComputePipelineAsync;
  let queue: Promise<unknown> = Promise.resolve();
  let built = 0;
  Device.prototype.createComputePipelineAsync = function (this: unknown, descriptor: unknown) {
    if (paceMs <= 0) return build.call(this, descriptor);
    const first = built++ === 0;
    const run = async () => {
      await pause(first ? paceMs * 6 : Math.max(5, Math.round(paceMs / 8)));
      return build.call(this, descriptor);
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  };
}

// WebLLM's own models, and the fine-tunes we converted (runtimes/custom-models.ts)
const appConfig: AppConfig = { ...prebuiltAppConfig, model_list: [...prebuiltAppConfig.model_list, ...customModelRecords(prebuiltAppConfig.model_list)] };

const host = createWebLlmHost(
  {
    engine: new MLCEngine({ appConfig }) as unknown as WebLlmEngine,
    modelUrl: (model) => appConfig.model_list.find((record) => record.model_id === model)?.model,
    deleteCache: (model) => deleteModelAllInfoInCache(model, appConfig),
  },
  (event: WebLlmEvent) => (self as unknown as Worker).postMessage(event)
);
self.onmessage = (event: MessageEvent) => {
  const data = event.data as WebLlmRequest | null;
  if (data && data.kind === 'chatty-pace') {
    paceMs = Number(data.ms) || 0;
    return;
  }
  if (data) host(data);
};
