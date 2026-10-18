import { request, type IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';

// AC-3: POST /session with the right token as JSON answers 204 with an HttpOnly, SameSite=Strict,
// Path=/ session cookie that opens /events and is the same cookie the legacy ?token= exchange sets.

const TOKEN = 's3cret';

type DashboardServerUnderTest = {
  readonly port: number;
  close(): Promise<void>;
};

type DashboardModule = {
  createDashboardServer: (options: {
    collector: unknown;
    host: string;
    port: number;
    token?: string;
  }) => Promise<DashboardServerUnderTest>;
};

type CollectorModule = {
  createCollector: (options: { windowMs: number; capacity: number }) => unknown;
};

type Result = { status: number; headers: IncomingHttpHeaders; body: string };

/**
 * One request over a fresh connection with exactly these headers and body. An event stream is cut
 * after its headers; anything else is read to the end.
 */
function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Result> {
  const method = options.method ?? 'GET';
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: options.headers ?? {}, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        const done = (): void =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        if ((res.headers['content-type'] ?? '').startsWith('text/event-stream')) {
          res.on('error', () => {
            // Destroying the open stream aborts the response; that is not a failure.
          });
          done();
          req.destroy();
          return;
        }
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', done);
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET') {
        reject(error);
      }
    });
    req.setTimeout(10_000, () => req.destroy(new Error(`timed out: ${method} ${path}`)));
    req.end(options.body);
  });
}

/** The Set-Cookie lines of a response. */
function setCookies(result: Result): string[] {
  return result.headers['set-cookie'] ?? [];
}

/** The `name=value` pair of a Set-Cookie line. */
function cookiePair(setCookie: string): { name: string; value: string } {
  const pair = setCookie.split(';')[0]?.trim() ?? '';
  const eq = pair.indexOf('=');
  return eq === -1
    ? { name: pair, value: '' }
    : { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
}

describe('dashboard POST /session — AC-3', () => {
  it('AC-3: POST /session with {"token":"s3cret"} (no Origin, or its own origin) answers 204 with an HttpOnly SameSite=Strict Path=/ cookie that is not the token, opens /events, and equals the legacy ?token= cookie', async () => {
    const collectorModule = (await import('../collector/index.js')) as unknown as CollectorModule;
    const dashboardModule = (await import('./index.js')) as unknown as DashboardModule;

    let server: DashboardServerUnderTest | undefined;
    try {
      const collector = collectorModule.createCollector({ windowMs: 1000, capacity: 10 });
      server = await dashboardModule.createDashboardServer({
        collector,
        host: '127.0.0.1',
        port: 0,
        token: TOKEN,
      });
      const port = server.port;
      const host = `127.0.0.1:${port}`;

      // The legacy exchange on the same server, for the cookie comparison.
      const legacy = await send(port, `/?token=${TOKEN}`, { headers: { host } });
      expect(legacy.status, 'GET /?token=s3cret').toBe(303);
      expect(setCookies(legacy)).toHaveLength(1);
      const legacyPair = cookiePair(setCookies(legacy)[0] ?? '');

      const variants: [string, Record<string, string>][] = [
        ['no Origin', {}],
        ['its own Origin', { origin: `http://127.0.0.1:${port}` }],
      ];
      for (const [what, extra] of variants) {
        const response = await send(port, '/session', {
          method: 'POST',
          headers: { host, 'content-type': 'application/json', ...extra },
          body: JSON.stringify({ token: TOKEN }),
        });
        expect(response.status, `POST /session with ${what}`).toBe(204);
        const cookies = setCookies(response);
        expect(cookies, `${what}: one Set-Cookie`).toHaveLength(1);
        const setCookie = cookies[0] ?? '';
        const attributes = setCookie
          .split(';')
          .slice(1)
          .map((part) => part.trim().toLowerCase());
        expect(attributes, `${what}: HttpOnly`).toContain('httponly');
        expect(attributes, `${what}: SameSite=Strict`).toContain('samesite=strict');
        expect(attributes, `${what}: Path=/`).toContain('path=/');
        const pair = cookiePair(setCookie);
        expect(pair.name, `${what}: a cookie name`).not.toBe('');
        expect(pair.value, `${what}: a cookie value`).not.toBe('');
        expect(pair.value, `${what}: the value is not the token`).not.toBe(TOKEN);
        expect(setCookie, `${what}: no token in the Set-Cookie`).not.toContain(TOKEN);

        // The cookie alone authorizes the event stream.
        const events = await send(port, '/events', {
          headers: { host, cookie: `${pair.name}=${pair.value}` },
        });
        expect(events.status, `${what}: GET /events with the cookie`).toBe(200);
        expect(events.headers['content-type'] ?? '').toMatch(/^text\/event-stream/);

        // The same cookie the legacy exchange sets on this server.
        expect(pair, `${what}: equals the legacy ?token= cookie`).toEqual(legacyPair);
      }
    } finally {
      await server?.close();
    }
  }, 30_000);
});
