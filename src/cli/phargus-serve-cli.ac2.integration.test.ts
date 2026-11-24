import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, diagnostics, runCli } from '../../test/support.js';

const TEST_TIMEOUT_MS = 240_000;

/** A stack-trace line: whitespace, then `at `. */
const STACK_LINE = /^\s+at /m;

afterAll(cleanup, 60_000);

const CASES: ReadonlyArray<{ args: readonly string[]; flag: string }> = [
  { args: ['--bogus'], flag: '--bogus' },
  { args: ['--port', 'abc'], flag: '--port' },
  { args: ['--port', '70000'], flag: '--port' },
  { args: ['--window-ms', '0'], flag: '--window-ms' },
  { args: ['--max-line-bytes', '0'], flag: '--max-line-bytes' },
];

describe('phargus serve: unknown flags and bad flag values are usage errors', () => {
  it.each(CASES)(
    'AC-2: serve $args exits 2 and its stderr names $flag with no stack-trace line',
    async ({ args, flag }) => {
      const { run, exit } = await runCli(['serve', ...args]);

      expect(exit.code, diagnostics(run)).toBe(2);
      expect(run.stderr(), diagnostics(run)).toContain(flag);
      expect(run.stderr(), diagnostics(run)).not.toMatch(STACK_LINE);
    },
    TEST_TIMEOUT_MS,
  );
});
