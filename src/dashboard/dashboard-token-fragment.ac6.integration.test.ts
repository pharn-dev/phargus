import { request, type IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';

// AC-6, after the removal of the deprecated GET /?token= login: a `?token=` query is no credential.
// Every request that carries one, with the right token or a wrong one, on the page, an asset or
// /events, answers 401 with no Set-Cookie and the error security headers, and no process warning
// (the old deprecation warning included) is emitted.

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

/** One request over a fresh connection with exactly these headers and body, read to the end. */
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
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`timed out: ${method} ${path}`)));
    req.end(options.body);
  });
}

/** Asserts the 401 a `?token=` request gets: no cookie, no event stream, the error headers. */
function expectRejected(what: string, result: Result): void {
  expect(result.status, what).toBe(401);
  expect(result.headers['set-cookie'], `${what}: no Set-Cookie`).toBeUndefined();
  expect(result.headers.location, `${what}: no redirect`).toBeUndefined();
  expect(result.headers['www-authenticate'], `${what}: WWW-Authenticate`).toBe('Bearer');
  expect(result.headers['x-content-type-options'], `${what}: nosniff`).toBe('nosniff');
  expect(result.headers['content-security-policy'] ?? '', `${what}: CSP`).toMatch(
    /(^|;\s*)default-src 'none'(;|$)/,
  );
  expect(result.headers['referrer-policy'], `${what}: referrer-policy`).toBe('no-referrer');
  expect(result.body, `${what}: no event stream`).not.toMatch(/^event:/m);
}

/** Runs `body` against a token-gated dashboard and returns the process warnings it raised. */
async function withServer(body: (port: number, host: string) => Promise<void>): Promise<Error[]> {
  const collectorModule = (await import('../collector/index.js')) as unknown as CollectorModule;
  const dashboardModule = (await import('./index.js')) as unknown as DashboardModule;
  const warnings: Error[] = [];
  const onWarning = (warning: Error): void => {
    warnings.push(warning);
  };
  process.on('warning', onWarning);
  let server: DashboardServerUnderTest | undefined;
  try {
    server = await dashboardModule.createDashboardServer({
      collector: collectorModule.createCollector({ windowMs: 1000, capacity: 10 }),
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
    });
    await body(server.port, `127.0.0.1:${server.port}`);
    // process.emitWarning delivers on a later tick; let any warning land before counting.
    await new Promise((resolve) => setImmediate(resolve));
    return warnings;
  } finally {
    process.off('warning', onWarning);
    await server?.close();
  }
}

describe('dashboard ?token= query after the legacy login was removed — AC-6', () => {
  it('AC-6: GET /?token=s3cret (the right token) answers 401 with no Set-Cookie and the security headers on every attempt', async () => {
    await withServer(async (port, host) => {
      for (const attempt of [1, 2]) {
        expectRejected(
          `GET /?token=s3cret #${attempt}`,
          await send(port, `/?token=${TOKEN}`, { headers: { host } }),
        );
      }
    });
  }, 30_000);

  it('AC-6: GET /?token=wrong answers 401 with no Set-Cookie and the security headers', async () => {
    await withServer(async (port, host) => {
      expectRejected('GET /?token=wrong', await send(port, '/?token=wrong', { headers: { host } }));
    });
  }, 30_000);

  it('AC-6: the right ?token= on the assets and /events answers 401 with no Set-Cookie and the security headers', async () => {
    await withServer(async (port, host) => {
      for (const path of ['/app.js', '/app.css', '/events']) {
        const url = `${path}?token=${TOKEN}`;
        expectRejected(`GET ${url}`, await send(port, url, { headers: { host } }));
      }
    });
  }, 30_000);

  it('AC-6: no ?token= request emits a process warning, the old deprecation warning included', async () => {
    const warnings = await withServer(async (port, host) => {
      for (const path of ['/', '/app.js', '/app.css', '/events']) {
        for (const value of [TOKEN, 'wrong']) {
          const url = `${path}?token=${value}`;
          expect((await send(port, url, { headers: { host } })).status, `GET ${url}`).toBe(401);
        }
      }
    });
    expect(warnings, 'process warnings').toEqual([]);
  }, 30_000);
});
