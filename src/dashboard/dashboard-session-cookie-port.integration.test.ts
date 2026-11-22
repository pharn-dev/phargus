import { request, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createCollector } from '../collector/index.js';
import { createDashboardServer, type DashboardServer } from './index.js';

type Reply = { status: number; headers: IncomingHttpHeaders };
const servers: DashboardServer[] = [];

/** One request to 127.0.0.1; an event stream is answered as soon as its headers arrive. */
function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        agent: false,
      },
      (res) => {
        const reply = { status: res.statusCode ?? 0, headers: res.headers };
        if ((res.headers['content-type'] ?? '').startsWith('text/event-stream')) {
          req.destroy();
          resolve(reply);
          return;
        }
        res.resume();
        res.on('error', reject);
        res.on('end', () => resolve(reply));
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    req.end(options.body);
  });
}

/**
 * A browser's cookie jar for one host: cookies ignore ports, so every cookie set by any port is
 * stored by name alone and sent to every port.
 */
function createJar(): {
  store(reply: Reply): void;
  header(): string;
  names(): string[];
} {
  const cookies = new Map<string, string>();
  return {
    store(reply: Reply): void {
      for (const line of reply.headers['set-cookie'] ?? []) {
        const pair = line.split(';', 1)[0] ?? '';
        const eq = pair.indexOf('=');
        cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    },
    header(): string {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    names(): string[] {
      return [...cookies.keys()];
    },
  };
}

async function start(token: string): Promise<DashboardServer> {
  const server = await createDashboardServer({
    collector: createCollector({ windowMs: 1000, capacity: 10 }),
    host: '127.0.0.1',
    port: 0,
    token,
  });
  servers.push(server);
  return server;
}

function login(port: number, token: string): Promise<Reply> {
  return send(port, '/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe('dashboard session cookie scoped to the bound port', () => {
  it('sets and accepts only phargus_session_<bound port>, even on a port 0 bind', async () => {
    const server = await start('only-port-token');
    const reply = await login(server.port, 'only-port-token');
    expect(reply.status).toBe(204);
    const pair = (reply.headers['set-cookie']?.[0] ?? '').split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    expect(pair.slice(0, eq)).toBe(`phargus_session_${server.port}`);
    const value = pair.slice(eq + 1);

    const events = (cookie: string): Promise<Reply> =>
      send(server.port, '/events', { headers: { cookie } });
    expect((await events(pair)).status).toBe(200);
    expect((await events(`phargus_token=${value}`)).status, 'the old cookie name').toBe(401);
    expect((await events(`phargus_session_0=${value}`)).status, 'the requested port').toBe(401);
    expect(
      (await events(`phargus_session_${server.port + 1}=${value}`)).status,
      "another port's name",
    ).toBe(401);
  });

  it('keeps separate sessions for two dashboards on one host sharing one cookie jar', async () => {
    const first = await start('first-dashboard-token');
    const second = await start('second-dashboard-token');
    const jar = createJar();

    const firstLogin = await login(first.port, 'first-dashboard-token');
    expect(firstLogin.status).toBe(204);
    jar.store(firstLogin);
    // Logging in to the second dashboard must not overwrite the first one's session.
    const secondLogin = await login(second.port, 'second-dashboard-token');
    expect(secondLogin.status).toBe(204);
    jar.store(secondLogin);
    expect(jar.names().sort()).toEqual(
      [`phargus_session_${first.port}`, `phargus_session_${second.port}`].sort(),
    );

    const cookie = jar.header();
    expect((await send(first.port, '/events', { headers: { cookie } })).status).toBe(200);
    expect((await send(second.port, '/events', { headers: { cookie } })).status).toBe(200);
    // Each cookie authenticates only the dashboard that set it.
    const [firstCookie, secondCookie] = cookie.split('; ');
    expect(
      (await send(first.port, '/events', { headers: { cookie: secondCookie ?? '' } })).status,
    ).toBe(401);
    expect(
      (await send(second.port, '/events', { headers: { cookie: firstCookie ?? '' } })).status,
    ).toBe(401);
  });
});
