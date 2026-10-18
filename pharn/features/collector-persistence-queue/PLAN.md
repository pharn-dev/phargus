---
spec_id: collector-persistence-queue
spec_content_hash: b1534e891eefda90f5ee1f1a8c5c822a35783021a3e2c2ead499bb1fc7ea9d96
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `collector-persistence-queue` (review finding F25,
> persistence on the critical path). Everything below was read live this run.

Discovery (live, this run):

- `src/collector/collector.ts` `consume()` builds `pipeline(source, guard, spanRouter, aggregator, recordWindows,
  persistWindows, createAlertEvaluator(rules), <alert consumer>)`. `persistWindows` is a Transform whose callback
  runs only after `store.append(window)` settles, so a slow append backpressures to the source, and a failed append
  fails the pipeline with the append error. After the pipeline, `consume()` awaits `dispatcher.settle()`, then
  `store.release()`, and rethrows the first failure (an `AggregateError` when the release also fails).
  `collector.persistence` is the `WindowStore` object itself. `close()` awaits `dispatcher.close()`, then
  `store.close()` (which latches the store: a later `append()` rejects with
  "window store <path> is closed; the window was not persisted").
- `src/collector/window-store.ts` serialises every operation on one promise chain (`enqueue`), opens the file lazily
  with `open(path, 'a', 0o600)` and writes with `handle.appendFile(line)`; `restore()` reads with `readFile` and
  treats ENOENT as empty. It validates `path` and `maxBytes` with `TypeError`/`RangeError` messages that name the
  option (`persist.maxBytes must be a positive safe integer`). `PersistOptions` is `{ path; maxBytes }`.
- `src/collector/ring-buffer.ts` pre-allocates `capacity` slots and has no "take oldest", so it does not fit a
  queue whose bound can be any positive safe integer. `src/otel/otlp-pending-items.ts` is the repo's lazily growing
  drop-oldest FIFO, but `src/otel` is a sibling module, so the collector gets its own small queue.
- The default bound, 1024, is the agent's default `queueBound` (`src/agent/config-schema.ts`).
- No other module reads `collector.persistence` (grep over `src/`); `phargus serve` does not use persistence.
- Existing tests that touch persistence and must keep passing unchanged: `collector-persistence.ac1/ac2/ac3`
  (append, restore, compaction, validation, a directory path rejecting from restore) and
  `collector-bounds.integration.test.ts` ("a consume() after collector.close() does not recreate the persistence
  file", file modes).

Strategy: persistence leaves the pipeline and becomes a per-collector consumer of the emitted windows.

1. A new `src/collector/persist-queue.ts` holds a bounded drop-oldest FIFO of windows and one serial drain loop that
   hands the oldest window to an `append` function, awaits it, then takes the next. It never throws from `push()`,
   never lets the pipeline wait, counts drops and failures as saturating integers, and tells its current failure
   listeners about each failed append.
2. `consume()` keeps only in-memory stages: `recordWindows` pushes each window into `windows`, hands it to the
   queue with a synchronous `push()`, emits it to subscribers and passes it on to the alert evaluator. The
   `persistWindows` Transform is deleted.
3. A failed append reaches the running `consume()` through the queue's failure listener, which destroys the run's
   `recordWindows` stream with that same Error, so `pipeline()` rejects with it without waiting for the source.
4. `consume()` (before releasing the store) and `close()` (before latching it) wait for the queue to drain.

The queue lives per collector (one bound, one drain loop), so appends stay serial across concurrent and successive
runs, and lines on disk follow emission order minus the dropped windows.

## Applied lessons

- none — `check-lessons-index.mjs --verdict` printed `NO_CANON`: the project has no `memory-bank/lessons-learned.md`
  yet, so there are no promoted lessons to apply.

## Steps

- **`src/collector/persist-queue.ts` (new).** Export `DEFAULT_PERSIST_QUEUE_SIZE = 1024`, a `PersistQueue` type and
  `createPersistQueue(options: { append(window: AggregatedWindow): Promise<void>; maxQueueSize: unknown })`.
  - Validate `maxQueueSize` first: `Number.isSafeInteger(value) && value > 0`, else throw
    `RangeError('persist.maxQueueSize must be a positive safe integer')` (same wording style as `maxBytes`). The
    caller resolves the default, so this function sees `undefined` only as an invalid value.
  - FIFO: an array plus a head index (no `Array.prototype.shift` per item, no up-front allocation of
    `maxQueueSize` slots). `push` appends; when `size === maxQueueSize` it first evicts the oldest item and
    increments `dropped`. `take` removes the oldest. Compact the backing array when the head passes half of it, so
    memory stays within `maxQueueSize` live items plus slack.
  - Drain loop: an `async function drain()` that runs `while (size > 0) { const window = take(); try { await
    append(window); } catch (error) { fail(toError(error)); } }`, then clears `running` and resolves every
    `drained()` waiter. `push()` starts it synchronously when not running (`running = true; drain()...`), so the
    first window is handed to `append` inside the same `push()` call: the window in flight is outside the FIFO,
    which keeps memory at `maxQueueSize` queued plus the one being appended, and makes the AC-2 count
    deterministic (window 1 in flight, the newest two queued). The loop's own promise cannot reject (every await is
    inside `try`/`catch`); attach a `.catch` that routes an impossible rejection to `fail` anyway, so nothing is
    floating or swallowed.
  - `fail(error)`: `failed` saturating increment (`>= Number.MAX_SAFE_INTEGER ? MAX : +1`), then call every
    registered failure listener with the Error (a copied listener list, each call in `try`/`catch` that reports a
    throwing listener with `process.emitWarning`, mirroring `collector-subscribers.ts`). With no listener the
    failure is still counted.
  - `onFailure(listener): () => void` registers and returns an unsubscribe.
  - `drained(): Promise<void>` resolves when the FIFO is empty and no append is in flight (immediately when idle);
    it never rejects.
  - Getters `dropped` and `failed` (integers).
- **`src/collector/window-store.ts`.** Extend `PersistOptions` with an optional `maxQueueSize?: number`, documented as
  "most windows waiting for the disk; when full the oldest is dropped and counted (default 1024). Used by the
  collector's persistence queue; the store itself ignores it." No behaviour change to the store, its file format,
  restore, compaction or file mode.
- **`src/collector/collector.ts`.**
  - `WindowPersistence` gains `readonly dropped: number` and `readonly failed: number`, with doc comments (windows
    dropped from a full persistence queue; windows whose append failed; both integers, saturating).
  - In `createCollector`, after `createWindowStore(...)` succeeds (so `path`/`maxBytes` errors keep their current
    precedence), build the queue synchronously:
    `createPersistQueue({ append: (window) => store.append(window), maxQueueSize:
    options.persist.maxQueueSize === undefined ? DEFAULT_PERSIST_QUEUE_SIZE : options.persist.maxQueueSize })`.
    Only `undefined` means "default": `null`, a string or any non-integer reaches the validator and throws a
    `RangeError` naming `maxQueueSize` at creation.
  - Replace `persistence: store` with a view object built once (or `undefined` without persistence) whose getters
    read `path`, `maxBytes`, `skipped`, `restored`, `bytes` from the store and `dropped`, `failed` from the queue,
    read-only like `ignored`.
  - In `consume()`: delete `persistWindows`; in `recordWindows.transform` call `queue?.push(window)` right after
    `windows.push(window)` (before `subscribers.emitWindow`), never awaiting it. Before `pipeline()`, register
    `queue?.onFailure((error) => { if (!runFailed) { runFailed = true; runError = error; } recordWindows.destroy(error); })`
    — destroying a stream of the pipeline with the Error makes `pipeline()` reject with that same Error and
    destroys the source, without waiting for it to end. After the `try/catch` around `restoreOnce()` +
    `pipeline()`: `await dispatcher.settle()`, then `await queue.drained()` (windows still queued are attempted,
    each failure counted), then unsubscribe the listener (in a `finally`), then, if the pipeline did not fail but
    `runFailed` is set (a failure that arrived after the source had ended), take `runError` as the run's failure.
    Then `store.release()` and the existing rethrow / `AggregateError` logic, unchanged.
  - `close()`: `await dispatcher.close()`, then `await queue?.drained()`, then `await store?.close()`. No timeout:
    a disk that never completes an append stalls `close()` (SPEC non-goal; CHANGELOG says so).
  - A `consume()` after `close()` still rejects naming the closed store: its first window reaches `store.append`,
    which rejects with the "closed" Error before opening the file; the queue counts it in `failed` and the listener
    fails the run with it.
- **`ARCHITECTURE.md`.** In the in-process diagram, change the collector line to an in-memory pipeline
  (`samples → windows → alerts → sinks`) and add a branch `windows ─▶ persistence queue (opt-in, bounded,
  drop-oldest) → append-only file`. In "Data flow, step by step" step 3, replace "windows go to an optional
  append-only file and to the alert evaluator" with: windows go to the alert evaluator and, when persistence is on,
  into a bounded queue (`persist.maxQueueSize`, default 1024) appended to the file one at a time in emission order;
  a slow disk drops the oldest queued windows (counted in `collector.persistence.dropped`) instead of slowing the
  pipeline; a failed append is counted in `failed` and rejects `consume()`; `close()` and the end of `consume()`
  wait for the queue to drain. Extend the "Backpressure is honored end to end" bullet with the collector's
  persistence queue.
- **`docs/LIMITS.md` §2.** In "Data is dropped, not queued without limit", add the collector's persistence queue:
  it holds `persist.maxQueueSize` windows (default 1024) and drops the oldest when the disk falls behind, counted in
  `collector.persistence.dropped`, not shown by the dashboard or `phargus serve` yet; and note that `close()` waits
  for queued appends with no time limit.
- **`FEATURES.md` §9.** Extend the persistence bullet: written off the critical path through a bounded drop-oldest
  queue (`maxQueueSize`, default 1024) with `dropped`/`failed` counters on `collector.persistence`, drained on
  `close()`.
- **`CHANGELOG.md`.** Under `## [Unreleased]` → `### Fixed`, one entry (review finding F25): persistence no longer
  backpressures `consume()`; windows go through a bounded queue (`persist.maxQueueSize`, default 1024, a positive
  safe integer, else creation throws); drop-oldest when full; `collector.persistence.dropped` and `.failed`
  (integer counters); an append failure still rejects `consume()` with the append error without waiting for the
  source; `close()` and the end of `consume()` drain the queue, with no time bound, so a disk that never completes an
  append stalls `close()`.
- Run `npx prettier --write` on each edited file, one by one, then `npm run typecheck`, `npm run lint`,
  `npm test`, `npm run build`, `npm run check:exports`, `npm run format:check`.

## Files

- `src/collector/persist-queue.ts` — new: the bounded drop-oldest persistence queue (validation of `maxQueueSize`,
  serial drain loop, `dropped`/`failed` counters, failure listeners, `drained()`)
- `src/collector/collector.ts` — persistence removed from the `consume()` pipeline; windows handed to the queue;
  failure listener per run; drain before `release()` and `close()`; `WindowPersistence` gains `dropped` and `failed`;
  `persistence` becomes a live view over store and queue
- `src/collector/window-store.ts` — `PersistOptions` gains the optional, documented `maxQueueSize` (type only; the
  store ignores it)
- `ARCHITECTURE.md` — diagram and data-flow step 3 describe the persistence queue off the pipeline; backpressure
  bullet
- `docs/LIMITS.md` — §2 drop bullet covers the persistence queue and the unbounded `close()` wait
- `FEATURES.md` — §9 persistence bullet mentions the queue, its default and counters
- `CHANGELOG.md` — `## [Unreleased]` `### Fixed` entry for F25 and its decisions

### Explicitly not touched

- `src/collector/index.ts` — already re-exports `WindowPersistence` and `PersistOptions`, whose new fields flow
  through; the queue stays internal
- `src/collector/ring-buffer.ts`, `src/collector/collector-subscribers.ts`, `src/collector/window-codec.ts` — reused
  unchanged
- `src/otel/otlp-pending-items.ts` — sibling module, not imported
- `src/agent/` — out of scope (SPEC non-goal)
- `src/dashboard/`, `src/cli/` — showing `dropped`/`failed` is a SPEC non-goal
- `docs/THREAT-MODEL.md`, `README.md` — do not describe the persistence data flow at this level
- `src/collector/collector-persistence.ac1.integration.test.ts`, `src/collector/collector-persistence.ac2.integration.test.ts`,
  `src/collector/collector-persistence.ac3.integration.test.ts`, `src/collector/collector-bounds.integration.test.ts` —
  existing tests that must keep passing unchanged
- `vitest.config.ts`, `package.json`, `package-lock.json` — no test-infrastructure or dependency change

## Acceptance mapping

- AC-1 (slow first append; 100 windows reach the subscriber and `collector.windows` while it is pending; file holds
  exactly the 100 windows after release; counters 0) → the pipeline no longer has a persistence stage, and
  `recordWindows` hands windows to the queue with a non-awaiting `push()`; with the default bound 1024 nothing is
  dropped; the serial drain loop appends in emission order; `consume()` resolves only after `drained()`.
- AC-2 (`maxQueueSize` 2, held first append, 10 windows; at most 3 lines, `dropped` = 10 − lines, lines in emission
  order ending with the last window; invalid sizes throw naming `maxQueueSize`) → window 1 is taken synchronously by
  `push()` into the in-flight append; windows 2–10 cycle through a 2-slot drop-oldest FIFO, leaving 9 and 10 and
  `dropped` 7; validation in `createPersistQueue` called synchronously from `createCollector` with the message
  `persist.maxQueueSize must be a positive safe integer`.
- AC-3 (ENOENT restore, `open` for append rejects, a source that never ends; `consume()` rejects with that same
  Error, `failed` ≥ 1, `dropped` 0, no unhandled rejection) → the queue catches the append rejection, counts it and
  calls the run's listener, which destroys `recordWindows` with that Error so `pipeline()` rejects with it and
  destroys the source; the drain attempts the windows already queued (each failure counted); every promise is
  handled inside the queue.
- AC-4 (held first append, ended 5-window source, `close()` called before release; `close()` waits; both resolve
  after release; file holds the 5 windows in order; counters 0) → `close()` awaits `queue.drained()` before
  `store.close()` latches the store, and `consume()` awaits the same drain before `store.release()`.
- Constraints: Node core only, `pipeline()` only, no persistence stage in the pipeline, serial appends, bounded
  memory, saturating integer counters, failures counted and surfaced, the closed-store rejection and existing
  persistence tests unchanged → the steps above; the full gate list runs at the end.

## Risks & open questions

- A failed append is reported to every `consume()` run active at that moment, so with two concurrent runs over one
  collector, one run's window failure also fails the other. They share the store, so this is the closest match to
  today's behaviour; flagged for review, not a SPEC requirement.
- A failure with no `consume()` running (possible only when a run stops listening while another run's window is
  still in flight) is counted in `failed` and nothing else, as the SPEC's constraint states; there is no warning per
  failure (the SPEC rules out a new error callback).
- `close()` drains with no time bound: a disk that never completes an append stalls `close()` and `phargus`'s callers
  (SPEC non-goal; documented in CHANGELOG and LIMITS).
- Windows a running `consume()` emits while `close()` is draining are still accepted and appended before the store
  latches; windows emitted after the latch fail with the "closed" Error, as today.
- AC-2's exact count depends on the first window being handed to `append` inside `push()`; the plan makes that
  synchronous on purpose. The SPEC's "at most 3 lines" tolerates fewer.
- The AC tests mock `node:fs/promises` (`vi.mock` with the real module behind it); `window-store.ts` keeps its named
  imports from `node:fs/promises`, which that mock replaces. No test-infrastructure change is planned.
