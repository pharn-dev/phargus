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
};

export type SpanDrain = { spans: TraceSpan[]; dropped: number };

export type SpanBuffer = {
  readonly capacity: number;
  /** Buffer a copy of `span`'s fields; the object itself is not kept. */
  push(span: TraceSpan): void;
  /**
   * The HTTP tracer's path: buffer one span from its fields, with a fresh span id. `traceId` must
   * be 32 lowercase hex characters; the drained span's name is `${method} ${path}`.
   */
  record(
    traceId: string,
    method: string,
    path: string,
    statusCode: number,
    startTimeMs: number,
    durationNs: number,
  ): void;
  /** Return buffered spans (oldest first) and the drop count since the last drain, then reset. */
  drain(): SpanDrain;
};

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
/** Path bytes kept per slot; a longer path (rare) is kept as its string. */
const PATH_SLOT_BYTES = 256;

/** Copies `text` as Latin-1 bytes when it fits in `max` and every character is below U+0100. */
function writeLatin1(target: Buffer, offset: number, text: string, max: number): boolean {
  if (text.length > max) {
    return false;
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      return false;
    }
    target[offset + i] = code;
  }
  return true;
}

/** Writes `hex` as raw bytes when it is exactly `bytes` bytes of lowercase hex; false otherwise. */
function writeLowerHex(target: Buffer, offset: number, hex: string, bytes: number): boolean {
  if (hex.length !== bytes * 2) {
    return false;
  }
  for (let i = 0; i < bytes; i += 1) {
    const high = hexValue(hex.charCodeAt(i * 2));
    const low = hexValue(hex.charCodeAt(i * 2 + 1));
    if (high < 0 || low < 0) {
      return false;
    }
    target[offset + i] = (high << 4) | low;
  }
  return true;
}

/** 0–15 for `0-9` and `a-f`, -1 for anything else (uppercase included: it would not round-trip). */
function hexValue(code: number): number {
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  if (code >= 97 && code <= 102) {
    return code - 87;
  }
  return -1;
}

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
  const methods: (string | undefined)[] = new Array<string | undefined>(capacity).fill(undefined);
  const pathBytes = Buffer.alloc(capacity * PATH_SLOT_BYTES);
  const pathLengths = new Uint16Array(capacity);
  // Kept as strings only when the compact form cannot hold them: an id that is not lowercase hex,
  // a path longer than a slot or outside Latin-1, a name that is not `${method} ${path}`.
  const traceIdText: (string | undefined)[] = new Array<string | undefined>(capacity).fill(
    undefined,
  );
  const spanIdText: (string | undefined)[] = new Array<string | undefined>(capacity).fill(
    undefined,
  );
  const pathText: (string | undefined)[] = new Array<string | undefined>(capacity).fill(undefined);
  const names: (string | undefined)[] = new Array<string | undefined>(capacity).fill(undefined);
  let head = 0;
  let length = 0;
  let dropped = 0;

  /** The slot for the next span: the oldest one's when full (it is dropped and counted). */
  const nextSlot = (): number => {
    if (length === capacity) {
      const slot = head;
      head = (head + 1) % capacity;
      dropped += 1;
      return slot;
    }
    const slot = (head + length) % capacity;
    length += 1;
    return slot;
  };

  const store = (
    slot: number,
    method: string,
    path: string,
    statusCode: number,
    startTimeMs: number,
    durationNs: number,
  ): void => {
    methods[slot] = method;
    if (writeLatin1(pathBytes, slot * PATH_SLOT_BYTES, path, PATH_SLOT_BYTES)) {
      pathLengths[slot] = path.length;
    } else {
      pathText[slot] = path;
    }
    statusCodes[slot] = statusCode;
    startTimes[slot] = startTimeMs;
    durations[slot] = durationNs;
  };

  const release = (slot: number): void => {
    methods[slot] = undefined;
    pathText[slot] = undefined;
    traceIdText[slot] = undefined;
    spanIdText[slot] = undefined;
    names[slot] = undefined;
  };

  return {
    capacity,
    push(span: TraceSpan): void {
      const slot = nextSlot();
      release(slot);
      store(slot, span.method, span.path, span.statusCode, span.startTimeMs, span.durationNs);
      if (!writeLowerHex(traceIds, slot * TRACE_ID_BYTES, span.traceId, TRACE_ID_BYTES)) {
        traceIdText[slot] = span.traceId;
      }
      if (!writeLowerHex(spanIds, slot * SPAN_ID_BYTES, span.spanId, SPAN_ID_BYTES)) {
        spanIdText[slot] = span.spanId;
      }
      if (span.name !== `${span.method} ${span.path}`) {
        names[slot] = span.name;
      }
    },
    record(traceId, method, path, statusCode, startTimeMs, durationNs): void {
      const slot = nextSlot();
      release(slot);
      store(slot, method, path, statusCode, startTimeMs, durationNs);
      if (!writeLowerHex(traceIds, slot * TRACE_ID_BYTES, traceId, TRACE_ID_BYTES)) {
        traceIdText[slot] = traceId;
      }
      writeSpanId(spanIds, slot * SPAN_ID_BYTES);
    },
    drain(): SpanDrain {
      const spans: TraceSpan[] = [];
      for (; length > 0; length -= 1) {
        const slot = head;
        head = (head + 1) % capacity;
        const method = methods[slot] ?? '';
        const pathOffset = slot * PATH_SLOT_BYTES;
        const path =
          pathText[slot] ??
          pathBytes.toString('latin1', pathOffset, pathOffset + (pathLengths[slot] ?? 0));
        const traceOffset = slot * TRACE_ID_BYTES;
        const spanOffset = slot * SPAN_ID_BYTES;
        spans.push({
          traceId:
            traceIdText[slot] ??
            traceIds.toString('hex', traceOffset, traceOffset + TRACE_ID_BYTES),
          spanId:
            spanIdText[slot] ?? spanIds.toString('hex', spanOffset, spanOffset + SPAN_ID_BYTES),
          name: names[slot] ?? `${method} ${path}`,
          method,
          path,
          statusCode: statusCodes[slot] ?? 0,
          startTimeMs: startTimes[slot] ?? 0,
          durationNs: durations[slot] ?? 0,
        });
        release(slot);
      }
      head = 0;
      const result = { spans, dropped };
      dropped = 0;
      return result;
    },
  };
}
