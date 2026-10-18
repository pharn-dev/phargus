import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createSpanBuffer, type TraceSpan } from './span-buffer.js';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

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

  it('push() hands back exactly the span it was given, including ids that are not lowercase hex', () => {
    const buffer = createSpanBuffer(8);
    const odd = makeSpan(7, {
      traceId: 'not-a-hex-trace-id',
      spanId: 'ABCDEF0123456789',
      name: 'custom name',
    });
    const plain = makeSpan(8);
    buffer.push(odd);
    buffer.record(TRACE_ID, 'GET', '/r', 200, 5, 6);
    buffer.push(plain);

    const { spans } = buffer.drain();
    expect(spans[0]).toEqual(odd);
    expect(spans[0]).not.toBe(odd);
    expect(spans[1]?.traceId).toBe(TRACE_ID);
    expect(spans[1]?.path).toBe('/r');
    expect(spans[2]).toEqual(plain);
  });

  it('round-trips paths of every shape: empty, Latin-1, longer than a slot, and beyond Latin-1', () => {
    const buffer = createSpanBuffer(8);
    const paths = [
      '',
      '/caf\u00e9?x=\u00ff',
      `/${'a'.repeat(300)}`,
      '/\u20ac/\u{1f600}',
      `/${'b'.repeat(255)}`,
    ];
    for (const path of paths) {
      buffer.record(TRACE_ID, 'GET', path, 200, 1, 1);
    }
    const pushed = makeSpan(3, { path: '/\u4e2d\u6587', name: 'GET /\u4e2d\u6587' });
    buffer.push(pushed);

    const { spans } = buffer.drain();
    expect(spans.map((span) => span.path)).toEqual([...paths, pushed.path]);
    expect(spans.map((span) => span.name)).toEqual([...paths.map((p) => `GET ${p}`), pushed.name]);
    expect(spans.at(-1)).toEqual(pushed);
  });

  it('drops the oldest spans past capacity and counts them, across push() and record()', () => {
    const buffer = createSpanBuffer(3);
    for (let n = 1; n <= 4; n += 1) {
      buffer.push(makeSpan(n));
    }
    buffer.record(TRACE_ID, 'GET', '/last', 200, 9, 9);

    const first = buffer.drain();
    expect(first.dropped).toBe(2);
    expect(first.spans.map((span) => span.path)).toEqual(['/p3', '/p4', '/last']);
    // The count resets with each drain, and the ring keeps working after it wraps.
    buffer.push(makeSpan(10));
    expect(buffer.drain()).toEqual({ spans: [makeSpan(10)], dropped: 0 });
  });

  it('does not keep the pushed span object alive until the next drain', async () => {
    const buffer = createSpanBuffer(16);
    const ref = ((): WeakRef<TraceSpan> => {
      const span = makeSpan(1);
      buffer.push(span);
      return new WeakRef(span);
    })();
    // A WeakRef target stays alive until the current job ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();

    expect(ref.deref()).toBeUndefined();
    expect(buffer.drain().spans).toEqual([makeSpan(1)]);
  });
});
