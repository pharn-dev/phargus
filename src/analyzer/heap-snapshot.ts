import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ResourceLimits } from 'node:worker_threads';
import { HeapSnapshotTooLargeError } from './heap-snapshot-error.js';
import { heapSnapshotTimeoutMs } from './heap-snapshot-timeout.js';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isTotals(value: unknown): value is { nodeCount: number; totalSelfSize: number } {
  return isRecord(value) && isInt(value.nodeCount) && isInt(value.totalSelfSize);
}

function isSummary(value: unknown): value is HeapSnapshotSummary {
  return (
    isTotals(value) &&
    Array.isArray((value as { top?: unknown }).top) &&
    (value as unknown as HeapSnapshotSummary).top.every(
      (item) =>
        isRecord(item) &&
        typeof item.name === 'string' &&
        isInt(item.count) &&
        isInt(item.selfSize),
    )
  );
}

function isDiff(value: unknown): value is HeapSnapshotDiff {
  return (
    isRecord(value) &&
    isTotals(value.before) &&
    isTotals(value.after) &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item.name === 'string' &&
        isInt(item.countDelta) &&
        isInt(item.selfSizeDelta),
    )
  );
}

export async function summarizeHeapSnapshot(
  path: string,
  options: AnalysisOptions = {},
): Promise<HeapSnapshotSummary> {
  const resolved = checkPath(path, 'path');
  const top = checkTop(options.top);
  const maxBytes = checkMaxBytes(options.maxSnapshotBytes);
  const size = await checkSize(resolved, maxBytes);
  const reply = await runTask({ kind: 'summary', path: resolved, top, maxBytes }, options, size);
  if (!isSummary(reply)) throw new Error('heap snapshot worker returned an unexpected summary');
  return reply;
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
  const reply = await runTask(
    { kind: 'diff', beforePath: before, afterPath: after, top, maxBytes },
    options,
    // Each size is at most maxBytes; clamp so a petabyte-scale cap cannot make the sum invalid.
    Math.min(beforeSize + afterSize, Number.MAX_SAFE_INTEGER),
  );
  if (!isDiff(reply)) throw new Error('heap snapshot worker returned an unexpected diff');
  return reply;
}
