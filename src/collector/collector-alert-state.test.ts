import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCollector } from './index.js';

function makeSample(timestamp: number, eventLoopMax: number): Record<string, unknown> {
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

describe('collector: alert state survives consume() runs', () => {
  it('a rule firing when one run ends does not fire again in the next, and resolves there', async () => {
    const collector = createCollector({
      windowMs: 1000,
      capacity: 20,
      alerts: [
        { id: 'loop-max', metric: 'eventLoop.max', comparison: '>', threshold: 100, forWindows: 3 },
      ],
    });

    await collector.consume(
      Readable.from([makeSample(100, 500), makeSample(1100, 500), makeSample(2100, 500)]),
    );
    const afterFirst = collector.alerts.snapshot().map((alert) => [alert.state, alert.windowStart]);
    expect(afterFirst).toEqual([['firing', 2000]]);

    await collector.consume(
      Readable.from([
        makeSample(3100, 500),
        makeSample(4100, 500),
        makeSample(5100, 500),
        makeSample(6100, 50),
      ]),
    );
    const afterSecond = collector.alerts
      .snapshot()
      .map((alert) => [alert.state, alert.windowStart]);
    expect(afterSecond).toEqual([
      ['firing', 2000],
      ['resolved', 6000],
    ]);
  });
});
