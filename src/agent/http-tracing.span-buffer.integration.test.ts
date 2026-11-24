import { createServer, get } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SPAN_BUFFER_SIZE,
  disable,
  drainSpans,
  enable,
  setSpanBufferSize,
} from './http-tracing.js';

let server: Server | undefined;
let port = 0;

function send(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      res.resume();
      res.on('end', resolve);
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** `count` requests, 25 in flight at a time; resolves once every response finish is recorded. */
async function burst(count: number): Promise<void> {
  for (let sent = 0; sent < count; sent += 25) {
    const batch = Math.min(25, count - sent);
    await Promise.all(Array.from({ length: batch }, (_, i) => send(`/r${String(sent + i)}`)));
  }
  await delay(25);
}

beforeAll(async () => {
  const s = createServer((_req, res) => {
    res.end('ok');
  });
  server = s;
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  port = (s.address() as AddressInfo).port;
});

afterAll(async () => {
  disable();
  setSpanBufferSize(DEFAULT_SPAN_BUFFER_SIZE);
  drainSpans();
  const s = server;
  if (s) {
    await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
  }
});

describe('http tracing — the span buffer caps the spans kept per drain (CORE-275)', () => {
  it('enable({ spanBufferSize: 64 }) keeps the newest 64 spans of 200 requests and counts the other 136 as dropped', async () => {
    enable({ spanBufferSize: 64 });
    drainSpans();
    await burst(200);
    const { spans, dropped } = drainSpans();
    expect(spans).toHaveLength(64);
    expect(dropped).toBe(136);
    const next = drainSpans();
    expect(next).toEqual({ spans: [], dropped: 0 });
  });

  it('setSpanBufferSize() keeps the buffered spans: shrinking drops and counts the oldest, at the next drain', async () => {
    setSpanBufferSize(64);
    drainSpans();
    await burst(10);
    setSpanBufferSize(4);
    let drained = drainSpans();
    expect(drained.spans).toHaveLength(4);
    expect(drained.dropped).toBe(6);

    await burst(3);
    setSpanBufferSize(16);
    drained = drainSpans();
    expect(drained.spans).toHaveLength(3);
    expect(drained.dropped).toBe(0);
  });
});
