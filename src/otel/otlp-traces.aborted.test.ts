import { describe, expect, it } from 'vitest';
import type { SpanRecord } from '../collector/index.js';
import { STATUS_CODE_ERROR, STATUS_CODE_UNSET } from './otlp-types.js';
import { toOtlpTraces } from './otlp-traces.js';

function record(spanId: string, statusCode: number, aborted: boolean): SpanRecord {
  const base: SpanRecord = {
    type: 'span',
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId,
    name: 'GET /slow',
    method: 'GET',
    path: '/slow',
    statusCode,
    startTimeMs: 1_700_000_000_123,
    durationNs: 200_000_000,
  };
  return aborted ? { ...base, aborted: true } : base;
}

describe('otlp traces — aborted spans', () => {
  it('sets status error on an aborted span, with or without a status code sent', () => {
    const request = toOtlpTraces([
      record('00f067aa0ba902b7', 0, true),
      record('b7ad6b7169203331', 200, true),
      record('1111111111111111', 200, false),
    ]);
    const spans = request.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];

    expect(spans.map((span) => span.status?.code)).toEqual([
      STATUS_CODE_ERROR,
      STATUS_CODE_ERROR,
      STATUS_CODE_UNSET,
    ]);
  });
});
