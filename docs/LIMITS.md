# Phargus — Limits

What Phargus does **not** guarantee, stated plainly. The latest release is Phargus 0.2.0 (S0 to S7
implemented). These are the design's inherent limits and the known gaps in what is built. For the
security design see [`THREAT-MODEL.md`](./THREAT-MODEL.md).

## 1. Cost and overhead

- **Overhead is measured, never zero.** `bench/overhead.mjs` compares agent-off with the agent
  loaded but disabled, the full agent, tracing only and samplers only, on HTTP workloads
  (`trivial`, `promise`, `cpu`, `stream`). A nightly workflow runs it; the results are
  informational and nothing fails on a regression. Numbers depend on the workload and the machine:
  run it on yours (see [`bench/README.md`](../bench/README.md)).
- **Tracing is where the per-request cost is.** Each traced request runs inside an
  `AsyncLocalStorage` context and keeps a small record until its response finishes. The samplers
  and the backpressure probe add a fixed cost per interval and a few nanoseconds per stream write.
- **What tracing costs, measured.** Full `bench/overhead.mjs` runs on Node 22.18.0 GitHub runners
  (4 vCPU, rps CV under 5% in 19 of 20 cells, 2026-10-18): `tracing` against `none` costs about
  10–13% more CPU per request and about 10% throughput when the server is CPU-bound (`cpu`,
  `stream`). Samplers alone stay within about 2%. On the same day's runs the tracer was cut from
  20–40% more CPU per request (trace and span ids now come from a pooled CSPRNG buffer) and from
  20–50% more RSS (buffered spans are now kept as bytes, so they no longer churn V8's old
  generation). Most of the remaining CPU cost on Node 22 is `AsyncLocalStorage` (next item). No
  overhead budget is defined yet; run the benchmark on your own workload.
- **Memory: a few MiB at steady state.** The span buffer preallocates about 280 KiB for its 1024
  spans. With tracing on, heap after GC is unchanged and RSS after a minute of load matches the
  agent-off process within run-to-run noise. In short benchmark cells RSS can still read up to
  about 25% higher on `promise`: V8 grows its young generation to the same maximum either way,
  only sooner under tracing (see "Reading the tables" in [`bench/README.md`](../bench/README.md)).
- **Node 22 makes tracing more expensive.** On Node 22, `AsyncLocalStorage` is built on
  `async_hooks` promise hooks, so once tracing is on every promise in the process pays for it, and
  promise-heavy handlers can lose a large share of their throughput. When tracing stops (a config
  file turned the agent off, or it disabled itself after an output error) Phargus disables its
  storage and no longer keeps those hooks on; with `PHARGUS_ENABLED=false` or `PHARGUS_OUTPUT=none`
  it never turns them on. Node 22's `--experimental-async-context-frame` flag switches to the
  implementation Node 24 uses by default. Compare on your workload with
  `node bench/overhead.mjs --workloads promise --node-arg=--experimental-async-context-frame`.
- **The default output shares your stdout.** With no configuration the agent writes about 2 KB per
  sample (one per second) plus one line per traced request to the process's stdout, interleaved
  with your own output. Set `PHARGUS_OUTPUT` to a file path, or to `none`, if that matters. The
  collector tolerates that output: `createNdjsonDecoder` and the collector skip and count lines and
  records that are not agent data. What remains: an app line that has the agent's sample keys, or
  `type: "span"` with every field of the agent's span shape, is taken as agent data; a malformed
  agent record (including a `type: "span"` line without that shape) is dropped (counted, not
  aggregated); and a line longer than `maxLineBytes` is dropped.
- **Heap snapshots pause the process.** Taking one blocks the event loop and can need as much memory
  again as the heap holds. On a large heap in a memory-constrained container, that can end in an OOM
  kill. Snapshots are opt-in and manual for this reason.
- **Analysis in Worker Threads is isolated from the event loop, not free.** Workers use CPU and memory
  of the same machine and can still slow the host through contention. Each analyzer worker may use
  up to its `resourceLimits` (default 512 MiB old generation, 64 MiB young generation).

## 2. In-process, so shared fate

- **If the host dies, Phargus dies with it,** and so does the in-memory data. The ring buffer is lost
  on a crash or restart unless opt-in disk persistence is on, and persistence keeps only recent
  windows, not history: at most `maxBytes`, and about half of it after each compaction.
- **Persistence failures are counted and reported, not fatal.** A file that cannot be read,
  appended to or compacted (a missing grant, a full disk) costs persisted windows only: each
  failure is counted in `collector.persistence.failed`, the first of each run of consecutive
  failures is reported as one `PhargusPersistenceWarning` process warning, and the windows, alerts
  and `consume()` carry on. When compaction keeps failing, nothing more is appended, so the file
  stays within `maxBytes`.
- **Data is dropped, not queued without limit.** The agent's sample and span output lanes each
  hold `queueBound` lines (default 1024) and drop the oldest; the span buffer holds 1024 spans
  between ticks. Above roughly 1000 requests per sampling interval, spans are dropped. Every sample
  line carries cumulative `dropped: { samples, spans }` counters; the collector and dashboard do not
  display them yet. The collector's persistence queue holds `persist.maxQueueSize` windows
  (default 1024) and drops the oldest when the disk falls behind, counted in
  `collector.persistence.dropped`; neither the dashboard nor `phargus serve` shows it yet.
  `close()` stops accepting windows, then waits for the queued appends with no time limit, so a
  disk that never completes an append stalls it.
- **Runtime figures are for one process per stream.** When several agents write to one stream (a
  `node:cluster` app, or an app that forks children, where every child inherits `--import` and
  stdout), each `collector.consume()` run follows the first sample `pid` it sees. Samples from
  every other process are skipped, counted in `collector.ignored` with the reason
  `other-process`, and passed to `onIgnored`; the run emits one process warning saying how many
  other processes it skipped. To choose the process, enable the agent only there: load it in the
  primary, or set `PHARGUS_ENABLED=false` in the environment of the processes you do not want to
  see. Spans are not filtered: requests from every process appear in the waterfall. Samples
  without a `pid` (an older agent) are treated as one process. One window series per process is
  not built yet.
- **Event loop lag is observed by the loop itself.** A loop blocked completely cannot report
  until it resumes, so the longest stalls are reported late, with their full length.
- **Event loop figures are delay beyond the timer interval.** The histogram samples on a 10 ms timer
  and records the whole interval on every tick, so the agent subtracts 10 ms from min, max, mean, p50
  and p99 and clamps at 0. An idle loop therefore reads close to 0, not exactly 0: the remainder is
  real timer and scheduling overhead. Delays shorter than the interval are not resolved, and the
  subtracted amount is the configured interval, not a measured idle baseline. On Windows, an idle
  loop reads a few milliseconds (about 5 ms on CI runners) rather than close to 0, because Windows
  timers are coarser.
- **Phargus cannot protect itself from the host.** Code running in the same process can read or alter
  Phargus's data. It is a diagnostic tool, not a tamper-evident audit log.

## 3. What the data can and cannot tell you

- **Only incoming HTTP requests are traced.** Requests to `node:http` and `node:https` servers get a
  trace id and a span. Outgoing requests, HTTP/2, database calls and queue consumers get no span of
  their own; work they do inside a traced request sees that request's trace id. A request that
  closes before its response finishes (the client disconnects, the response is destroyed or times
  out) still gets a span, marked `aborted: true`, with the status code if a head was sent (else
  `0`) and the time until the close.
- **Trace context can be lost.** `AsyncLocalStorage` propagates through promises and most callbacks,
  but not across every native addon, connection pool or queue, and not across processes. Spans can
  be missing or attached to the wrong request. Worker Threads need explicit propagation.
- **No distributed tracing.** A valid incoming W3C `traceparent` is continued: the request's span
  takes its trace-id as `traceId` and its parent-id as `parentSpanId` (both lowercased), and OTLP
  export sends that parent. Its trace-flags and any `tracestate` are not kept. A request with no
  valid header starts a fresh trace and its span has no `parentSpanId`. Phargus does not add a
  `traceparent` to outgoing requests, so it does not follow a request across services.
- **Backpressure hotspots are inferred from `write()` returning `false`.** The probe wraps `write`
  on the `Writable`, `Duplex` and `http.OutgoingMessage` prototypes, which covers `Writable`
  subclasses, `fs.WriteStream`, `Duplex`, `Transform`, `PassThrough`, `net.Socket`,
  `tls.TLSSocket`, `http.ServerResponse` and `http.ClientRequest`. A socket stall inside
  `res.write()` is counted once, on the response. Writes Node makes internally (such as the data
  passed to `res.end(data)`) show up as socket stalls. A stall lasts from the `write()` that
  returned `false` until whichever comes first: `drain`, `finish` (the stream was ended, so no
  `drain` follows, as with `res.write(big); res.end()`) or `close` (the stream was destroyed, for
  example by a client that disconnected). A stream class that overrides `write` without calling
  the prototype's is not seen. Hotspots point to where to look, not to a proven root cause.
- **Windows are aggregates.** Percentiles over a time window hide what happened inside it, and
  counters use integer math, so very small or very large values are bounded by the unit chosen.
- **Windows follow sample timestamps, not the collector's clock.** A sample whose `timestamp` is
  not a safe integer, or is more than 24 hours ahead of the collector's `Date.now()`, is
  `malformed` and counted in `collector.ignored`; past timestamps are accepted, so an old capture
  replays unchanged. A sample up to 60 windows older than the open window is counted in that
  window's `late` and dropped. A sample more than 60 windows older (a host clock stepped back by
  NTP or a VM resume) restarts aggregation: the open window is emitted and a new one starts at the
  sample's time, so window `start` values are then not monotonic.
- **Alerts have no hysteresis.** A rule fires after `forWindows` adjacent breaching windows (a
  window whose `start` is not the previous window's `end` restarts the count) and resolves on the
  first window that does not breach. A metric hovering at its threshold therefore alternates
  `firing` and `resolved`, and each one is a sink delivery (a webhook `POST`). A rule's state lives
  in its collector, so it carries over from one `consume()` run to the next.
- **GC and deoptimization detail depend on Node and V8.** GC data comes from `PerformanceObserver`
  `gc` entries, whose detail varies by Node version. Deoptimization support is a parser for
  `node --trace-deopt` output: Phargus does not start or capture that output, and the text format can
  change between V8 versions. Phargus targets the Node versions in `package.json`'s `engines` field
  and may report less on others.
- **Heap-snapshot analysis has caps.** Files over `maxSnapshotBytes` (default 256 MiB) are refused
  before reading. The streaming parser needs the top-level keys in V8's order (`snapshot`, `nodes`,
  `strings`), keeps at most 262 144 distinct object names, and truncates names over 1 KiB.
  The cap and the task timeout are paired: unless `timeoutMs` is passed or the pool was made with
  `taskTimeoutMs`, the analysis timeout is `max(30 s, size / 20 MB/s)` (see `heapSnapshotTimeoutMs`),
  summed over both files for a diff. A pool not made by `createHeapSnapshotPool` keeps its own
  timeout, and a file that grows after the size check is not re-measured.
  Source files and maps over `maxFileBytes` (default 64 MiB) are not symbolized.

## 4. Security limits

- **No TLS.** The dashboard is plain HTTP. Remote access needs an authenticated tunnel or a
  reverse proxy. The token gate stops casual access, not a network attacker. The session cookie is
  never marked `Secure`, because the dashboard itself always serves plain HTTP; a TLS-terminating
  proxy in front of it does not change that.
- **There is no redaction step.** Phargus records method, the first 256 characters of the path
  as requested (no query string), status and timing, and nothing else from a request. A secret in a
  path segment is recorded as is.
- **Sandboxed rules are limited, not safe.** `isolated-vm` constrains memory, time, result size and
  reach, but it is a defense in depth, not a guarantee. Load only rules you would run anyway.
- **Worker memory limits are best-effort for custom workers.** A worker file that makes one large
  native allocation (for example `JSON.parse` of a big string) can exceed its `resourceLimits` far
  enough to abort the whole process. The analyzer's own workers cap their input to avoid this; the
  heap-snapshot worker also rejects JSON nested more than 64 levels deep.
- **The symbolizer's confinement is only as narrow as the working directory.** `symbolizeStackFrames`
  reads only files inside the working directory unless `roots` names other directories. `roots: null`
  turns confinement off. A broad working directory (`/`, `$HOME`) confines little, and Phargus does
  not detect or refuse one.
- **A source map the worker heap cannot decode is reported as malformed.** Any file a frame names
  inside the roots, `node_modules` included, can carry a source map. The symbolizer refuses one
  before decoding it when its `sources` is not an array or its `mappings` is not a string (in the
  map or any section), or when its mappings are longer than 1/32 of the free worker heap: decoding
  costs about 20 bytes of heap per mapping byte. A genuine map that large is not symbolized either.

## 5. Packaging

- **One agent per process, main thread only.** `--import` and `--require` preloads run in every
  worker thread and are passed on to `child_process.fork` and `cluster` children. The agent starts
  only in the main thread, so worker threads are not sampled: their event loops, heaps and GC do
  not appear, and their streams and HTTP servers are not patched. Each forked or cluster child is
  its own process and runs its own agent; every sample line carries the writer's integer `pid`, but
  the collector does not yet separate lines by `pid`.
- **ESM and CJS can both be loaded.** The package ships both formats. If an application loads
  `@pharn-dev/phargus/agent` once through `import` and once through `require`, it gets two copies of the module
  (the "dual package hazard"). The agent itself starts only once per process, and the two copies
  share one set of prototype wrappers through `globalThis` registries, so disabling either copy, in
  any order, leaves `write` and `emit` working and restores the prototypes when the last one is
  disabled. Each copy still keeps its own samples, spans and trace context. Pick one format per
  process.
- **Platform.** Phargus is developed on Linux and macOS. The required CI checks run on Linux; a
  non-required smoke job runs the build, the exports check and the test suite on Windows and macOS.
  The packed-package install check and the release-workflow check run on Linux only, and releases
  are packed on Linux: a tarball packed on Windows has no execute bit on the `phargus` bin.
- **No graceful shutdown from a signal on Windows.** On Windows, `process.kill()` with `SIGTERM` or
  `SIGINT` ends the process without running its signal handlers. So `phargus serve` and
  `examples/express-app` stop without closing the dashboard, flushing the collector or printing the
  `counts:` line. Ctrl+C in a console window still delivers `SIGINT` and shuts down gracefully. The
  tests for signal-driven shutdown are skipped on Windows.
- **Windows does not apply POSIX directory modes.** A directory made read-only with `chmod` stays
  writable on Windows, so the test that a heap snapshot into a non-writable directory is refused is
  skipped there.
