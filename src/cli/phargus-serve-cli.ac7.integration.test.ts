import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  diagnostics,
  openEvents,
  sleep,
  startCli,
  waitForPort,
} from '../../test/support.js';

const SHUTDOWN_BOUND_MS = 10_000;
const TEST_TIMEOUT_MS = 240_000;

const COUNTS_LINE =
  /decoder\.invalid=(\d+)[^\n]*decoder\.oversized=(\d+)[^\n]*collector\.ignored=(\d+)/;

afterAll(cleanup, 60_000);

const SIGNALS: ReadonlyArray<NodeJS.Signals> = ['SIGTERM', 'SIGINT'];

describe('phargus serve: graceful shutdown on a signal', () => {
  // On Windows, process.kill() with SIGTERM or SIGINT terminates the process without running its
  // signal handlers, so there is no graceful shutdown to observe (see docs/LIMITS.md).
  it.skipIf(process.platform === 'win32').each(SIGNALS)(
    'AC-7: on %s with stdin still open and an SSE client connected, serve exits 0 within 10 s, the SSE response ends and stderr reports the counts',
    async (signal) => {
      const run = startCli(['serve', '--port', '0']);
      const port = await waitForPort(run);
      expect(port, diagnostics(run)).toBeGreaterThan(0);

      const sse = await openEvents(port);
      expect(sse.statusCode, diagnostics(run)).toBe(200);
      expect(run.exitInfo(), diagnostics(run)).toBeUndefined();

      const signalledAt = Date.now();
      run.child.kill(signal);
      const outcome = await Promise.race([
        Promise.all([run.exited, sse.ended]).then(() => 'done' as const),
        sleep(SHUTDOWN_BOUND_MS).then(() => 'timeout' as const),
      ]);
      const elapsed = Date.now() - signalledAt;

      expect(outcome, `exit and SSE end within ${SHUTDOWN_BOUND_MS} ms\n${diagnostics(run)}`).toBe(
        'done',
      );
      expect(elapsed).toBeLessThanOrEqual(SHUTDOWN_BOUND_MS);
      expect(run.exitInfo()?.code, diagnostics(run)).toBe(0);
      expect(run.stderr(), diagnostics(run)).toMatch(COUNTS_LINE);
    },
    TEST_TIMEOUT_MS,
  );
});
