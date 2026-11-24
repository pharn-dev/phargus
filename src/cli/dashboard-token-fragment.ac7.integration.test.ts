import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  cliEnv,
  RUN_TIMEOUT_MS,
  sleep,
  startCli,
  STARTUP_TIMEOUT_MS,
  stopCli,
  URL_LINE,
  waitForExit,
  type CliRun,
} from '../../test/support.js';

// AC-7: `phargus serve` with PHARGUS_TOKEN prints the fragment login link with the literal <token>
// placeholder and the bound port, never the token; `phargus --help` describes the fragment login.

const TEST_TIMEOUT_MS = 240_000;

/** The run's output for a failure message, with the token masked so it never reaches a report. */
function diagnostics(run: CliRun, secret?: string): string {
  const mask = (text: string): string =>
    secret === undefined ? text : text.split(secret).join('<TOKEN VALUE>');
  return mask(
    `stdout:\n${run.stdout()}\nstderr:\n${run.stderr()}\nnotes: ${run.notes.join('; ')}\nexit: ${JSON.stringify(run.exitInfo() ?? null)}`,
  );
}

/** Waits until stderr matches the predicate; fails if the CLI exits first or the timeout passes. */
async function waitForStderr(
  run: CliRun,
  predicate: (stderr: string) => boolean,
  what: string,
  secret: string,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    if (predicate(run.stderr())) return;
    if (run.exitInfo() !== undefined) {
      throw new Error(`the CLI exited before its stderr had ${what}\n${diagnostics(run, secret)}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for stderr to have ${what}\n${diagnostics(run, secret)}`);
    }
    await sleep(25);
  }
}

afterAll(cleanup, 60_000);

describe('phargus serve: the fragment login link', () => {
  it(
    'AC-7: serve --port 0 with PHARGUS_TOKEN prints http://127.0.0.1:<port>/login#token=<token> on stderr with the literal placeholder and never the token, and --help describes --token with /login#token=',
    async () => {
      const token = `ac7-${randomBytes(12).toString('hex')}`;

      const serve = startCli(['serve', '--port', '0'], cliEnv({ PHARGUS_TOKEN: token }));
      try {
        await waitForStderr(serve, (text) => URL_LINE.test(text), 'the dashboard URL', token);
        const port = Number(URL_LINE.exec(serve.stderr())?.[1]);
        expect(port, diagnostics(serve, token)).toBeGreaterThan(0);
        const link = `http://127.0.0.1:${port}/login#token=<token>`;
        await waitForStderr(
          serve,
          (text) => text.split('\n').some((line) => line.includes(link)),
          `a line with ${link}`,
          token,
        );
        expect(
          serve
            .stderr()
            .split('\n')
            .some((line) => line.includes(link)),
          diagnostics(serve, token),
        ).toBe(true);
        expect(serve.stderr().includes(token), 'the token value on stderr').toBe(false);
        expect(serve.stdout().includes(token), 'the token value on stdout').toBe(false);
      } finally {
        await stopCli(serve);
      }

      const help = startCli(['--help']);
      help.child.stdin.end();
      const exit = await waitForExit(help, RUN_TIMEOUT_MS);
      expect(exit.code, diagnostics(help)).toBe(0);
      expect(help.stdout(), diagnostics(help)).toContain('--token');
      expect(help.stdout(), diagnostics(help)).toContain('/login#token=');
    },
    TEST_TIMEOUT_MS,
  );
});
