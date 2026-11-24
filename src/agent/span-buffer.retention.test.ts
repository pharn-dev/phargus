import { describe, expect, it } from 'vitest';
import { createSpanBuffer } from './span-buffer.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

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

  it('round-trips the paths the tracer keeps: empty, Latin-1, and a full 256-character slot', () => {
    const buffer = createSpanBuffer(8);
    const paths = ['', '/caf\u00e9?x=\u00ff', `/${'b'.repeat(255)}`, '/short'];
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
});
