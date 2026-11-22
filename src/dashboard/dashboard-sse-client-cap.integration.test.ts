import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createCollector } from '../collector/index.js';
import { createDashboardServer, type DashboardServer } from './index.js';

const sockets: Socket[] = [];
const servers: DashboardServer[] = [];

type EventsReply = { socket: Socket; status: number; head: string };

/** Opens a raw `GET /events` and resolves with the status once the response head arrives. */
function openEvents(port: number): Promise<EventsReply> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    sockets.push(socket);
    let data = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        socket.setTimeout(0);
        fn();
      }
    };
    socket.on('error', (error) => settle(() => reject(error)));
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('latin1');
      const end = data.indexOf('\r\n\r\n');
      if (end !== -1) {
        const head = data.slice(0, end + 4);
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
        settle(() => resolve({ socket, status, head }));
      }
    });
    socket.once('close', () =>
      settle(() => reject(new Error('connection closed before the response head'))),
    );
    socket.setTimeout(10_000, () =>
      settle(() => reject(new Error('timed out waiting for the /events response head'))),
    );
    socket.once('connect', () => {
      socket.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    });
  });
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await server.close();
});

describe('dashboard SSE client cap', () => {
  it('answers the 65th concurrent /events with 503, and accepts a new client once one closes', async () => {
    const server = await createDashboardServer({
      collector: createCollector({ windowMs: 1000, capacity: 10 }),
      host: '127.0.0.1',
      port: 0,
      heartbeatMs: 60_000,
    });
    servers.push(server);

    const accepted: Socket[] = [];
    for (let i = 0; i < 64; i += 1) {
      const reply = await openEvents(server.port);
      expect(reply.status, `client ${i + 1}`).toBe(200);
      accepted.push(reply.socket);
    }
    expect(server.clientCount).toBe(64);

    const overflow = await openEvents(server.port);
    expect(overflow.status).toBe(503);
    expect(overflow.head.toLowerCase()).toContain('connection: close');
    expect(server.clientCount).toBe(64);

    accepted[0]?.destroy();
    await waitFor(() => server.clientCount === 63, 'the closed client to be released');
    const next = await openEvents(server.port);
    expect(next.status).toBe(200);
    expect(server.clientCount).toBe(64);
  }, 30_000);
});
