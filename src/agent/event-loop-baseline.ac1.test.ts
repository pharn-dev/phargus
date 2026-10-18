import { describe, expect, it } from 'vitest';
import { DEFAULT_RESOLUTION_MS } from './event-loop-sampler.js';

const KEYS = ['min', 'max', 'mean', 'p50', 'p99'] as const;

function expectNonNegativeInt(value: unknown): void {
  expect(typeof value).toBe('number');
  expect(Number.isInteger(value)).toBe(true);
  expect(value as number).toBeGreaterThanOrEqual(0);
}

describe('event loop baseline — AC-1', () => {
  it('AC-1: with no options an idle loop reports p50 below the default resolution, and a never-enabled sampler reports zeros', async () => {
    const { createEventLoopSampler } = await import('./index.js');

    const sampler = createEventLoopSampler();
    sampler.enable();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      const sample = sampler.sample();
      for (const key of KEYS) {
        expectNonNegativeInt(sample[key]);
      }
      // Below one timer interval: fails without the baseline subtraction (an idle loop then
      // reads at least the interval) and tolerates coarse Windows timers and loaded runners.
      expect(sample.p50).toBeLessThan(DEFAULT_RESOLUTION_MS * 1_000_000);
    } finally {
      sampler.disable();
    }

    const fresh = createEventLoopSampler();
    const empty = fresh.sample();
    for (const key of KEYS) {
      expect(empty[key]).toBe(0);
    }
  });
});
