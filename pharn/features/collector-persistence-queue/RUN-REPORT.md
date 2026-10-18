# RUN REPORT — collector-persistence-queue

Every line below is derived by `pharn/floor/render-run-report.mjs` from artifacts this run already
produced. No line is authored by a model.

**Trust split (P2).** The values this report reads from deterministic tool output — verdicts, exit
codes, token counts, paths — are the enum-gated / floor-verifiable class. Everything shown inside a
fenced block is **free text that inherits its source's untrusted tag** and is rendered as DATA:
quoted for a person to read, never executed, and never an instruction to any later stage.

**This report ANNOTATES a run and gates nothing.** No proceed/stop anywhere reads it. It is not a
judgment that the change is good, correct, or worth its cost.

## Outcome

The `decision` below is copied verbatim from `LOOP.md`'s frontmatter by the ledger; this report
introduces no second source of truth for it.

```text
decision         STOP_GREEN
iterations       1
blocked          none
base             67709097bb271430342c2a16236584e18c2eb715
command          /pharn-loop
skills_version   6.55.0
ledger coverage  partial
run membership   bounded
```

## Tokens — stage x iteration x model

**Measured population: the RUN'S OWN CONTEXTS inside its window** (`run-window/2`) — only requests of the
selected session that fall inside the window below AND come from the context that printed the run's
markers or an agent that context tree spawned during the run. Earlier and later activity in that session,
and other contexts working inside the window (a concurrent run, its agents, the main thread), are excluded
and counted, never summed. This is NOT a feature's lifetime cost, other sessions' requests are not
collected, and the request that opened the window falls just before it. A floor on this run's spend,
never the total.

```text
status             bounded
method             run-window/2
window start       2026-10-18T13:00:09.211Z
window end         2026-10-18T13:25:14.538Z
selected session   ea997e0b-c47c-4484-a962-328114b9e355
run context        agent:aae8512ddb06c8ab7
run contexts       agent:a9a68bdc378733249, agent:aadddfb1501628fcf, agent:aae8512ddb06c8ab7, agent:ac120dae9e98a71b2, agent:ad4ac7967e980bdc0
excluded requests  1411
```

Copied from `cost.json`'s stored views, never recomputed here — `check-cost-ledger.mjs` already
holds those views to a recompute from `requests[]`, so this is one number with one owner.

**TOKENS ONLY.** There is no price table here or in `cost.json`; money is the reader's own
multiplication against their own list, and `output_thinking` is a SUBSET of `output`, not a seventh
class. `unattributed` is an honest STAGE bucket — run requests before the first stage marker — never
folded into a neighbouring stage.

```text
stage           iter  model              reqs  input  cache_write_5m  cache_write_1h  cache_read  output  output_thinking
--------------  ----  -----------------  ----  -----  --------------  --------------  ----------  ------  ---------------
(unattributed)  -     claude-opus-5-5      10     20           13479               0     2208121     120                0
pharn-build     1     claude-opus-5-5       2      4            2589               0      437102      32                0
pharn-build     1     claude-sonnet-5-5    23     46           89280               0     2529194    9520              615
pharn-grill     -     claude-opus-5-5       1      2            1724               0      212397      16                0
pharn-plan      -     claude-opus-5-5      29     58          292344               0     3456222   11481             2786
pharn-spec      -     claude-opus-5-5      29     58          282361               0     3256022    4117               41
pharn-test      -     claude-opus-5-5      30     60          280015               0     3337436   12860              386
pharn-verify    1     claude-opus-5-5       1      2             373               0      221426      16                0
TOTAL           -     -                   125    250          962165               0    15657920   38162             3828
unattributed    -     -                    10     20           13479               0     2208121     120                0
```

## Stage elapsed and deterministic work

**Observed elapsed** is wall-clock time between two PHARN markers — the stage's start and the orchestrator's
return — read by two different processes. It is NOT CPU time, model time or tool time, it is not monotonic, and
it includes orchestration, subprocesses, waiting and any answer a human gave inside the stage. An `unmeasured`
row names why no interval could be paired, and is never a zero. **Deterministic work** is counted from each
`/pharn-regress` and `/pharn-verify` execution's own gate-run stamp at its `done` exit; an execution that ended any
other way recorded none. Nothing here is subtracted from anything else.

```text
observed elapsed — wall clock between PHARN's stage markers (not CPU, model or tool time; not monotonic)
  stage              iter  run  elapsed
  pharn-spec            -    1  367.3 s
  pharn-plan            -    1  402.7 s
  pharn-grill           -    1  13.4 s
  pharn-test            -    1  360.2 s
  pharn-build           1    1  195.3 s
  pharn-regress         1    1  24.7 s
  pharn-verify          1    1  49.8 s

deterministic work — gate processes run vs taken from reused evidence (counted from each stage's gate-run stamp)
  pharn-regress iter 1 run 1: HEAD gates 3 run, 0 reused, 0 nothing-to-run, of 3; BASE from the entry gates (no worktree, no install, 0 base gate processes; 3 results from this run's entry check)
  pharn-verify iter 1 run 1: gates 5 run, 2 reused, 0 nothing-to-run, of 7
```

## Entry gates (background)

The **entry check** runs the project's gates in a background process while the spec, plan and grill stages work.
Its **lifetime** runs from `--start` to the record of the process that ended it: wall clock across processes,
placement only, not CPU or gate time. A **segment** is one runner or takeover process, timed on its own monotonic
clock. A **wait call** is the foreground time one `--wait` line took, and a takeover runs inside it and is never
added to it. Totals are interval unions, never sums. `INCOMPLETE` means no end was recorded before the run-stop
marker, and it is never a zero.

```text
entry gates — the background check, observed apart from the stage rows (never added to them)
  invocation 240bc58a: start started (call 488 ms); lifetime 131.5 s (wall clock, start to the runner end record; placement, not CPU or gate time)
    runner 8d8e65: 131.0 s monotonic, 6 gate(s), ended done
    execution union: 131.0 s
    of it inside measured stage rows (wall-clock placement only — not proof both were active, not a saving): 124.3 s
    wait calls: 1 (41 ms green); union 41 ms foreground
    abort: nothing running
```

## Files

Changed since `67709097bb271430342c2a16236584e18c2eb715`, plus untracked files. **This is a changed-since-base observation, not a
record of what the build wrote** — a path can appear here because another stage, a generator, or a
person touched it. A `not named in PLAN ## Files` marker is therefore not a scope violation; the
scope question is `check-bash-reconcile.mjs`'s and this report never answers it.

The tree was clean before the run, so no path below is marked `dirty-before-run`.

Rendered after `cost.json` was written and before any commit this run may make, so `cost.json`
appears below and this report itself does not.

- `ARCHITECTURE.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `ARCHITECTURE.md` — diagram and data-flow step 3 describe the persistence queue off the pipeline; backpressure
  ```

- `CHANGELOG.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `CHANGELOG.md` — `## [Unreleased]` `### Fixed` entry for F25 and its decisions
  ```

- `FEATURES.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `FEATURES.md` — §9 persistence bullet mentions the queue, its default and counters
  ```

- `docs/LIMITS.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `docs/LIMITS.md` — §2 drop bullet covers the persistence queue and the unbounded `close()` wait
  ```

- `src/collector/collector.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/collector/collector.ts` — persistence removed from the `consume()` pipeline; windows handed to the queue;
  ```

- `src/collector/window-store.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/collector/window-store.ts` — `PersistOptions` gains the optional, documented `maxQueueSize` (type only; the
  ```

- `pharn/features/collector-persistence-queue/AC-TESTS.lock.json` — _not named in PLAN ## Files_
- `pharn/features/collector-persistence-queue/AC-TESTS.md` — _not named in PLAN ## Files_
- `pharn/features/collector-persistence-queue/BUILD.md` — _not named in PLAN ## Files_
- `pharn/features/collector-persistence-queue/GRILL.md` — _not named in PLAN ## Files_
- `pharn/features/collector-persistence-queue/LOOP.md` — _not named in PLAN ## Files_
- `pharn/features/collector-persistence-queue/PLAN.md` — _not named in PLAN ## Files_
- `pharn/features/collector-persistence-queue/REGRESSION.md` — _not named in PLAN ## Files_
- `pharn/features/collector-persistence-queue/SPEC.md` — _not named in PLAN ## Files_
- `pharn/features/collector-persistence-queue/VERIFY.md` — _not named in PLAN ## Files_
- `pharn/features/collector-persistence-queue/cost.json` — _not named in PLAN ## Files_
- `pharn/features/collector-persistence-queue/regression-report.json` — _not named in PLAN ## Files_
- `pharn/features/collector-persistence-queue/verify-report.json` — _not named in PLAN ## Files_
- `src/collector/collector-persistence-queue.ac1.integration.test.ts` — _not named in PLAN ## Files_
- `src/collector/collector-persistence-queue.ac2.integration.test.ts` — _not named in PLAN ## Files_
- `src/collector/collector-persistence-queue.ac3.integration.test.ts` — _not named in PLAN ## Files_
- `src/collector/collector-persistence-queue.ac4.integration.test.ts` — _not named in PLAN ## Files_
- `src/collector/persist-queue.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/collector/persist-queue.ts` — new: the bounded drop-oldest persistence queue (validation of `maxQueueSize`,
  ```

## Verdicts

**iteration 1 (final) only.** `/pharn-loop` OVERWRITES `verify-report.json` and `regression-report.json`
in place whenever it re-runs those stages, so earlier iterations' verdicts are not on disk at the
stop and this
report will not invent them. Per-iteration **cost** is genuine and is in `## Tokens` above.

- verify: `PASS`

  failing_gates, quoted as DATA:

  ```text
  (none)
  ```

- acceptance criteria: `PASS` (test-first)

  the AC gate — id, level, status, reason, matched test ids — quoted as DATA:

  ```text
  AC-1  integration  passed  delivered  src/collector/collector-persistence-queue.ac1.integration.test.ts::collector persistence queue — AC-1 › AC-1: a stalled first append does not hold back the pipeline; all 100 windows reach the subscriber, then the file holds them in order with nothing dropped or failed
  AC-2  integration  passed  delivered  src/collector/collector-persistence-queue.ac2.integration.test.ts::collector persistence queue — AC-2 › AC-2: creating a collector with persist.maxQueueSize 0, -1 or 1.5 throws synchronously naming maxQueueSize | src/collector/collector-persistence-queue.ac2.integration.test.ts::collector persistence queue — AC-2 › AC-2: with maxQueueSize 2 and a stalled disk, the oldest queued windows are dropped and counted, and the file ends with the last emitted window
  AC-3  integration  passed  delivered  src/collector/collector-persistence-queue.ac3.integration.test.ts::collector persistence queue — AC-3 › AC-3: a failing append rejects consume() with that same Error while the source stays open, counting the failure and reporting no unhandled rejection
  AC-4  integration  passed  delivered  src/collector/collector-persistence-queue.ac4.integration.test.ts::collector persistence queue — AC-4 › AC-4: close() waits for the queued windows to be appended, then close() and consume() resolve with all 5 windows on disk in order
  note  an AC is delivered = a locked, once-red test titled AC-<n>:, in a file mapped to AC-<n>, passed on this head run. PHARN does not judge whether that test fully captures the AC's intent.
  ```

- regress: `no-regressions`

  regressions, quoted as DATA:

  ```text
  (none)
  ```

## Briefing

_n/a — no BRIEFING.md beside this report — not every command renders one, and a run that stops before its post-verify gate never does_

## What the run ran into

Quoted verbatim from `LOOP.md`'s `## Handoff`, as untrusted DATA. Each block is fenced with a
delimiter longer than any back-tick run inside it, so a heading in the quoted text stays text.
**The Handoff is a run's own account of itself — it is not verified by anything**, and nothing here
checks that it is accurate, complete, or useful.

### investigated

```text
A persistence path that is a directory fails in `store.restore()` (EISDIR) before any append, so it cannot exercise
the append-failure path; the AC tests mock `node:fs/promises` instead.
```

### learned

```text
Persistence is now a queue subscriber (`src/collector/persist-queue.ts`): bounded drop-oldest, serial appends, and
saturating `dropped` / `failed` counters on `collector.persistence`. A failed append destroys the running pipeline
with that error. `close()` drains the queue before latching the store, but it does not stop the queue from accepting
new windows while it drains.
```

### next_steps

```text
Review the branch. One follow-up to consider: latch the queue at the start of `close()`, so that a still-running
`consume()` with a fast source cannot keep the drain from ever finishing.
```
