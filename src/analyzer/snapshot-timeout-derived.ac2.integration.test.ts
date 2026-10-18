import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerPool } from './worker-pool.js';

type HeapSnapshotSummary = {
  nodeCount: number;
  totalSelfSize: number;
  top: Array<{ name: string; count: number; selfSize: number }>;
};

type HeapSnapshotDiff = {
  entries: Array<{ name: string; countDelta: number; selfSizeDelta: number }>;
};

type AnalysisOptions = {
  pool?: WorkerPool;
  timeoutMs?: number;
  top?: number;
  maxSnapshotBytes?: number;
};

type AnalyzerModule = {
  heapSnapshotTimeoutMs: (bytes: number) => number;
  createHeapSnapshotPool: (options?: { size?: number; taskTimeoutMs?: number }) => WorkerPool;
  summarizeHeapSnapshot: (path: string, options?: AnalysisOptions) => Promise<HeapSnapshotSummary>;
  diffHeapSnapshots: (
    beforePath: string,
    afterPath: string,
    options?: AnalysisOptions,
  ) => Promise<HeapSnapshotDiff>;
};

function runTimeouts(calls: unknown[][]): Array<number | undefined> {
  return calls.map((call) => {
    const runOptions = call[1] as { timeoutMs?: number } | undefined;
    return runOptions?.timeoutMs;
  });
}

describe('size-derived heap-snapshot task timeout', () => {
  it('AC-2: summarizeHeapSnapshot passes the timeout derived from the file size to a createHeapSnapshotPool() pool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phargus-std-ac2-summary-'));
    const mod = (await import('./index.js')) as unknown as AnalyzerModule;
    const pool = mod.createHeapSnapshotPool();
    try {
      const snapshotPath = writeHeapSnapshot(join(dir, 'a.heapsnapshot'));
      const size = (await stat(snapshotPath)).size;
      const runSpy = vi.spyOn(pool, 'run');

      const summary = await mod.summarizeHeapSnapshot(snapshotPath, { pool });

      expect(Number.isSafeInteger(summary.nodeCount)).toBe(true);
      expect(summary.nodeCount).toBeGreaterThan(0);
      const expected = mod.heapSnapshotTimeoutMs(size);
      const timeouts = runTimeouts(runSpy.mock.calls);
      expect(timeouts.length).toBeGreaterThan(0);
      expect(timeouts).toEqual(timeouts.map(() => expected));
    } finally {
      await pool.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('AC-2: diffHeapSnapshots passes the timeout derived from the sum of both file sizes to a createHeapSnapshotPool() pool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phargus-std-ac2-diff-'));
    const mod = (await import('./index.js')) as unknown as AnalyzerModule;
    const pool = mod.createHeapSnapshotPool();
    try {
      const beforePath = writeHeapSnapshot(join(dir, 'before.heapsnapshot'));
      const afterPath = writeHeapSnapshot(join(dir, 'after.heapsnapshot'));
      const beforeSize = (await stat(beforePath)).size;
      const afterSize = (await stat(afterPath)).size;
      const runSpy = vi.spyOn(pool, 'run');

      const diff = await mod.diffHeapSnapshots(beforePath, afterPath, { pool });

      expect(Array.isArray(diff.entries)).toBe(true);
      const expected = mod.heapSnapshotTimeoutMs(beforeSize + afterSize);
      const timeouts = runTimeouts(runSpy.mock.calls);
      expect(timeouts.length).toBeGreaterThan(0);
      expect(timeouts).toEqual(timeouts.map(() => expected));
    } finally {
      await pool.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
