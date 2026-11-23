import { describe, expect, it } from 'vitest';
import { classifyRecord } from './record-guard.js';

const sample = {
  timestamp: 1000,
  eventLoop: { min: 1, max: 20, mean: 10, p50: 9, p99: 18 },
  memory: { heapUsed: 100, heapTotal: 200, rss: 1000, external: 0, arrayBuffers: 0 },
  gc: { count: 1, totalPause: 3, maxPause: 3, kinds: { minor: 1, major: 0, incremental: 0 } },
  backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  dropped: { samples: 0, spans: 0 },
};

describe('collector record guard and the sample line pid', () => {
  it('accepts a sample line with a pid', () => {
    expect(classifyRecord({ ...sample, pid: 4242 })).toBe('sample');
  });

  it('still accepts a sample line without a pid, as an older agent writes it', () => {
    expect('pid' in sample).toBe(false);
    expect(classifyRecord(sample)).toBe('sample');
  });
});
