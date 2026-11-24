# bench/

Two maintained harnesses that keep the agent's overhead and resource claims checkable:

- `overhead.mjs` — agent-on versus agent-off HTTP benchmark.
- `soak.mjs` — long run under load that fails on leaks.

Both use Node core only (no dependencies, like the agent). They measure the **built package**:
the targets load `@pharn-dev/phargus/agent` through the package's own `exports` (self-reference by package
name), which is exactly what a user's `--import @pharn-dev/phargus/agent` loads. Build first:

```bash
npm ci
npm run build
```

Like `scripts/*.mjs`, these files are plain ESM JavaScript: `npm run lint` covers them,
`npm run typecheck` (which checks `.ts` only) does not.

## Overhead benchmark

```bash
node bench/overhead.mjs                       # full run, about 13 minutes
node bench/overhead.mjs --duration 3 --rounds 1 --warmup 1   # quick look, about 2.5 minutes
```

| Flag            | Default                                        | Meaning                                                      |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `--duration`    | `5`                                            | measured seconds per cell                                    |
| `--warmup`      | `1.5`                                          | seconds of load before measuring                             |
| `--connections` | `32`                                           | concurrent keep-alive connections                            |
| `--rounds`      | `3`                                            | interleaved rounds; every number is the median across rounds |
| `--workloads`   | `trivial,promise,cpu,stream,large`             | comma list                                                   |
| `--variants`    | `none,idle,full,notrace,pipe,tracing,samplers` | comma list                                                   |
| `--out`         | a file in the OS temp directory                | where the JSON result goes                                   |
| `--node-arg`    | none                                           | extra Node flag for every target, repeatable                 |

**How it works.** For each cell (workload × variant × round) a fresh target process starts an
HTTP server on loopback. The harness drives it closed-loop: `--connections` keep-alive sockets,
each with one request in flight, request paths cycling over 50 values, one request in seven
carrying a W3C `traceparent`. After the warm-up the target is told to start measuring, and after
`--duration` to stop. Within a round the variants of a workload run back to back, and the variant
order rotates from round to round, so slow drift on the host does not always hit the same variant.

**Workloads**

| Workload  | Per request                                                                       |
| --------- | --------------------------------------------------------------------------------- |
| `trivial` | `res.end('ok')`                                                                   |
| `promise` | a chain of 20 `await`s, then respond (AsyncLocalStorage propagation cost)         |
| `cpu`     | 20 000 integer operations, then respond                                           |
| `stream`  | 4 KiB through a `Transform` into the response with `stream/promises` `pipeline()` |
| `large`   | one `res.write()` of 256 KiB, then `res.end()`                                    |

`large` is the workload where `write()` returns false: 256 KiB is more than the response and
socket buffers take at once, so the backpressure probe takes its stall path (a stall, then a
drain) on every request. The `bp events` column shows it; in the other workloads it stays at 0.

**Variants**

| Variant    | What is loaded                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `none`     | nothing: the baseline                                                                                                      |
| `idle`     | `--import @pharn-dev/phargus/agent` with `PHARGUS_ENABLED=false`: installed, switched off by config                        |
| `full`     | `--import @pharn-dev/phargus/agent` with its defaults: tracing and every sampler, NDJSON to stdout (a file)                |
| `notrace`  | `--import @pharn-dev/phargus/agent` with `PHARGUS_SPAN_BUFFER=0`: every sampler, no HTTP tracing                           |
| `pipe`     | as `full`, but stdout is a pipe read by a reader process (the documented `\| phargus serve` topology)                      |
| `tracing`  | agent internals from `dist/` (no auto-start): HTTP tracing on, spans flushed once a second to stdout (a file); no samplers |
| `samplers` | agent internals from `dist/` (no auto-start): samplers and the backpressure probe at 1 s, to stdout (a file); tracing off  |

The target's stdout is a file in the cell's temporary directory for every variant but `pipe`. For
`pipe` the harness forks a reader process (`lib/pipe-reader.mjs`) and hands its stdin to the
target as stdout, so the agent's per-tick write burst goes into a pipe that another process
drains, as it does under `node --import @pharn-dev/phargus/agent app.js | phargus serve`. The
reader runs on its own event loop, so the harness's load generator does not slow it down.

**What is measured.** On the load generator: requests per second and the p50/p99 latency, from
the HDR histogram in `node:perf_hooks`. In the target, for the measured window only: CPU time
(`process.cpuUsage`, reported per request and as % of one core), event-loop utilisation
(`performance.eventLoopUtilization`), RSS at the end, and GC count and total pause
(`PerformanceObserver` on `gc` entries). From the target's stdout, for the whole cell (warm-up
included), once the target has exited: `out KiB`, the bytes the agent wrote (for `pipe`, the bytes
the reader consumed), and `bp events`, the backpressure events summed over the agent's sample
lines.

**Reading the tables.** Each workload gets one table on stdout (Markdown, so it pastes into a PR
or a job summary as is). Every value is the median across rounds; `±` after rps is the coefficient
of variation across rounds; percentages in parentheses are the change versus `none`.

- Where the server has spare CPU (ELU well below 1), the cost shows up as **CPU µs/req**, not as
  throughput or latency. Where it is saturated (ELU ≈ 1), it shows up as lower rps and higher p50.
- `idle` should be indistinguishable from `none`. `full` ≈ `tracing` + `samplers`; tracing is
  where the per-request cost is.
- On Node 22, `AsyncLocalStorage` rides on `async_hooks`, so `promise` under `full`/`tracing` is
  much slower than on Node 24. Compare with
  `--node-arg=--experimental-async-context-frame` to see the Node 24 profile on Node 22.
- **RSS is read at the end of a short cell, so it shows how far V8 has grown its young
  generation, not only what the agent keeps.** Under this load V8 grows the young generation to
  its maximum (32 MiB on 64-bit) within a minute or two whether the agent is loaded or not.
  Per-request state that lives across a scavenge (a traced request's context, for one) makes it
  get there sooner, so `tracing` and `full` can read several MiB, up to about 25%, above `none`
  in a 5 s cell and level out in a long run. A real retention cost shows up as old-generation
  growth: run the soak (heap after GC), or compare long runs with `--duration 60` or more, before
  calling an RSS delta a memory cost.

**Noise.** Treat a delta smaller than about twice the CV as noise. On a quiet machine the rps CV
is 1–2 % for `trivial`, `promise` and `cpu`; on shared CI runners expect **CV 3–8 %** on rps and
more on p99. `stream` is the noisiest workload. A loaded laptop (other builds, a browser) makes
every number unreliable; the JSON records the load average at the start so you can tell.

**Exit code.** 0 when every cell ran and no budget was exceeded; 1 when the harness broke (a
target crashed, a request failed, the agent reported itself disabled on stderr, its output could
not be counted); 2 when a budget was exceeded in a low-variance run (see below).

## Budget

The benchmark has one budget, in `bench/lib/budget.mjs`:

| Workload  | Compared      | Metric     | Budget           |
| --------- | ------------- | ---------- | ---------------- |
| `trivial` | `full`/`none` | CPU µs/req | at most **+25%** |

The nightly runs on GitHub runners have measured this delta at about +5% (Node 22.18, November
2026), so +25% leaves room for runner noise and catches a regression that multiplies the
per-request cost, not one of a few percent.

A budget is judged only when the run can be trusted: at least two rounds, and a coefficient of
variation of the budgeted metric under **10%** in both cells (`none` and `full`). Over the budget
in such a run is `exceeded`, and the run exits 2. Over the budget in a noisier run, or with one
round, is `noisy` and does not fail. A run that did not include both cells reports the budget as
`skipped`. The verdicts are printed under the tables and kept under `budgets` in the JSON.

**JSON.** One file per run: run metadata (commit, Node version, platform, CPU, load average,
settings), `summary[workload][variant][metric]` with `median`, `min`, `max`, `cv` and `n` plus
`deltaVsNone`, the budget verdicts under `budgets`, and every raw cell under `cells` (the agent
output counts under `output`).

## Soak test

```bash
node bench/soak.mjs                    # 120 s
node bench/soak.mjs --duration 30      # quick run; the heap baseline moves to 7.5 s
```

Three processes for the whole run:

1. **App** — `node --expose-gc --import @pharn-dev/phargus/agent` with `PHARGUS_INTERVAL_MS=100` and
   `PHARGUS_OUTPUT=stdout`, serving a mix of the benchmark workloads under closed-loop load
   (`--connections`, default 8). Every request path is unique, and one request in eight stalls a
   `Writable`, so the backpressure probe churns too.
2. **Collector** — `node --expose-gc`, reading the app's NDJSON (piped through the harness) into
   `@pharn-dev/phargus/collector`, and keeping every other module busy:
   - `@pharn-dev/phargus/dashboard` serves it to SSE clients: `--sse-concurrency` loops (default 10) that
     connect, read for 20–300 ms and hang up, plus `--stalled-clients` (default 5) that connect at
     the start and never read until the end;
   - `@pharn-dev/phargus/otel` metric and trace exporters flood a dead endpoint (500 batches per 100 ms each);
   - `@pharn-dev/phargus/analyzer` symbolizes twice a second, on a persistent pool and every fourth time on a
     fresh pool (a Worker created and terminated per call);
   - `@pharn-dev/phargus/plugin-runner` runs the built-in rules every second, plus a rule that times out every
     fifth run (the sandbox child is killed and respawned).
3. **Harness** — load generator, SSE clients, and the checks.

Heap-after-GC (`gc()` with `--expose-gc`, minimum of three readings) is taken in both processes
at the baseline (`--baseline`, default `min(30 s, duration / 4)`) and at the end, while the load
is still running. Then everything is closed and the run **fails (exit 1)** if:

- heap-after-GC grew more than `--max-heap-growth` (default 10 %) in either process;
- a Worker thread or child process outlived its owner's `close()` (counted in-process and with
  `pgrep -P`);
- the dashboard still has clients after every client hung up;
- any HTTP request or SSE connection failed;
- either process did not exit on its own once closed (a leaked handle), or exited non-zero;
- the agent reported itself disabled on stderr, or the NDJSON pipe failed;
- either process's heap passed `--heap-ceiling` (default 512 MiB) at a 5 s probe — the run stops
  early rather than exhaust the machine.

The lines after the table are informational: request rate, SSE cycles and dropped events,
NDJSON lines and windows received (fewer windows than expected means agent samples were lost on
the way), exporter drops and failures, analyzer and plugin-runner outcomes, and the first error
of each kind. `--out` also writes everything as JSON.

## In CI

`.github/workflows/nightly.yml` runs both daily (and on demand via `workflow_dispatch`) on the
Node floor from `.nvmrc`, as two non-required jobs:

- **Nightly benchmark** — a soft check. Tables in the job summary, JSON uploaded as the
  `overhead-benchmark` artifact (kept 90 days) for comparing runs over time. It fails when the
  budget above is exceeded in a low-variance run (exit 2) or the harness broke (exit 1). The
  workflow is not a required check, so a failure alerts without blocking a merge.
- **Nightly soak** — fails the workflow on a leak (exit 1 above).

The benchmark does not run on pull requests: shared-runner noise (CV 3–8 %) is larger than most
real regressions, so it would block PRs on noise. If a PR touches a hot path (the HTTP wrapper,
the write wrapper, the samplers, the exporter), run it locally before and after the change and
put both tables in the PR.

A hard release gate is a later decision. When there is one, it is meant to be run as:

```bash
node bench/overhead.mjs --rounds 5 --workloads trivial,promise --variants none,full --out release.json
```

and to compare the `full` versus `none` p50 and CPU µs/req deltas against the trailing median of
the nightly artifacts, not against a fixed number.
