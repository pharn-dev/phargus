import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createSpanBuffer } from '../agent/span-buffer.js';
import { toSpanRecord } from '../agent/span-record.js';
import { createCollector } from './collector.js';
import { classifyRecord, MAX_SPAN_STRING_LENGTH, parseSpanRecord } from './record-guard.js';

const SPAN = {
  type: 'span',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: 'b7ad6b7169203331',
  name: 'GET /users',
  method: 'GET',
  path: '/users',
  statusCode: 200,
  startTimeMs: 1_700_000_000_123,
  durationNs: 1_000_000,
};

async function consume(records: unknown[]): Promise<ReturnType<typeof createCollector>> {
  const collector = createCollector({ windowMs: 1000, capacity: 4 });
  await collector.consume(Readable.from(records));
  return collector;
}

function longestString(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (typeof value !== 'object' || value === null) return 0;
  return Math.max(0, ...Object.values(value).map(longestString));
}

describe('record guard: only a well-formed span is stored (CORE-242)', () => {
  it('skips a span line with junk and no span fields as malformed', async () => {
    const reasons: string[] = [];
    const collector = createCollector({
      windowMs: 1000,
      capacity: 4,
      onIgnored: (_record, reason) => reasons.push(reason),
    });
    await collector.consume(Readable.from([{ type: 'span', junk: 'x'.repeat(100_000) }]));
    expect(collector.spans.snapshot()).toEqual([]);
    expect(collector.ignored).toBe(1);
    expect(reasons).toEqual(['malformed']);
  });

  it('skips a span whose path is an object as malformed', async () => {
    const bad = { ...SPAN, path: { nested: 'x' } };
    expect(classifyRecord(bad)).toBe('malformed');
    const collector = await consume([bad]);
    expect(collector.spans.snapshot()).toEqual([]);
    expect(collector.ignored).toBe(1);
  });

  it.each([
    ['traceId', 'A'.repeat(32)],
    ['traceId', 'a'.repeat(31)],
    ['spanId', 'z'.repeat(16)],
    ['name', 1],
    ['method', null],
    ['statusCode', '200'],
    ['statusCode', -1],
    ['startTimeMs', 1.5],
    ['durationNs', Number.MAX_SAFE_INTEGER + 2],
    ['parentSpanId', 'short'],
    ['parentSpanId', 7],
    ['aborted', 'yes'],
  ])('rejects %s = %j', (key, value) => {
    expect(classifyRecord({ ...SPAN, [key]: value })).toBe('malformed');
  });

  it.each([
    'traceId',
    'spanId',
    'name',
    'method',
    'path',
    'statusCode',
    'startTimeMs',
    'durationNs',
  ])('rejects a span without %s', (key) => {
    const rest: Record<string, unknown> = { ...SPAN };
    delete rest[key];
    expect(classifyRecord(rest)).toBe('malformed');
  });

  it('stores a valid span with an extra key without that key', async () => {
    const collector = await consume([{ ...SPAN, junk: 'x', extra: { a: 1 } }]);
    expect(collector.spans.snapshot()).toEqual([SPAN]);
    expect(collector.ignored).toBe(0);
  });

  it('never stores a string longer than 1,024 characters', async () => {
    const long = 'p'.repeat(200_000);
    const collector = await consume([
      { ...SPAN, name: `GET ${long}`, method: long, path: `/${long}` },
    ]);
    const [stored] = collector.spans.snapshot();
    expect(stored).toBeDefined();
    expect(longestString(stored)).toBe(MAX_SPAN_STRING_LENGTH);
    expect(stored?.path).toBe(`/${long}`.slice(0, MAX_SPAN_STRING_LENGTH));
  });

  it('passes every span the current agent writes, with aborted and parentSpanId', async () => {
    const buffer = createSpanBuffer(8);
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    buffer.record(traceId, 'GET', '/plain', 200, 1_700_000_000_000, 5_000);
    buffer.record(traceId, 'POST', '/aborted', 0, 1_700_000_000_001, 6_000, true);
    buffer.record(
      traceId,
      'GET',
      '/child',
      201,
      1_700_000_000_002,
      7_000,
      false,
      '00f067aa0ba902b7',
    );
    buffer.record(traceId, 'PUT', '/both', 0, 1_700_000_000_003, 8_000, true, '00f067aa0ba902b7');
    const lines = buffer
      .drain()
      .spans.map((span) => JSON.parse(JSON.stringify(toSpanRecord(span))) as unknown);
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(classifyRecord(line)).toBe('span');
      expect(parseSpanRecord(line)).toEqual(line);
    }
    const collector = await consume(lines);
    expect(collector.spans.snapshot()).toEqual(lines);
    expect(collector.ignored).toBe(0);
  });

  it('treats aborted: false as not aborted', () => {
    expect(parseSpanRecord({ ...SPAN, aborted: false })).toEqual(SPAN);
  });
});
