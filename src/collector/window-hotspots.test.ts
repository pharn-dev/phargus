import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AgentSample } from '../agent/index.js';
import { createCollector } from './index.js';
import {
  MAX_HOTSPOT_SITE_LENGTH,
  MAX_TRACKED_SITES,
  MAX_WINDOW_HOTSPOTS,
  addSample,
  closeWindow,
  openWindow,
  type AggregatedWindow,
} from './window.js';

type Hotspot = { site: string; events: number; totalStall: number; maxStall: number };

/** A sample-shaped record whose `backpressure.hotspots` is whatever the test passes. */
function makeSample(timestamp: number, hotspots: unknown): Record<string, unknown> {
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
    backpressure: { events: 1, totalStall: 5, maxStall: 5, hotspots },
  };
}

function windowOf(...hotspotLists: unknown[]): AggregatedWindow {
  const acc = openWindow(0);
  hotspotLists.forEach((hotspots, index) => {
    addSample(acc, makeSample(index, hotspots) as unknown as AgentSample);
  });
  return closeWindow(acc, 1000);
}

function hotspot(site: string, events: number, totalStall: number, maxStall: number): Hotspot {
  return { site, events, totalStall, maxStall };
}

describe('window backpressure hotspots', () => {
  it('merges three samples that share a site into one hotspot with summed events and totalStall', () => {
    const w = windowOf(
      [hotspot('a.js:1', 1, 100, 100)],
      [hotspot('a.js:1', 2, 300, 250), hotspot('b.js:2', 1, 50, 50)],
      [hotspot('a.js:1', 3, 600, 400)],
    );
    expect(w.backpressure.hotspots).toEqual([
      { site: 'a.js:1', events: 6, totalStall: 1000, maxStall: 400 },
      { site: 'b.js:2', events: 1, totalStall: 50, maxStall: 50 },
    ]);
  });

  it('keeps at most 5 hotspots, sorted by totalStall, all integers, sites at most 256 characters', () => {
    const long = 'x'.repeat(1000);
    const w = windowOf(
      [
        hotspot('s1', 1, 10, 10),
        hotspot('s2', 1.9, 70.7, 70.2),
        hotspot('s3', 1, 30, 30),
        hotspot(long, 1, 90, 90),
        hotspot('s5', 1, 50, 50),
        hotspot('s6', 1, 20, 20),
        hotspot('s7', 1, 60, 60),
      ],
      [hotspot('s1', 1, Number.MAX_SAFE_INTEGER, 1)],
    );
    const hotspots = w.backpressure.hotspots;
    expect(MAX_WINDOW_HOTSPOTS).toBe(5);
    expect(MAX_HOTSPOT_SITE_LENGTH).toBe(256);
    expect(hotspots).toHaveLength(5);
    expect(hotspots.map((h) => h.site)).toEqual(['s1', 'x'.repeat(256), 's2', 's7', 's5']);
    expect(hotspots[0]?.totalStall).toBe(Number.MAX_SAFE_INTEGER);
    for (let i = 1; i < hotspots.length; i += 1) {
      expect(hotspots[i - 1]!.totalStall).toBeGreaterThanOrEqual(hotspots[i]!.totalStall);
    }
    for (const h of hotspots) {
      expect(h.site.length).toBeLessThanOrEqual(256);
      expect(Number.isSafeInteger(h.events)).toBe(true);
      expect(Number.isSafeInteger(h.totalStall)).toBe(true);
      expect(Number.isSafeInteger(h.maxStall)).toBe(true);
    }
  });

  it('a sample with hotspots "x" or a malformed entry keeps the valid entries only (or none)', () => {
    expect(windowOf('x').backpressure.hotspots).toEqual([]);
    expect(windowOf(undefined).backpressure.hotspots).toEqual([]);
    const w = windowOf([
      null,
      'a.js:1',
      { site: 7, events: 1, totalStall: 1, maxStall: 1 },
      { site: 'no-numbers' },
      { site: 'bad-total', events: 1, totalStall: '9', maxStall: 1 },
      hotspot('ok.js:3', 2, 40, 30),
    ]);
    expect(w.backpressure.hotspots).toEqual([hotspot('ok.js:3', 2, 40, 30)]);
    expect(w.count).toBe(1);
    expect(w.backpressure.events).toBe(1);
  });

  it(`tracks at most ${MAX_TRACKED_SITES} distinct sites per window`, () => {
    const many = Array.from({ length: MAX_TRACKED_SITES + 10 }, (_, i) =>
      hotspot(`site-${i}`, 1, 1, 1),
    );
    const acc = openWindow(0);
    addSample(acc, makeSample(0, many) as unknown as AgentSample);
    addSample(
      acc,
      makeSample(1, [hotspot('late', 1, 1_000_000, 1_000_000)]) as unknown as AgentSample,
    );
    expect(acc.bpSites.size).toBe(MAX_TRACKED_SITES);
    const w = closeWindow(acc, 1000);
    expect(w.backpressure.hotspots.map((h) => h.site)).not.toContain('late');
  });

  it('a collector counts samples with malformed hotspots as normal samples', async () => {
    const collector = createCollector({ windowMs: 1000, capacity: 10 });
    await collector.consume(
      Readable.from([
        makeSample(100, 'x'),
        makeSample(200, [{ site: 1 }, hotspot('ok.js:1', 1, 5, 5)]),
        makeSample(300, [hotspot('ok.js:1', 1, 7, 7)]),
      ]),
    );
    expect(collector.ignored).toBe(0);
    const windows = collector.windows.snapshot();
    expect(windows).toHaveLength(1);
    expect(windows[0]?.count).toBe(3);
    expect(windows[0]?.backpressure.hotspots).toEqual([hotspot('ok.js:1', 2, 12, 7)]);
  });
});
