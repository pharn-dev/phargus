import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BIN,
  cleanup,
  cliEnv as cleanEnv,
  openEvents,
  parseSse,
  repoRoot,
  sleep,
  STARTUP_TIMEOUT_MS,
  stopCli as stopProc,
  tempDir,
  track,
  URL_LINE,
  waitForStderr,
  type PipedChild,
  type Proc,
  type SseConnection,
} from '../../test/support.js';

const AGENT_ENTRY = join(repoRoot, 'dist', 'esm', 'agent', 'auto.js');

const EVENT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 300_000;

/** The monitored app: it writes its own plain-text log lines to stdout and runs until killed. */
const APP_SOURCE = [
  'let n = 0;',
  "setInterval(() => { console.log('plain app log line ' + String(n++)); }, 200);",
].join('\n');

function describeProc(name: string, proc: Proc<PipedChild>): string {
  return `${name} stderr:\n${proc.stderr()}\n${name} notes: ${proc.notes.join('; ')}\n${name} exit: ${JSON.stringify(proc.exitInfo() ?? null)}`;
}

type WindowView = { start: unknown; count: unknown };

function windowsOf(connection: SseConnection): WindowView[] {
  return parseSse(connection.body())
    .filter((event) => event.event === 'window')
    .map((event) => {
      const parsed = JSON.parse(event.data.join('\n')) as unknown;
      const record =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      return { start: record['start'], count: record['count'] };
    });
}

afterAll(cleanup, 60_000);

describe('phargus serve: a real agent-instrumented app piped in', () => {
  it(
    "AC-5: an app started with --import of the built agent, its stdout piped into serve --port 0 together with plain-text log lines, yields a window event from the real agent's samples",
    async () => {
      // The app runs from an empty directory so no phargus.config.* steers its agent.
      const appDir = tempDir('phargus-ac5-app-');

      const cliChild = spawn(process.execPath, [BIN, 'serve', '--port', '0'], {
        cwd: repoRoot,
        env: cleanEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cli = track(cliChild);
      cliChild.stdout.resume();
      cliChild.stdin.on('error', (err) => cli.notes.push(`child stdin error: ${err.message}`));

      const appChild = spawn(
        process.execPath,
        ['--import', pathToFileURL(AGENT_ENTRY).href, '-e', APP_SOURCE],
        { cwd: appDir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const app = track(appChild, 'never-read');
      const piped = pipeline(appChild.stdout, cliChild.stdin).catch((err: unknown) => {
        app.notes.push(`pipe error: ${err instanceof Error ? err.message : String(err)}`);
      });

      const what = (): string => `${describeProc('cli', cli)}\n${describeProc('app', app)}`;
      const match = await waitForStderr(cli, URL_LINE, STARTUP_TIMEOUT_MS, what);
      const port = Number(match[1]);
      expect(port, what()).toBeGreaterThan(0);

      const sse = await openEvents(port);
      expect(sse.statusCode, what()).toBe(200);

      const startedAt = Date.now();
      const deadline = startedAt + EVENT_TIMEOUT_MS;
      while (windowsOf(sse).length === 0) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for a window event\nSSE body:\n${sse.body()}\n${what()}`,
          );
        }
        await sleep(50);
      }

      const [first] = windowsOf(sse);
      expect(typeof first?.count, what()).toBe('number');
      expect(Number(first?.count), what()).toBeGreaterThanOrEqual(1);
      expect(typeof first?.start, what()).toBe('number');
      // Real samples carry wall-clock timestamps, so the window starts close to now.
      expect(Math.abs(Number(first?.start) - startedAt), what()).toBeLessThan(600_000);

      await stopProc(app);
      await piped;
    },
    TEST_TIMEOUT_MS,
  );
});
