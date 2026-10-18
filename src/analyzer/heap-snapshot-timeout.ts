/** Parse throughput the derived timeout assumes: 20 000 bytes per millisecond (20 MB/s). */
const BYTES_PER_MS = 20_000;
/** The derived timeout never goes below the worker pool's 30 s default. */
const MIN_SNAPSHOT_TIMEOUT_MS = 30_000;

/**
 * Task timeout for analysing `bytes` of heap snapshot: `max(30 000, ceil(bytes / 20 000))` ms.
 * Integer math only. Throws a `RangeError` unless `bytes` is a non-negative safe integer.
 */
export function heapSnapshotTimeoutMs(bytes: number): number {
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError('bytes must be a non-negative safe integer');
  }
  const rem = bytes % BYTES_PER_MS;
  const ms = (bytes - rem) / BYTES_PER_MS + (rem === 0 ? 0 : 1);
  return Math.max(MIN_SNAPSHOT_TIMEOUT_MS, ms);
}
