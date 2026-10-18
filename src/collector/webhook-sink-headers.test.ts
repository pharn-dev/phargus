import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createSinks, createWebhookSink, type Alert } from './index.js';

const SECRET = 'Bearer s3cr3t-token-value';

const alert: Alert = {
  ruleId: 'loop-max',
  metric: 'eventLoop.max',
  comparison: '>',
  threshold: 100,
  observed: 500,
  windowStart: 1000,
  windowEnd: 2000,
  state: 'firing',
};

type TestServer = {
  readonly url: string;
  readonly received: IncomingHttpHeaders[];
  stop(): Promise<void>;
};

/** A local 127.0.0.1 server that records request headers and answers `status`. */
async function startServer(status: number): Promise<TestServer> {
  const received: IncomingHttpHeaders[] = [];
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      received.push(request.headers);
      response.statusCode = status;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/alerts`,
    received,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Every string an error can surface: message, stack, String() and the whole cause chain. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(String(current), current.message, current.stack ?? '');
    current = current.cause;
  }
  if (current !== undefined) {
    parts.push(String(current));
  }
  return parts.join('\n');
}

function thrownBy(create: () => unknown): unknown {
  try {
    create();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('webhook sink headers', () => {
  it('sends the caller headers with every request, alongside the JSON content type', async () => {
    const server = await startServer(200);
    try {
      const headers: Record<string, string> = { Authorization: SECRET, 'X-Team': 'payments' };
      const sink = createWebhookSink({ url: server.url, timeoutMs: 2000, headers });
      // The headers are copied: a later change to the caller's object is not sent.
      headers['Authorization'] = 'changed';
      await sink.send(alert);
      await sink.send(alert);
      await sink.close();
      expect(server.received).toHaveLength(2);
      for (const received of server.received) {
        expect(received['authorization']).toBe(SECRET);
        expect(received['x-team']).toBe('payments');
        expect(received['content-type']).toBe('application/json');
      }
      expect(sink.failed).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it('passes headers through a webhook sink config given to createSinks', async () => {
    const server = await startServer(204);
    try {
      const [sink] = createSinks([
        { type: 'webhook', url: server.url, timeoutMs: 2000, headers: { authorization: SECRET } },
      ]);
      await sink?.send(alert);
      await sink?.close();
      expect(server.received[0]?.['authorization']).toBe(SECRET);
    } finally {
      await server.stop();
    }
  });

  it('keeps header values out of delivery failure errors', async () => {
    const errors: Error[] = [];
    const onError = (error: Error): void => {
      errors.push(error);
    };

    // The endpoint rejects the request.
    const server = await startServer(401);
    try {
      const sink = createWebhookSink({
        url: server.url,
        timeoutMs: 2000,
        retries: 0,
        headers: { authorization: SECRET },
        onError,
      });
      await sink.send(alert);
      await sink.close();
      expect(sink.failed).toBe(1);
    } finally {
      await server.stop();
    }

    // Nothing listens any more: the connection is refused.
    const refused = createWebhookSink({
      url: server.url,
      timeoutMs: 2000,
      retries: 0,
      headers: { authorization: SECRET },
      onError,
    });
    await refused.send(alert);
    await refused.close();
    expect(refused.failed).toBe(1);

    // The sink is closed: the alert is dropped.
    await refused.send(alert);
    expect(refused.dropped).toBe(1);

    expect(errors).toHaveLength(3);
    expect(errors[0]?.message).toContain('status 401');
    for (const error of errors) {
      expect(errorText(error)).not.toContain('s3cr3t');
    }
  });

  it('rejects bad headers when the sink is created, naming the header but never its value', () => {
    const cases: { headers: unknown; message: RegExp }[] = [
      { headers: { authorization: `${SECRET}\r\nx-injected: 1` }, message: /invalid character/ },
      { headers: { authorization: `${SECRET}\u0000` }, message: /invalid character/ },
      { headers: { authorization: `${SECRET} €` }, message: /invalid character/ },
      { headers: { authorization: 42 }, message: /must have a string value/ },
      { headers: { [`authorization: ${SECRET}`]: 'x' }, message: /not a valid HTTP token/ },
      { headers: { 'Content-Type': 'text/plain' }, message: /reserved/ },
      { headers: { 'content-type': SECRET }, message: /reserved/ },
      { headers: { Authorization: SECRET, authorization: SECRET }, message: /more than once/ },
      {
        headers: JSON.parse(`{"__proto__":"${SECRET}"}`) as unknown,
        message: /cannot be sent by fetch/,
      },
      { headers: 'authorization', message: /must be an object/ },
      { headers: [SECRET], message: /must be an object/ },
    ];
    for (const { headers, message } of cases) {
      const options = { url: 'http://127.0.0.1:1/alerts', headers } as Parameters<
        typeof createWebhookSink
      >[0];
      const direct = thrownBy(() => createWebhookSink(options));
      expect(direct).toBeInstanceOf(TypeError);
      expect((direct as Error).message).toMatch(message);
      expect(errorText(direct)).not.toContain('s3cr3t');

      const viaConfig = thrownBy(() => createSinks([{ type: 'webhook', ...options }]));
      expect((viaConfig as Error).message).toMatch(message);
      expect(errorText(viaConfig)).not.toContain('s3cr3t');
    }
  });
});
