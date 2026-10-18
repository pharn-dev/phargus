import { describe, expect, it } from 'vitest';

const RESOLUTION_MS = 20;
const KEYS = ['min', 'max', 'mean', 'p50', 'p99'] as const;

function expectNonNegativeInt(value: unknown): void {
  expect(typeof value).toBe('number');
  expect(Number.isInteger(value)).toBe(true);
  expect(value as number).toBeGreaterThanOrEqual(0);
}

describe('event loop baseline — AC-2', () => {
  it('AC-2: with { resolution: 20 } an idle loop reports p50 below that resolution and non-negative integers', async () => {
    const { createEventLoopSampler } = await import('./index.js');

    const sampler = createEventLoopSampler({ resolution: RESOLUTION_MS });
    sampler.enable();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      const sample = sampler.sample();
      for (const key of KEYS) {
        expectNonNegativeInt(sample[key]);
      }
      // Below one timer interval: fails without the baseline subtraction (an idle loop then
      // reads at least the interval) and tolerates coarse Windows timers and loaded runners.
      expect(sample.p50).toBeLessThan(RESOLUTION_MS * 1_000_000);
    } finally {
      sampler.disable();
    }
  });
});
