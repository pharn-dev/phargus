---
spec_id: collector-persistence-queue
state: Approved
spec_content_hash: b1534e891eefda90f5ee1f1a8c5c822a35783021a3e2c2ead499bb1fc7ea9d96
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
---

## Intent

Review finding F25: the collector's opt-in window persistence sits on the critical path. Today
`collector.consume()` runs persistence as a stage of its `pipeline()` that waits for each window's file
append before passing the window on, so a slow disk backpressures through the pipeline to the source. In
the stdout topology (agent | collector) the agent then drops samples: the drops are counted, but the cause
is the collector's disk, not the monitored process. A user who turns persistence on must not lose live data
because the disk is slow. The pipeline should stay in-memory only, and persistence should become a consumer
of the emitted windows with its own bounded queue: when the disk falls behind, the oldest queued windows are
dropped and counted, the source is never slowed, append failures are counted and still surface, and a clean
shutdown writes everything still queued.

## Scope

**In scope:**

- Taking persistence out of the `consume()` pipeline: the pipeline keeps only in-memory stages, and every
  window it emits is handed to a persistence queue that appends windows to the store one at a time, in
  emission order, without the pipeline waiting for the disk.
- A bounded persistence queue with a configurable size, `persist.maxQueueSize` on the persistence options,
  defaulting to 1024 windows (the agent's default `queueBound`). A non-positive or non-integer value is
  rejected when the collector is created, with an error that names `maxQueueSize`.
- Overflow follows the repo's bounded-buffer convention (the agent's lanes, `src/otel/otlp-batch-queue.ts`,
  the dashboard's client queues): drop-oldest. Each dropped window increments an integer, saturating
  `dropped` counter.
- Append failures: each window whose append fails increments an integer, saturating `failed` counter, and
  the failure surfaces through `consume()`'s existing rejection path, as today: `consume()` rejects with the
  append error, without waiting for the source to end.
- `dropped` and `failed` exposed on the existing live view `collector.persistence`, the same way
  `collector.ignored` is exposed (read-only, integer).
- Drain on shutdown: `collector.close()`, and the store release at the end of `consume()`, wait until every
  window still queued has been appended (or has failed), so nothing queued is lost on a clean shutdown.
- `ARCHITECTURE.md`, `docs/LIMITS.md` and `FEATURES.md` updated wherever they describe the persistence data
  flow, and a `CHANGELOG.md` entry under `## [Unreleased]` `### Fixed` that records the behaviour change and
  the decisions below (drop-oldest, the default size, the rejection behaviour, the unbounded close wait).
- Integration tests under `src/collector/` that use temporary directories and a mocked `node:fs/promises`
  for a slow or failing disk.

**Out of scope (non-goals):**

- `consume({ signal })` cancellation (review finding F11).
- Any change to the window store's file format, restore, compaction or `0600` file mode.
- Showing `dropped` or `failed` in the dashboard, the `phargus serve` `counts:` line or the OTLP export.
- A new error-callback option for persistence failures, or a drop report beyond the counter.
- Any change to `src/agent`, the window aggregator, the alert evaluator or the alert sinks.
- A bounded (timed) wait in `close()` for a disk that never completes an append.

## Acceptance Criteria

- **AC-1** Given a collector created from the collector entrypoint with `windowMs` 1000, capacity 200 and
  persistence pointing at a file in a temporary directory with the default queue size, a mocked
  `node:fs/promises` whose first file append by the store stays pending until the test releases it (a disk
  stalled for at least 200 ms), and a subscriber that records every window When it consumes a readable
  source of agent samples spanning 100 consecutive windows Then, while that first append is still pending,
  all 100 windows reach the subscriber and `collector.windows`, in order; and after the test releases the
  append, `consume()` resolves, the file holds exactly 100 lines that parse as JSON and equal the windows in
  `collector.windows` in the same order, and `collector.persistence.dropped` and
  `collector.persistence.failed` both read 0
  - verify: integration
- **AC-2** Given a collector created from the collector entrypoint with persistence pointing at a file in a
  temporary directory with `maxQueueSize` 2, and a mocked `node:fs/promises` whose first file append stays
  pending until the test releases it When it consumes a source spanning 10 windows, and the test releases
  the append once all 10 windows are in `collector.windows` Then `consume()` resolves, the file holds at most
  3 lines, `collector.persistence.dropped` equals 10 minus the number of lines in the file and is an integer,
  the lines are windows from `collector.windows` in emission order ending with the last emitted window, and
  `collector.persistence.failed` reads 0; and when a collector is created with `maxQueueSize` 0, -1 or 1.5
  Then creation throws synchronously with a message that names `maxQueueSize`
  - verify: integration
- **AC-3** Given a collector created from the collector entrypoint with persistence pointing at a file in a
  temporary directory, and a mocked `node:fs/promises` where reading the file reports ENOENT and opening it
  for append rejects with an Error When it consumes a source that delivers samples spanning three windows
  and then stays open without ending Then `consume()` rejects with that same Error,
  `collector.persistence.failed` reads an integer of at least 1, `collector.persistence.dropped` reads 0, and
  no unhandled rejection is reported
  - verify: integration
- **AC-4** Given a collector created from the collector entrypoint with persistence pointing at a file in a
  temporary directory, a mocked `node:fs/promises` whose first file append stays pending until the test
  releases it, and a `consume()` of a source spanning 5 windows that has ended When all 5 windows are in
  `collector.windows`, the test calls `collector.close()`, and only then releases the append Then
  `close()` has not resolved before the release; after the release `close()` and `consume()` both resolve,
  the file holds exactly the 5 windows, one line each, in emission order, and
  `collector.persistence.dropped` and `collector.persistence.failed` both read 0
  - verify: integration

## Constraints

- `src/collector` uses Node core modules only; `src/agent` never imports from `src/collector`; the root
  `package.json` gains no runtime dependency.
- Stream composition uses `stream/promises` `pipeline()`, never `.pipe()`; no persistence stage remains
  inside the `consume()` pipeline.
- Appends run serially, so the order of lines on disk is the order in which windows were emitted (minus
  dropped windows).
- Memory used by persistence is bounded: at most `maxQueueSize` queued windows plus the one being appended.
- `dropped` and `failed` are integers that saturate at `Number.MAX_SAFE_INTEGER`, never floats.
- No silent failure and no unhandled rejection: every append failure is counted and reaches `consume()`'s
  rejection; a failure while no `consume()` is running still increments `failed`.
- Existing behaviour holds: a collector without persistence touches no file; the collector-persistence
  criteria (restore, skipped lines, compaction, `path` and `maxBytes` validation, a persistence path that is
  a directory rejecting `consume()`) still hold; and a `consume()` after `collector.close()` still rejects
  with an error naming the closed store and does not recreate the file.
- Node 22.18 or later, TypeScript strict mode, the dual ESM/CJS build, `npm run check:exports`, lint and
  `npm run format:check` keep passing.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these criteria, with per-test results; the
  test stage's preflight decides whether that holds. No `test:e2e` script exists, and no criterion needs one.
- The "slow store, append delayed ~200 ms" of the request is realised as a first append held pending until
  the test releases it (at least 200 ms in practice), so the test is deterministic and fast; 100 windows is
  more than the pipeline's own stream buffers can absorb, so a pipeline that waits for the disk would stall
  before the subscriber sees them all.
- A slow or failing disk is produced by mocking `node:fs/promises` (for example `open()` returning a handle
  whose `appendFile` is held, or rejecting for the append flag `'a'` while `readFile` reports ENOENT). A
  persistence path that is a directory cannot be used: `consume()` rejects from restore before any append.
- Decision on `consume()` for store failures: keep today's observable behaviour, a rejection with the append
  error that ends the run without waiting for the source, because it does not put the disk back on the
  critical path (only a failure, never a slow append, stops the pipeline). Windows already queued at that
  point are still attempted while the store is released, and each failure among them is counted.
- Drops are surfaced through the `dropped` counter only, as the agent's lanes and the dashboard's
  `droppedEvents` do; no warning is emitted per drop.
- `close()` has no time bound today for the store, so draining the queue adds none: a disk that never
  completes an append stalls `close()`, and the CHANGELOG entry says so.
- Restored windows are not re-appended to the file, as today.
- `maxQueueSize` must be a positive safe integer; any other value, including a non-number, is rejected the
  same way.
- The PLAN decides whether the queue lives per collector or per `consume()` run and how windows reach it
  (for example through the existing subscriber mechanism), as long as appends stay serial across runs.
