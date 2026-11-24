# Phargus — Feature List

**Everything in this document is in scope.** We build the full version; nothing is deferred to
"later". The markers record what the code on `main` does today, so a reader can tell a built
feature from a planned one.

Status legend:

- ✅ **Implemented** — in the code, with tests.
- 🟡 **Partly implemented** — the note says what is missing.
- ⬜ **Not built yet** — in scope, no code yet.

---

## 1. Installation & integration

- ✅ One-line injection: `require('@pharn-dev/phargus/agent')` / `import '@pharn-dev/phargus/agent'`.
- ✅ Preload via `node --require @pharn-dev/phargus/agent app.js` or `node --import @pharn-dev/phargus/agent app.mjs` (no
  source edit needed).
- ✅ Zero external dependencies in the agent (Node core only; enforced by ESLint).
- ✅ Dual package: ESM + CJS, six subpath exports.
- ✅ Config via env vars (`PHARGUS_OUTPUT`, `PHARGUS_OUTPUT_MAX_BYTES`, `PHARGUS_INTERVAL_MS`,
  `PHARGUS_QUEUE_BOUND`, `PHARGUS_SPAN_BUFFER`, `PHARGUS_ENABLED`) + `phargus.config.json`, or one explicit `.json` file pinned with `PHARGUS_CONFIG`. A config file is parsed, never executed: a `phargus.config.js` is not read and gets one warning. Unknown `PHARGUS_*` variables warn, listing the valid names, and are ignored (the CLI's `PHARGUS_TOKEN` and `PHARGUS_DEBUG` are ignored silently).
- ✅ A file output has a size bound (`PHARGUS_OUTPUT_MAX_BYTES`, default 64 MiB, `0` = none): at
  the bound it is renamed to `<file>.1` and a new `0600` file is started, so at most twice the
  bound is on disk.
- ✅ Tracing can be reduced or switched off without switching the samplers off:
  `PHARGUS_SPAN_BUFFER` (config key `spanBuffer`, 0 to 65536, default 1024) is the number of spans
  kept per sampling interval, and `PHARGUS_SPAN_BUFFER=0` turns HTTP tracing off (no `emit` wrap,
  no diagnostics-channel subscription, no `AsyncLocalStorage`; `currentTraceId()` is `undefined`).
  The variable is read before anything is patched; `spanBuffer: 0` in a config file switches
  tracing off once the file is read. Measured costs: `docs/LIMITS.md` §1.
- ✅ CLI: `phargus serve` reads the agent's NDJSON from stdin or a file and serves the dashboard,
  so `node --import @pharn-dev/phargus/agent app.mjs | npx phargus serve` is the whole setup.
  Loopback by default; a non-loopback `--host` requires a token. ESM-only, not an `exports` subpath.
- 🟡 Works the same locally and in production. The agent does; the dashboard needs a collector
  process (`phargus serve`, or one you wire yourself as in `examples/express-app`), and the
  default output is the app's stdout.
- ✅ Published to npm: `@pharn-dev/phargus` (first release 0.1.0 on 2026-10-12; `CHANGELOG.md` lists every release). Changes on `main` since the latest release are under `Unreleased` in `CHANGELOG.md`; build from source to get them before the next release.

## 2. Runtime metrics (the headline diagnostics)

- 🟡 Event loop lag (min, max, mean, p50, p99 per interval; aggregated per window). Values are the
  delay beyond the timer interval the histogram samples at (10 ms), so an idle loop reads close to 0.
  Min and p50 stop at the agent's sample line: the collector window keeps only `max`, `p99` and
  `mean`, so the dashboard, alerts and OTLP never see them. The window's `max` is the largest
  sample max, its `p99` is the largest of the samples' p99 values (not a p99 over the window), and
  its `mean` is the mean of the samples' means, rounded down (not weighted by histogram counts).
- ✅ Memory pressure (samples carry heap used/total, RSS, external and array buffers; windows keep
  the last and max heap used and RSS).
- 🟡 GC events (count, total and max pause, by kind) from `PerformanceObserver` `gc` entries. There
  is no `--trace-gc` text hook; the observer gives the same counts without parsing. The counts by
  kind (`kinds`: minor, major, incremental, weakcb) stop at the agent's sample line: the collector
  window keeps only `count`, `totalPause` and `maxPause`, so the dashboard, alerts and OTLP never
  see them.
- ✅ Stream backpressure hotspots (where writes stall, by call site) for `Writable` subclasses,
  `fs.WriteStream`, `Duplex`, `Transform`, `PassThrough`, `net.Socket`, `tls.TLSSocket`,
  `http.ServerResponse` and `http.ClientRequest`. Collector windows keep the top 5 call sites by
  total stall (merged by site across the window's samples, sites cut to 256 characters, at most 64
  distinct sites tracked per window), and the dashboard shows them; they are not an alert metric
  and not exported over OTLP.
- 🟡 Request tracing with an automatic `traceId` — **no user-code instrumentation**, powered by
  AsyncLocalStorage. Covers incoming requests to `node:http` and `node:https` servers, honouring
  an incoming W3C `traceparent`. A request aborted by the client or destroyed (a timeout) leaves a
  span marked `aborted: true`, shown as an error in the waterfall and in OTLP. Outgoing requests
  and other entry points get no span.
- ✅ Loss accounting: bounded output lanes with `dropped: { samples, spans }` on every sample line.

## 3. V8 / memory deep-dive

- ✅ `v8.getHeapSpaceStatistics()` exposure through `sampleHeapSpaces()` (library API; not on the
  sample line).
- ✅ On-demand heap snapshots (`takeHeapSnapshot`, library API).
- ✅ Heap-snapshot summaries and diffing in the analyzer worker pool, with an input size cap; the
  task timeout scales with the snapshot size unless the caller sets one.
- ✅ Allocation sampling profiler capture (`sampleAllocations`, library API).
- 🟡 Deoptimization detection: a bounded parser for `node --trace-deopt` output
  (`createDeoptParser`). Nothing in Phargus starts or captures that output; you feed the parser lines.
- ✅ Stack-trace symbolization in a Worker Thread, with directory confinement (`roots`; default the working directory, `roots: null` to turn it off).

## 4. Data pipeline & export

- ✅ Agent exports data as an NDJSON stream with backpressure (stdout or a file; drop-oldest). On
  Windows, where Node writes a stdout pipe synchronously, the agent writes that pipe itself with
  asynchronous `fs.write`, so a stalled reader holds one libuv thread-pool thread instead of
  blocking the app (`docs/LIMITS.md`).
- ✅ Collector pipeline: raw samples → aggregated time windows → alerts (Transform streams via
  `stream/promises` `pipeline()`).
- ✅ Integer-math aggregation (no float drift in counters).
- ✅ Shared-stdout tolerance: `createNdjsonDecoder` (bounded line memory) and the collector's record
  guard skip, and count, lines and records that are not agent data instead of failing.
- ✅ OpenTelemetry export of windows (metrics) and spans (traces) as OTLP/HTTP JSON, in
  `@pharn-dev/phargus/otel`, outside the agent core. Batched sends, a bounded drop-oldest queue with
  counted and reported loss, timeouts, no redirects, bounded `close()`.
- ✅ Every window field but the backpressure hotspots and `dropped` exported as an OTLP metric: event loop lag and memory gauges, GC count and
  pause, backpressure events and stalls, and the window's sample and late-sample counts (maxima and
  last values as gauges, per-window totals as delta sums; the list is in the README). Metrics carry
  the resource attributes `service.name`, `service.instance.id` (a per-process UUID, or
  `serviceInstanceId`), `host.name` and `process.pid`.

## 5. Dashboard

- ✅ Lightweight UI: vanilla JS, no framework, no bundler. Started from the command line with
  `phargus serve`, or from code with `createDashboardServer`.
- ✅ Live updates over SSE (Server-Sent Events), bounded per client.
- ✅ Views for event loop lag, memory, GC, backpressure, alerts and traces. The Backpressure view
  shows the latest window's stall count, total and maximum stall, and its top 5 call sites.
- ✅ Recent trend per card: the page keeps the last 300 windows it received and draws a sparkline
  of event loop p99, heap used and RSS, GC total pause, and backpressure total stall, labelled with
  the line's maximum. The figures show the latest window.
- ✅ Trace detail / waterfall view of recent requests.
- ⬜ Time-range scrubbing of recent windows: the sparklines cover the last 300 windows, with no
  way to pick a range.
- ✅ Exposure/auth model: loopback without a token, any other bind requires one; `Host`/`Origin`
  allowlist (`allowedHosts`); a `/login#token=` fragment link exchanged once through `POST /session` for an `HttpOnly`, `SameSite=Strict` cookie;
  `Authorization: Bearer` for API clients.

## 6. Custom diagnostic rules (plugin runner)

- 🟡 User-supplied rules, e.g. "find windows where the event loop lag goes over 50 ms". Rules run
  over aggregated windows that you pass in: `runner.run(source, windows)` or
  `runRules(runner, rules, windows)` returns the findings to its caller. Nothing schedules rules
  against the collector, and a finding does not become an alert; for alerts, use collector alert
  rules (§8).
- ✅ Rules execute in `isolated-vm` in a child process with a **hard memory limit and timeout**,
  and capped results (`maxFindings`, `maxResultBytes`).
- ✅ A small bundled rule library (event loop lag, GC pause share, heap growth).
- 🟡 Node Permission Model. The agent runs under `--permission` with file system grants only, except
  `sampleAllocations`, which uses `node:inspector` and is refused unless your Node release offers
  `--allow-inspector` and you pass it (no Node 22 release does). The sandbox child inherits the
  host's permission flags. Phargus does not turn the permission model
  on for you; you start Node with it. See `docs/PERMISSIONS.md`.

## 7. Analysis (Worker Threads)

- ✅ Heap-snapshot analysis off the monitored event loop, streamed, with `resourceLimits` on every
  worker.
- ✅ Worker pool for parallel profile processing (bounded queue, task timeout, crashed workers
  replaced).

## 8. Alerting

- ✅ Window-based alerts emitted from the pipeline.
- ✅ Alert thresholds configurable per metric (`>` or `>=`, optionally for N consecutive,
  adjacent windows; no hysteresis, see `docs/LIMITS.md` §3).
- ✅ Alerts from the command line: `phargus serve --alert '<metric><op><threshold>[:<windows>]'`
  (repeatable; the rule id is the flag text) prints one stderr line when a rule fires and one when
  it resolves, and the dashboard's Alerts panel shows them. The threshold takes `ms` or `s` for
  time metrics and `MiB` or `GiB` for memory metrics. For example
  `--alert 'eventLoop.p99>50ms:3'` or `--alert 'memory.rssLast>=512MiB'`. No sink flags: use the
  collector API for stdout, file or webhook sinks.
- ✅ Alert sinks: stdout / file / webhook. Webhook uses Node core `fetch` only, never follows
  redirects, and has a bounded `close()`. Its optional `headers` (for example
  `{ authorization: 'Bearer …' }`) go on every request; they are checked when the sink is created,
  `content-type` is reserved, and header values never appear in an error. A URL with a username
  or password is refused when the sink is created (put credentials in `headers`); a failed
  delivery names the origin and a fixed reason or network error code, never the path, query or a
  header value. The OTLP exporters apply the same rules to their `url` and `headers`.

## 9. Persistence

- ✅ In-memory ring buffers of recent windows, alerts and spans.
- ✅ Opt-in disk persistence of recent windows: an append-only NDJSON file capped at `maxBytes`
  (compacted to the newest windows that fit in half of it), restored on start, created with mode
  `0600`. Written off the critical path through a bounded drop-oldest queue (`maxQueueSize`,
  default 1024) with `dropped` and `failed` counters on `collector.persistence`, drained on
  `close()`. A persistence failure is counted in `failed` and reported as one process warning per
  run of consecutive failures; it is never fatal to windows, alerts or `consume()`.

## 10. Examples (ship with the repo)

- ✅ `examples/express-app` — agent in the app, collector and dashboard in a second process.
- ✅ `examples/worker-pool` — Worker Threads, a heap snapshot and analysis on the analyzer pool.

## 11. Measurement

- ✅ `bench/overhead.mjs` (agent-on versus agent-off) and `bench/soak.mjs` (leak checks under
  load), run nightly. The benchmark fails the nightly run on an exceeded budget; nothing gates a
  merge or release.

---

## Out of scope — by identity, not by timeline

These stay out even in the full build, because they contradict what Phargus _is_
(lightweight, dependency-free, local-first). Cutting them is not deferral:

- A hosted/SaaS backend or a required external collector service.
- A heavy framework-based dashboard or a build step for the UI.
- Pulling any third-party APM/agent SDK into the agent (`src/agent`).
