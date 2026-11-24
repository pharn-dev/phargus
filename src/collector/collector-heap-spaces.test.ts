import { describe, expect, it } from 'vitest';
import { createCollector } from './index.js';
import { createNdjsonDecoder } from './ndjson-decoder.js';

function sampleLine(timestamp: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp,
    pid: 4242,
    eventLoop: { min: 1, max: 20, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 100, heapTotal: 200, rss: 1000, external: 0, arrayBuffers: 0 },
    gc: {
      count: 0,
      totalPause: 0,
      maxPause: 0,
      kinds: { minor: 0, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
    dropped: { samples: 0, spans: 0 },
    ...extra,
  });
}

describe('collector and the heapSpaces field (CORE-273)', () => {
  it('aggregates sample lines with heapSpaces (older agents) and without it (current agents)', async () => {
    const older = sampleLine(100, {
      heapSpaces: [
        {
          name: 'new_space',
          space_size: 1,
          space_used_size: 1,
          space_available_size: 0,
          physical_space_size: 1,
        },
      ],
    });
    const current = sampleLine(200);
    const collector = createCollector({ windowMs: 1000, capacity: 10 });
    const decoder = createNdjsonDecoder();
    const consumed = collector.consume(decoder);
    decoder.end(Buffer.from(`${older}\n${current}\n`, 'utf8'));
    await consumed;
    await collector.close();

    expect(collector.ignored).toBe(0);
    expect(collector.windows.snapshot().map((w) => w.count)).toEqual([2]);
  });
});
