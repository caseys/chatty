/** The temperature of a fix turn, and the lowest a retry goes */
export const RETRY_FLOOR_TEMPERATURE = 0.2;

/**
 * A model's usual temperature, halved on each retry down to RETRY_FLOOR_TEMPERATURE: an attempt
 * that went wrong is tried again closer to the model's most likely reply
 */
export function retryTemperature(base: number, retry = 0): number {
  if (retry <= 0) return base;
  return Math.max(Math.min(base, RETRY_FLOOR_TEMPERATURE), base / 2 ** retry);
}
