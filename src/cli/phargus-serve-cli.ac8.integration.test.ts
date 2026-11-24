import { createServer, type Server } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  cliEnv,
  diagnostics,
  RUN_TIMEOUT_MS,
  startCli,
  waitForExit,
  type CliRun,
  type ExitInfo,
} from '../../test/support.js';

const TEST_TIMEOUT_MS = 240_000;

/** A stack-trace line: whitespace, then `at `. */
const STACK_LINE = /^\s+at /m;

const servers: Server[] = [];

/** Runs the CLI with stdin left open (as a pipe from a live app would be) until it exits. */
async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ run: CliRun; exit: ExitInfo }> {
  const run = startCli(args, env);
  const exit = await waitForExit(run, RUN_TIMEOUT_MS);
  return { run, exit };
}

/** Binds a plain TCP listener on 127.0.0.1 and an ephemeral port, and returns that port. */
function occupyPort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    servers.push(server);
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        fail(new Error(`unexpected listener address ${JSON.stringify(address)}`));
        return;
      }
      done(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done) => {
    server.close(() => {
      done();
    });
  });
}

afterAll(async () => {
  await cleanup();
  for (const server of servers) {
    await closeServer(server);
  }
}, 60_000);

describe('phargus serve: a port already in use', () => {
  it(
    'AC-8: serve --port <a bound port> exits 1 naming the port with no stack-trace line, and with PHARGUS_DEBUG=1 still exits 1 with a stack-trace line',
    async () => {
      const port = await occupyPort();

      const plain = await runCli(['serve', '--port', String(port)], cliEnv());
      expect(plain.exit.code, diagnostics(plain.run)).toBe(1);
      expect(plain.run.stderr(), diagnostics(plain.run)).toContain(String(port));
      expect(plain.run.stderr(), diagnostics(plain.run)).not.toMatch(STACK_LINE);

      const debug = await runCli(['serve', '--port', String(port)], cliEnv({ PHARGUS_DEBUG: '1' }));
      expect(debug.exit.code, diagnostics(debug.run)).toBe(1);
      expect(debug.run.stderr(), diagnostics(debug.run)).toMatch(STACK_LINE);
    },
    TEST_TIMEOUT_MS,
  );
});
