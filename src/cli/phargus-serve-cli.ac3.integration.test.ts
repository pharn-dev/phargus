import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  cliEnv,
  diagnostics,
  openEvents,
  RUN_TIMEOUT_MS,
  startCli,
  URL_LINE,
  waitForExit,
  waitForPort,
} from '../../test/support.js';

const TEST_TIMEOUT_MS = 240_000;

afterAll(cleanup, 60_000);

describe('phargus serve: the token gate', () => {
  it(
    'AC-3: serve --host 0.0.0.0 --port 0 with no --token and no PHARGUS_TOKEN exits 2 saying a token is required for a non-loopback host',
    async () => {
      const run = startCli(['serve', '--host', '0.0.0.0', '--port', '0']);
      const exit = await waitForExit(run, RUN_TIMEOUT_MS);

      expect(exit.code, diagnostics(run)).toBe(2);
      expect(run.stderr(), diagnostics(run)).toMatch(/token/i);
      expect(run.stderr(), diagnostics(run)).toMatch(/required/i);
      expect(run.stderr(), diagnostics(run)).toMatch(/loopback/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'AC-3: with PHARGUS_TOKEN set, serve --port 0 on loopback answers GET /events with 401 without credentials and 200 with Authorization: Bearer <token>',
    async () => {
      const token = `ac3-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 24)}`;
      const run = startCli(['serve', '--port', '0'], cliEnv({ PHARGUS_TOKEN: token }));
      const port = await waitForPort(run);
      expect(port, diagnostics(run)).toBeGreaterThan(0);

      const anonymous = await openEvents(port);
      expect(anonymous.statusCode, diagnostics(run)).toBe(401);
      anonymous.request.destroy();

      const authorized = await openEvents(port, { authorization: `Bearer ${token}` });
      expect(authorized.statusCode, diagnostics(run)).toBe(200);
      authorized.request.destroy();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'AC-3: a short --token exits 2 before a non-loopback server binds',
    async () => {
      const run = startCli([
        'serve',
        '--host',
        '0.0.0.0',
        '--port',
        '0',
        '--token',
        'secret-short',
      ]);
      const exit = await waitForExit(run, RUN_TIMEOUT_MS);

      expect(exit.code, diagnostics(run)).toBe(2);
      expect(run.stderr(), diagnostics(run)).toContain('16 characters');
      expect(run.stderr(), diagnostics(run)).not.toContain('secret-short');
      expect(run.stderr(), diagnostics(run)).not.toMatch(URL_LINE);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'AC-3: a short PHARGUS_TOKEN exits 2 before a non-loopback server binds',
    async () => {
      const run = startCli(
        ['serve', '--host', '0.0.0.0', '--port', '0'],
        cliEnv({ PHARGUS_TOKEN: 'secret-short' }),
      );
      const exit = await waitForExit(run, RUN_TIMEOUT_MS);

      expect(exit.code, diagnostics(run)).toBe(2);
      expect(run.stderr(), diagnostics(run)).toContain('16 characters');
      expect(run.stderr(), diagnostics(run)).not.toContain('secret-short');
      expect(run.stderr(), diagnostics(run)).not.toMatch(URL_LINE);
    },
    TEST_TIMEOUT_MS,
  );
});
