---
decision: STOP_GREEN_QUICK
iterations: 1
cap: 3
mode: quick
commit: 2e7e062dd04d152ec4400d57c8055b38ab6086d2
date: 2026-10-18
---

# LOOP — snapshot-timeout-derived

- Stages: `/pharn-spec --quick --model-approve` (agent:opus), `/pharn-plan` (agent:opus),
  `/pharn-grill --quick` (inline, policy), entry gates GREEN (all six), `/pharn-test --unattended`
  (agent:opus, `READY test-first`), then iteration 1: `/pharn-build` (agent:sonnet, `done gate:pass`),
  quick scope check (exit 0, nothing escaped), `/pharn-verify` (inline, policy) `PASS`.
- Iteration 1: verify `PASS`; scope check GREEN; `check-loop-fresh.mjs` exit 0 (FRESH);
  `check-loop.mjs` exit 0, `STOP_GREEN_QUICK`.
- Standing reds: none.
- Pointers: `GRILL.md`, `VERIFY.md`, `BUILD.md`. No `REGRESSION.md` (quick mode).
- An earlier run of this intent (`snapshot-timeout-from-size`) stopped at S14
  (`blocked: gates-red-at-entry`) on load-related test timeouts in files outside `src/analyzer`; those
  files passed alone and the full suite passed on the base tree before this run. That run's directory
  was set aside, not committed.

## Outcome

- commit: committed pharn-loop/snapshot-timeout-derived
- spec: approved by the model
- blocked: none
- ac-tests: test-first

## Not checked in quick mode

- regressions outside the feature — no base comparison ran; the scope check did;
- the plan interrogation — `/pharn-grill --quick` ran its two floor stops only;
- `RUN-REPORT.md` — not rendered; `cost.json` is.

## Handoff

### investigated

Whether the pool exposes a per-task timeout (it does: `run(payload, { timeoutMs })`), and how to tell an
explicit pool timeout from the default (a private WeakSet of pools `createHeapSnapshotPool` made without
`taskTimeoutMs`).

### learned

"20 MB/s" was read as 20 000 000 bytes per second, so the 30 s floor covers files up to 600 000 000
bytes and the default 256 MiB cap still gets 30 s. A pool built through the CJS entry and passed to the
ESM functions is not in the ESM module's WeakSet and keeps the pool default.

### next_steps

A person reviews the branch; the 20 MB/s figure is an assumption, not a measurement.
