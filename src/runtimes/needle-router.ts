// ============================================================================
// Needle tool picker: Cactus Compute's 35 MB tool-calling model (same cactus-needle
// package as Whistle STT). Runs on the CPU in its own WebAssembly worker, so it stays
// loaded next to the WebGPU chat model without competing for GPU memory.
// ============================================================================

import type { Needle, ToolCollection } from 'cactus-needle/browser';

export const NEEDLE_LABEL = 'Needle 3';
const NEEDLE_EXPECTED_BYTES = 35_300_000;

export type PickedCall = { name: string; args: Record<string, unknown> };

export class NeedleToolPicker {
  private session: Needle | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly tools: ToolCollection) {}

  get isLoaded(): boolean {
    return this.session !== null;
  }

  /** Loads the model (from CacheStorage after the first visit). */
  initialize(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.session) return Promise.resolve();
    this.loading ??= (async () => {
      const { createNeedle } = await import('cactus-needle/browser');
      this.session = await createNeedle({
        tools: this.tools,
        // Every turn is routed on its own
        stateless: true,
        maxOutputTokens: 128,
        onDownloadProgress: ({ loaded, total }) => {
          const size = total ?? NEEDLE_EXPECTED_BYTES;
          onProgress?.(Math.min(loaded, size), size);
        },
      });
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** The tool Needle picks for `text`, or null when it decides no tool applies. */
  async pick(text: string): Promise<PickedCall | null> {
    await this.initialize();
    try {
      // No abort signal: aborting a Needle call terminates its session
      const { toolCalls } = await this.session!.generate({ prompt: text });
      const call = toolCalls[0];
      return call ? { name: call.toolName, args: (call.input ?? {}) as Record<string, unknown> } : null;
    } catch (err) {
      // A failed engine call can leave the worker unusable: reload on the next turn
      await this.dispose();
      throw err;
    }
  }

  async dispose(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.close();
  }
}
