import { ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCollector } from '../collector/index.js';
import { createDashboardServer, type DashboardServer } from './index.js';

const WINDOW_MS = 1000;
const BATCH = 40;

/** A full AgentSample-shaped object at the given timestamp. */
function makeSample(timestamp: number): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: 20, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 100, heapTotal: 200, rss: 1000, external: 0, arrayBuffers: 0 },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  };
}

/** Polls the predicate until it holds, or fails after the timeout. */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** Opens a raw `/events` connection and resolves once the first response bytes arrive. */
function openRawSseClient(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    // A reset the test itself causes is routine on this side too.
    socket.on('error', () => undefined);
    socket.once('connect', () => {
      socket.write(
        `GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`,
      );
    });
    socket.once('data', () => resolve(socket));
    socket.once('close', () => reject(new Error('closed before the response started')));
  });
}

const sockets: Socket[] = [];
const servers: DashboardServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function start(): Promise<{
  server: DashboardServer;
  collector: ReturnType<typeof createCollector>;
  onError: ReturnType<typeof vi.fn<(error: Error) => void>>;
}> {
  const collector = createCollector({ windowMs: WINDOW_MS, capacity: 50 });
  const onError = vi.fn<(error: Error) => void>();
  const server = await createDashboardServer({
    collector,
    host: '127.0.0.1',
    port: 0,
    heartbeatMs: 60_000,
    onError,
  });
  servers.push(server);
  return { server, collector, onError };
}

/** Records every `ServerResponse` that reaches `flushHeaders` (the SSE handler calls it once). */
function captureEventResponses(): ServerResponse[] {
  const captured: ServerResponse[] = [];
  const original = ServerResponse.prototype.flushHeaders;
  vi.spyOn(ServerResponse.prototype, 'flushHeaders').mockImplementation(function (
    this: ServerResponse,
  ): void {
    captured.push(this);
    original.call(this);
  });
  return captured;
}

describe('dashboard SSE disconnect reporting', () => {
  it('a client that resets while events are being written is cleanup, not an onError', async () => {
    const { server, collector, onError } = await start();
    let produced = 0;
    const feed = async (): Promise<void> => {
      const samples: Record<string, unknown>[] = [];
      for (let i = 0; i < BATCH; i += 1) {
        samples.push(makeSample((produced + i) * WINDOW_MS + 100));
      }
      produced += BATCH;
      await collector.consume(Readable.from(samples));
    };

    for (let cycle = 0; cycle < 30; cycle += 1) {
      const socket = await openRawSseClient(server.port);
      sockets.push(socket);
      // Fire the writes and the hang-up together, so the server writes to a peer that is going.
      const feeding = feed();
      socket.resetAndDestroy();
      await feeding;
    }
    // Writes after every peer has gone are the ones that surface EPIPE.
    for (let round = 0; round < 3; round += 1) {
      await feed();
    }
    await waitFor(() => server.clientCount === 0, 5_000, 'every SSE client to be cleaned up');

    expect(onError).not.toHaveBeenCalled();
  }, 60_000);

  it.each([
    ['EPIPE', 'write EPIPE'],
    ['ECONNRESET', 'read ECONNRESET'],
    [undefined, 'aborted'],
  ])(
    'an SSE response error (%s) from a peer that went away is not reported, and cleanup is idempotent',
    async (code, message) => {
      const captured = captureEventResponses();
      const { server, onError } = await start();
      const socket = await openRawSseClient(server.port);
      sockets.push(socket);
      await waitFor(() => server.clientCount === 1, 5_000, 'the SSE client to connect');
      const res = captured[0];
      expect(res).toBeDefined();

      const error = code === undefined ? new Error(message) : errnoError(code, message);
      res?.emit('error', error);
      expect(server.clientCount).toBe(0);
      // A second report of the same loss, after cleanup, changes nothing and does not throw.
      expect(() => res?.emit('error', error)).not.toThrow();
      res?.emit('close');
      expect(server.clientCount).toBe(0);
      expect(onError).not.toHaveBeenCalled();
      await expect(server.close()).resolves.toBeUndefined();
    },
  );

  it('an EPIPE on the SSE socket is not reported either', async () => {
    const captured = captureEventResponses();
    const { server, onError } = await start();
    const socket = await openRawSseClient(server.port);
    sockets.push(socket);
    await waitFor(() => server.clientCount === 1, 5_000, 'the SSE client to connect');

    captured[0]?.socket?.emit('error', errnoError('EPIPE', 'write EPIPE'));
    await waitFor(() => server.clientCount === 0, 5_000, 'the SSE client to be cleaned up');

    expect(onError).not.toHaveBeenCalled();
  });

  it('a genuine response error is still reported once, and the client is still cleaned up', async () => {
    const captured = captureEventResponses();
    const { server, onError } = await start();
    const socket = await openRawSseClient(server.port);
    sockets.push(socket);
    await waitFor(() => server.clientCount === 1, 5_000, 'the SSE client to connect');

    const genuine = errnoError('ENOSPC', 'no space left on device');
    captured[0]?.emit('error', genuine);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(genuine);
    expect(server.clientCount).toBe(0);
  });

  it('with no onError a genuine error becomes a process warning and an EPIPE does not', async () => {
    const captured = captureEventResponses();
    const warnings: string[] = [];
    vi.spyOn(process, 'emitWarning').mockImplementation((warning: string | Error): void => {
      warnings.push(typeof warning === 'string' ? warning : warning.message);
    });
    const collector = createCollector({ windowMs: WINDOW_MS, capacity: 50 });
    const server = await createDashboardServer({
      collector,
      host: '127.0.0.1',
      port: 0,
      heartbeatMs: 60_000,
    });
    servers.push(server);
    const socket = await openRawSseClient(server.port);
    sockets.push(socket);
    await waitFor(() => server.clientCount === 1, 5_000, 'the SSE client to connect');

    captured[0]?.emit('error', errnoError('EPIPE', 'write EPIPE'));
    expect(warnings).toEqual([]);

    const second = await openRawSseClient(server.port);
    sockets.push(second);
    await waitFor(() => server.clientCount === 1, 5_000, 'the second SSE client to connect');
    captured[1]?.emit('error', errnoError('ENOSPC', 'no space left on device'));
    expect(warnings).toEqual(['dashboard server error: no space left on device']);
  });
});
