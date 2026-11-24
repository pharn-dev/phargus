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

describe('examples/worker-pool: CPU tasks on Worker Threads', () => {
  it('AC-1: the example exits 0 with the agent enabled and reports the completed CPU worker tasks', async () => {
    const result = await runExample();
    const diagnostics = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

    expect(result.timedOut, diagnostics).toBe(false);
    expect(result.signal, diagnostics).toBeNull();
    expect(result.code, diagnostics).toBe(0);
    expect(result.stderr).not.toContain('[phargus] agent disabled');

    const match = /^\[worker-pool\] cpu tasks completed: ([1-9]\d*)$/m.exec(result.stdout);
    expect(match, diagnostics).not.toBeNull();
    const tasks = Number(match?.[1]);
    expect(Number.isSafeInteger(tasks)).toBe(true);
    expect(tasks).toBeGreaterThan(0);
  }, 90_000);
});
