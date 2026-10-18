---
spec_id: snapshot-timeout-derived
state: Approved
spec_content_hash: "d992de47dda2a66f588ec4b8ce47b0a0f84df4ef4d12fea17fc98c3b694d10fc"
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

A user who raises `maxSnapshotBytes` to analyze a real 1-4 GB production heap snapshot with
`summarizeHeapSnapshot` or `diffHeapSnapshots` hits `ERR_WORKER_TASK_TIMEOUT`, because the analysis
task still runs under the worker pool's fixed 30 s default timeout while the size cap they raised
(default 256 MiB) no longer bounds the parse time (review finding F27). When the caller has not
chosen a timeout, the analysis timeout should grow with the bytes to be read, so a large snapshot
that is within the caller's cap is not killed by a timeout sized for the default cap. A timeout the
caller chose explicitly must keep winning.

## Scope

**In scope:**

- An exported pure helper in `@pharn-dev/phargus/analyzer` that turns a byte count into a task
  timeout in milliseconds: `ceil(bytes / 20 MB/s)` expressed in ms with integer math, never below
  30 000 ms.
- `summarizeHeapSnapshot` derives its task timeout from the size of its one file, and
  `diffHeapSnapshots` from the sum of the sizes of its two files, using the sizes already read by the
  existing pre-read size check, and passes it as the per-task timeout the pool already supports.
- The derived timeout is used only when no explicit timeout exists: not when `options.timeoutMs` is
  set, and not when the caller's pool was made with `createHeapSnapshotPool({ taskTimeoutMs })`.
  A caller-supplied pool not made by `createHeapSnapshotPool` keeps its own configured timeout (no
  per-task override is passed to it).
- Docs: the cap/timeout pairing in `docs/LIMITS.md` and in the analyzer docs (README and/or
  `FEATURES.md`); the stale comment on `DEFAULT_MAX_SNAPSHOT_BYTES` corrected; a `CHANGELOG.md`
  entry under `## [Unreleased]` `### Fixed`.

**Out of scope (non-goals):**

- No change to `DEFAULT_MAX_SNAPSHOT_BYTES`, to the worker pool's 30 s default, or to the worker's
  parsing speed.
- No change to stack symbolization timeouts or any other analyzer task.
- No version bump, and no change under `src/agent`.

## Acceptance Criteria

- **AC-1** Given the exported snapshot-timeout helper When it is called with 0, with 268 435 456
  (256 MiB), with 600 000 000, with 600 000 001, with 1 073 741 824 (1 GiB) and with 4 294 967 296
  (4 GiB) bytes Then it returns 30 000, 30 000, 30 000, 30 001, 53 688 and 214 749 respectively,
  each an integer
  - verify: unit
- **AC-2** Given a heap snapshot file and a pool from `createHeapSnapshotPool()` made without
  `taskTimeoutMs`, whose `run` method is observed When `summarizeHeapSnapshot` is called on the file,
  and `diffHeapSnapshots` on that file and a second one, each without `options.timeoutMs` Then the
  pool's `run` receives a `timeoutMs` equal to the helper's value for the file's size in the summary
  case and for the sum of both files' sizes in the diff case, and both calls resolve with a summary
  and a diff
  - verify: integration
- **AC-3** Given an explicit timeout When `summarizeHeapSnapshot` runs with `options.timeoutMs` set on
  a caller-supplied pool, runs on a pool from `createHeapSnapshotPool({ taskTimeoutMs })` whose
  timeout is shorter than the analysis takes, and runs on a caller-supplied pool not made by
  `createHeapSnapshotPool` Then the first pool's `run` receives exactly the `options.timeoutMs`
  value, the second call rejects with code `ERR_WORKER_TASK_TIMEOUT`, and the third pool's `run`
  receives no `timeoutMs`
  - verify: integration

## Constraints

- Integer math for the derived timeout (no float drift), and the result is a positive safe integer
  the pool accepts as a per-task timeout.
- `src/agent` stays untouched; the analyzer keeps Node-core-only imports.
- Every changed file passes `npm run format:check`, `npm run lint` and `npm run typecheck`.

## Assumptions

- "20 MB/s" means 20 000 000 bytes per second, so the timeout in ms is `ceil(bytes / 20 000)`, and
  the 30 000 ms floor applies to every size up to 600 000 000 bytes.
- The helper's export name is chosen by the PLAN; the SPEC fixes only its behavior and that it is
  exported from `@pharn-dev/phargus/analyzer`.
- Inputs to the helper outside non-negative safe integers are not specified by the request; the PLAN
  decides whether to reject them, and no criterion covers them.
- The derived timeout uses the file sizes seen by the existing pre-read size check; a file that grows
  between that check and the worker's read is not re-measured.
- The project's `test` script is `vitest run`; the test stage's own preflight decides whether its
  runner gives per-test results for these criteria.
