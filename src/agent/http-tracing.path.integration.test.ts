import { Buffer } from 'node:buffer';
import { request as httpRequest, createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disable, drainSpans, enable } from './http-tracing.js';
import { SPAN_RECORD_TYPE } from './span-record.js';

let server: Server | undefined;
let port = 0;

function send(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Lets the server-side response finish be recorded after the client has read the body. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await delay(25);
}

beforeAll(async () => {
  const s = createServer((req, res) => {
    // What a framework does inside a mounted router (Express strips the mount path).
    req.url = '/rewritten';
    res.end('ok');
  });
  server = s;
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  port = (s.address() as AddressInfo).port;
  enable();
  drainSpans();
});

afterAll(async () => {
  disable();
  const s = server;
  if (s) {
    await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
  }
});

describe('http tracing span path', () => {
  it('names the span by the path on the request line, even after the handler rewrites req.url', async () => {
    expect(await send('/api/v1/users/42?token=secret')).toBe(200);
    await settle();
    const { spans } = drainSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.method).toBe('GET');
    expect(spans[0]?.path).toBe('/api/v1/users/42');
    expect(spans[0]?.name).toBe('GET /api/v1/users/42');
  });

  it('keeps the first 256 characters of a long path, so the span line stays under 1 KB', async () => {
    const path = `/${'a'.repeat(14_999)}`;
    expect(await send(`${path}?q=1`)).toBe(200);
    await settle();
    const { spans } = drainSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span?.path).toBe(path.slice(0, 256));
    expect(span?.path).toHaveLength(256);
    if (span === undefined) return;
    const line = `${JSON.stringify({ type: SPAN_RECORD_TYPE, ...span })}\n`;
    expect(Buffer.byteLength(line)).toBeLessThan(1024);
  });
});
