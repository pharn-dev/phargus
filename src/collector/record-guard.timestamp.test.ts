import { describe, expect, it } from 'vitest';
import { classifyRecord, MAX_SAMPLE_FUTURE_MS } from './record-guard.js';

const NOW = 1_800_000_000_000;

function sampleAt(timestamp: unknown): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: 20, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 100, heapTotal: 200, rss: 1000, external: 0, arrayBuffers: 0 },
    gc: { count: 1, totalPause: 3, maxPause: 3, kinds: { minor: 1, major: 0, incremental: 0 } },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
    dropped: { samples: 0, spans: 0 },
  };
}

describe('collector record guard: sample timestamps', () => {
  it('rejects a non-integer timestamp as malformed', () => {
    expect(classifyRecord(sampleAt(NOW - 1000.5), NOW)).toBe('malformed');
  });

  it('rejects an unsafe integer timestamp as malformed', () => {
    expect(classifyRecord(sampleAt(Number.MAX_SAFE_INTEGER + 1), NOW)).toBe('malformed');
    expect(classifyRecord(sampleAt(2 ** 60), NOW)).toBe('malformed');
  });

  it('rejects a non-finite or non-number timestamp as malformed', () => {
    expect(classifyRecord(sampleAt(Number.POSITIVE_INFINITY), NOW)).toBe('malformed');
    expect(classifyRecord(sampleAt(Number.NaN), NOW)).toBe('malformed');
    expect(classifyRecord(sampleAt('1800000000000'), NOW)).toBe('malformed');
  });

  it('rejects a timestamp more than 24 hours ahead of the collector clock as malformed', () => {
    expect(MAX_SAMPLE_FUTURE_MS).toBe(86_400_000);
    expect(classifyRecord(sampleAt(NOW + MAX_SAMPLE_FUTURE_MS + 1), NOW)).toBe('malformed');
    const tenYears = 10 * 365 * MAX_SAMPLE_FUTURE_MS;
    expect(classifyRecord(sampleAt(NOW + tenYears), NOW)).toBe('malformed');
  });

  it('accepts a timestamp up to 24 hours ahead, and any past one (an old capture)', () => {
    expect(classifyRecord(sampleAt(NOW + MAX_SAMPLE_FUTURE_MS), NOW)).toBe('sample');
    expect(classifyRecord(sampleAt(NOW), NOW)).toBe('sample');
    expect(classifyRecord(sampleAt(NOW - 30 * MAX_SAMPLE_FUTURE_MS), NOW)).toBe('sample');
    expect(classifyRecord(sampleAt(1000), NOW)).toBe('sample');
  });

  it("uses the collector's Date.now() when no clock is passed", () => {
    expect(classifyRecord(sampleAt(Date.now()))).toBe('sample');
    expect(classifyRecord(sampleAt(Date.now() + 2 * MAX_SAMPLE_FUTURE_MS))).toBe('malformed');
  });
});
