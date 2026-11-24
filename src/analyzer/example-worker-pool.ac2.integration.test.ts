import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, sleep, startNode } from '../../test/support.js';

const EXAMPLE_ENTRY = 'examples/worker-pool/index.mjs';

const RUN_TIMEOUT_MS = 60_000;

type RunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/** Runs the example to completion; one still running after RUN_TIMEOUT_MS is killed. */
async function runExample(): Promise<RunResult> {
  const run = startNode([EXAMPLE_ENTRY]);
  run.child.stdin.end();
  const timedOut = await Promise.race([
    run.exited.then(() => false),
    sleep(RUN_TIMEOUT_MS).then(() => true),
  ]);
  if (timedOut) run.child.kill('SIGKILL');
  const { code, signal, error } = await run.exited;
  if (error) throw error;
  return { code, signal, stdout: run.stdout(), stderr: run.stderr(), timedOut };
}

afterAll(cleanup);

describe('examples/worker-pool: heap snapshot analysis on the analyzer pool', () => {
  it('AC-2: the example prints a heap-snapshot summary and the main event loop ticked during the analysis', async () => {
    const result = await runExample();
    const diagnostics = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

    expect(result.timedOut, diagnostics).toBe(false);
    expect(result.signal, diagnostics).toBeNull();
    expect(result.code, diagnostics).toBe(0);

    const snapshot =
      /^\[worker-pool\] heap snapshot: nodes=([1-9]\d*) totalSelfSize=([1-9]\d*)$/m.exec(
        result.stdout,
      );
    expect(snapshot, diagnostics).not.toBeNull();
    const nodes = Number(snapshot?.[1]);
    const totalSelfSize = Number(snapshot?.[2]);
    expect(Number.isSafeInteger(nodes)).toBe(true);
    expect(nodes).toBeGreaterThan(0);
    expect(Number.isSafeInteger(totalSelfSize)).toBe(true);
    expect(totalSelfSize).toBeGreaterThan(0);

    const topNames = [
      ...result.stdout.matchAll(/^\[worker-pool\] heap top: (\S.*?) count=\d+ selfSize=\d+$/gm),
    ].map((m) => m[1] ?? '');
    expect(topNames.length, diagnostics).toBeGreaterThanOrEqual(1);
    for (const name of topNames) {
      expect(name.trim().length).toBeGreaterThan(0);
    }

    const ticks = /^\[worker-pool\] event loop ticks during analysis: (\d+)$/m.exec(result.stdout);
    expect(ticks, diagnostics).not.toBeNull();
    const tickCount = Number(ticks?.[1]);
    expect(Number.isSafeInteger(tickCount)).toBe(true);
    expect(tickCount).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
