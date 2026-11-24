import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import type { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cliEnv,
  diagnostics,
  HTTP_TIMEOUT_MS,
  openEvents,
  parseSse,
  repoRoot,
  sleep,
  STARTUP_TIMEOUT_MS,
  stopCli as stopExample,
  track,
  waitFor,
  type Proc,
} from '../../test/support.js';

const EXAMPLE_ENTRY = 'examples/express-app/index.mjs';

const WINDOW_TIMEOUT_MS = 20_000;
const LAG_THRESHOLD_NS = 50_000_000;

const APP_LINE = /^\[express-app\] app listening on http:\/\/127\.0\.0\.1:(\d+)$/m;
const DASHBOARD_LINE = /^\[express-app\] dashboard listening on http:\/\/127\.0\.0\.1:(\d+)$/m;

type ExampleRun = Proc<ChildProcessByStdio<null, Readable, Readable>>;

/** Spawns the example entry with both ports set to 0. */
function startExample(): ExampleRun {
  return track(
    spawn(process.execPath, [EXAMPLE_ENTRY], {
      cwd: repoRoot,
      env: cliEnv({ APP_PORT: '0', DASHBOARD_PORT: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

/** Waits for both address lines; fails if the example exits first or the timeout passes. */
async function waitForPorts(
  run: ExampleRun,
  timeoutMs: number,
): Promise<{ appPort: number; dashboardPort: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const app = APP_LINE.exec(run.stdout());
    const dashboard = DASHBOARD_LINE.exec(run.stdout());
    if (app && dashboard) {
      return { appPort: Number(app[1]), dashboardPort: Number(dashboard[1]) };
    }
    if (run.exitInfo() !== undefined) {
      throw new Error(`the example exited before reporting its addresses\n${diagnostics(run)}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the example's addresses\n${diagnostics(run)}`);
    }
    await sleep(25);
  }
}

/** GETs a path on 127.0.0.1 and resolves with the status code once the body has been read. */
function httpGet(port: number, path: string): Promise<number> {
  return new Promise((done, fail) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false },
      (response) => {
        response.on('error', fail);
        response.on('end', () => {
          done(response.statusCode ?? 0);
        });
        response.resume();
      },
    );
    request.on('error', fail);
    request.setTimeout(HTTP_TIMEOUT_MS, () => {
      request.destroy(new Error(`GET ${path} timed out`));
    });
    request.end();
  });
}

type SseConnection = Omit<Awaited<ReturnType<typeof openEvents>>, 'errors'> & {
  errors: () => string[];
};

/** Opens GET /events and resolves on the response headers; the body is collected as it arrives. */
async function openSse(port: number): Promise<SseConnection> {
  const sse = await openEvents(port);
  return { ...sse, errors: () => sse.errors };
}

type WindowView = { end: unknown; eventLoopMax: unknown };

function windowsOf(connection: SseConnection): WindowView[] {
  return parseSse(connection.body())
    .filter((event) => event.event === 'window')
    .map((event) => {
      const parsed = JSON.parse(event.data.join('\n')) as unknown;
      const record =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const eventLoop = record['eventLoop'];
      const eventLoopMax =
        typeof eventLoop === 'object' && eventLoop !== null
          ? (eventLoop as Record<string, unknown>)['max']
          : undefined;
      return { end: record['end'], eventLoopMax };
    });
}

let current: ExampleRun | undefined;
const connections: SseConnection[] = [];

afterAll(async () => {
  for (const connection of connections) {
    connection.request.destroy();
  }
  if (current !== undefined) {
    await stopExample(current);
  }
}, 40_000);

describe('examples/express-app: the slow route shows up as event-loop lag in a window event', () => {
  it('AC-2: after a request to the slow route the SSE stream delivers a window event with eventLoop.max of at least 50 ms', async () => {
    const run = startExample();
    current = run;
    const { appPort, dashboardPort } = await waitForPorts(run, STARTUP_TIMEOUT_MS);

    const sse = await openSse(dashboardPort);
    connections.push(sse);
    expect(sse.statusCode, diagnostics(run)).toBe(200);
    expect(sse.contentType).toMatch(/^text\/event-stream/);

    const sentAt = Date.now();
    expect(await httpGet(appPort, '/slow'), diagnostics(run)).toBe(200);

    const laggedAfterRequest = (): boolean =>
      windowsOf(sse).some(
        (window) =>
          typeof window.end === 'number' &&
          window.end >= sentAt &&
          typeof window.eventLoopMax === 'number' &&
          window.eventLoopMax >= LAG_THRESHOLD_NS,
      );
    await waitFor(
      laggedAfterRequest,
      WINDOW_TIMEOUT_MS,
      () =>
        `a window event ending at or after ${String(sentAt)} with eventLoop.max >= ${String(LAG_THRESHOLD_NS)}\nSSE body:\n${sse.body()}\n${diagnostics(run)}`,
    );
    expect(laggedAfterRequest()).toBe(true);
    expect(sse.errors()).toEqual([]);
  }, 90_000);
});
