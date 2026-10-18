import { request, type IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';

// AC-5: with no token, /session is 404; with a token, only /login and /login.js are public, they
// carry the dashboard page's CSP, the page has no inline script, and neither holds the token.

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

/** Every <script> element of the HTML: its start tag's attributes and its inline content. */
function scriptElements(html: string): { attributes: string; content: string }[] {
  return Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi), (match) => ({
    attributes: match[1] ?? '',
    content: match[2] ?? '',
  }));
}

describe('dashboard public login assets — AC-5', () => {
  it('AC-5: with no token POST /session is 404; with a token /login and /login.js answer 200 with the page CSP while /, /app.js, /app.css and /events answer 401, the login page has only src scripts, and neither body holds the token', async () => {
    const collectorModule = (await import('../collector/index.js')) as unknown as CollectorModule;
    const dashboardModule = (await import('./index.js')) as unknown as DashboardModule;

    const servers: DashboardServerUnderTest[] = [];
    try {
      // No token configured: /session does not exist.
      const open = await dashboardModule.createDashboardServer({
        collector: collectorModule.createCollector({ windowMs: 1000, capacity: 10 }),
        host: '127.0.0.1',
        port: 0,
      });
      servers.push(open);
      const body = JSON.stringify({ token: TOKEN });
      const noToken = await send(open.port, '/session', {
        method: 'POST',
        headers: {
          host: `127.0.0.1:${open.port}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      });
      expect(noToken.status, 'POST /session with no token configured').toBe(404);

      // Token configured: only the login page and its script are public.
      const gated = await dashboardModule.createDashboardServer({
        collector: collectorModule.createCollector({ windowMs: 1000, capacity: 10 }),
        host: '127.0.0.1',
        port: 0,
        token: TOKEN,
      });
      servers.push(gated);
      const host = `127.0.0.1:${gated.port}`;

      const login = await send(gated.port, '/login', { headers: { host } });
      const loginScript = await send(gated.port, '/login.js', { headers: { host } });
      expect(login.status, 'GET /login without credentials').toBe(200);
      expect(loginScript.status, 'GET /login.js without credentials').toBe(200);
      for (const path of ['/', '/app.js', '/app.css', '/events']) {
        const response = await send(gated.port, path, { headers: { host } });
        expect(response.status, `GET ${path} without credentials`).toBe(401);
      }

      // The same CSP header value as the authenticated dashboard page.
      const page = await send(gated.port, '/', {
        headers: { host, authorization: `Bearer ${TOKEN}` },
      });
      expect(page.status, 'GET / with Bearer').toBe(200);
      const pageCsp = page.headers['content-security-policy'];
      expect(pageCsp, 'the dashboard page CSP').toBeDefined();
      expect(login.headers['content-security-policy'], '/login CSP').toBe(pageCsp);
      expect(loginScript.headers['content-security-policy'], '/login.js CSP').toBe(pageCsp);

      // Scripts only by src, never inline.
      for (const script of scriptElements(login.body)) {
        expect(script.attributes, 'a <script> on /login has a src').toMatch(/\bsrc\s*=/i);
        expect(script.content.trim(), 'a <script> on /login has no inline content').toBe('');
      }

      // No token in either body.
      expect(login.body, '/login body').not.toContain(TOKEN);
      expect(loginScript.body, '/login.js body').not.toContain(TOKEN);
    } finally {
      for (const server of servers) {
        await server.close();
      }
    }
  }, 30_000);
});
