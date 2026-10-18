import { Buffer } from 'node:buffer';
import { randomFillSync } from 'node:crypto';

const ALL_ZERO_TRACE_ID = '0'.repeat(32);
/** The version-00 layout: version, trace-id, parent-id, trace-flags (55 characters). */
const TRACEPARENT_00 = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const TRACEPARENT_00_LENGTH = 55;
const ALL_ZERO_PARENT_ID = '0'.repeat(16);

/**
 * Ids are cut from a pool of CSPRNG bytes refilled 4 KiB at a time, and no byte is used twice.
 * A traced request takes two ids; one `randomBytes()` call each (a native call plus its own
 * Buffer) was about 16% of the busy CPU in the overhead benchmark's tracing target.
 */
const POOL_BYTES = 4096;
const pool = Buffer.alloc(POOL_BYTES);
let poolOffset = POOL_BYTES;

function randomHex(bytes: number): string {
  if (poolOffset + bytes > POOL_BYTES) {
    randomFillSync(pool);
    poolOffset = 0;
  }
  const hex = pool.toString('hex', poolOffset, poolOffset + bytes);
  poolOffset += bytes;
  return hex;
}

/** A fresh W3C-valid trace id: 32 lowercase hex characters, never all zeros. */
export function newTraceId(): string {
  let id = randomHex(16);
  while (id === ALL_ZERO_TRACE_ID) {
    id = randomHex(16);
  }
  return id;
}

const ALL_ZERO_SPAN_ID = '0'.repeat(16);

/** A fresh W3C-shaped span id: 16 lowercase hex characters, never all zeros. */
export function newSpanId(): string {
  let id = randomHex(8);
  while (id === ALL_ZERO_SPAN_ID) {
    id = randomHex(8);
  }
  return id;
}

/**
 * Extract the trace id from a W3C `traceparent` header value. Returns the lowercased
 * trace id, or undefined when the value is absent, duplicated, malformed, or carries an
 * all-zero trace-id or parent-id.
 *
 * Version `00` must be exactly the 55-character layout. Version `ff` is invalid. Any other
 * version is parsed with the `00` layout (W3C Trace Context §3.2.4): its first 55 characters
 * must fit that layout, and anything after them must start with `-` (fields a future version
 * appends).
 */
export function parseTraceparent(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || value.length < TRACEPARENT_00_LENGTH) {
    return undefined;
  }
  const version = value.slice(0, 2).toLowerCase();
  if (version === 'ff') {
    return undefined;
  }
  if (value.length > TRACEPARENT_00_LENGTH) {
    if (version === '00' || value.charAt(TRACEPARENT_00_LENGTH) !== '-') {
      return undefined;
    }
  }
  const match = TRACEPARENT_00.exec(value.slice(0, TRACEPARENT_00_LENGTH));
  const traceId = match?.[2]?.toLowerCase();
  const parentId = match?.[3];
  if (
    traceId === undefined ||
    parentId === undefined ||
    traceId === ALL_ZERO_TRACE_ID ||
    parentId === ALL_ZERO_PARENT_ID
  ) {
    return undefined;
  }
  return traceId;
}
