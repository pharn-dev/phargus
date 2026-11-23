import { describe, expect, it } from 'vitest';
import type { AggregatedWindow } from '../collector/index.js';
import { toOtlpMetrics } from './index.js';

const withoutHotspots: AggregatedWindow = {
  start: 1700000000000,
  end: 1700000001000,
  count: 10,
  late: 0,
  eventLoop: { max: 5000000, p99: 4000000, mean: 2000000 },
  memory: { heapUsedLast: 1000, heapUsedMax: 2000, rssLast: 3000, rssMax: 4000 },
  gc: { count: 7, totalPause: 0, maxPause: 0 },
  backpressure: { events: 3, totalStall: 900, maxStall: 500, hotspots: [] },
};

describe('otel metrics — backpressure hotspots', () => {
  it('toOtlpMetrics output for a window is unchanged by its hotspots', () => {
    const withHotspots: AggregatedWindow = {
      ...withoutHotspots,
      backpressure: {
        ...withoutHotspots.backpressure,
        hotspots: [{ site: 'a.js:1', events: 3, totalStall: 900, maxStall: 500 }],
      },
    };
    const expected = JSON.stringify(toOtlpMetrics(withoutHotspots));
    expect(JSON.stringify(toOtlpMetrics(withHotspots))).toBe(expected);
    expect(expected).not.toContain('a.js:1');
  });
});
