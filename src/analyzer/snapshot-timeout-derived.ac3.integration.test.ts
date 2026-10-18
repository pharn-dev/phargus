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

type AnalyzerModule = {
  heapSnapshotTimeoutMs: (bytes: number) => number;
  createHeapSnapshotPool: (options?: { size?: number; taskTimeoutMs?: number }) => WorkerPool;
  summarizeHeapSnapshot: (
    path: string,
    options?: { pool?: WorkerPool; timeoutMs?: number },
  ) => Promise<HeapSnapshotSummary>;
};

async function loadAnalyzer(): Promise<AnalyzerModule> {
  return (await import('./index.js')) as unknown as AnalyzerModule;
}

describe('explicit heap-snapshot task timeouts win over the size-derived one', () => {
  it('AC-3: options.timeoutMs reaches the pool run unchanged instead of the derived timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phargus-std-ac3-explicit-'));
    const mod = await loadAnalyzer();
    const pool = mod.createHeapSnapshotPool();
    try {
      const snapshotPath = writeHeapSnapshot(join(dir, 'a.heapsnapshot'));
      const size = (await stat(snapshotPath)).size;
      const explicitTimeoutMs = mod.heapSnapshotTimeoutMs(size) + 12_345;
      const runSpy = vi.spyOn(pool, 'run');

      const summary = await mod.summarizeHeapSnapshot(snapshotPath, {
        pool,
        timeoutMs: explicitTimeoutMs,
      });

      expect(summary.nodeCount).toBeGreaterThan(0);
      expect(runSpy.mock.calls.length).toBeGreaterThan(0);
      for (const call of runSpy.mock.calls) {
        const runOptions = call[1] as { timeoutMs?: number } | undefined;
        expect(runOptions?.timeoutMs).toBe(explicitTimeoutMs);
      }
    } finally {
      await pool.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('AC-3: a createHeapSnapshotPool({ taskTimeoutMs }) pool keeps its own short timeout and the analysis rejects with ERR_WORKER_TASK_TIMEOUT', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phargus-std-ac3-pool-'));
    const mod = await loadAnalyzer();
    const pool = mod.createHeapSnapshotPool({ taskTimeoutMs: 1 });
    try {
      const snapshotPath = writeHeapSnapshot(join(dir, 'a.heapsnapshot'));
      const size = (await stat(snapshotPath)).size;
      // The derived timeout for this file is at least the 30 000 ms floor, so a timeout
      // rejection proves the pool's own 1 ms timeout was kept rather than overridden.
      expect(mod.heapSnapshotTimeoutMs(size)).toBeGreaterThanOrEqual(30_000);

      await expect(mod.summarizeHeapSnapshot(snapshotPath, { pool })).rejects.toMatchObject({
        code: 'ERR_WORKER_TASK_TIMEOUT',
      });
    } finally {
      await pool.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('AC-3: a caller-supplied pool not made by createHeapSnapshotPool receives no timeoutMs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phargus-std-ac3-foreign-'));
    const mod = await loadAnalyzer();
    try {
      const snapshotPath = writeHeapSnapshot(join(dir, 'a.heapsnapshot'));
      const size = (await stat(snapshotPath)).size;
      // A derived timeout exists for this file; the foreign pool must still not be sent one.
      expect(mod.heapSnapshotTimeoutMs(size)).toBeGreaterThanOrEqual(30_000);

      const recorded: Array<{ timeoutMs?: number } | undefined> = [];
      const result: HeapSnapshotSummary = { nodeCount: 1, totalSelfSize: 1, top: [] };
      const foreignPool: WorkerPool = {
        size: 1,
        closed: false,
        run<T = unknown>(_payload: unknown, options?: { timeoutMs?: number }): Promise<T> {
          recorded.push(options);
          return Promise.resolve(result as unknown as T);
        },
        close(): Promise<void> {
          return Promise.resolve();
        },
      };

      const summary = await mod.summarizeHeapSnapshot(snapshotPath, { pool: foreignPool });

      expect(summary).toEqual(result);
      expect(recorded.length).toBeGreaterThan(0);
      for (const options of recorded) {
        expect(options?.timeoutMs).toBeUndefined();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
