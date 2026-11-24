/// <reference types="node" />
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { roundToNonNegativeInt } from './int.js';

/**
 * One window of event loop delay, all values integer nanoseconds. Each value is the delay beyond the
 * expected timer interval (`DEFAULT_RESOLUTION_MS`), clamped at 0, so an idle loop reads close to 0.
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

/** Timer interval of the underlying `monitorEventLoopDelay` histogram, in whole milliseconds. */
export const DEFAULT_RESOLUTION_MS = 10;
/** The histogram records the whole timer interval on every tick, even on an idle loop. */
const BASELINE_NS = DEFAULT_RESOLUTION_MS * 1_000_000;

export function createEventLoopSampler(): EventLoopSampler {
  const histogram = monitorEventLoopDelay({ resolution: DEFAULT_RESOLUTION_MS });
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
              min: roundToNonNegativeInt(histogram.min - BASELINE_NS),
              max: roundToNonNegativeInt(histogram.max - BASELINE_NS),
              mean: roundToNonNegativeInt(histogram.mean - BASELINE_NS),
              p50: roundToNonNegativeInt(histogram.percentile(50) - BASELINE_NS),
              p99: roundToNonNegativeInt(histogram.percentile(99) - BASELINE_NS),
            };
      histogram.reset();
      return result;
    },
  };
}
