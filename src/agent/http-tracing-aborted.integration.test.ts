import { request as httpRequest, createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disable, drainSpans, enable } from './http-tracing.js';
import type { TraceSpan } from './span-buffer.js';

const MS = 1_000_000;
const HOLD_MS = 150;
/** How far the span duration may sit from the handler-to-close time the server itself saw. */
const TOLERANCE_NS = 20 * MS;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server | undefined;
let port = 0;
const handlers = new Map<string, Handler>();

/**
 * Sends a GET; resolves on the full body or on any client-side error (an aborted request).
 * With `abortWhen`, the client destroys the request once that promise settles.
 */
function get(path: string, abortWhen?: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve());
      res.on('error', () => resolve());
    });
    req.on('error', () => resolve());
    req.on('close', () => resolve());
    req.end();
    void abortWhen?.then(() => req.destroy());
  });
}

/** Measures, on the server, the time from the handler running to the response's close. */
function timeUntilClose(res: ServerResponse): Promise<number> {
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    res.once('close', () => resolve(Number(process.hrtime.bigint() - started)));
  });
}

/** Drains until a span for `path` shows up (the close event can trail the client by a tick). */
async function spansFor(path: string): Promise<TraceSpan[]> {
  const found: TraceSpan[] = [];
  for (let i = 0; i < 300 && found.length === 0; i += 1) {
    await delay(10);
    found.push(...drainSpans().spans.filter((span) => span.path === path));
  }
  // Give a duplicate span (finish and close both recording) the chance to appear.
  await delay(50);
  found.push(...drainSpans().spans.filter((span) => span.path === path));
  return found;
}

beforeAll(async () => {
  enable();
  const s = createServer((req, res) => {
    const handler = handlers.get(req.url ?? '');
    if (typeof handler !== 'function') {
      res.statusCode = 404;
      res.end();
      return;
    }
    handler(req, res);
  });
  server = s;
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  port = (s.address() as AddressInfo).port;
});

beforeEach(() => {
  drainSpans();
});

afterAll(async () => {
  disable();
  const s = server;
  if (s) {
    s.closeAllConnections();
    await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
  }
});

describe('agent HTTP tracing — aborted and destroyed requests leave a span', () => {
  it('a client that disconnects before the response ends yields one aborted span with status 0', async () => {
    let closed: Promise<number> | undefined;
    let arrived: () => void = () => undefined;
    const inHandler = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    handlers.set('/client-gone?q=1', (req, res) => {
      // A framework may rewrite req.url; the span keeps the path seen at start.
      req.url = '/rewritten';
      // Never respond: the client gives up first.
      closed = timeUntilClose(res);
      arrived();
    });
    // Client and server share this event loop. A timer armed at send time can fire before the
    // request is even read (one stall of HOLD_MS is enough), and then no span is due. So the hold
    // starts only once the handler has run.
    await get(
      '/client-gone?q=1',
      inHandler.then(() => delay(HOLD_MS)),
    );
    const spans = await spansFor('/client-gone');
    const untilClose = await closed;

    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.aborted).toBe(true);
    expect(span?.statusCode).toBe(0);
    expect(span?.method).toBe('GET');
    expect(untilClose).toBeDefined();
    expect(Math.abs((span?.durationNs ?? 0) - (untilClose ?? 0))).toBeLessThan(TOLERANCE_NS);
  });

  it('a response destroyed on the server yields one aborted span with status 0', async () => {
    let closed: Promise<number> | undefined;
    handlers.set('/server-destroy', (_req, res) => {
      closed = timeUntilClose(res);
      setTimeout(() => res.destroy(), HOLD_MS);
    });
    await get('/server-destroy');
    const spans = await spansFor('/server-destroy');
    const untilClose = await closed;

    expect(spans).toHaveLength(1);
    expect(spans[0]?.aborted).toBe(true);
    expect(spans[0]?.statusCode).toBe(0);
    expect(spans[0]?.durationNs).toBeGreaterThanOrEqual((HOLD_MS - 5) * MS);
    expect(Math.abs((spans[0]?.durationNs ?? 0) - (untilClose ?? 0))).toBeLessThan(TOLERANCE_NS);
  });

  it('a response destroyed after its head was sent keeps that status code', async () => {
    handlers.set('/head-sent', (_req, res) => {
      res.writeHead(200);
      res.write('partial');
      setTimeout(() => res.destroy(), 20);
    });
    await get('/head-sent');
    const spans = await spansFor('/head-sent');

    expect(spans).toHaveLength(1);
    expect(spans[0]?.aborted).toBe(true);
    expect(spans[0]?.statusCode).toBe(200);
  });

  it('a normal request yields exactly one span with no aborted key', async () => {
    handlers.set('/normal', (_req, res) => {
      res.end('ok');
    });
    await get('/normal');
    const spans = await spansFor('/normal');

    expect(spans).toHaveLength(1);
    expect(spans[0]?.statusCode).toBe(200);
    expect(Object.hasOwn(spans[0] ?? {}, 'aborted')).toBe(false);
  });

  it('records no aborted span for a request that closes after tracing was disabled', async () => {
    let release: (() => void) | undefined;
    handlers.set('/after-disable', (_req, res) => {
      release = () => res.destroy();
    });
    const done = get('/after-disable');
    for (let i = 0; i < 100 && release === undefined; i += 1) {
      await delay(10);
    }
    disable();
    try {
      release?.();
      await done;
      await delay(50);
      expect(drainSpans().spans.filter((span) => span.path === '/after-disable')).toEqual([]);
    } finally {
      enable();
    }
  });
});
