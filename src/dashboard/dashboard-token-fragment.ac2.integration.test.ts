import { request, type IncomingHttpHeaders } from 'node:http';
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';

// AC-2: a fragment login with the wrong token is answered 401 with no cookie, the login page says
// "token rejected", and the window's address keeps neither the fragment nor the token.

const TOKEN = 's3cret';
const WRONG = 'wrong';

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
    allowedHosts?: string[];
  }) => Promise<DashboardServerUnderTest>;
};

type CollectorModule = {
  createCollector: (options: { windowMs: number; capacity: number }) => unknown;
};

/** The slice of happy-dom's API this test drives (typed locally: the module loads inside the test body). */
type DomElement = {
  textContent: string | null;
  appendChild(child: DomElement): unknown;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
};

type DomDocument = {
  write(html: string): void;
  createElement(tagName: string): DomElement;
  readonly body: DomElement | null;
};

type DomWindow = {
  readonly document: DomDocument;
  readonly location: { readonly href: string };
  readonly happyDOM: { close(): Promise<void> };
};

type HappyDomModule = {
  Window: new (options: { url: string; settings: Record<string, boolean> }) => DomWindow;
};

type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };

/** One HTTP message parsed off a recorded byte stream. */
type Message = { startLine: string; headers: Map<string, string[]>; complete: boolean };

type Exchange = { request: Message; response: Message | undefined };

type RecordingProxy = {
  readonly port: number;
  /** Every request/response pair seen so far, in connection then arrival order. */
  exchanges(): Exchange[];
  close(): Promise<void>;
};

const BODYLESS_STATUS = /^HTTP\/1\.[01] (1\d\d|204|304)\b/;

/** Parses sequential HTTP/1.x messages from a latin1 byte string; stops at the first incomplete one. */
function parseMessages(data: string, kind: 'request' | 'response', methods: string[]): Message[] {
  const messages: Message[] = [];
  let offset = 0;
  while (offset < data.length) {
    const headerEnd = data.indexOf('\r\n\r\n', offset);
    if (headerEnd === -1) {
      break;
    }
    const lines = data.slice(offset, headerEnd).split('\r\n');
    const startLine = lines[0] ?? '';
    const headers = new Map<string, string[]>();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        const name = line.slice(0, colon).trim().toLowerCase();
        headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()]);
      }
    }
    let cursor = headerEnd + 4;
    const method = methods[messages.length] ?? 'GET';
    const noBody =
      kind === 'response' && (BODYLESS_STATUS.test(startLine) || method.toUpperCase() === 'HEAD');
    const length = headers.get('content-length')?.[0];
    const chunked = (headers.get('transfer-encoding')?.[0] ?? '').toLowerCase().includes('chunked');
    let complete = true;
    if (noBody) {
      // No body follows.
    } else if (chunked) {
      complete = false;
      for (;;) {
        const sizeEnd = data.indexOf('\r\n', cursor);
        if (sizeEnd === -1) {
          break;
        }
        const size = Number.parseInt(data.slice(cursor, sizeEnd).split(';')[0] ?? '', 16);
        if (!Number.isFinite(size)) {
          break;
        }
        if (size === 0) {
          const trailerEnd = data.indexOf('\r\n\r\n', cursor);
          if (trailerEnd === -1) {
            break;
          }
          cursor = trailerEnd + 4;
          complete = true;
          break;
        }
        if (sizeEnd + 2 + size + 2 > data.length) {
          break;
        }
        cursor = sizeEnd + 2 + size + 2;
      }
    } else if (length !== undefined) {
      const bytes = Number(length);
      if (cursor + bytes > data.length) {
        complete = false;
      } else {
        cursor += bytes;
      }
    } else if (kind === 'response') {
      // Delimited by the connection closing (or an open stream): the rest is its body.
      cursor = data.length;
    }
    messages.push({ startLine, headers, complete });
    if (!complete) {
      break;
    }
    offset = cursor;
  }
  return messages;
}

/** A TCP proxy to the upstream port that records both directions of every connection. */
async function startRecordingProxy(upstreamPort: number): Promise<RecordingProxy> {
  const connections: { toServer: string; toClient: string }[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const record = { toServer: '', toClient: '' };
    connections.push(record);
    const upstream = connect({ host: '127.0.0.1', port: upstreamPort });
    sockets.add(client);
    sockets.add(upstream);
    client.on('data', (chunk: Buffer) => {
      record.toServer += chunk.toString('latin1');
      upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      record.toClient += chunk.toString('latin1');
      client.write(chunk);
    });
    client.on('end', () => upstream.end());
    upstream.on('end', () => client.end());
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
    // A reset on either side ends the relayed connection; the close handlers above tear it down.
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    exchanges: () =>
      connections.flatMap((record) => {
        const requests = parseMessages(record.toServer, 'request', []);
        const methods = requests.map((message) => message.startLine.split(' ')[0] ?? '');
        const responses = parseMessages(record.toClient, 'response', methods);
        return requests.map((message, index) => ({
          request: message,
          response: responses[index],
        }));
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** One GET over a fresh connection, with exactly the given request headers, read to the end. */
function httpGet(url: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', headers, agent: false }, (res) => {
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
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`timed out: GET ${url}`)));
    req.end();
  });
}

/** The src of every <script> start tag in the HTML, in document order. */
function scriptSources(html: string): string[] {
  const sources: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(match[1] ?? '');
    const value = src?.[1] ?? src?.[2] ?? src?.[3];
    if (value !== undefined && value !== '') {
      sources.push(value);
    }
  }
  return sources;
}

/** The text a reader sees in the body: its text without that of script, style and template elements. */
function visibleText(document: DomDocument): string {
  const body = document.body;
  if (body === null) {
    return '';
  }
  let text = body.textContent ?? '';
  for (const hidden of Array.from(body.querySelectorAll('script, style, template'))) {
    const hiddenText = hidden.textContent ?? '';
    if (hiddenText !== '') {
      text = text.replace(hiddenText, '');
    }
  }
  return text;
}

/** Polls the predicate until it holds, or fails after the timeout. */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isSessionPost(exchange: Exchange): boolean {
  return /^POST \/session(\?| )/.test(exchange.request.startLine);
}

describe('dashboard fragment login — AC-2', () => {
  it('AC-2: /login#token=wrong in a DOM window gets a 401 with no Set-Cookie, shows "token rejected", and leaves neither # nor the token in location.href', async () => {
    const collectorModule = (await import('../collector/index.js')) as unknown as CollectorModule;
    const dashboardModule = (await import('./index.js')) as unknown as DashboardModule;
    const happyDom = (await import('happy-dom')) as unknown as HappyDomModule;

    let server: DashboardServerUnderTest | undefined;
    let proxy: RecordingProxy | undefined;
    let window: DomWindow | undefined;
    try {
      const collector = collectorModule.createCollector({ windowMs: 1000, capacity: 10 });
      // A recording proxy in front observes the POST /session answer; a bare name allows its port.
      server = await dashboardModule.createDashboardServer({
        collector,
        host: '127.0.0.1',
        port: 0,
        token: TOKEN,
        allowedHosts: ['127.0.0.1'],
      });
      proxy = await startRecordingProxy(server.port);
      const base = `http://127.0.0.1:${proxy.port}`;

      const page = await httpGet(`${base}/login`);
      expect(page.status, 'GET /login').toBe(200);
      const scripts: string[] = [];
      for (const src of scriptSources(page.body)) {
        const url = new URL(src, `${base}/login`);
        const response = await httpGet(url.href);
        expect(response.status, `GET ${url.pathname}`).toBe(200);
        scripts.push(response.body);
      }
      expect(scripts.length, 'scripts the login page references').toBeGreaterThanOrEqual(1);

      window = new happyDom.Window({
        url: `${base}/login#token=${WRONG}`,
        settings: {
          enableJavaScriptEvaluation: true,
          suppressInsecureJavaScriptEnvironmentWarning: true,
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      });
      const document = window.document;
      document.write(page.body);
      for (const js of scripts) {
        const script = document.createElement('script');
        script.textContent = js;
        document.body?.appendChild(script);
      }

      const recording = proxy;
      await waitFor(
        () => recording.exchanges().some((e) => isSessionPost(e) && e.response?.complete === true),
        15_000,
        'the answered POST /session through the proxy',
      );
      const sessionResponse = recording.exchanges().find((e) => isSessionPost(e))?.response;
      expect(sessionResponse?.startLine ?? '', 'POST /session status line').toMatch(
        /^HTTP\/1\.[01] 401\b/,
      );
      expect(sessionResponse?.headers.has('set-cookie'), 'a Set-Cookie on the 401').toBe(false);

      await waitFor(
        () => visibleText(document).includes('token rejected'),
        15_000,
        'visible "token rejected" text on the login page',
      );
      expect(visibleText(document)).toContain('token rejected');
      expect(window.location.href).not.toContain('#');
      expect(window.location.href).not.toContain(WRONG);
    } finally {
      await window?.happyDOM.close();
      await proxy?.close();
      await server?.close();
    }
  }, 30_000);
});
