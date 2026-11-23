import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AgentSample } from '../agent/index.js';
import { createCollector } from './index.js';
import { parseWindowLine, serializeWindow } from './window-codec.js';
import { addSample, closeWindow, openWindow, type AggregatedWindow } from './window.js';

/** A sample-shaped record; `dropped` is left out when the test passes undefined. */
function makeSample(timestamp: number, dropped?: unknown): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: 2, mean: 1, p50: 1, p99: 2 },
    memory: { heapUsed: 10, heapTotal: 20, rss: 30, external: 0, arrayBuffers: 0 },
    gc: {
      count: 0,
      totalPause: 0,
      maxPause: 0,
      kinds: { minor: 0, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
    ...(dropped === undefined ? {} : { dropped }),
  };
}

function windowOf(...droppedValues: unknown[]): AggregatedWindow {
  const acc = openWindow(0);
  droppedValues.forEach((dropped, index) => {
    addSample(acc, makeSample(index, dropped) as unknown as AgentSample);
  });
  return closeWindow(acc, 1000);
}

describe('window — agent drop counters', () => {
  it("carries the counters of the window's last sample", () => {
    expect(windowOf({ samples: 1, spans: 10 }, { samples: 2, spans: 40 }).dropped).toEqual({
      samples: 2,
      spans: 40,
    });
  });

  it('gives zeros for a sample without the field', () => {
    expect(windowOf(undefined).dropped).toEqual({ samples: 0, spans: 0 });
    // The last sample decides, even when an earlier one carried counters.
    expect(windowOf({ samples: 2, spans: 40 }, undefined).dropped).toEqual({
      samples: 0,
      spans: 0,
    });
  });

  it('counts a malformed counter as 0', () => {
    expect(windowOf('x').dropped).toEqual({ samples: 0, spans: 0 });
    expect(windowOf({ samples: -1, spans: 1.5 }).dropped).toEqual({ samples: 0, spans: 0 });
    expect(windowOf({ samples: '3', spans: 7 }).dropped).toEqual({ samples: 0, spans: 7 });
    expect(windowOf({ samples: 2 ** 53, spans: null }).dropped).toEqual({ samples: 0, spans: 0 });
  });

  it('carries the counters through collector.consume()', async () => {
    const collector = createCollector({ windowMs: 1000, capacity: 10 });
    await collector.consume(
      Readable.from([
        makeSample(100, { samples: 1, spans: 5 }),
        makeSample(200, { samples: 2, spans: 40 }),
      ]),
    );
    expect(collector.windows.snapshot().map((w) => w.dropped)).toEqual([{ samples: 2, spans: 40 }]);
    await collector.close();
  });
});

describe('window codec — agent drop counters', () => {
  const base = {
    start: 1000,
    end: 2000,
    count: 3,
    late: 0,
    eventLoop: { max: 5, p99: 4, mean: 2 },
    memory: { heapUsedLast: 10, heapUsedMax: 20, rssLast: 30, rssMax: 40 },
    gc: { count: 1, totalPause: 2, maxPause: 2 },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  };

  it('restores a persisted window without `dropped` with zeros', () => {
    expect(parseWindowLine(JSON.stringify(base))?.dropped).toEqual({ samples: 0, spans: 0 });
  });

  it('round-trips a window with drop counters', () => {
    const window: AggregatedWindow = { ...base, dropped: { samples: 2, spans: 40 } };
    expect(parseWindowLine(serializeWindow(window))).toEqual(window);
  });

  it('rejects a line whose `dropped` is present but not well formed', () => {
    const bad = ['x', null, { samples: 1 }, { samples: 1, spans: -1 }, { samples: 1.5, spans: 0 }];
    for (const dropped of bad) {
      expect(parseWindowLine(JSON.stringify({ ...base, dropped }))).toBeUndefined();
    }
  });
});
