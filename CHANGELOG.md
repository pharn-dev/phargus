# Changelog

All notable changes to Phargus are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Releases publish when a version-bump PR merges to
`main`; see [`docs/RELEASING.md`](./docs/RELEASING.md).

## [Unreleased]

### Added

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

### Fixed

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
  On Windows, the tests for signal-driven graceful shutdown and for a non-writable heap snapshot
  directory are skipped; `docs/LIMITS.md` records both limits.

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
