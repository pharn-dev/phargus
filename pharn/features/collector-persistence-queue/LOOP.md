---
decision: STOP_GREEN
iterations: 1
cap: 3
commit: 67709097bb271430342c2a16236584e18c2eb715
date: 2026-10-18
---

# LOOP — collector-persistence-queue

- Stages that ran, in order: `/pharn-spec --model-approve` (agent:opus), `/pharn-plan` (agent:opus), `/pharn-grill
  --floor-only` (inline by policy; chain GREEN, lessons GREEN, scans: no findings), entry gates (green), `/pharn-test`
  (agent:opus; 4 AC tests, each red before the build), then iteration 1: `/pharn-build` (agent:sonnet, `done
  gate:pass`), `/pharn-regress` (inline by policy), `/pharn-verify` (inline by policy).
- Iteration 1: regress `no-regressions`, verify `PASS`; `check-loop-fresh.mjs` FRESH; `check-loop.mjs` exit 0,
  `decision: STOP_GREEN`.
- No standing reds.
- Pointers: `GRILL.md`, `BUILD.md`, `REGRESSION.md`, `VERIFY.md` in this directory.
- An earlier run of this intent (same slug, base `2e7e062`) stopped blocked at the entry gates (S14) on test
  timeouts under machine load in `src/release/publish-workflow.ac3.integration.test.ts` and
  `src/plugin-runner/plugin-runner-sandbox.ac2.integration.test.ts`. Its artifacts were set aside, not committed; this
  run started from `origin/main` at `6770909`, which carries the timeout fix (#84).

## Outcome

- commit: committed pharn-loop/collector-persistence-queue
- spec: approved by the model
- blocked: none
- ac-tests: test-first

## Handoff

### investigated

A persistence path that is a directory fails in `store.restore()` (EISDIR) before any append, so it cannot exercise
the append-failure path; the AC tests mock `node:fs/promises` instead.

### learned

Persistence is now a queue subscriber (`src/collector/persist-queue.ts`): bounded drop-oldest, serial appends, and
saturating `dropped` / `failed` counters on `collector.persistence`. A failed append destroys the running pipeline
with that error. `close()` drains the queue before latching the store, but it does not stop the queue from accepting
new windows while it drains.

### next_steps

Review the branch. One follow-up to consider: latch the queue at the start of `close()`, so that a still-running
`consume()` with a fast source cannot keep the drain from ever finishing.
