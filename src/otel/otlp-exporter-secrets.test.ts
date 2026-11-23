import { createServer } from 'node:net';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { AggregatedWindow, SpanRecord } from '../collector/index.js';
import { createOtlpMetricsExporter } from './otlp-exporter.js';
import { createOtlpTraceExporter } from './otlp-trace-exporter.js';

// Fake markers: the test fails if either reaches a reported error.
const URL_MARKER = 'url-marker-5d1c07';
const HEADER_MARKER = 'header-marker-9a4f62';

const window: AggregatedWindow = {
  start: 0,
  end: 1000,
  count: 1,
  late: 0,
  eventLoop: { max: 1, p99: 1, mean: 1 },
  memory: { heapUsedLast: 1, heapUsedMax: 1, rssLast: 1, rssMax: 1 },
  gc: { count: 0, totalPause: 0, maxPause: 0 },
  backpressure: { events: 0, totalStall: 0, maxStall: 0 },
};

const span: SpanRecord = {
  type: 'span',
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  name: 'GET /users',
  method: 'GET',
  path: '/users',
  statusCode: 200,
  startTimeMs: 1700000000000,
  durationNs: 1000,
};

type Options = Parameters<typeof createOtlpMetricsExporter>[0];

/** Each exporter: create it, and get back a function that sends one item and closes it. */
const exporters: { name: string; create: (options: Options) => () => Promise<void> }[] = [
  {
    name: 'metrics',
    create: (options) => {
      const exporter = createOtlpMetricsExporter(options);
      return async () => {
        exporter.export(window);
        await exporter.close();
      };
    },
  },
  {
    name: 'traces',
    create: (options) => {
      const exporter = createOtlpTraceExporter(options);
      return async () => {
        exporter.export(span);
        await exporter.close();
      };
    },
  },
];

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

describe.each(exporters)('OTLP $name exporter secrets', ({ create }) => {
  it('refuses a URL with a username or password at creation, without quoting it', () => {
    for (const url of ['https://user:pass@host/x', 'https://user@host/x', 'https://:pass@host/x']) {
      const error = thrownBy(() => create({ url }));
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
  });

  it('rejects a bad header at creation, naming the header but never its value', () => {
    const cases: { headers: Record<string, string>; message: RegExp }[] = [
      { headers: { authorization: `Bearer ${HEADER_MARKER}\nx` }, message: /authorization/ },
      { headers: { authorization: `Bearer ${HEADER_MARKER}\r` }, message: /authorization/ },
      { headers: { authorization: `Bearer ${HEADER_MARKER}\u0000` }, message: /authorization/ },
      { headers: { [`authorization: ${HEADER_MARKER}`]: 'x' }, message: /not a valid HTTP token/ },
      { headers: { 'bad name': HEADER_MARKER }, message: /not a valid HTTP token/ },
    ];
    for (const { headers, message } of cases) {
      const error = thrownBy(() => create({ url: 'http://127.0.0.1:1/v1', headers }));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toMatch(message);
      expect(inspect(error, { depth: null })).not.toContain(HEADER_MARKER);
    }
  });

  it('reports a refused connection by its code, with no URL path, query or header value', async () => {
    const port = await closedPort();
    const errors: Error[] = [];
    const run = create({
      url: `http://127.0.0.1:${port}/${URL_MARKER}?api_key=${URL_MARKER}`,
      headers: { authorization: `Bearer ${HEADER_MARKER}` },
      timeoutMs: 2000,
      onError: (error) => errors.push(error),
    });
    await run();
    expect(errors.length).toBeGreaterThan(0);
    const text = inspect(errors, { depth: null });
    expect(text).toContain('ECONNREFUSED');
    expect(text).not.toContain(URL_MARKER);
    expect(text).not.toContain(HEADER_MARKER);
  });
});
