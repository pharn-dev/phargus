import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCollector } from './collector.js';
import type { IgnoredReason } from './record-guard.js';

const WINDOW_MS = 1000;

/** A full agent sample line at `timestamp`, written by `pid` (none for an older agent). */
function makeSample(
  timestamp: number,
  pid: number | undefined,
  heapUsed: number,
  rss: number,
): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 0, max: 5, mean: 2, p50: 2, p99: 4 },
    memory: { heapUsed, heapTotal: heapUsed * 2, rss, external: 0, arrayBuffers: 0 },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
    dropped: { samples: 0, spans: 0 },
    ...(pid === undefined ? {} : { pid }),
  };
}

function makeSpan(spanId: string): Record<string, unknown> {
  return {
    type: 'span',
    traceId: 'a'.repeat(32),
    spanId,
    name: 'GET /users',
    method: 'GET',
    path: '/users',
    statusCode: 200,
    startTimeMs: 1_700_000_000_000,
    durationNs: 1_500_000,
  };
}

const PID_A = 4100;
const PID_B = 4200;

/**
 * Two windows of interleaved samples: pid A writes 2 then 1, pid B writes 3 then 2, with B's
 * memory always the larger and B's line last in each window. One span from each process.
 */
const interleaved: readonly Record<string, unknown>[] = [
  makeSample(1000, PID_A, 100, 1000),
  makeSample(1100, PID_B, 900, 9000),
  makeSample(1200, PID_B, 900, 9000),
  makeSpan('1'.repeat(16)),
  makeSample(1300, PID_A, 110, 1100),
  makeSample(1400, PID_B, 950, 9500),
  makeSample(2000, PID_A, 120, 1200),
  makeSpan('2'.repeat(16)),
  makeSample(2100, PID_B, 990, 9900),
  makeSample(2200, PID_B, 999, 9990),
];

describe('collector follows one process per consume() run', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds windows from the first pid only, with count equal to its samples', async () => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const collector = createCollector({ windowMs: WINDOW_MS, capacity: 10 });
    await collector.consume(Readable.from(interleaved));

    const windows = collector.windows.snapshot();
    expect(windows.map((w) => [w.start, w.count])).toEqual([
      [1000, 2],
      [2000, 1],
    ]);
    expect(windows[0]?.memory).toEqual({
      heapUsedLast: 110,
      heapUsedMax: 110,
      rssLast: 1100,
      rssMax: 1100,
    });
    expect(windows[0]?.gc.count).toBe(2);
    expect(windows[1]?.memory.heapUsedLast).toBe(120);
    expect(windows[1]?.gc.count).toBe(1);
  });

  it('counts the other pid in ignored and passes each of its samples to onIgnored', async () => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const seen: Array<[unknown, IgnoredReason]> = [];
    const collector = createCollector({
      windowMs: WINDOW_MS,
      capacity: 10,
      onIgnored: (record, reason) => {
        seen.push([record, reason]);
      },
    });
    await collector.consume(Readable.from(interleaved));

    expect(collector.ignored).toBe(5);
    expect(seen).toHaveLength(5);
    expect(seen.every(([, reason]) => reason === 'other-process')).toBe(true);
    expect(seen.map(([record]) => (record as { pid: number }).pid)).toEqual([
      PID_B,
      PID_B,
      PID_B,
      PID_B,
      PID_B,
    ]);
    const reason: IgnoredReason = 'other-process';
    expect(reason).toBe('other-process');
  });

  it('emits exactly one warning per run, naming how many other processes were seen', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const PID_C = 4300;
    const collector = createCollector({ windowMs: WINDOW_MS, capacity: 10 });
    const many: Record<string, unknown>[] = [makeSample(1000, PID_A, 100, 1000)];
    for (let i = 0; i < 200; i += 1) {
      many.push(makeSample(1001 + i, i % 2 === 0 ? PID_B : PID_C, 900, 9000));
    }
    await collector.consume(Readable.from(many));

    expect(collector.ignored).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, type] = warn.mock.calls[0] ?? [];
    expect(String(message)).toContain('2 other processes');
    expect(String(message)).toContain(`pid ${String(PID_A)}`);
    expect(type).toBe('PhargusCollectorWarning');

    // A second run warns again, once, and follows its own first pid.
    await collector.consume(
      Readable.from([makeSample(5000, PID_B, 1, 1), makeSample(5001, PID_A, 2, 2)]),
    );
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toContain('1 other process on');
    expect(collector.windows.snapshot().at(-1)?.memory.heapUsedLast).toBe(1);
  });

  it('emits no warning and aggregates as before when samples carry no pid', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const collector = createCollector({ windowMs: WINDOW_MS, capacity: 10 });
    await collector.consume(
      Readable.from([
        makeSample(1000, undefined, 100, 1000),
        makeSample(1100, undefined, 900, 9000),
        makeSample(2000, undefined, 120, 1200),
      ]),
    );

    expect(collector.ignored).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    const windows = collector.windows.snapshot();
    expect(windows.map((w) => [w.start, w.count])).toEqual([
      [1000, 2],
      [2000, 1],
    ]);
    expect(windows[0]?.memory.heapUsedLast).toBe(900);
    expect(windows[0]?.gc.count).toBe(2);
  });

  it('stores spans from every process', async () => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const collector = createCollector({ windowMs: WINDOW_MS, capacity: 10 });
    await collector.consume(Readable.from(interleaved));

    expect(collector.spans.snapshot().map((s) => s.spanId)).toEqual([
      '1'.repeat(16),
      '2'.repeat(16),
    ]);
  });

  it('still warns once when the run fails after skipping another process', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const collector = createCollector({ windowMs: WINDOW_MS, capacity: 10 });
    async function* failing(): AsyncGenerator<unknown> {
      yield makeSample(1000, PID_A, 100, 1000);
      yield makeSample(1001, PID_B, 900, 9000);
      yield makeSample(1002, PID_B, 900, 9000);
      throw new Error('source broke');
    }

    await expect(collector.consume(failing())).rejects.toThrow('source broke');
    expect(collector.ignored).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('1 other process on');
  });
});
