import { Buffer } from 'node:buffer';
import { writeSpanId } from './trace-id.js';

export type TraceSpan = {
  traceId: string;
  spanId: string;
  name: string;
  method: string;
  path: string;
  statusCode: number;
  startTimeMs: number;
  durationNs: number;
  /** Set only when the request continued a W3C `traceparent`: that header's parent-id. */
  parentSpanId?: string;
  /** Set only when the request closed before its response finished (client gone, destroyed). */
  aborted?: true;
};

export type SpanDrain = { spans: TraceSpan[]; dropped: number };

export type SpanBuffer = {
  readonly capacity: number;
  /**
   * Buffer one span from its fields, with a fresh span id. As the HTTP tracer makes them,
   * `traceId` is 32 lowercase hex characters (`parentSpanId`, when given, 16) and `path` at most
   * 256 Latin-1 characters. The drained span's name is `${method} ${path}`.
   */
  record(
    traceId: string,
    method: string,
    path: string,
    statusCode: number,
    startTimeMs: number,
    durationNs: number,
    aborted?: boolean,
    parentSpanId?: string,
  ): void;
  /** Return buffered spans (oldest first) and the drop count since the last drain, then reset. */
  drain(): SpanDrain;
};

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
/** Path bytes kept per slot: the HTTP tracer keeps at most 256 characters of a path. */
const PATH_SLOT_BYTES = 256;

/**
 * Bounded drop-oldest span buffer that counts the records it lost.
 *
 * Spans are stored field by field in preallocated slots (ids, path and numbers as raw bytes), so a
 * buffered span keeps no heap object of its own alive. Under load a span stays in the buffer for
 * several young-generation collections (about 20 ms at 50 000 requests/s against a scavenge every
 * few ms), so anything it held was promoted to the old generation and died there: about 8 MiB per
 * 20 s on the overhead benchmark's promise workload, which showed up as tens of MiB of extra RSS.
 */
export function createSpanBuffer(capacity: number): SpanBuffer {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError(`capacity must be a positive safe integer, got ${String(capacity)}`);
  }
  const traceIds = Buffer.alloc(capacity * TRACE_ID_BYTES);
  const spanIds = Buffer.alloc(capacity * SPAN_ID_BYTES);
  const statusCodes = new Float64Array(capacity);
  const startTimes = new Float64Array(capacity);
  const durations = new Float64Array(capacity);
  const abortedFlags = new Uint8Array(capacity);
  const parentSpanIds = Buffer.alloc(capacity * SPAN_ID_BYTES);
  const parentFlags = new Uint8Array(capacity);
  // The HTTP parser's own method strings: keeping a reference allocates nothing.
  const methods: (string | undefined)[] = new Array<string | undefined>(capacity).fill(undefined);
  const pathBytes = Buffer.alloc(capacity * PATH_SLOT_BYTES);
  const pathLengths = new Uint16Array(capacity);
  let head = 0;
  let length = 0;
  let dropped = 0;

  return {
    capacity,
    record(
      traceId,
      method,
      path,
      statusCode,
      startTimeMs,
      durationNs,
      aborted,
      parentSpanId,
    ): void {
      // The slot for this span: the oldest one's when full (it is dropped and counted).
      const slot = (head + length) % capacity;
      if (length === capacity) {
        head = (head + 1) % capacity;
        dropped += 1;
      } else {
        length += 1;
      }
      traceIds.write(traceId, slot * TRACE_ID_BYTES, TRACE_ID_BYTES, 'hex');
      writeSpanId(spanIds, slot * SPAN_ID_BYTES);
      methods[slot] = method;
      pathLengths[slot] = pathBytes.write(path, slot * PATH_SLOT_BYTES, PATH_SLOT_BYTES, 'latin1');
      statusCodes[slot] = statusCode;
      startTimes[slot] = startTimeMs;
      durations[slot] = durationNs;
      abortedFlags[slot] = aborted === true ? 1 : 0;
      parentFlags[slot] = parentSpanId === undefined ? 0 : 1;
      if (parentSpanId !== undefined) {
        parentSpanIds.write(parentSpanId, slot * SPAN_ID_BYTES, SPAN_ID_BYTES, 'hex');
      }
    },
    drain(): SpanDrain {
      const spans: TraceSpan[] = [];
      for (; length > 0; length -= 1) {
        const slot = head;
        head = (head + 1) % capacity;
        const method = methods[slot] ?? '';
        methods[slot] = undefined;
        const pathOffset = slot * PATH_SLOT_BYTES;
        const path = pathBytes.toString(
          'latin1',
          pathOffset,
          pathOffset + (pathLengths[slot] ?? 0),
        );
        const traceOffset = slot * TRACE_ID_BYTES;
        const spanOffset = slot * SPAN_ID_BYTES;
        const span: TraceSpan = {
          traceId: traceIds.toString('hex', traceOffset, traceOffset + TRACE_ID_BYTES),
          spanId: spanIds.toString('hex', spanOffset, spanOffset + SPAN_ID_BYTES),
          name: `${method} ${path}`,
          method,
          path,
          statusCode: statusCodes[slot] ?? 0,
          startTimeMs: startTimes[slot] ?? 0,
          durationNs: durations[slot] ?? 0,
        };
        if (parentFlags[slot] === 1) {
          span.parentSpanId = parentSpanIds.toString('hex', spanOffset, spanOffset + SPAN_ID_BYTES);
        }
        if (abortedFlags[slot] === 1) {
          span.aborted = true;
        }
        spans.push(span);
      }
      head = 0;
      const result = { spans, dropped };
      dropped = 0;
      return result;
    },
  };
}
