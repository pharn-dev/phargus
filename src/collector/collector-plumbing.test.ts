import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpanRecord } from '../agent/index.js';
import type { Alert } from './alert-evaluator.js';
import type { AlertRule } from './alert-rules.js';
import { createCollector } from './collector.js';
import type { AggregatedWindow } from './window.js';
import { makeSample } from '../../test/support.js';

const SPAN: SpanRecord = {
  type: 'span',
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  name: 'GET /users',
  method: 'GET',
  path: '/users',
  statusCode: 200,
  startTimeMs: 1_700_000_000_000,
  durationNs: 1_000_000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('collector plumbing (CORE-367)', () => {
  it.each([0, -1, 1.5, Number.NaN, '1000'])('rejects windowMs %s at creation', (windowMs) => {
    expect(() => createCollector({ windowMs: windowMs as number, capacity: 4 })).toThrow(
      new RangeError('windowMs must be a positive safe integer'),
    );
  });

  it('validates the alert rules once per collector, not per consume()', async () => {
    let reads = 0;
    const rule = {
      id: 'loop-max',
      comparison: '>',
      threshold: 100,
      get metric(): string {
        reads += 1;
        return 'eventLoop.max';
      },
    } as AlertRule;
    const collector = createCollector({ windowMs: 1000, capacity: 4, alerts: [rule] });
    const afterCreate = reads;
    expect(afterCreate).toBeGreaterThan(0);
    await collector.consume(Readable.from([makeSample(100, 500), makeSample(1100, 50)]));
    await collector.consume(Readable.from([makeSample(2100, 500), makeSample(3100, 50)]));
    expect(reads).toBe(afterCreate);
    expect(collector.alerts.snapshot().map((alert) => alert.state)).toEqual([
      'firing',
      'resolved',
      'firing',
      'resolved',
    ]);
    await collector.close();
  });

  it('reports a throwing listener and still notifies the others of windows, alerts and spans', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const collector = createCollector({
      windowMs: 1000,
      capacity: 4,
      alerts: [{ id: 'loop-max', metric: 'eventLoop.max', comparison: '>', threshold: 100 }],
    });
    const seen: { windows: AggregatedWindow[]; alerts: Alert[]; spans: SpanRecord[] } = {
      windows: [],
      alerts: [],
      spans: [],
    };
    collector.subscribe({
      window(): void {
        throw new Error('window boom');
      },
      alert(): void {
        throw new Error('alert boom');
      },
      span(): void {
        throw 'span boom';
      },
    });
    collector.subscribe({
      window: (window) => seen.windows.push(window),
      alert: (alert) => seen.alerts.push(alert),
      span: (span) => seen.spans.push(span),
    });
    await collector.consume(Readable.from([makeSample(100, 500), SPAN, makeSample(1100, 50)]));
    expect(seen.windows).toHaveLength(2);
    expect(seen.alerts.map((alert) => alert.state)).toEqual(['firing', 'resolved']);
    expect(seen.spans).toEqual([SPAN]);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain('collector listener threw: window boom');
    expect(messages).toContain('collector listener threw: alert boom');
    expect(messages).toContain('collector listener threw: span boom');
    await collector.close();
  });
});
