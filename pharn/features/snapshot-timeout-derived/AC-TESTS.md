---
spec_id: snapshot-timeout-derived
spec_content_hash: d992de47dda2a66f588ec4b8ce47b0a0f84df4ef4d12fea17fc98c3b694d10fc
---

## Files

- `src/analyzer/snapshot-timeout-derived.ac1.test.ts` — the tests for AC-1
- `src/analyzer/snapshot-timeout-derived.ac2.integration.test.ts` — the tests for AC-2
- `src/analyzer/snapshot-timeout-derived.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/analyzer/snapshot-timeout-derived.ac1.test.ts` | src/analyzer/index.ts#heapSnapshotTimeoutMs(bytes: number): number — called with 0, 268_435_456, 600_000_000, 600_000_001, 1_073_741_824 and 4_294_967_296; expected 30_000, 30_000, 30_000, 30_001, 53_688 and 214_749, each Number.isSafeInteger
- AC-2 | integration | `src/analyzer/snapshot-timeout-derived.ac2.integration.test.ts` | src/analyzer/index.ts#createHeapSnapshotPool(options?: { size?: number; taskTimeoutMs?: number }): WorkerPool, called with no taskTimeoutMs, observed with vi.spyOn(pool, 'run') on that same pool object (never a wrapper object); src/analyzer/index.ts#summarizeHeapSnapshot(path: string, options?: { pool?: WorkerPool; timeoutMs?: number; top?: number; maxSnapshotBytes?: number }): Promise<HeapSnapshotSummary> and src/analyzer/index.ts#diffHeapSnapshots(beforePath: string, afterPath: string, options?: same): Promise<HeapSnapshotDiff>, each called with { pool } and no timeoutMs on node:v8 writeHeapSnapshot files in an fs.mkdtemp(os.tmpdir()) directory; observed: run's second argument has timeoutMs === heapSnapshotTimeoutMs((await stat(a)).size) for the summary and === heapSnapshotTimeoutMs(size(a) + size(b)) for the diff, and both calls resolve (summary with integer nodeCount, diff with an entries array); pool.close() in finally
- AC-3 | integration | `src/analyzer/snapshot-timeout-derived.ac3.integration.test.ts` | src/analyzer/index.ts#summarizeHeapSnapshot(path: string, options?: { pool?: WorkerPool; timeoutMs?: number }): Promise<HeapSnapshotSummary> on a node:v8 writeHeapSnapshot file, three cases: (1) a createHeapSnapshotPool() pool spied with vi.spyOn(pool, 'run') and options.timeoutMs set to heapSnapshotTimeoutMs(size) + 12_345 → run receives exactly that timeoutMs; (2) a createHeapSnapshotPool({ taskTimeoutMs: 1 }) pool, no options.timeoutMs → rejects with code 'ERR_WORKER_TASK_TIMEOUT' (WorkerTaskTimeoutError); (3) a hand-written WorkerPool object { size: 1, closed: false, run, close } whose run records its options argument and resolves with a valid HeapSnapshotSummary ({ nodeCount: 1, totalSelfSize: 1, top: [] }), no options.timeoutMs → the recorded options has timeoutMs === undefined; heapSnapshotTimeoutMs is imported from src/analyzer/index.ts so the test depends on the new export
