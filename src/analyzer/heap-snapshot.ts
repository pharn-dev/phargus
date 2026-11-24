import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ResourceLimits } from 'node:worker_threads';
import { resolveBundledWorkerFile } from './worker-file.js';
import { createWorkerPool, type WorkerPool } from './worker-pool.js';

export type HeapSnapshotTypeStats = { name: string; count: number; selfSize: number };

export type HeapSnapshotSummary = {
  nodeCount: number;
  totalSelfSize: number;
  top: HeapSnapshotTypeStats[];
};

export type HeapSnapshotDiffEntry = { name: string; countDelta: number; selfSizeDelta: number };

export type HeapSnapshotDiff = {
  entries: HeapSnapshotDiffEntry[];
  before: { nodeCount: number; totalSelfSize: number };
  after: { nodeCount: number; totalSelfSize: number };
};

type AnalysisOptions = {
  top?: number;
  /** A pool from `createHeapSnapshotPool()`; its worker's reply is returned without a re-check. */
  pool?: WorkerPool;
  /**
   * Task timeout in milliseconds. Always wins when set. When unset, a pool made by
   * `createHeapSnapshotPool()` without `taskTimeoutMs` (including the one made for a call with no
   * `pool`) gets `heapSnapshotTimeoutMs(size)`; any other pool keeps its own timeout.
   */
  timeoutMs?: number;
  /**
   * Largest snapshot file accepted, in bytes. A larger file is rejected with
   * `HeapSnapshotTooLargeError` before anything is read or sent to a worker. Default 256 MiB.
   */
  maxSnapshotBytes?: number;
};

const DEFAULT_TOP = 20;
/**
 * The worker streams the file, so its heap use does not grow with the file size; the cap bounds
 * the time and I/O one analysis can take. The cap and the task timeout are paired: a file at the
 * default cap gets the 30 s floor, and raising the cap raises the derived timeout at 20 MB/s
 * (about 54 s for 1 GiB, 215 s for 4 GiB). See `heapSnapshotTimeoutMs`.
 */
export const DEFAULT_MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;

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

/** Typed error for a heap snapshot file larger than the configured byte cap. Nothing was read. */
export class HeapSnapshotTooLargeError extends RangeError {
  readonly code = 'ERR_HEAP_SNAPSHOT_TOO_LARGE';
  readonly path: string;
  readonly size: number;
  readonly maxBytes: number;

  constructor(path: string, size: number, maxBytes: number) {
    super(
      `heap snapshot ${path} is ${String(size)} bytes, over the ${String(maxBytes)}-byte limit ` +
        '(raise maxSnapshotBytes to analyse it)',
    );
    this.name = 'HeapSnapshotTooLargeError';
    this.path = path;
    this.size = size;
    this.maxBytes = maxBytes;
  }
}

/** Pools made here without `taskTimeoutMs`: only these get a size-derived per-task timeout. */
const derivedTimeoutPools = new WeakSet<WorkerPool>();

export function createHeapSnapshotPool(
  options: { size?: number; taskTimeoutMs?: number; resourceLimits?: ResourceLimits } = {},
): WorkerPool {
  const pool = createWorkerPool({
    size: options.size ?? 1,
    workerFile: resolveBundledWorkerFile('heap-snapshot.worker'),
    ...(options.taskTimeoutMs === undefined ? {} : { taskTimeoutMs: options.taskTimeoutMs }),
    ...(options.resourceLimits === undefined ? {} : { resourceLimits: options.resourceLimits }),
  });
  if (options.taskTimeoutMs === undefined) derivedTimeoutPools.add(pool);
  return pool;
}

function checkPath(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return resolve(value);
}

function checkMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('maxSnapshotBytes must be a positive safe integer');
  }
  return maxBytes;
}

/**
 * Rejects a missing, non-regular or oversized file before any worker is involved; returns the
 * size it saw.
 */
async function checkSize(path: string, maxBytes: number): Promise<number> {
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    throw new Error(
      `cannot read heap snapshot ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!stats.isFile()) throw new Error(`heap snapshot ${path} is not a regular file`);
  if (stats.size > maxBytes) throw new HeapSnapshotTooLargeError(path, stats.size, maxBytes);
  return stats.size;
}

function checkTop(value: number | undefined): number {
  const top = value ?? DEFAULT_TOP;
  if (!Number.isSafeInteger(top) || top <= 0) {
    throw new RangeError('top must be a positive safe integer');
  }
  return top;
}

async function runTask(
  payload: unknown,
  options: AnalysisOptions,
  bytes: number,
): Promise<unknown> {
  const pool = options.pool ?? createHeapSnapshotPool();
  try {
    let taskOptions: { timeoutMs?: number } = {};
    if (options.timeoutMs !== undefined) {
      taskOptions = { timeoutMs: options.timeoutMs };
    } else if (derivedTimeoutPools.has(pool)) {
      taskOptions = { timeoutMs: heapSnapshotTimeoutMs(bytes) };
    }
    return await pool.run(payload, taskOptions);
  } finally {
    if (options.pool === undefined) await pool.close();
  }
}

export async function summarizeHeapSnapshot(
  path: string,
  options: AnalysisOptions = {},
): Promise<HeapSnapshotSummary> {
  const resolved = checkPath(path, 'path');
  const top = checkTop(options.top);
  const maxBytes = checkMaxBytes(options.maxSnapshotBytes);
  const size = await checkSize(resolved, maxBytes);
  // The bundled worker is trusted code in this process: its reply is not re-checked.
  return (await runTask(
    { kind: 'summary', path: resolved, top, maxBytes },
    options,
    size,
  )) as HeapSnapshotSummary;
}

export async function diffHeapSnapshots(
  beforePath: string,
  afterPath: string,
  options: AnalysisOptions = {},
): Promise<HeapSnapshotDiff> {
  const before = checkPath(beforePath, 'beforePath');
  const after = checkPath(afterPath, 'afterPath');
  const top = checkTop(options.top);
  const maxBytes = checkMaxBytes(options.maxSnapshotBytes);
  const beforeSize = await checkSize(before, maxBytes);
  const afterSize = await checkSize(after, maxBytes);
  return (await runTask(
    { kind: 'diff', beforePath: before, afterPath: after, top, maxBytes },
    options,
    // Each size is at most maxBytes; clamp so a petabyte-scale cap cannot make the sum invalid.
    Math.min(beforeSize + afterSize, Number.MAX_SAFE_INTEGER),
  )) as HeapSnapshotDiff;
}
