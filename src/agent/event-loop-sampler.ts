/// <reference types="node" />
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * One window of event loop delay, all values integer nanoseconds. Each value is the delay beyond the
 * expected timer interval (the sampler's `resolution`), clamped at 0, so an idle loop reads close to 0.
 */
export type EventLoopSample = {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p99: number;
};

export type EventLoopSampler = {
  enable(): void;
  disable(): void;
  /** Read the current window, then reset so the next window starts fresh. */
  sample(): EventLoopSample;
};

export type EventLoopSamplerOptions = {
  /**
   * Timer interval of the underlying `monitorEventLoopDelay` histogram, in whole milliseconds
   * (default 10). It is subtracted from every exported value.
   */
  resolution?: number;
};

const DEFAULT_RESOLUTION_MS = 10;
const NS_PER_MS = 1_000_000;

function validateResolution(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `createEventLoopSampler: resolution must be a positive integer number of milliseconds, got ${String(value)}`,
    );
  }
  return value;
}

function toNonNegativeInt(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  const rounded = Math.round(value);
  if (rounded < 0) {
    return 0;
  }
  return rounded > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : rounded;
}

export function createEventLoopSampler(options?: EventLoopSamplerOptions): EventLoopSampler {
  const resolution = validateResolution(options?.resolution ?? DEFAULT_RESOLUTION_MS);
  // The histogram records the whole timer interval on every tick, even on an idle loop.
  const baselineNs = resolution * NS_PER_MS;
  const histogram = monitorEventLoopDelay({ resolution });
  return {
    enable(): void {
      histogram.enable();
    },
    disable(): void {
      histogram.disable();
    },
    sample(): EventLoopSample {
      // An empty window reports a huge min sentinel and a NaN mean: emit zeros instead.
      const result: EventLoopSample =
        histogram.count === 0
          ? { min: 0, max: 0, mean: 0, p50: 0, p99: 0 }
          : {
              min: toNonNegativeInt(histogram.min - baselineNs),
              max: toNonNegativeInt(histogram.max - baselineNs),
              mean: toNonNegativeInt(histogram.mean - baselineNs),
              p50: toNonNegativeInt(histogram.percentile(50) - baselineNs),
              p99: toNonNegativeInt(histogram.percentile(99) - baselineNs),
            };
      histogram.reset();
      return result;
    },
  };
}
