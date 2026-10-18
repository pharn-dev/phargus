import { request, type IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';

// AC-6: the legacy GET /?token= exchange still answers 303 with the POST /session cookie, and the
// server warns exactly once with a PHARGUS_DEP_TOKEN_QUERY DeprecationWarning that omits the token.

const TOKEN = 's3cret';
const CODE = 'PHARGUS_DEP_TOKEN_QUERY';

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

/** The `name=value` pair of a response's single Set-Cookie line ('' when there is none). */
function cookiePair(result: Result): string {
  return (result.headers['set-cookie']?.[0] ?? '').split(';')[0]?.trim() ?? '';
}

describe('dashboard legacy ?token= exchange — AC-6', () => {
  it('AC-6: GET /?token=s3cret twice answers 303 to / with the POST /session cookie each time, and emits exactly one PHARGUS_DEP_TOKEN_QUERY DeprecationWarning without the token', async () => {
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
      const port = server.port;
      const host = `127.0.0.1:${port}`;

      const body = JSON.stringify({ token: TOKEN });
      const session = await send(port, '/session', {
        method: 'POST',
        headers: {
          host,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      });
      expect(session.status, 'POST /session').toBe(204);
      const sessionCookie = cookiePair(session);
      expect(sessionCookie, 'the POST /session cookie').toMatch(/^[^=\s]+=.+$/);

      for (const attempt of [1, 2]) {
        const legacy = await send(port, `/?token=${TOKEN}`, { headers: { host } });
        expect(legacy.status, `GET /?token=s3cret #${attempt}`).toBe(303);
        expect(legacy.headers.location, `#${attempt}: location`).toBe('/');
        expect(legacy.headers['set-cookie'] ?? [], `#${attempt}: one Set-Cookie`).toHaveLength(1);
        expect(cookiePair(legacy), `#${attempt}: the POST /session cookie`).toBe(sessionCookie);
      }

      // process.emitWarning delivers on a later tick; let it land before counting.
      await new Promise((resolve) => setImmediate(resolve));
      const ours = warnings.filter((warning) => (warning as { code?: unknown }).code === CODE);
      expect(ours, `${CODE} warnings`).toHaveLength(1);
      const warning = ours[0];
      expect(warning?.name).toBe('DeprecationWarning');
      expect(warning?.message ?? '').not.toContain(TOKEN);
    } finally {
      process.off('warning', onWarning);
      await server?.close();
    }
  }, 30_000);
});
