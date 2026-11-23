import { Transform } from 'node:stream';
import { isSpanRecord, type SpanRecord } from '../agent/span-record.js';

/** Why a record was skipped: not agent data at all, or agent-shaped but unusable. */
export type IgnoredReason = 'foreign' | 'malformed';

/** Called once for every skipped record, after the collector's `ignored` counter is incremented. */
export type IgnoredRecordHandler = (record: unknown, reason: IgnoredReason) => void;

/** The keys the agent always writes on a sample line and `addSample` reads. */
const SAMPLE_KEYS = ['timestamp', 'eventLoop', 'memory', 'gc', 'backpressure'] as const;

/** How far ahead of the collector's clock a sample's timestamp may be: 24 hours, in ms. */
export const MAX_SAMPLE_FUTURE_MS = 24 * 60 * 60 * 1000;

/** Every numeric field the window aggregator reads, as [group, field]. */
const NUMERIC_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['eventLoop', 'max'],
  ['eventLoop', 'p99'],
  ['eventLoop', 'mean'],
  ['memory', 'heapUsed'],
  ['memory', 'rss'],
  ['gc', 'count'],
  ['gc', 'totalPause'],
  ['gc', 'maxPause'],
  ['backpressure', 'events'],
  ['backpressure', 'totalStall'],
  ['backpressure', 'maxStall'],
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidSample(record: Record<string, unknown>, now: number): boolean {
  const { timestamp } = record;
  // A future-dated line would open a window no real sample can close.
  if (!Number.isSafeInteger(timestamp) || (timestamp as number) > now + MAX_SAMPLE_FUTURE_MS) {
    return false;
  }
  for (const [group, field] of NUMERIC_FIELDS) {
    const section = record[group];
    if (!isPlainObject(section) || typeof section[field] !== 'number') {
      return false;
    }
  }
  return true;
}

/** Longest string a stored span keeps, in UTF-16 code units; longer strings are cut. */
export const MAX_SPAN_STRING_LENGTH = 1024;

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * `text` cut to MAX_SPAN_STRING_LENGTH. A cut is copied through a Buffer: V8 may keep a plain
 * `slice` as a view of the whole parsed string, which would retain the long line.
 */
function cut(text: string): string {
  if (text.length <= MAX_SPAN_STRING_LENGTH) {
    return text;
  }
  return Buffer.from(text.slice(0, MAX_SPAN_STRING_LENGTH), 'utf16le').toString('utf16le');
}

/**
 * Rebuild a span line as a fresh object holding only the agent's span fields, strings cut to
 * MAX_SPAN_STRING_LENGTH. Returns undefined when any field is missing or has the wrong type:
 * ids that are not lowercase hex of the agent's length, a non-string name, method or path, a
 * count that is not a non-negative safe integer, or an optional field of the wrong type.
 */
export function parseSpanRecord(value: unknown): SpanRecord | undefined {
  if (!isPlainObject(value) || !isSpanRecord(value)) {
    return undefined;
  }
  const { traceId, spanId, name, method, path, parentSpanId, aborted } = value as Record<
    string,
    unknown
  >;
  const statusCode = nonNegativeInt(value.statusCode);
  const startTimeMs = nonNegativeInt(value.startTimeMs);
  const durationNs = nonNegativeInt(value.durationNs);
  if (
    typeof traceId !== 'string' ||
    !TRACE_ID_PATTERN.test(traceId) ||
    typeof spanId !== 'string' ||
    !SPAN_ID_PATTERN.test(spanId) ||
    typeof name !== 'string' ||
    typeof method !== 'string' ||
    typeof path !== 'string' ||
    statusCode === undefined ||
    startTimeMs === undefined ||
    durationNs === undefined ||
    (parentSpanId !== undefined &&
      (typeof parentSpanId !== 'string' || !SPAN_ID_PATTERN.test(parentSpanId))) ||
    (aborted !== undefined && typeof aborted !== 'boolean')
  ) {
    return undefined;
  }
  const span: SpanRecord = {
    type: 'span',
    traceId,
    spanId,
    name: cut(name),
    method: cut(method),
    path: cut(path),
    statusCode,
    startTimeMs,
    durationNs,
  };
  if (parentSpanId !== undefined) {
    span.parentSpanId = parentSpanId;
  }
  // The agent writes `aborted` only as `true`; `false` means the same as leaving it out.
  if (aborted === true) {
    span.aborted = true;
  }
  return span;
}

/**
 * Deterministic key-membership classification of one parsed record.
 * `span` and `sample` are forwarded; `foreign` and `malformed` are skipped. A sample whose
 * `timestamp` is not a safe integer, or is more than 24 hours ahead of `now`, is `malformed`. A
 * record with `type: "span"` is a `span` only when `parseSpanRecord` accepts it, else `malformed`.
 */
export function classifyRecord(
  value: unknown,
  now: number = Date.now(),
): 'sample' | 'span' | IgnoredReason {
  if (isSpanRecord(value)) {
    return parseSpanRecord(value) === undefined ? 'malformed' : 'span';
  }
  if (!isPlainObject(value) || value['type'] !== undefined) {
    return 'foreign';
  }
  for (const key of SAMPLE_KEYS) {
    if (!(key in value)) {
      return 'foreign';
    }
  }
  return isValidSample(value, now) ? 'sample' : 'malformed';
}

/**
 * Object-mode Transform that forwards sample records unchanged, forwards each well-formed span as
 * the fresh object `parseSpanRecord` builds, and hands every other record to `onSkip`. A throw
 * from `onSkip` errors the Transform, so the surrounding pipeline rejects.
 */
export function createRecordGuard(
  onSkip: (record: unknown, reason: IgnoredReason) => void,
): Transform {
  return new Transform({
    objectMode: true,
    transform(chunk: unknown, _encoding, callback): void {
      const span = parseSpanRecord(chunk);
      const kind = span === undefined ? classifyRecord(chunk) : 'span';
      if (kind === 'sample' || kind === 'span') {
        callback(null, span ?? chunk);
        return;
      }
      try {
        onSkip(chunk, kind);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      callback();
    },
  });
}
