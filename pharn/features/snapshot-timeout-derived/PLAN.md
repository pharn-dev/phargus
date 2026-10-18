---
spec_id: snapshot-timeout-derived
spec_content_hash: d992de47dda2a66f588ec4b8ce47b0a0f84df4ef4d12fea17fc98c3b694d10fc
applied_lessons: none
---

## Approach

> ADVISORY: model-written plan derived from the Approved SPEC. Nothing in this body is floor-checked except the
> shape of the frontmatter and the `## Files` writes-scope.

Add one pure, exported helper, `heapSnapshotTimeoutMs(bytes: number): number`, in a new file
`src/analyzer/heap-snapshot-timeout.ts`, re-exported from `src/analyzer/index.ts` (so it is part of
`@pharn-dev/phargus/analyzer` in both the ESM and CJS builds through the existing `./analyzer` subpath). It
computes `ceil(bytes / 20 000)` with integer math only and never returns less than 30 000:

```ts
const rem = bytes % BYTES_PER_MS; // BYTES_PER_MS = 20_000 (20 000 000 B/s)
const ms = (bytes - rem) / BYTES_PER_MS + (rem === 0 ? 0 : 1);
return Math.max(MIN_SNAPSHOT_TIMEOUT_MS, ms); // MIN_SNAPSHOT_TIMEOUT_MS = 30_000
```

`bytes - rem` is an exact multiple of 20 000, so the division is exact for every safe integer (no float rounding
in the ceiling). Input outside non-negative safe integers (negative, fractional, `NaN`, `Infinity`, over
`Number.MAX_SAFE_INTEGER`, non-number) throws a `RangeError('bytes must be a non-negative safe integer')`, the
same style as `checkMaxBytes`/`checkTop` (the SPEC leaves this to the PLAN; no criterion covers it). The largest
possible result (`ceil((2^53 - 1) / 20 000)`, about 4.5e11) is a positive safe integer, which the pool's
`positiveSafeInteger` accepts as a per-task `timeoutMs`.

In `src/analyzer/heap-snapshot.ts`:

1. `checkSize` returns the `stats.size` it already reads (instead of `void`), so the derived timeout uses exactly
   the sizes the existing pre-read check saw (SPEC Assumptions).
2. A module-private `WeakSet<WorkerPool>` records each pool `createHeapSnapshotPool` made **without**
   `taskTimeoutMs`. A pool made with `taskTimeoutMs` is not recorded, and a hand-written or `createWorkerPool` pool
   is never recorded. The set holds pools weakly, so a closed and dropped pool is not retained.
3. `runTask(payload, options, bytes)` chooses the per-task options:
   - `options.timeoutMs !== undefined` → `{ timeoutMs: options.timeoutMs }` (unchanged; explicit wins).
   - otherwise, if the pool in use (the caller's `options.pool`, or the one `runTask` makes with
     `createHeapSnapshotPool()` when none is given, which is therefore recorded) is in the set →
     `{ timeoutMs: heapSnapshotTimeoutMs(bytes) }`.
   - otherwise → `{}` (the pool keeps its own configured timeout; no per-task override).
4. `summarizeHeapSnapshot` passes its one file's size; `diffHeapSnapshots` passes
   `Math.min(beforeSize + afterSize, Number.MAX_SAFE_INTEGER)` (each size is at most `maxBytes`, a safe integer,
   but two of them can sum past the safe range only with a cap in the petabytes; the clamp keeps the helper's
   input valid instead of turning such a call into a new `RangeError`).
5. Correct the stale comment on `DEFAULT_MAX_SNAPSHOT_BYTES`: the cap and the timeout are now paired (a file at
   the default cap gets the 30 s floor; raising the cap raises the derived timeout at 20 MB/s, about 54 s for
   1 GiB and 215 s for 4 GiB), instead of claiming a file at the cap "stays well within the default 30 s task
   timeout" with a parse-speed figure the code does not measure. Add a JSDoc line to `AnalysisOptions.timeoutMs`
   saying when the derived timeout applies and that an explicit value always wins.

The worker pool, its 30 s default, `DEFAULT_MAX_SNAPSHOT_BYTES`, the heap-snapshot worker and stack symbolization
are not changed (SPEC non-goals). Nothing under `src/agent` changes, and the new file imports nothing.

## Applied lessons

- none — the project has no `memory-bank/lessons-learned.md` yet (`check-lessons-index.mjs --verdict` printed
  `NO_CANON`), so there is no canon to sweep.

## Steps

- Create `src/analyzer/heap-snapshot-timeout.ts` with `heapSnapshotTimeoutMs` and its two named constants
  (`20_000` bytes per ms and the `30_000` ms floor), each with a one-line comment; validate input and compute
  with the integer ceiling shown above.
- Export `heapSnapshotTimeoutMs` from `src/analyzer/index.ts` next to the other heap-snapshot exports.
- In `src/analyzer/heap-snapshot.ts`: make `checkSize` return the size; add the module-private `WeakSet` and
  register pools in `createHeapSnapshotPool` when `options.taskTimeoutMs === undefined`; give `runTask` the
  byte count and the three-way timeout choice; pass the summary's size and the diff's clamped sum; fix the
  `DEFAULT_MAX_SNAPSHOT_BYTES` comment and document `timeoutMs` on `AnalysisOptions`.
- `docs/LIMITS.md` §3, the "Heap-snapshot analysis has caps" item: add the cap/timeout pairing (unless
  `timeoutMs` is passed or the pool was made with `taskTimeoutMs`, the analysis timeout is
  `max(30 s, size / 20 MB/s)`, summed over both files for a diff; a pool not made by `createHeapSnapshotPool`
  keeps its own timeout; a file that grows after the size check is not re-measured).
- `FEATURES.md`: extend the "Heap-snapshot summaries and diffing ... with an input size cap" item to say the
  task timeout scales with the snapshot size unless the caller sets one (README's table row stays as is; it has
  no per-option detail).
- `CHANGELOG.md`: add a `### Fixed` entry under `## [Unreleased]` (review finding F27): `summarizeHeapSnapshot`
  and `diffHeapSnapshots` no longer time out on large snapshots within a raised `maxSnapshotBytes`; the new
  `heapSnapshotTimeoutMs` export; when the derived timeout applies and when it does not.
- Run `npx prettier --write` on each edited file by name, then `npm run format:check`, `npm run lint`,
  `npm run typecheck` and `npm test`.

## Files

- `src/analyzer/heap-snapshot-timeout.ts` — new: the pure `heapSnapshotTimeoutMs(bytes)` helper and its constants
- `src/analyzer/index.ts` — re-export `heapSnapshotTimeoutMs`
- `src/analyzer/heap-snapshot.ts` — `checkSize` returns the size; pool registry; derived per-task timeout in `runTask`; corrected `DEFAULT_MAX_SNAPSHOT_BYTES` comment; `timeoutMs` JSDoc
- `docs/LIMITS.md` — the cap/timeout pairing in the heap-snapshot caps item
- `FEATURES.md` — the analyzer heap-snapshot item mentions the size-derived timeout
- `CHANGELOG.md` — `## [Unreleased]` `### Fixed` entry for F27

### Explicitly not touched

- `src/analyzer/worker-pool.ts` — the pool's 30 s default and its per-task `timeoutMs` support are reused as is
- `src/analyzer/workers/heap-snapshot.worker.ts` — parsing speed and protocol unchanged
- `src/analyzer/stack-symbolization.ts` — symbolization timeouts are out of scope
- `src/analyzer/heap-snapshot-error.ts` — the size-cap error is unchanged
- `src/agent/` — out of scope; no file there changes
- `package.json` — no version bump, no new dependency
- `README.md` — its analyzer row has no option-level detail to update

## Acceptance mapping

- AC-1 → `heapSnapshotTimeoutMs` from `@pharn-dev/phargus/analyzer` (`src/analyzer/index.ts`) returns
  `max(30 000, ceil(bytes / 20 000))` by integer ceiling: 0 → 30 000; 268 435 456 → 13 422 → 30 000;
  600 000 000 → exactly 30 000; 600 000 001 → 30 001; 1 073 741 824 → 53 688; 4 294 967 296 → 214 749; every
  result is an integer.
- AC-2 → a `createHeapSnapshotPool()` pool (no `taskTimeoutMs`) is registered, so with no `options.timeoutMs`
  `runTask` calls `pool.run(payload, { timeoutMs: heapSnapshotTimeoutMs(size) })` for a summary and with the
  sum of both `checkSize` results for a diff; the real worker then returns a summary and a diff.
- AC-3 → `options.timeoutMs` is checked first and passed through unchanged; a pool made with
  `createHeapSnapshotPool({ taskTimeoutMs })` is not registered, so no override is sent and the pool's own short
  timeout fires (`ERR_WORKER_TASK_TIMEOUT`); a caller pool not made by `createHeapSnapshotPool` is never
  registered, so `run` gets `{}` (no `timeoutMs`).

## Risks & open questions

- **Pool identity is by object.** The registry is a `WeakSet` keyed on the pool object. A test (or user) that
  observes `run` with `vi.spyOn(pool, 'run')` keeps the identity; one that wraps the pool in a new object (`{
  ...pool, run }`) makes a pool the registry does not know, which then keeps the 30 s default. `/pharn-test`
  should spy on the pool object itself (the AC-TESTS mapping says so).
- **Dual-package hazard (advisory).** The ESM and CJS builds are separate module instances with separate
  registries. A pool made by `require('@pharn-dev/phargus/analyzer').createHeapSnapshotPool()` and passed to the
  ESM `summarizeHeapSnapshot` is not recognised and keeps the pool's 30 s default: the behaviour before this
  fix, never a shorter timeout. A `Symbol.for(...)` marker on the pool would cross that boundary; the plan picks
  the `WeakSet` because it adds nothing visible to the pool object. Flag for `/pharn-grill`.
- **AC-3 guards behaviour that already holds today.** Before the build, an explicit `timeoutMs` is already
  passed through, a `taskTimeoutMs` pool already times out and a foreign pool already gets `{}`. For the red run,
  `/pharn-test` must make the AC-3 test depend on the new behaviour or export (for example by computing the
  explicit and the pool timeouts from `heapSnapshotTimeoutMs` so they differ from the derived value), or the AC-3
  test will not fail before the build.
- **AC-2 sees the 30 s floor in practice.** A test-process snapshot is far below 600 000 000 bytes, so the
  expected `timeoutMs` is 30 000 for both calls. The test still fails before the build, because `run` receives
  `{}` today.
- The AC-3 `taskTimeoutMs` case relies on a real parse taking longer than the short pool timeout; a timeout of a
  few milliseconds on a real snapshot keeps that deterministic in practice, but it is timing-based.
