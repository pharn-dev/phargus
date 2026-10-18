import { describe, expect, it } from 'vitest';

describe('event loop baseline — AC-3', () => {
  it('AC-3: a resolution of 0, -1, 1.5, NaN or Infinity throws an error naming resolution', async () => {
    const { createEventLoopSampler } = await import('./index.js');

    for (const resolution of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createEventLoopSampler({ resolution })).toThrow(/resolution/);
    }
  });
});
