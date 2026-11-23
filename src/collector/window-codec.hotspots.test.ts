import { describe, expect, it } from 'vitest';
import { parseWindowLine, serializeWindow } from './window-codec.js';
import type { AggregatedWindow } from './window.js';

const base = {
  start: 1000,
  end: 2000,
  count: 3,
  late: 0,
  eventLoop: { max: 5, p99: 4, mean: 2 },
  memory: { heapUsedLast: 10, heapUsedMax: 20, rssLast: 30, rssMax: 40 },
  gc: { count: 1, totalPause: 2, maxPause: 2 },
};

describe('window codec — backpressure hotspots', () => {
  it('restores a persisted window without hotspots with an empty list', () => {
    const line = JSON.stringify({
      ...base,
      backpressure: { events: 0, totalStall: 0, maxStall: 0 },
    });
    expect(parseWindowLine(line)?.backpressure).toEqual({
      events: 0,
      totalStall: 0,
      maxStall: 0,
      hotspots: [],
    });
  });

  it('round-trips a window with hotspots through serializeWindow and parseWindowLine', () => {
    const window: AggregatedWindow = {
      ...base,
      backpressure: {
        events: 4,
        totalStall: 900,
        maxStall: 500,
        hotspots: [
          { site: 'a.js:1', events: 3, totalStall: 800, maxStall: 500 },
          { site: 'b.js:2', events: 1, totalStall: 100, maxStall: 100 },
        ],
      },
    };
    expect(parseWindowLine(serializeWindow(window))).toEqual(window);
  });

  it('rejects a line whose hotspots are present but not well formed', () => {
    const bad = [
      'x',
      [{ site: 1, events: 1, totalStall: 1, maxStall: 1 }],
      [{ site: 'a', events: 1.5, totalStall: 1, maxStall: 1 }],
      [{ site: 'y'.repeat(257), events: 1, totalStall: 1, maxStall: 1 }],
      Array.from({ length: 6 }, (_, i) => ({
        site: `s${i}`,
        events: 1,
        totalStall: 1,
        maxStall: 1,
      })),
    ];
    for (const hotspots of bad) {
      const line = JSON.stringify({
        ...base,
        backpressure: { events: 1, totalStall: 1, maxStall: 1, hotspots },
      });
      expect(parseWindowLine(line)).toBeUndefined();
    }
  });
});
