import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  diagnostics,
  rawRequest,
  repoRoot,
  runCli,
  startCli,
  STARTUP_TIMEOUT_MS,
  stopCli,
  waitForStderr,
  type CliRun,
} from '../../test/support.js';

const TEST_TIMEOUT_MS = 240_000;

async function waitForDashboardPort(run: CliRun): Promise<number> {
  const match = await waitForStderr(
    run,
    /dashboard at http:\/\/127\.0\.0\.1:(\d+)/,
    STARTUP_TIMEOUT_MS,
  );
  return Number(match[1]);
}

afterAll(cleanup, 60_000);

describe('phargus CLI: --help and --version', () => {
  it(
    'AC-1: --help exits 0 and prints to stdout a usage text naming serve and --port, --host, --token, --window-ms and --max-line-bytes',
    async () => {
      const { run, exit } = await runCli(['--help']);

      expect(exit.code, diagnostics(run)).toBe(0);
      for (const word of [
        'serve',
        '--port',
        '--host',
        '--token',
        '--window-ms',
        '--max-line-bytes',
      ]) {
        expect(run.stdout(), `usage text names ${word}\n${diagnostics(run)}`).toContain(word);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "AC-1: --version exits 0 and prints to stdout the package.json's version",
    async () => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      expect(typeof manifest.version).toBe('string');
      const version = String(manifest.version);

      const { run, exit } = await runCli(['--version']);

      expect(exit.code, diagnostics(run)).toBe(0);
      expect(run.stdout(), diagnostics(run)).toContain(version);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('phargus CLI: malformed dashboard requests', () => {
  it(
    'AC: malformed request targets do not stop the built CLI and SIGTERM exits 0',
    async () => {
      const run = startCli(['serve', '--port', '0']);
      run.child.stdin.end();
      try {
        const port = await waitForDashboardPort(run);
        for (const target of ['//', '//[', '//x:y', 'http://a:b/']) {
          const reply = await rawRequest(port, target);
          expect(reply, target).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
        }
        expect(run.exitInfo(), diagnostics(run)).toBeUndefined();
      } finally {
        await stopCli(run);
      }
      // On Windows, process.kill() with SIGTERM terminates the process without running its signal
      // handlers, so there is no graceful exit code to observe (see docs/LIMITS.md).
      if (process.platform !== 'win32') {
        expect(run.exitInfo(), diagnostics(run)).toEqual({ code: 0, signal: null });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
