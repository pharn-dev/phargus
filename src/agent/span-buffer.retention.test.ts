import { describe, expect, it } from 'vitest';
import { createSpanBuffer, type SpanBuffer, type TraceSpan } from './span-buffer.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

function makeSpan(n: number, overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    traceId: n.toString(16).padStart(32, '0'),
    spanId: n.toString(16).padStart(16, '0'),
    name: `GET /p${n}`,
    method: 'GET',
    path: `/p${n}`,
    statusCode: 200,
    startTimeMs: 1_700_000_000_000 + n,
    durationNs: 1000 + n,
    ...overrides,
  };
}

/** Buffer `span`'s fields the way the HTTP tracer does; the buffer makes its own span id. */
function record(buffer: SpanBuffer, span: TraceSpan): void {
  buffer.record(
    span.traceId,
    span.method,
    span.path,
    span.statusCode,
    span.startTimeMs,
    span.durationNs,
    span.aborted,
    span.parentSpanId,
  );
}

describe('span buffer — keeps span fields, not span objects', () => {
  it('record() buffers a span with a fresh span id and the name built from method and path', () => {
    const buffer = createSpanBuffer(8);
    buffer.record(TRACE_ID, 'POST', '/orders', 201, 1_700_000_000_123.5, Number.MAX_SAFE_INTEGER);
    buffer.record(TRACE_ID, 'GET', '/', 200, 1_700_000_000_124, 0);

    const { spans, dropped } = buffer.drain();
    expect(dropped).toBe(0);
    expect(spans).toHaveLength(2);
    const [first, second] = spans;
    expect(first).toEqual({
      traceId: TRACE_ID,
      spanId: expect.stringMatching(/^[0-9a-f]{16}$/) as unknown,
      name: 'POST /orders',
      method: 'POST',
      path: '/orders',
      statusCode: 201,
      startTimeMs: 1_700_000_000_123.5,
      durationNs: Number.MAX_SAFE_INTEGER,
    });
    expect(first?.spanId).not.toBe('0'.repeat(16));
    expect(second?.name).toBe('GET /');
    expect(second?.spanId).not.toBe(first?.spanId);
    expect(buffer.drain()).toEqual({ spans: [], dropped: 0 });
  });

  it('record() hands back exactly the span it was given, with a fresh span id', () => {
    const buffer = createSpanBuffer(8);
    const child = makeSpan(7, { parentSpanId: '00f067aa0ba902b7' });
    const plain = makeSpan(8);
    record(buffer, child);
    buffer.record(TRACE_ID, 'GET', '/r', 200, 5, 6);
    record(buffer, plain);

    const { spans } = buffer.drain();
    expect(spans[0]).toEqual({ ...child, spanId: spans[0]?.spanId });
    expect(spans[0]?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spans[1]?.traceId).toBe(TRACE_ID);
    expect(spans[1]?.path).toBe('/r');
    expect(spans[2]).toEqual({ ...plain, spanId: spans[2]?.spanId });
  });

  it('keeps aborted: true through record(), and writes no aborted key otherwise', () => {
    const buffer = createSpanBuffer(2);
    buffer.record(TRACE_ID, 'GET', '/gone', 0, 1, 2, true);
    buffer.record(TRACE_ID, 'GET', '/gone', 0, 1, 2, true);
    expect(buffer.drain().spans.map((span) => span.aborted)).toEqual([true, true]);

    // The same slots, reused for spans that finished normally, carry no aborted key.
    buffer.record(TRACE_ID, 'GET', '/ok', 200, 1, 2, false);
    buffer.record(TRACE_ID, 'GET', '/ok', 200, 1, 2);
    const { spans } = buffer.drain();
    expect(spans.map((span) => Object.hasOwn(span, 'aborted'))).toEqual([false, false]);
  });

  it('keeps parentSpanId through record(), and writes no parentSpanId key otherwise', () => {
    const buffer = createSpanBuffer(3);
    buffer.record(TRACE_ID, 'GET', '/child', 200, 1, 2, false, '00f067aa0ba902b7');
    buffer.record(TRACE_ID, 'GET', '/gone', 0, 1, 2, true, 'b7ad6b7169203331');
    let { spans } = buffer.drain();
    expect(spans.map((span) => span.parentSpanId)).toEqual([
      '00f067aa0ba902b7',
      'b7ad6b7169203331',
    ]);
    expect(spans[1]?.aborted).toBe(true);

    // The same slots, reused for root spans, carry no parentSpanId key.
    buffer.record(TRACE_ID, 'GET', '/root', 200, 1, 2);
    buffer.record(TRACE_ID, 'GET', '/root', 200, 1, 2, false, undefined);
    ({ spans } = buffer.drain());
    expect(spans.map((span) => Object.hasOwn(span, 'parentSpanId'))).toEqual([false, false]);
  });

  it('round-trips paths of every shape the tracer produces: empty, Latin-1, and a path cut at the 256-character limit', () => {
    const buffer = createSpanBuffer(8);
    const paths = [
      '',
      '/caf\u00e9?x=\u00ff',
      `/${'a'.repeat(300)}`.slice(0, 256),
      `/${'b'.repeat(254)}`,
    ];
    for (const path of paths) {
      buffer.record(TRACE_ID, 'GET', path, 200, 1, 1);
    }

    const { spans } = buffer.drain();
    expect(spans.map((span) => span.path)).toEqual(paths);
    expect(spans.map((span) => span.name)).toEqual(paths.map((p) => `GET ${p}`));
  });

  it('drops the oldest spans past capacity and counts them', () => {
    const buffer = createSpanBuffer(3);
    for (let n = 1; n <= 4; n += 1) {
      buffer.record(TRACE_ID, 'GET', `/p${n}`, 200, n, n);
    }
    buffer.record(TRACE_ID, 'GET', '/last', 200, 9, 9);

    const first = buffer.drain();
    expect(first.dropped).toBe(2);
    expect(first.spans.map((span) => span.path)).toEqual(['/p3', '/p4', '/last']);
    // The count resets with each drain, and the ring keeps working after it wraps.
    buffer.record(TRACE_ID, 'GET', '/p10', 200, 10, 10);
    const second = buffer.drain();
    expect(second.dropped).toBe(0);
    expect(second.spans.map((span) => span.path)).toEqual(['/p10']);
  });

  it("does not keep the caller's path string: each path is copied into its fixed 256-byte slot", () => {
    const buffer = createSpanBuffer(2);
    const long = `/${'c'.repeat(299)}`;
    buffer.record(TRACE_ID, 'GET', long, 200, 1, 1);
    buffer.record(TRACE_ID, 'GET', '/next', 200, 1, 1);

    const { spans } = buffer.drain();
    // A kept string would come back whole; the slot holds only its first 256 bytes.
    expect(spans[0]?.path).toBe(long.slice(0, 256));
    expect(spans[1]?.path).toBe('/next');
  });
});
