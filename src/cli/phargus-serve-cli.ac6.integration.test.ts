import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  diagnostics,
  openEvents,
  RUN_TIMEOUT_MS,
  startCli,
  tempDir,
  waitForExit,
  waitForPort,
  waitForWindow,
} from '../../test/support.js';

const TEST_TIMEOUT_MS = 300_000;

/** A stack-trace line: whitespace, then `at `. */
const STACK_LINE = /^\s+at /m;

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

/** Agent sample lines spanning three 1000 ms windows, encoded the way the agent writes them. */
async function captureContent(): Promise<string> {
  const { encodeNdjsonLine } = await import('../agent/ndjson-encoder.js');
  return [
    makeSample(BASE_MS + 100, 40),
    makeSample(BASE_MS + 700, 60),
    makeSample(BASE_MS + 1_300, 80),
    makeSample(BASE_MS + 1_800, 30),
    makeSample(BASE_MS + 2_400, 50),
  ]
    .map((sample) => encodeNdjsonLine(sample))
    .join('');
}

describe('phargus serve: file and stdin input', () => {
  it(
    'AC-6: serve --port 0 <file> replays an NDJSON capture and an SSE client receives a window event',
    async () => {
      const dir = tempDir('phargus-ac6-');
      const file = join(dir, 'capture.ndjson');
      writeFileSync(file, await captureContent());

      const run = startCli(['serve', '--port', '0', file]);
      const port = await waitForPort(run);
      expect(port, diagnostics(run)).toBeGreaterThan(0);

      const sse = await openEvents(port);
      expect(sse.statusCode, diagnostics(run)).toBe(200);
      const windows = await waitForWindow(sse, run);
      expect(windows.length).toBeGreaterThanOrEqual(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'AC-6: serve --port 0 - reads the same content from stdin and an SSE client receives a window event',
    async () => {
      const content = await captureContent();

      const run = startCli(['serve', '--port', '0', '-']);
      const port = await waitForPort(run);
      expect(port, diagnostics(run)).toBeGreaterThan(0);

      run.child.stdin.end(content);
      const sse = await openEvents(port);
      expect(sse.statusCode, diagnostics(run)).toBe(200);
      const windows = await waitForWindow(sse, run);
      expect(windows.length).toBeGreaterThanOrEqual(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'AC-6: serve --port 0 <missing path> exits 1 with a stderr message naming the path and no stack-trace line',
    async () => {
      const dir = tempDir('phargus-ac6-missing-');
      const missing = join(dir, 'no-such-capture.ndjson');

      const run = startCli(['serve', '--port', '0', missing]);
      run.child.stdin.end();
      const exit = await waitForExit(run, RUN_TIMEOUT_MS);

      expect(exit.code, diagnostics(run)).toBe(1);
      expect(run.stderr(), diagnostics(run)).toContain(missing);
      expect(run.stderr(), diagnostics(run)).not.toMatch(STACK_LINE);
    },
    TEST_TIMEOUT_MS,
  );
});
