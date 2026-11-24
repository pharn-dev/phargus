import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { encodeNdjsonLine } from '../agent/ndjson-exporter.js';
import { createCollector, createNdjsonDecoder } from './index.js';
import type { IgnoredReason } from './record-guard.js';
import type { AggregatedWindow } from './window.js';

const WINDOW_MS = 1000;
const DAY_MS = 86_400_000;
const SPIKE_NS = 500_000_000;

function makeSample(timestamp: number, eventLoopMax: number): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: eventLoopMax, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 1000, heapTotal: 4000, rss: 9000, external: 0, arrayBuffers: 0 },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
    dropped: { samples: 0, spans: 0 },
    pid: 4242,
  };
}

/** One sample per second from `base`, with a lag spike in second 40. */
function captureLines(base: number, count: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(encodeNdjsonLine(makeSample(base + i * 1000 + 250, i === 40 ? SPIKE_NS : 20)));
  }
  return lines;
}

type Run = {
  windows: AggregatedWindow[];
  /** Alerts that fired (an edge-triggered alert also emits `resolved`). */
  firing: number;
  ignored: number;
  skipped: Array<{ record: unknown; reason: IgnoredReason }>;
};

/** Feeds NDJSON lines through the decoder into a fresh collector, as `phargus serve` does. */
async function replay(lines: readonly string[]): Promise<Run> {
  const skipped: Run['skipped'] = [];
  const collector = createCollector({
    windowMs: WINDOW_MS,
    capacity: 1000,
    alerts: [{ id: 'lag', metric: 'eventLoop.max', comparison: '>', threshold: SPIKE_NS - 1 }],
    onIgnored: (record, reason) => {
      skipped.push({ record, reason });
    },
  });
  await pipeline(Readable.from([lines.join('')]), createNdjsonDecoder(), (records) =>
    collector.consume(records),
  );
  const run: Run = {
    windows: collector.windows.snapshot(),
    firing: collector.alerts.snapshot().filter((alert) => alert.state === 'firing').length,
    ignored: collector.ignored,
    skipped,
  };
  await collector.close();
  return run;
}

/** A recent, window-aligned base time: the samples are in the past, as a live stream's are. */
function recentBase(): number {
  return Math.floor((Date.now() - 120_000) / WINDOW_MS) * WINDOW_MS;
}

describe('collector: a future-dated sample cannot stop the windows', () => {
  it('63 samples, the third dated ten years ahead, yield one window per real sample second, ignored 1 and an onIgnored malformed call', async () => {
    const base = recentBase();
    const lines = captureLines(base, 63);
    const future = makeSample(Date.now() + 10 * 365 * DAY_MS, 20);
    lines[2] = encodeNdjsonLine(future);

    const run = await replay(lines);

    expect(run.windows).toHaveLength(62);
    const expectedStarts = Array.from({ length: 63 }, (_, i) => base + i * 1000).filter(
      (_, i) => i !== 2,
    );
    expect(run.windows.map((window) => window.start)).toEqual(expectedStarts);
    expect(run.windows.every((window) => window.count === 1 && window.late === 0)).toBe(true);
    expect(run.ignored).toBe(1);
    expect(run.skipped).toEqual([{ record: future, reason: 'malformed' }]);
    expect(run.firing).toBe(1);
  });

  it('a capture recorded a month ago produces the same windows as the same capture recorded today', async () => {
    const today = recentBase();
    const monthAgo = today - 30 * DAY_MS;

    const now = await replay(captureLines(today, 60));
    const old = await replay(captureLines(monthAgo, 60));

    expect(old.ignored).toBe(0);
    expect(old.windows).toHaveLength(60);
    expect(now.firing).toBe(1);
    expect(old.firing).toBe(now.firing);
    const shift = (window: AggregatedWindow): AggregatedWindow => ({
      ...window,
      start: window.start + 30 * DAY_MS,
      end: window.end + 30 * DAY_MS,
    });
    expect(old.windows.map(shift)).toEqual(now.windows);
  });
});
