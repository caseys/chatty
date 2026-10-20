/**
 * Pauses between memory-heavy steps. Safari crashes the tab when big allocations follow each
 * other too closely (a model load, then the next load or the first reply), so each heavy step
 * leaves time for memory to be freed before the next starts. The same on every device.
 */

/** After anything that shows a progress bar (a model download or load), done or failed */
export const AFTER_LOAD_MS = 750;
/** After other memory-heavy steps: unloading a model, deleting downloads, clearing the screen */
export const AFTER_HEAVY_MS = 250;

import { isAppleMobile } from './settings.ts';

export function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** For load.finally(): waits AFTER_LOAD_MS once a load is done, keeping its result */
export const settleAfterLoad = (): Promise<void> => settle(AFTER_LOAD_MS);

/**
 * A pause only on iPhone/iPad Safari, the browser that kills the tab when heavy steps follow
 * each other too closely (a reply, then the program; a test run, then the real run); elsewhere
 * nothing waits
 */
export function settleOnIos(ms: number): Promise<void> {
  return isAppleMobile() ? settle(ms) : Promise.resolve();
}
