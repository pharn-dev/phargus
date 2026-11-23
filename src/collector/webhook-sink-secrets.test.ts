import { createServer } from 'node:net';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createSinks, createWebhookSink, type Alert } from './index.js';

// Fake markers: the test fails if either reaches a reported error.
const URL_MARKER = 'url-marker-7f3a9c';
const HEADER_MARKER = 'header-marker-2b8e41';

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

/** A loopback port nothing listens on: bound, then closed. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function thrownBy(create: () => unknown): unknown {
  try {
    create();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('webhook sink secrets', () => {
  it('refuses a URL with a username or password at creation, without quoting it', () => {
    for (const url of ['https://user:pass@host/x', 'https://user@host/x', 'https://:pass@host/x']) {
      for (const create of [
        () => createWebhookSink({ url }),
        () => createSinks([{ type: 'webhook', url }]),
      ]) {
        const error = thrownBy(create);
        expect(error).toBeInstanceOf(TypeError);
        const { message } = error as Error;
        expect(message).not.toContain('user');
        expect(message).not.toContain('pass');
        // Stack paths may hold any word, so the whole inspected error is checked for the URL parts.
        const text = inspect(error, { depth: null });
        expect(text).not.toContain(':pass');
        expect(text).not.toContain('@host');
        expect((error as Error).message).toContain('headers option');
      }
    }
  });

  it('reports a refused connection by its code, with no URL path, query or header value', async () => {
    const port = await closedPort();
    const errors: Error[] = [];
    const sink = createWebhookSink({
      url: `http://127.0.0.1:${port}/${URL_MARKER}?key=${URL_MARKER}`,
      headers: { authorization: `Bearer ${HEADER_MARKER}` },
      timeoutMs: 2000,
      retries: 0,
      onError: (error) => errors.push(error),
    });
    await sink.send(alert);
    await sink.close();
    expect(sink.failed).toBe(1);
    expect(errors).toHaveLength(1);
    const text = inspect(errors[0], { depth: null });
    expect(text).toContain('ECONNREFUSED');
    expect(text).not.toContain(URL_MARKER);
    expect(text).not.toContain(HEADER_MARKER);
  });
});
