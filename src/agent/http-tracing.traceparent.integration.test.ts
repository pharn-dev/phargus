import { request as httpRequest, createServer } from 'node:http';
import type { OutgoingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentTraceId } from './context.js';
import { disable, drainSpans, enable } from './http-tracing.js';
import type { TraceSpan } from './span-buffer.js';
import { SPAN_RECORD_TYPE } from './span-record.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_ID = '00f067aa0ba902b7';

let server: Server | undefined;
let port = 0;
/** The trace id `currentTraceId()` returned inside the handler, per request path. */
const seen = new Map<string, string | undefined>();

function send(path: string, headers: OutgoingHttpHeaders = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
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

async function onlySpan(path: string, headers?: OutgoingHttpHeaders): Promise<TraceSpan> {
  expect(await send(path, headers)).toBe(200);
  await settle();
  const { spans } = drainSpans();
  expect(spans).toHaveLength(1);
  const span = spans[0];
  if (span === undefined) throw new Error('no span recorded');
  return span;
}

beforeAll(async () => {
  const s = createServer((req, res) => {
    seen.set(req.url ?? '', currentTraceId());
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

describe('http tracing — a continued traceparent keeps its parent span id (CORE-231)', () => {
  it('a valid traceparent gives the span its trace-id and parent-id, lowercased', async () => {
    const header = `00-${TRACE_ID.toUpperCase()}-${PARENT_ID.toUpperCase()}-01`;
    const span = await onlySpan('/continued', { traceparent: header });
    expect(span.traceId).toBe(TRACE_ID);
    expect(span.parentSpanId).toBe(PARENT_ID);
    expect(span.spanId).not.toBe(PARENT_ID);
    expect(seen.get('/continued')).toBe(TRACE_ID);
    const line = JSON.parse(JSON.stringify({ type: SPAN_RECORD_TYPE, ...span })) as Record<
      string,
      unknown
    >;
    expect(line['traceId']).toBe(TRACE_ID);
    expect(line['parentSpanId']).toBe(PARENT_ID);
  });

  it('a request without the header gets a fresh trace id and no parentSpanId key', async () => {
    const span = await onlySpan('/fresh');
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.traceId).not.toBe(TRACE_ID);
    expect(seen.get('/fresh')).toBe(span.traceId);
    expect(Object.hasOwn({ type: SPAN_RECORD_TYPE, ...span }, 'parentSpanId')).toBe(false);
  });

  it('an invalid header gets a fresh trace id and no parentSpanId key', async () => {
    const span = await onlySpan('/invalid', {
      traceparent: `00-${TRACE_ID}-0000000000000000-01`,
    });
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.traceId).not.toBe(TRACE_ID);
    expect(seen.get('/invalid')).toBe(span.traceId);
    expect(Object.hasOwn({ type: SPAN_RECORD_TYPE, ...span }, 'parentSpanId')).toBe(false);
  });
});
