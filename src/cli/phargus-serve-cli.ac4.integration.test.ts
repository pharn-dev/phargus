import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  COUNTS_LINE,
  diagnostics,
  EVENT_TIMEOUT_MS,
  INPUT_ENDED_LINE,
  openEvents,
  startCli,
  waitForPort,
  waitForStderr,
  waitForWindow,
  writeStdin,
} from '../../test/support.js';

const TEST_TIMEOUT_MS = 300_000;

afterAll(cleanup, 60_000);

/** A full agent sample object, the shape the auto-started agent writes. */
function makeSample(timestamp: number, eventLoopMax: number): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: eventLoopMax, mean: 10, p50: 9, p99: 18 },
    memory: {
      heapUsed: 1000 + eventLoopMax,
      heapTotal: 4000,
      rss: 9000,
      external: 0,
      arrayBuffers: 0,
    },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
    dropped: { samples: 0, spans: 0 },
  };
}

const BASE_MS = 1_700_000_000_000;

describe('phargus serve: stdin with mixed agent and log lines', () => {
  it(
    'AC-4: prints the dashboard URL, streams windows over SSE, reports the input end with the skip and ignored counts, and keeps serving after stdin ends',
    async () => {
      const { encodeNdjsonLine } = await import('../agent/ndjson-encoder.js');

      const samples = [
        makeSample(BASE_MS + 100, 40),
        makeSample(BASE_MS + 600, 60),
        makeSample(BASE_MS + 1_200, 80),
        makeSample(BASE_MS + 1_700, 30),
        makeSample(BASE_MS + 2_300, 50),
        makeSample(BASE_MS + 3_400, 20),
      ];
      const plainLines = [
        'Server listening on http://127.0.0.1:3000',
        'GET /users 200 12ms',
        'warning: cache miss for key "users"',
      ];
      const pinoLines = [
        JSON.stringify({ level: 30, time: BASE_MS, pid: 42, msg: 'request completed' }),
        JSON.stringify({ level: 40, time: BASE_MS + 100, pid: 42, msg: 'slow query' }),
      ];
      const N = plainLines.length;
      const M = pinoLines.length;

      const [s0, s1, s2, s3, s4, s5] = samples;
      const [t0, t1, t2] = plainLines;
      const [j0, j1] = pinoLines;
      const input =
        `${t0}\n` +
        encodeNdjsonLine(s0) +
        `${j0}\n` +
        encodeNdjsonLine(s1) +
        `${t1}\n` +
        encodeNdjsonLine(s2) +
        encodeNdjsonLine(s3) +
        `${j1}\n` +
        encodeNdjsonLine(s4) +
        `${t2}\n` +
        encodeNdjsonLine(s5);

      const run = startCli(['serve', '--port', '0', '--window-ms', '1000']);
      const port = await waitForPort(run);
      expect(port, diagnostics(run)).toBeGreaterThan(0);

      const live = await openEvents(port);
      expect(live.statusCode, diagnostics(run)).toBe(200);

      await writeStdin(run, input);
      const liveWindows = await waitForWindow(live, run);
      expect(liveWindows.length).toBeGreaterThanOrEqual(1);

      run.child.stdin.end();
      await waitForStderr(run, INPUT_ENDED_LINE, EVENT_TIMEOUT_MS);
      const counts = await waitForStderr(run, COUNTS_LINE, EVENT_TIMEOUT_MS);
      const invalid = Number(counts[1]);
      const oversized = Number(counts[2]);
      const foreign = Number(counts[3]);
      const ignored = Number(counts[4]);
      expect(invalid + oversized, `decoder skip count\n${diagnostics(run)}`).toBe(N);
      // The CLI's decoder skips JSON log lines itself (agentOnly), so they never reach the collector.
      expect(foreign, `decoder foreign count\n${diagnostics(run)}`).toBe(M);
      expect(ignored, `collector ignored count\n${diagnostics(run)}`).toBe(0);

      expect(
        run.exitInfo(),
        `the CLI must keep running after its input ended\n${diagnostics(run)}`,
      ).toBeUndefined();
      const late = await openEvents(port);
      expect(late.statusCode, diagnostics(run)).toBe(200);
      const lateWindows = await waitForWindow(late, run);
      expect(lateWindows.length).toBeGreaterThanOrEqual(1);
      expect(run.exitInfo(), diagnostics(run)).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});
