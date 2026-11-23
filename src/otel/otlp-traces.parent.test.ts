import { describe, expect, it } from 'vitest';
import type { SpanRecord } from '../collector/index.js';
import { toOtlpTraces } from './otlp-traces.js';

const BASE: SpanRecord = {
  type: 'span',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: 'b7ad6b7169203331',
  name: 'GET /child',
  method: 'GET',
  path: '/child',
  statusCode: 200,
  startTimeMs: 1_700_000_000_123,
  durationNs: 1_000_000,
};

describe('otlp traces — parent span id (CORE-231)', () => {
  it('emits parentSpanId for a continued span and omits the key for a root span', () => {
    const request = toOtlpTraces([{ ...BASE, parentSpanId: '00f067aa0ba902b7' }, BASE]);
    const spans = request.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];

    expect(spans[0]?.parentSpanId).toBe('00f067aa0ba902b7');
    expect(Object.hasOwn(spans[1] ?? {}, 'parentSpanId')).toBe(false);
  });

  it('rejects a malformed parentSpanId without echoing it', () => {
    expect(() => toOtlpTraces({ ...BASE, parentSpanId: 'NOT-A-SPAN-ID' })).toThrow(
      new RangeError('span parentSpanId must be 16 lowercase hex characters'),
    );
  });
});
