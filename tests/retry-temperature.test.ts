import { describe, expect, it } from 'vitest';
import { retryTemperature } from '../src/runtimes/retry-temperature.ts';

describe('retryTemperature', () => {
  it('halves the usual temperature on each retry, down to 0.2', () => {
    expect(retryTemperature(1, 0)).toBe(1);
    expect(retryTemperature(1, 1)).toBe(0.5);
    expect(retryTemperature(1, 2)).toBe(0.25);
    expect(retryTemperature(1, 3)).toBe(0.2);
    expect(retryTemperature(0.6, 1)).toBe(0.3);
  });

  it('never raises a temperature already below the floor', () => {
    expect(retryTemperature(0.1, 1)).toBe(0.1);
  });
});
