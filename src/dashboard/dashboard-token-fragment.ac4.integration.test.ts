import { request, type IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';

// AC-4: POST /session refuses a wrong token (401), a foreign Origin (403), a non-JSON or missing
// content type (415), an oversized body (413), malformed or token-less JSON (400), a non-POST
// method (405, allow: POST) and a foreign Host (421) — and only a success sets a cookie.

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
 * One request over a fresh connection with exactly these headers and body, read to the end. The
 * server may answer and close before reading the body: a reset after the answer is not a failure.
 */
function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Result> {
  const method = options.method ?? 'GET';
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: options.headers ?? {}, agent: false },
      (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        const done = (): void =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'ECONNRESET') {
            done();
          } else {
            reject(error);
          }
        });
        res.on('end', done);
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (!answered || (error.code !== 'ECONNRESET' && error.code !== 'EPIPE')) {
        reject(error);
      }
    });
    req.setTimeout(10_000, () => req.destroy(new Error(`timed out: ${method} ${path}`)));
    req.end(options.body);
  });
}

function json(body: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...extra,
  };
}

describe('dashboard POST /session refusals — AC-4', () => {
  it('AC-4: POST /session answers 401 to a wrong token, 403 to a foreign Origin, 415/415/413/400/400/400 to bad bodies, 405 with allow: POST to GET, and 421 to a foreign Host, with no Set-Cookie on any refusal', async () => {
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
      const right = JSON.stringify({ token: TOKEN });

      const post = (headers: Record<string, string>, body: string): Promise<Result> =>
        send(port, '/session', { method: 'POST', headers: { host, ...headers }, body });

      // A wrong token and a foreign Origin: refused, no cookie.
      const wrong = await post(
        json(JSON.stringify({ token: 'wrong' })),
        JSON.stringify({ token: 'wrong' }),
      );
      expect(wrong.status, 'wrong token').toBe(401);
      expect(wrong.headers['set-cookie'], 'wrong token: Set-Cookie').toBeUndefined();

      const foreign = await post(json(right, { origin: 'http://evil.example.com' }), right);
      expect(foreign.status, 'foreign Origin').toBe(403);
      expect(foreign.headers['set-cookie'], 'foreign Origin: Set-Cookie').toBeUndefined();

      // Bodies and content types the endpoint does not take.
      const oversized = JSON.stringify({ token: TOKEN, pad: 'x'.repeat(5000) });
      expect(Buffer.byteLength(oversized)).toBeGreaterThan(4096);
      const cases: [string, Record<string, string>, string, number][] = [
        [
          'content-type: text/plain',
          { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(right)) },
          right,
          415,
        ],
        ['no content type', { 'content-length': String(Buffer.byteLength(right)) }, right, 415],
        ['a body over 4096 bytes', json(oversized), oversized, 413],
        ['malformed JSON', json('{"token":'), '{"token":', 400],
        ['no token field', json('{"tok":"s3cret"}'), '{"tok":"s3cret"}', 400],
        ['a non-string token', json('{"token":123}'), '{"token":123}', 400],
      ];
      for (const [what, headers, body, status] of cases) {
        const response = await post(headers, body);
        expect(response.status, what).toBe(status);
        expect(response.headers['set-cookie'], `${what}: Set-Cookie`).toBeUndefined();
      }

      // Only POST.
      const get = await send(port, '/session', { headers: { host } });
      expect(get.status, 'GET /session').toBe(405);
      expect(get.headers.allow, 'GET /session: allow').toBe('POST');
      expect(get.headers['set-cookie'], 'GET /session: Set-Cookie').toBeUndefined();

      // A foreign Host.
      const misdirected = await send(port, '/session', {
        method: 'POST',
        headers: json(right, { host: 'evil.example.com' }),
        body: right,
      });
      expect(misdirected.status, 'foreign Host').toBe(421);
      expect(misdirected.headers['set-cookie'], 'foreign Host: Set-Cookie').toBeUndefined();
    } finally {
      await server?.close();
    }
  }, 30_000);
});
