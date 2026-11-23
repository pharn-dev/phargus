import { describe, expect, it } from 'vitest';
import { buildWaterfall } from './ui/waterfall-model.js';

const TRACE_ID = 'c'.repeat(32);

function span(spanId: string, statusCode: number, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'span',
    traceId: TRACE_ID,
    spanId,
    name: 'GET /slow',
    method: 'GET',
    path: '/slow',
    statusCode,
    startTimeMs: 1_700_000_000_000,
    durationNs: 200_000_000,
    ...extra,
  };
}

describe('dashboard trace waterfall — aborted spans', () => {
  it('flags an aborted span as an error and names it "aborted"; other rows are unchanged', () => {
    const model = buildWaterfall(
      [span('0000000000000001', 0, { aborted: true }), span('0000000000000002', 200)],
      5,
    );
    const rows = model.traces[0]?.rows ?? [];
    const aborted = rows.find((row) => row.spanId === '0000000000000001');
    const normal = rows.find((row) => row.spanId === '0000000000000002');

    expect(aborted?.isError).toBe(true);
    expect(aborted?.label).toBe('GET /slow 0 200.0 ms aborted');
    expect(normal?.isError).toBe(false);
    expect(normal?.label).toBe('GET /slow 200 200.0 ms');
  });

  it('keeps the error style off a span whose aborted field is anything but true', () => {
    const model = buildWaterfall([span('0000000000000003', 200, { aborted: 'yes' })], 5);
    const row = model.traces[0]?.rows[0];
    expect(row?.isError).toBe(false);
    expect(row?.label).not.toContain('aborted');
  });
});
