# Changelog

All notable changes to Phargus are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Releases publish when a version-bump PR merges to
`main`; see [`docs/RELEASING.md`](./docs/RELEASING.md).

## [Unreleased]

### Added

- A file output now has a size bound: `PHARGUS_OUTPUT_MAX_BYTES` (config key `outputMaxBytes`,
  default 64 MiB, `0` = no bound). Before a line would take the file past it, the agent renames it
  to `<file>.1`, replacing an older one, and continues in a new file created with mode `0600`, so
  at most twice the bound is on disk and no line is split. Rotation uses asynchronous file calls
  only; a failed rename disables the agent with one `[phargus] agent disabled: ...` line. Under
  `--permission` a file output now also needs `--allow-fs-write=<file>.1` and
  `--allow-fs-read=<file>` (see `docs/PERMISSIONS.md`).
- `PHARGUS_SPAN_BUFFER` (config key `spanBuffer`, 0 to 65536, default 1024) sets how many spans the
  agent keeps per sampling interval; the rest are counted in `dropped.spans`. `0` turns HTTP
  tracing off and keeps the samplers and the backpressure probe: nothing is patched or subscribed,
  no span line is written, and `currentTraceId()` returns `undefined`. The variable is read before
  anything is patched, like `PHARGUS_ENABLED`; an invalid value disables the agent with a message
  naming it. `bench/overhead.mjs` has a `notrace` variant (the agent with `PHARGUS_SPAN_BUFFER=0`).
- `phargus serve --alert '<metric><op><threshold>[:<windows>]'` raises collector alerts from the
  command line, for example `--alert 'eventLoop.p99>50ms:3'` or `--alert 'memory.rssLast>=512MiB'`.
  The flag is repeatable, the rule id is its text, and the threshold takes `ms`/`s` for time
  metrics and `MiB`/`GiB` for memory metrics. Each rule prints one stderr line when it fires and
  one when it resolves, and the dashboard's Alerts panel shows them. A bad rule is a usage error
  (exit 2) that quotes it; an unknown metric lists the valid names.
- Each dashboard card now shows the recent trend, not only the last value: the page keeps the last
  300 windows it received and draws an inline SVG sparkline of event loop p99, heap used and RSS,
  GC total pause, and backpressure total stall, labelled with the line's maximum. Sparkline redraws
  are coalesced to one per animation frame, and a reconnect refills the lines from the new replay.
- The agent's drop counters now reach the user: each collector window carries
  `dropped: { samples, spans }` from its last sample (missing or malformed counts as 0; persisted
  windows without the field restore with zeros), the dashboard header shows "agent dropped N
  samples, M spans" when either is above 0 and the waterfall notes that older requests may be
  missing, and the `counts:` line of `phargus serve` adds `agent.droppedSamples` and
  `agent.droppedSpans`. OTLP metrics are unchanged.
- Collector windows now keep where writes stalled: `backpressure.hotspots` holds the top 5 call
  sites by total stall, merged by site across the window's samples (at most 64 distinct sites
  tracked per window, sites cut to 256 characters). A sample with missing or malformed hotspots
  still counts. Persisted windows carry the field (older lines restore with an empty list), and
  the dashboard has a Backpressure section with the latest window's stalls and call sites. OTLP
  metrics are unchanged.
- The dashboard says when its data is stale: each card shows the end time of the window on
  display, and after `max(3 × window length, 5 s)` without a new window the status reads
  `stale: no data for N s` (counting up, in the error style) until the next window arrives. A
  disconnected stream still shows `reconnecting`. `docs/LIMITS.md` §2 explains why the figures are
  one window behind.
- `phargus serve` now passes the app's own output through: when reading stdin, every line that
  is not agent data (plain text and JSON log lines) is written to its stdout in input order,
  instead of disappearing. `--no-passthrough` turns it off; a file input never echoes. Output is
  bounded at 1 MiB waiting (further lines are dropped and counted as `passthrough.dropped`), and
  a closed stdout stops the passthrough with one stderr line. `createNdjsonDecoder` gets
  `agentOnly: true`, which skips non-agent JSON objects as `foreign` (a new counter and
  `onSkipped` reason with the raw line); the `counts:` line gains `decoder.foreign` and
  `passthrough.dropped`.
- A request that closes before its response finishes (client disconnect, `res.destroy()`, a
  timeout) now leaves a span with `aborted: true`; the dashboard waterfall shows it as an error
  marked "aborted", and OTLP export sets its status to error.
- A request that continues a W3C `traceparent` now keeps its parent-id: the span line carries it
  as `parentSpanId` (lowercased), and OTLP export sets the span's `parentSpanId`, so the span is
  no longer exported as a root. Spans of requests without a valid header have no `parentSpanId`.

### Changed

- The agent's sample line no longer carries `heapSpaces` (V8 heap space statistics): nothing in
  the collector, dashboard, OTLP export or CLI reads it, and it was about 1.6 KB of a 2 KB line. A
  line with no backpressure hotspots is now about 450 bytes. `sampleHeapSpaces()` is still
  exported with the same shape, and the collector still accepts lines from older agents that
  carry the field.
- A window persistence failure (restore, append or compaction) no longer rejects
  `collector.consume()` or stops the pipeline: it is counted in `collector.persistence.failed` and
  reported as one `PhargusPersistenceWarning` per run of consecutive failures, and windows and
  alerts carry on. `persist.maxBytes` now caps the file: compaction keeps the newest windows that
  fit in half of it, so the file is rewritten rarely. Compaction writes `<file>.compact.tmp`, so
  grant `--allow-fs-write` for that path too (`docs/PERMISSIONS.md`).
- The collector no longer adds samples from several processes on one stream (a `node:cluster`
  app, forked children) into one window: each `consume()` run follows the first sample `pid` it
  sees, skips samples from other processes as the new `IgnoredReason` `other-process` (counted in
  `collector.ignored`, passed to `onIgnored`), and emits one process warning saying how many
  other processes it skipped. Samples without a `pid` and all spans are kept as before.
- One bounded drop-oldest queue (`src/agent/bounded-queue.ts`) now serves the agent exporter, the
  collector's ring buffers and persistence queue, the dashboard's SSE client and the OTLP batch
  queue, replacing four separate implementations. It grows to its capacity on demand, so a large
  bound costs nothing until used. `createRingBuffer` keeps its type and behaviour.
- `summarizeHeapSnapshot`, `diffHeapSnapshots` and `symbolizeStackFrames` no longer re-check the
  shape of their worker's reply; the inputs are still checked before any worker runs. The `pool`
  option is meant for a pool from `createHeapSnapshotPool()` or `createSymbolizationPool()`: a pool
  running some other worker now gets that worker's reply back as is.

### Removed

- **Breaking:** the deprecated dashboard login link `/?token=<token>` is gone, along with its
  `PHARGUS_DEP_TOKEN_QUERY` warning. A `?token=` query is no longer a credential: `GET /?token=…`
  answers `401` and sets no cookie. Open `/login#token=<token>` in a browser, or send
  `Authorization: Bearer <token>`.
- **Breaking:** `@pharn-dev/phargus/agent` no longer exports the agent's own wiring, configuration
  and permission internals. Importing the subpath starts the agent, so these were never safe to use
  next to it (a second controller doubles the observers; `createNdjsonExporter(process.stdout).stop()`
  ends the app's stdout). Removed runtime exports: `createSamplerController`,
  `createNdjsonExporter`, `createEventLoopSampler`, `createGcSampler`, `createBackpressureProbe`,
  `loadAgentConfig`, `defaultAgentConfig`, `PhargusConfigError`, `assertPermission`,
  `checkPermission`, `isPermissionModelEnabled`, `sampleMemory`,
  `DEFAULT_ALLOCATION_SAMPLING_INTERVAL`, `DEFAULT_ALLOCATION_SAMPLING_DURATION_MS` and
  `DEFAULT_ALLOCATION_SITE_LIMIT` (the `sampleAllocations` defaults, 32768 bytes, 1000 ms and 20
  sites, are in `docs/API.md`). Their types go with them: `SamplerController`, `NdjsonExporter`,
  `NdjsonExporterOptions`, `EventLoopSampler`, `EventLoopSamplerOptions`, `GcSampler`,
  `BackpressureProbe`, `BackpressureProbeOptions`, `LoadAgentConfigOptions`, `AgentConfig`,
  `PermissionCheck` and `PermissionScope`. The agent keeps ten runtime exports: `currentTraceId`,
  `runWithTrace`, `takeHeapSnapshot`, `sampleAllocations`, `sampleHeapSpaces`, `createDeoptParser`,
  `ANONYMOUS_FUNCTION`, `DEPENDENT_CODE_KIND`, `PhargusPermissionError` and `SPAN_RECORD_TYPE`, and
  the output-format types. To check a permission grant, use Node's `process.permission.has()`.
- **Breaking:** the agent no longer reads `phargus.config.js`, and `PHARGUS_CONFIG` accepts a
  `.json` path only. Move the settings to `phargus.config.json` (same keys). A config file is now
  parsed, never executed: a `phargus.config.js` in the working directory prints one warning naming
  `phargus.config.json`, and `PHARGUS_CONFIG=settings.js` disables the agent with the
  "unsupported extension" message. The unknown-variable warning lists the valid `PHARGUS_*` names
  instead of guessing one ("did you mean").

### Fixed

- On Windows, with output on stdout and stdout a pipe, a stalled reader no longer stops the app. Node
  writes a stdout pipe synchronously there, so the agent now writes that pipe itself with
  asynchronous `fs.write` (libuv's thread pool) instead of through `process.stdout`; its bounded
  lanes drop and count lines as on Linux and macOS. While the reader is stalled, one thread-pool
  thread waits on the pipe (see `docs/LIMITS.md`).
- `phargus --help` (and `--version`) now win over a bad flag: `phargus --bogus --help` prints the
  usage and exits 0 instead of exiting 2.
- `phargus serve <directory>` fails before the dashboard binds, with
  `cannot read input file "<path>": EISDIR` and exit 1, instead of printing the dashboard URL and
  then failing on the first read.
- Docs: the README's V8 row names `/agent` for `takeHeapSnapshot`, `sampleAllocations` and
  `createDeoptParser`; `docs/API.md` says `runWithTrace` always starts a fresh trace id and that
  importing `/agent` starts the agent unless `PHARGUS_ENABLED=false`; `FEATURES.md` marks event
  loop min/p50 and GC counts by kind as stopping at the sample line and documents how window `p99`
  and `mean` are computed; `FEATURES.md`, `ARCHITECTURE.md` and the README diagram no longer show
  the plugin runner fed by the collector; the OTLP resource notes say `host.name` and
  `process.pid` describe the exporter's process; `docs/PERMISSIONS.md` says `sampleAllocations`
  needs `--allow-inspector` and is refused on Node 22.
- The backpressure probe names each stall by its own call site instead of caching the first
  stall's site per stream, so stalls from different code on one keep-alive socket, shared log
  stream or database connection are separate hotspots. A sampling window makes at most 32 stack
  captures; later stalls in the window are named by the stream's constructor (for example
  `ServerResponse`), so a server whose responses stall no longer pays a stack capture per request.
- The dashboard waterfall rebuilds at most once per animation frame instead of once per span event,
  so a page load that replays 1,024 spans builds it once; an aborted span keeps its "aborted" marker
  when later spans arrive; the stream reader no longer builds a promise chain that grows for as long
  as the tab stays open; and the embedded layout function survives a minifier renaming it.
- `diffHeapSnapshots` now shows what shrank as well as what grew: it leaves out types whose count
  and self size did not change and ranks the rest by absolute self-size change, so a type that
  lost objects is no longer cut off below the unchanged rows.
- Rule sandbox edges: `loadRulesDirectory` reports a rule file over 1 MiB as a
  `RULE_FILE_UNREADABLE` failure without reading it, and a run's watchdog now starts only once the
  sandbox child has loaded `isolated-vm`, so a cold first run with a short `timeoutMs` is no longer
  timed on process start-up (a child that does not start within 10 s fails as
  `PHARGUS_SANDBOX_CRASHED`). `docs/THREAT-MODEL.md` D2 now says a rule that exhausts memory ends
  as `PHARGUS_RULE_MEMORY_LIMIT`, `PHARGUS_RULE_TIMEOUT` or `PHARGUS_SANDBOX_CRASHED`.
- One sample line dated in the future, or a host clock stepping back, no longer stops all windows
  and alerts until the collector restarts. A sample whose `timestamp` is not a safe integer or is
  more than 24 hours ahead of the collector's clock is now `malformed` and counted in
  `collector.ignored`, and a sample more than 60 windows older than the open window restarts
  aggregation at its time instead of being counted as `late`.
- HTTP tracing no longer pins `EventEmitter.prototype.emit` for HTTP and HTTPS servers: a later replacement (`node:domain`, other instrumentation) is now reached, so a domain catches a server's `'error'` again.
- A span's path is now the path the client requested, read when the request starts, so a framework
  that rewrites `req.url` (an Express mounted router) no longer changes it. It is cut to its first
  256 characters, so a long URL cannot grow a span line past a few hundred bytes.
- A backpressure stall that ends with `finish` or `close` instead of `drain` (a
  `res.write(big)` followed by `res.end()`, or a client that disconnects mid-stall) now reports
  its duration in `totalStall`, `maxStall` and its hotspot instead of 0.
- A preloaded agent (`--import` or `--require`) now starts in the main thread only, so worker
  threads no longer each start their own agent and write extra sample lines. Every sample line now
  carries the writer's integer `pid`; forked and cluster children each still run their own agent.
- Off means off: with `PHARGUS_ENABLED=false` (or `0`) or `PHARGUS_OUTPUT=none` the agent no longer
  patches `http.Server.prototype.emit` for a moment or executes `phargus.config.js`, and an agent
  that disables itself (for example after an output error) also disables its `AsyncLocalStorage`,
  so `currentTraceId()` is `undefined` everywhere and Node 22 stops paying for its async hooks.
- The stdout alert sink keeps delivering when its stream is backed up: after a `write()` that
  returned `false` it no longer waits for a `drain` that had already fired, so later alerts are
  written and `close()`, `collector.close()` and `consume()` resolve again.
- The collector stores a `type: "span"` record as a span only when it has the agent's span shape
  (hex `traceId` and `spanId`, string `name`, `method` and `path`, non-negative integer
  `statusCode`, `startTimeMs` and `durationNs`, and a valid `parentSpanId` or `aborted` when
  present); anything else is skipped and counted in `ignored` as malformed. A stored span keeps
  only those fields, with strings cut to 1,024 characters, so large span-shaped lines no longer
  fill the span ring and every dashboard client with up to 1 GiB.
- An alert rule with `forWindows: N` now fires only on N adjacent breaching windows: a gap between
  windows (dropped agent lines, an agent restart, a clock step back) restarts the count. A rule's
  state is kept by its collector, so a rule firing when one `consume()` run ends no longer fires
  again in the next, and resolves there when it stops breaching.
- A partial line that reaches the collector's NDJSON decoder in tiny pieces (progress dots, a
  spinner) is now held in one buffer that doubles as it fills, capped at `maxLineBytes`, instead
  of one Buffer per piece: 1,000,000 one-byte chunks held 109 MiB of heap before, about 1 MiB now.
- The plugin runner's ESM build now finds its sandbox child script when the package is installed
  under a path containing `)` (a `proj (copy)` or `Dropbox (Company)` folder). It used to look
  for the child at a path relative to the filesystem root, so every rule failed with
  `PHARGUS_SANDBOX_CRASHED`. The plugin runner and the analyzer now find their own directory the
  same way.
- The plugin runner's sandbox child no longer starts a second agent or writes sample lines to the
  host's stdout when the host preloads the agent through `NODE_OPTIONS`: it is forked with its
  stdout ignored and a minimal environment (`PATH`, `SystemRoot` on Windows, and
  `PHARGUS_ENABLED=false`), so it no longer receives `NODE_OPTIONS` or any of the host's secrets.

- The dashboard login link (`/login#token=<token>`) now keeps `+`, `/` and `=` in a token
  instead of turning `+` into a space, so base64 tokens work; other characters can be
  percent-encoded.

### Security

- A heap snapshot file under the 256 MiB cap can no longer abort the host process:
  `summarizeHeapSnapshot` and `diffHeapSnapshots` reject JSON nested more than 64 levels deep
  ("nesting too deep"), and the worker no longer keeps every distinct top-level key, only
  `snapshot`, `nodes` and `strings`. Both now fail with a `WorkerTaskError` instead.

- The dashboard returns `400` for malformed request targets and catches request-handler errors, so one request cannot crash the process hosting it.

- Dashboard binds outside loopback now require a token of at least 16 characters; short tokens are refused before the server binds.

- A dashboard without a token now refuses to start when `allowedHosts` (`phargus serve --allowed-host`)
  names a host that is not loopback, even on a loopback bind; `phargus serve` exits with code 2
  before binding. Previously a loopback bind plus a public `allowedHosts` name served that name
  with no token. Such a name now needs a token of at least 16 characters, as a non-loopback bind
  does. The `421` body now says such a name needs a token.

- **Breaking change:** The dashboard session cookie is now named `phargus_session_<port>` after
  the port the dashboard is bound to (the actual port on a port 0 bind), instead of
  `phargus_token`, so two dashboards on one host no longer overwrite each other's session. The
  rename signs every browser out once; open the `/login#token=<token>` link again.

- The dashboard refuses `/events` with `503` while 64 clients are connected; closing one frees a
  slot.

- Removed the dead `Secure` cookie branch: the dashboard serves plain HTTP only, so its session
  cookie is never `Secure` (now stated in `docs/LIMITS.md`).

- The webhook sink and the OTLP exporters refuse a URL with a username or password when they are
  created (send credentials with the `headers` option), the OTLP exporters check `headers` as the
  webhook sink does, and a failed delivery no longer copies `fetch`'s message, which could quote
  the full URL or a header value: it reports a fixed text or the network error code (for example
  `fetch failed (ECONNREFUSED)`).

- A hostile source map no longer aborts the process or crashes the symbolization worker.
  `symbolizeStackFrames` now reports a map as malformed (`MalformedSourceMapError` on its frames)
  when its `sources` is not an array or its `mappings` is not a string, in the map or any section
  (a 70-byte map with `"sources":{"length":4294967295}` made V8 end the host with exit code 134),
  or when its mappings are longer than 1/32 of the free worker heap (a mapping-dense map of about
  24 MiB or more killed the worker and rejected the whole call). A built file of up to 64 MiB of
  newlines no longer kills the worker while its `sourceMappingURL` comment is looked for.

## [0.2.1] - 2026-11-08

### Fixed

- The backpressure probe no longer double-counts a stall on `http.ServerResponse` and
  `http.ClientRequest`. On newer Node releases the message flushes to its underlying socket after
  `write()` returns, outside the synchronous window the probe's wrapper suppresses, so the probe
  started a second, separate stall for that socket even though it was the same write already
  tracked as a stall on the message. `createBackpressureProbe` now recognizes a socket covered by
  an open stall on its `_httpMessage` and skips observing it, so one slow write is reported once.

## [0.2.0] - 2026-10-18

### Security

- Behavior change: `symbolizeStackFrames` now confines reads to the working directory when `roots`
  is left out. Frames whose built file or source map lies outside the working directory are no
  longer read; they come back unchanged unless you pass `roots` naming the directories to read
  from, or `roots: null` for the old unconfined behavior.
- Dashboard login no longer puts the token in a request line. Open `/login#token=<token>`: the
  token is in the URL fragment, which the browser never sends; the public login page removes it
  from the address bar and history, then posts it as JSON to the new `POST /session` (4096-byte
  cap, JSON only, constant-time compare), which answers `204` with the same `HttpOnly`,
  `SameSite=Strict` session cookie, or `401` with none. `phargus serve` and the dashboard script
  now point at this link. `/?token=<token>` still works but is deprecated and will be removed in a
  later release; the first use emits a `PHARGUS_DEP_TOKEN_QUERY` deprecation warning.

### Added

- `PHARGUS_CONFIG` pins the agent's config file. When set, the agent loads exactly that `.json`
  or `.js` file (a relative path resolves against the working directory) and does not look for
  `phargus.config.json` or `phargus.config.js` there. An empty value, a missing or unreadable
  file, something that is not a regular file, or any other extension rejects with a
  `PhargusConfigError` naming `PHARGUS_CONFIG`, and never falls back to the working-directory
  lookup. `docs/THREAT-MODEL.md` gains row I1 for the config file as code-execution surface.
- `phargus serve`, a command-line way to get the dashboard without writing a collector. The
  package now has a `bin`, so `node --import @pharn-dev/phargus/agent app.mjs | npx phargus serve`
  reads the agent's NDJSON from stdin (or `-`), replays a capture file given as an argument,
  aggregates it into windows and serves the dashboard. Flags: `--port` (default 7070), `--host`
  (default `127.0.0.1`), `--token`, `--window-ms` (default 1000) and `--max-line-bytes`, plus
  `--help` and `--version`. `PHARGUS_TOKEN` supplies the token, and a non-loopback `--host`
  without one is refused with exit code 2 before anything binds. Diagnostics go to stderr only:
  the dashboard URL, an input-ended line and a `counts:` line (`decoder.invalid`,
  `decoder.oversized`, `collector.ignored`, `dashboard.droppedEvents`). The server keeps running
  after the input ends. SIGINT and SIGTERM close the server and the collector and exit 0; a stuck
  shutdown is forced out with exit code 1 after 5 seconds. Exit codes: 0 success, 1 runtime error
  (unreadable file, port in use), 2 usage error. Errors print without a stack unless
  `PHARGUS_DEBUG` is set. The CLI is ESM-only and is not an `exports` subpath.
  `@pharn-dev/phargus/dashboard` now also exports `isLoopbackHost`. `npm run check:exports`,
  `check:package` and `check:install` verify the `bin`.
- `phargus serve --allowed-host <host>`, repeatable, passed to the dashboard's `allowedHosts`.
  It lets a browser reach a server bound with `--host 0.0.0.0` (for example in a container) by
  IP or hostname instead of getting `421`. A bare name matches on any port; `host:port` matches
  exactly. An empty value, or one with whitespace or `/`, is a usage error (exit code 2). It does
  not lift the token requirement for a non-loopback `--host`.
- Webhook alert sinks take an optional `headers` option, for example
  `{ authorization: 'Bearer …' }`, sent with every request (review finding F23). It works on
  `createWebhookSink` and on a `{ type: 'webhook' }` sink config. Headers are copied and checked
  when the sink is created: a name must be an HTTP token, a value must be a string with no control
  characters (tab aside) and nothing above U+00FF, and the same name twice in different case is
  rejected. `content-type` is reserved for the sink's own `application/json`, so supplying it is a
  `TypeError` rather than a silent override. `__proto__` is rejected too, because Node's `fetch`
  drops it. Errors name the header, never its value.
- OTLP metrics export (`@pharn-dev/phargus/otel`) now carries every window field (review finding
  F22). New gauges `phargus.gc.pause.max` and `phargus.backpressure.stall.max` (`ns`); new delta
  monotonic sums `phargus.gc.pause.total` and `phargus.backpressure.stall.total` (`ns`),
  `phargus.backpressure.events` (`{event}`), `phargus.window.samples` and
  `phargus.window.late_samples` (`{sample}`, from the window's `count` and `late`). The metrics
  resource now carries `service.instance.id`, `host.name` and `process.pid` beside
  `service.name`, so several instances no longer merge into one series. `service.instance.id`
  defaults to a random UUID generated once per process; the new `serviceInstanceId` option on
  `createOtlpMetricsExporter` and `toOtlpMetrics` overrides it, and an empty or non-string value
  throws a `TypeError`. The trace exporter is unchanged.

- `docs/API.md`, a reference of every supported export per subpath. `npm run check:exports` now
  also compares each subpath's runtime export names with an exact expected list, through `import`
  and `require`, and fails on a name added or missing.

### Fixed

- Lower memory cost of HTTP tracing under load. The tracer's span buffer kept each of its 1024
  most recent spans as an object plus four strings, and under load each lived long enough to be
  promoted by V8 and die in the old generation (about 3× the agent-off promotion rate on a
  promise-heavy server, and about 25 MiB more RSS after a minute). Spans are now stored as bytes
  in preallocated slots, which take about 280 KiB for the default 1024 spans. Promotion and
  steady-state RSS now match the agent-off run. What is buffered, dropped and exported is
  unchanged.
- Lower per-request CPU cost of HTTP tracing. Trace and span ids are now cut from a 4 KiB buffer
  of CSPRNG bytes refilled as it runs out, instead of one `randomBytes()` call (and Buffer) per
  id; a CPU profile of the overhead benchmark put those calls at about 16% of the busy time of a
  traced server. Ids keep their format (lowercase hex, never all zeros) and no byte is used twice.
- The dashboard no longer reports a normal SSE client disconnect as a server error. A write to a
  connection the client had already closed (`EPIPE`) is now treated like `ECONNRESET`: the client
  is cleaned up and `onError` (or the process warning) is not called. Other errors on an SSE
  response or socket are still reported, and cleanup stays idempotent.
- `summarizeHeapSnapshot` and `diffHeapSnapshots` (`@pharn-dev/phargus/analyzer`) no longer time
  out on large snapshots within a raised `maxSnapshotBytes` (review finding F27). The task timeout
  is now `max(30 s, size / 20 MB/s)`, summed over both files for a diff, computed by the new
  `heapSnapshotTimeoutMs(bytes)` export. It applies when no `timeoutMs` is passed and the pool is
  the one the call makes or one from `createHeapSnapshotPool()` without `taskTimeoutMs`. An
  explicit `timeoutMs` always wins, and a pool made with `taskTimeoutMs`, `createWorkerPool` or
  anything else keeps its own timeout. At the default 256 MiB cap the timeout stays 30 s.
- Collector persistence no longer backpressures `consume()` (review finding F25). A slow disk used
  to hold every window up behind the append, all the way back to the source. Windows now go
  through a bounded queue and are appended one at a time, in emission order, off the pipeline.
  `persist.maxQueueSize` sets how many wait (default 1024); it must be a positive safe integer,
  or `createCollector` throws a `RangeError`. When the queue is full the oldest window is dropped.
  `collector.persistence.dropped` counts those drops and `collector.persistence.failed` counts
  windows whose append failed (both integers). A failed append still rejects `consume()` with the
  append error, now without waiting for the source to end. `close()` and the end of `consume()`
  wait for the queue to drain, with no time limit, so a disk that never completes an append
  stalls `close()`. `close()` stops accepting windows before it drains, so a `consume()` still
  running cannot hold it open; a window that arrives after it is counted in `failed`.
- OTLP exporters (`@pharn-dev/phargus/otel`) no longer lose spans and windows under load (review
  finding F2). They used to send one request per exported span or window, with one request in
  flight, and silently dropped the newest batch once 64 were queued. They now batch: pending
  items go out in one request when `maxBatchSize` (default 512) items are pending or after
  `flushIntervalMs` (default 1000 ms), one request at a time. At most `maxQueueSize` (default 2048) items are held; when full, the OLDEST pending items are dropped, counted and reported
  through `onError` as aggregated "dropped" reports. New counters `droppedItems`, `exportedItems`
  and `failedItems` sit beside `droppedBatches` and `failedBatches`. The flush timer is
  `unref()`ed and armed only while items are pending. A record that cannot be encoded fails only
  itself. Behaviour change: one export call is no longer one request, and the first send waits up
  to `flushIntervalMs` unless a full batch is pending; call `close()` or `flush()` before exit.
  `queueCapacity` is deprecated: still accepted and validated, but it no longer bounds anything
  (the queue holds items, not batches); use `maxQueueSize`.
- Dashboard: a client that connects to `/events` now receives the collector's whole history
  (every buffered alert, window and span) instead of losing part of it to the live-event drop
  queue; with full buffers it previously got no alerts and a truncated window history. The replay
  is written in one call outside that queue, alerts first, then windows, then spans.
  `maxBufferedEvents` and `droppedEvents` now cover live events only.
- Dashboard: a request whose `Host` is not allowed still gets `421`, but now with a short
  `text/plain` body naming the `allowedHosts` option and `phargus serve --allowed-host` (review
  finding F24). It used to be bodyless, so behind a proxy or a container port map the browser
  showed a blank page. The rejected `Host` is not echoed back.
- The collector no longer dies on non-agent stdout lines. `collector.consume()` now accepts any
  parsed records: foreign records (not agent data) and malformed ones (agent-shaped but unusable)
  are skipped and counted in `collector.ignored`, with an optional `onIgnored` hook, instead of
  rejecting `consume()`. Malformed agent records are skipped rather than thrown. The new
  `createNdjsonDecoder` export turns the byte stream into objects with bounded line memory and
  counts non-object (`invalid`) and over-long (`oversized`) lines.
- Event loop figures no longer include the 10 ms timer interval (review finding F16). The
  sampler's histogram records the whole interval on every tick, so an idle process reported a min
  of about 10 ms and a p50 of about 11 ms, the dashboard showed that as lag, and any alert
  threshold below about 12 ms always fired. `createEventLoopSampler` now passes an explicit
  `resolution` to `monitorEventLoopDelay` and subtracts it from min, max, mean, p50 and p99,
  clamped at 0 in integer nanoseconds, so the values are delay beyond the timer interval and an
  idle loop reads close to 0. It takes an optional `{ resolution }` (whole milliseconds, default
  10; anything else throws a `RangeError`), and the agent exports the `EventLoopSamplerOptions`
  type. Behaviour change: every event loop value, and every window and OTLP metric built from it,
  is about 10 ms lower. The bundled `phargus/event-loop-lag` rule (100 ms default) and the
  example app's 50 ms alert are unchanged; a threshold you set close to 10 ms now fires only on
  real delay.

### Changed

- The agent no longer warns about `PHARGUS_TOKEN` and `PHARGUS_DEBUG`. They belong to
  `phargus serve`, and the agent now ignores them silently, so a shell or container that runs
  both sides of the pipe can set them once. Other unknown `PHARGUS_*` variables still warn.
- Releases now publish on merge: a PR that bumps the version (with its lockfile and a
  `## [X.Y.Z]` section here) is the release. Every push to `main` runs the jobs gate, build,
  publish and release, which release only when `package.json`'s version has no tag yet; the GitHub
  Release notes are that version's section of this file. `NPM_PUBLISH_ENABLED` still has to be
  `true` for the publish and release jobs to run. Checks for the release notes, the version files
  and the workflow run under `npm test`.
- CI: the non-required `node-latest` workflow now also runs `Platform smoke` jobs on
  `windows-latest` and `macos-latest` (review finding F21). On the `.nvmrc` Node floor they run
  `npm ci`, build, `check:exports` and `npm test`, so platform-specific code paths (plugin child
  script paths, the symbolizer worker, process groups) get some CI coverage. The required checks
  still run on Linux only. `.gitattributes` now checks text files out with LF on every platform.
  On Windows, the tests for signal-driven graceful shutdown, a non-writable heap snapshot
  directory, the packed bin's execute bit and the release-workflow check are skipped;
  `docs/LIMITS.md` records these limits. The idle event loop tests now bound p50 by the sampler's
  resolution instead of 5 ms, because Windows timers leave an idle loop at about 5 ms.

### Removed

- The public entry points of `@pharn-dev/phargus/agent`, `/collector`, `/dashboard` and
  `/plugin-runner` no longer export internals and scaffold placeholders (review findings F18,
  F19). This is **breaking** for 0.x consumers that imported them. What is left is the list in
  [`docs/API.md`](./docs/API.md). Removed:
  - `agent`: `encodeNdjsonLine`, `createSpanExport`, `SpanExport`, `enable`, `disable`,
    `drainSpans`, `DEFAULT_SPAN_BUFFER_SIZE`, `HttpTracingOptions`, `SpanDrain`, `toSpanRecord`,
    `isSpanRecord`, `PhargusAgentPlaceholder`
  - `collector`: `createWindowAggregator`, `WindowAggregatorOptions`, `createSpanRouter`,
    `parseWindowLine`, `serializeWindow`, `CollectorPlaceholder`
  - `dashboard`: `DashboardPlaceholder`
  - `plugin-runner`: `PluginRunnerPlaceholder`

## [0.1.0] - 2026-10-12

First release of Phargus (`@pharn-dev/phargus`).

### Added

- Release preparation workflow that validates a tarball without publishing, with explicit opt-in
  for later GitHub Release publishing.
- Installed-package checks for ESM/CJS imports and types, analyzer workers, plugin sandbox, and
  the agent → collector → dashboard SSE flow.

- Single npm package with subpath exports, built as both ESM and CommonJS.
- Open-source baseline: `README.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `docs/THREAT-MODEL.md`,
  `docs/LIMITS.md`, issue and pull request templates.
- CI: format, lint, typecheck, test, build, action-pin checks, CodeQL and gitleaks.
- Manual release process with npm Trusted Publishing and provenance.
- Agent: event loop delay and memory samplers driven by a sampler controller.
- Agent: NDJSON export stream with bounded, drop-oldest backpressure, to stdout or a file.
- Agent: configuration from `PHARGUS_*` environment variables and `phargus.config.{js,json}`.
- Agent: GC sampler (count and pause times by kind) from `PerformanceObserver`.
- Agent: stream backpressure probe that reports stalled writes by call site.
- Agent: `require('@pharn-dev/phargus/agent')` / `import '@pharn-dev/phargus/agent'` (or `--require`/`--import`) starts the
  agent once per process.
- Agent: automatic trace id per incoming `node:http`/`node:https` request through
  `AsyncLocalStorage`, honouring an incoming W3C `traceparent`; `currentTraceId()`.
- Agent: V8 heap space statistics in every sample and on-demand heap snapshots
  (`takeHeapSnapshot`).
- Agent: on-demand allocation sampling through the inspector (`sampleAllocations`).
- Agent: a parser for `node --trace-deopt` output (`createDeoptParser`). It does not capture the
  output itself.
- Agent: runs under the Node permission model; a denied grant disables only that feature with a
  typed `PhargusPermissionError`; `isPermissionModelEnabled()` and `checkPermission()`.
- Agent: HTTP spans exported as NDJSON lines next to samples.
- Collector (`@pharn-dev/phargus/collector`): fixed time windows with integer math and ring buffers of recent
  windows, alerts and spans.
- Collector: window-based alerts with per-metric thresholds.
- Collector: alert sinks for stdout, a file and a webhook (Node core `fetch`).
- Collector: opt-in persistence of recent windows to an append-only file, restored on start.
- Dashboard (`@pharn-dev/phargus/dashboard`): SSE server with token gating for non-loopback binds.
- Dashboard: vanilla-JS live page with event loop, memory, GC, alerts and a trace waterfall of
  recent requests.
- Analyzer (`@pharn-dev/phargus/analyzer`): Worker Thread pool with heap-snapshot summaries and diffs.
- Analyzer: source-map stack-trace symbolization on the worker pool.
- Plugin runner (`@pharn-dev/phargus/plugin-runner`): user rules in an `isolated-vm` sandbox in a child process,
  with a memory limit and a timeout.
- Plugin runner: built-in rules (event loop lag, GC pause share, heap growth) and
  `loadRulesDirectory`.
- OpenTelemetry (`@pharn-dev/phargus/otel`): opt-in OTLP/HTTP JSON export of windows as metrics and spans as
  traces.
- Examples: `examples/express-app` (agent in the app, collector and dashboard in a second process)
  and `examples/worker-pool`.
- Agent: every sample line carries cumulative `dropped: { samples, spans }` loss counters.
- Agent: `createDeoptParser({ maxEvents, maxLineLength })` and `droppedEvents()`.
- Agent: `createSamplerController(onSample, { onError })`; new `PhargusSamplerWarning` and
  `PhargusBackpressureWarning` process warnings.
- Dashboard: `allowedHosts` option for names the dashboard is reached by (reverse proxy, container
  port mapping).
- Collector and OpenTelemetry: `closeTimeoutMs` option on the webhook sink and the OTLP exporters;
  `WindowStore.close()`.
- Analyzer: `maxSnapshotBytes` option (default 256 MiB) and `HeapSnapshotTooLargeError`
  (`ERR_HEAP_SNAPSHOT_TOO_LARGE`); `DEFAULT_RESOURCE_LIMITS`, `DEFAULT_MAX_SNAPSHOT_BYTES`.
- Analyzer: symbolizer `roots` option (reads confined by `realpath`) and `maxFileBytes` (default
  64 MiB); `DEFAULT_MAX_SOURCE_FILE_BYTES`.
- Plugin runner: `maxFindings` (default 10 000) and `maxResultBytes` (default 1 MiB) options.
- `bench/overhead.mjs` (agent-on versus agent-off benchmark), `bench/soak.mjs` (leak checks under
  load) and a nightly workflow that runs both.
- CI: `npm run check:package` in the Build job checks the tarball contents and that
  `engines.node` matches `.nvmrc`.

### Changed

- Renamed the project and npm package to Phargus (`@pharn-dev/phargus`). Imports and preloads now
  use `@pharn-dev/phargus/<subpath>`; configuration uses `PHARGUS_*` environment variables and
  `phargus.config.{js,json}`. Existing integrations must update those names.
- Renamed public errors and warnings to `Phargus*`, error codes to `PHARGUS_*`, built-in rule IDs
  and OpenTelemetry metric names to `phargus/...` and `phargus.*`, and the dashboard session
  cookie to `phargus_token` (existing dashboard sessions must sign in again).
- `engines.node` is now `>=22.18.0`, and `.nvmrc` pins `22.18.0`; required CI jobs run on that
  floor.
- The package no longer ships declaration maps or the analyzer test fixture; `.js.map` files embed
  their sources.
- Agent: an unknown `PHARGUS_*` variable prints one warning on stderr and is ignored, instead of
  disabling the agent.
- Agent: samples and spans are queued in separate lanes, each bounded by `queueBound`; sample lines
  are written first.
- Agent: the backpressure probe also covers `Duplex`, `Transform`, `PassThrough`, `net.Socket`,
  `tls.TLSSocket`, `http.ServerResponse` and `http.ClientRequest`.
- Agent: an ESM and a CJS copy of the agent share one set of prototype wrappers.
- Agent: `traceparent` with an all-zero parent id starts a new trace; versions other than `00` are
  parsed with the `00` layout.
- Dashboard: requests whose `Host` is not allowed get `421`; a cross-origin `Origin` on `/events`
  or a non-GET request gets `403`.
- Dashboard: `?token=` is accepted only on `GET /` and exchanged for an `HttpOnly`,
  `SameSite=Strict` cookie; assets and `/events` take the cookie or `Authorization: Bearer`.
- Dashboard: malformed-request warnings are rate-limited to one report plus one summary per 10 s;
  client resets are not reported.
- Collector and OpenTelemetry: `close()` waits at most `closeTimeoutMs`, then drops queued batches
  and aborts in-flight requests, counting both.
- Collector: `collector.close()` closes the sinks first and latches the window store.
- Analyzer: every pool worker runs with `resourceLimits` (default 512 MiB old, 64 MiB young
  generation).
- Analyzer: the heap-snapshot worker streams the file; snapshots must list `snapshot`, `nodes` and
  `strings` in V8's order and have at most 262 144 distinct object names.
- Analyzer: workers no longer inherit entry-point flags such as `--input-type`, `-e` or
  `--inspect`.
- Plugin runner: the sandbox child receives the host's `--permission`, `--experimental-permission`
  and `--allow-*` flags.

### Fixed

- Agent: requests that arrive while the agent configuration loads are traced.
- Agent: spans no longer evict metric samples from the output queue under load.
- Agent: disabling the backpressure probe or tracing never leaves a throwing `write` or `emit`
  behind and never removes a wrapper another library installed later.
- Agent: the stream `write` wrappers keep the original arity (`write.length === 3`).
- Agent: a throwing `onSample` callback no longer becomes an uncaught exception.
- Agent: the deopt parser no longer keeps every event forever.
- Analyzer: an oversized heap snapshot can no longer abort the host process with a fatal
  out-of-memory error.
- Analyzer: a host started with `--input-type=module -e` can start analyzer workers.
- Collector: `append()` after `collector.close()` no longer reopens the persistence file.
- Dashboard: a stalled SSE client no longer retains dropped events.

### Security

- Dashboard: `Host`/`Origin` allowlist against DNS rebinding.
- Dashboard: the token no longer appears in page, asset or SSE URLs; the session cookie holds an
  HMAC of the token, not the token. `/events` and error responses send `nosniff`, a
  `default-src 'none'` CSP and `Referrer-Policy: no-referrer`.
- Collector and OpenTelemetry: webhook and OTLP requests never follow redirects (a 3xx is a failed
  delivery) and read at most 64 KiB of a response body.
- Files the agent, the window store and the file alert sink create are mode `0600`.
- Analyzer: symbolizer parse errors no longer quote file content.
- Plugin runner: rule results are capped in the child and validated on the host; rule error
  messages are cut to 4 096 characters.
