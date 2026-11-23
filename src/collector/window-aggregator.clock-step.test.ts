import { once } from 'node:events';
import type { Transform } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createWindowAggregator, MAX_LATE_WINDOWS } from './window-aggregator.js';
import type { AggregatedWindow } from './window.js';

const WINDOW_MS = 1000;
const HOUR_MS = 3_600_000;
const T = 1_700_000_000_000;

function makeSample(timestamp: number, eventLoopMax = 20): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: eventLoopMax, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 100, heapTotal: 200, rss: 1000, external: 0, arrayBuffers: 0 },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  };
}

function writeAndWait(stream: Transform, chunk: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function aggregate(timestamps: readonly number[]): Promise<AggregatedWindow[]> {
  const aggregator = createWindowAggregator({ windowMs: WINDOW_MS });
  const windows: AggregatedWindow[] = [];
  aggregator.on('data', (window: AggregatedWindow) => {
    windows.push(window);
  });
  const ended = once(aggregator, 'end');
  for (const timestamp of timestamps) {
    await writeAndWait(aggregator, makeSample(timestamp));
  }
  aggregator.end();
  await ended;
  return windows;
}

describe('window aggregator: a clock step back', () => {
  it('after samples at T and T+1 s, a sample at T minus one hour starts a new window and later samples aggregate normally', async () => {
    const back = T - HOUR_MS;
    const windows = await aggregate([T, T + 1000, back, back + 200, back + 1000, back + 2000]);

    expect(windows.map((window) => [window.start, window.count, window.late])).toEqual([
      [T, 1, 0],
      [T + 1000, 1, 0],
      [back, 2, 0],
      [back + 1000, 1, 0],
      [back + 2000, 1, 0],
    ]);
    // The start values are not monotonic after the reset.
    expect(windows[2]!.start).toBeLessThan(windows[1]!.start);
  });

  it('a sample one window late is counted in late and not aggregated', async () => {
    const windows = await aggregate([T, T + 1000, T + 500, T + 2000]);
    expect(windows.map((window) => [window.start, window.count, window.late])).toEqual([
      [T, 1, 0],
      [T + 1000, 1, 1],
      [T + 2000, 1, 0],
    ]);
  });

  it(`stays late up to ${String(MAX_LATE_WINDOWS)} windows back and resets beyond that`, async () => {
    expect(MAX_LATE_WINDOWS).toBe(60);
    const open = T + 100 * WINDOW_MS;

    const atLimit = await aggregate([open, open - MAX_LATE_WINDOWS * WINDOW_MS]);
    expect(atLimit.map((window) => [window.start, window.count, window.late])).toEqual([
      [open, 1, 1],
    ]);

    const pastLimit = await aggregate([open, open - (MAX_LATE_WINDOWS + 1) * WINDOW_MS]);
    expect(pastLimit.map((window) => [window.start, window.count, window.late])).toEqual([
      [open, 1, 0],
      [open - (MAX_LATE_WINDOWS + 1) * WINDOW_MS, 1, 0],
    ]);
  });
});
