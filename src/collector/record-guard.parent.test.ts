import { describe, expect, it } from 'vitest';
import { classifyRecord } from './record-guard.js';

describe('collector record guard and the span line parentSpanId (CORE-231)', () => {
  it('accepts a span line with or without parentSpanId', () => {
    const span = {
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
    expect(classifyRecord({ ...span, parentSpanId: '00f067aa0ba902b7' })).toBe('span');
    expect(classifyRecord(span)).toBe('span');
  });
});
