# API reference

This page lists every supported export of `@pharn-dev/phargus`, one section per `exports` subpath.
Anything not listed on this page is internal: it can change or disappear in any release, including
a patch release. That covers files you could reach by a deep path such as
`@pharn-dev/phargus/dist/esm/agent/http-tracing.js` too.

`npm run check:exports` enforces the runtime lists below: it loads each subpath through `import` and
`require` and fails when the loaded names differ from the expected list, in either direction. The
type lists are not runtime exports and are checked by reading the declaration files.

## `@pharn-dev/phargus/agent`

Importing this subpath starts the agent (it reads `PHARGUS_*` variables and `phargus.config.json`,
never a `.js` config, and writes NDJSON to the configured output), whichever of the functions below you import. The functions work next to the
running agent: the trace context, on-demand heap and allocation diagnostics, and the deopt parser.
To call them with the agent off, set `PHARGUS_ENABLED=false` (or `PHARGUS_OUTPUT=none`) before the
import: then nothing is patched and no config file is read. A worker thread never starts the agent.

**Runtime exports**

- `ANONYMOUS_FUNCTION` — the function name the deopt parser reports for an unnamed function
- `DEPENDENT_CODE_KIND` — the deopt event kind reported for dependent-code deoptimizations
- `PhargusPermissionError` — what `takeHeapSnapshot` rejects with when the Node permission model
  denies the write
- `SPAN_RECORD_TYPE` — the `type` value of a span line in the NDJSON stream
- `createDeoptParser` — creates a parser for `--trace-deopt` output
- `currentTraceId` — returns the trace id of the current async context, if any
- `runWithTrace` — runs a function inside a fresh trace context with a new trace id (it takes no id)
- `sampleAllocations` — takes an allocation profile and returns the top allocation sites. Defaults:
  `samplingInterval` 32768 bytes (V8's own), `durationMs` 1000 ms, `limit` 20 sites
- `sampleHeapSpaces` — samples `v8.getHeapSpaceStatistics()`
- `takeHeapSnapshot` — writes a heap snapshot to disk on demand

**Types**

- `AgentLossCounters` — counters for samples and spans the agent dropped
- `AgentSample` — one combined sampler reading
- `AgentSampleLine` — the NDJSON line shape for a sample
- `AllocationSamplingOptions` — options for `sampleAllocations`
- `AllocationSite` — one allocation site in an allocation profile
- `BackpressureHotspot` — one stream with recorded backpressure stalls
- `BackpressureSample` — one backpressure reading
- `DeoptEvent` — one parsed deoptimization event
- `DeoptLocation` — a source location in a deoptimization event
- `DeoptParser` — the deopt output parser
- `DeoptParserOptions` — options for `createDeoptParser`
- `EventLoopSample` — one event loop delay reading
- `GcSample` — one garbage collection reading
- `HeapSnapshotOptions` — options for `takeHeapSnapshot`
- `HeapSnapshotResult` — the result of `takeHeapSnapshot`
- `HeapSpaceEntry` — one V8 heap space reading
- `HeapSpaceSample` — all heap spaces at one moment
- `MemorySample` — one memory reading
- `SpanRecord` — a trace span as it appears in the NDJSON stream
- `TraceSpan` — a finished HTTP request span

## `@pharn-dev/phargus/collector`

**Runtime exports**

- `DEFAULT_MAX_LINE_BYTES` — default longest NDJSON line the decoder accepts
- `DEFAULT_SPAN_CAPACITY` — default number of spans the collector keeps
- `createAlertEvaluator` — creates a transform that turns windows into alerts
- `createCollector` — creates the collector that aggregates samples into windows and keeps spans
- `createFileSink` — creates an alert sink that appends to a file
- `createNdjsonDecoder` — creates a transform that splits a byte stream into NDJSON records
- `createRingBuffer` — creates a fixed-size buffer that drops the oldest item when full
- `createSinks` — builds alert sinks from sink configurations
- `createStdoutSink` — creates an alert sink that writes to stdout
- `createWebhookSink` — creates an alert sink that posts to a URL
- `createWindowStore` — creates the in-memory window store, with optional disk persistence
- `validateAlertRules` — checks alert rules and returns them typed

**Types**

- `AggregatedWindow` — one aggregated time window
- `Alert` — an alert raised by a rule
- `AlertComparison` — the comparison an alert rule applies
- `AlertMetric` — a metric an alert rule can watch
- `AlertRule` — an alert rule
- `AlertSink` — a destination for alerts
- `AlertState` — whether an alert is firing or resolved
- `Collector` — the collector
- `CollectorListener` — a callback for collector events
- `CollectorOptions` — options for `createCollector`
- `FileSinkOptions` — options for `createFileSink`
- `IgnoredReason` — why the collector ignored a record
- `IgnoredRecordHandler` — a callback for ignored records
- `NdjsonDecoder` — the NDJSON decoder
- `NdjsonDecoderOptions` — options for `createNdjsonDecoder`
- `NdjsonSkip` — a line the decoder skipped, with the reason
- `PersistOptions` — options for disk persistence of windows
- `RingBuffer` — the ring buffer
- `SinkConfig` — a sink configuration object
- `SinkErrorHandler` — a callback for sink errors
- `SinkInput` — a sink configuration or a ready sink
- `SpanRecord` — a trace span record, re-exported from the agent
- `StdoutSinkOptions` — options for `createStdoutSink`
- `WebhookSinkOptions` — options for `createWebhookSink`
- `WindowPersistence` — the persistence hook the collector writes windows through
- `WindowStore` — the window store

### Options

`createCollector(options)` takes:

- `windowMs` (required) — window length in ms, a positive integer.
- `capacity` (required) — how many windows, and separately how many alerts, the collector keeps in
  memory; the oldest is dropped when full.
- `spanCapacity` — how many spans it keeps (default `DEFAULT_SPAN_CAPACITY`, 1024).
- `alerts` — alert rules, checked when the collector is created (a bad rule throws, naming its id).
- `sinks` — where alerts go, besides `collector.alerts`.
- `onSinkError(error, sink)` — called with each sink error, such as a failed delivery. Without it
  the error becomes a process warning.
- `persist` — opt-in disk persistence of windows.
- `onIgnored` — called once for each record `consume()` skips.

**Alert rules.** A rule is `{ id, metric, comparison, threshold, forWindows? }`:

- `id` — a non-empty string, unique among the rules.
- `metric` — one window field, by name:

  | Metric                                             | Unit        |
  | -------------------------------------------------- | ----------- |
  | `eventLoop.max`, `eventLoop.p99`, `eventLoop.mean` | nanoseconds |
  | `memory.heapUsedLast`, `memory.heapUsedMax`        | bytes       |
  | `memory.rssLast`, `memory.rssMax`                  | bytes       |
  | `gc.count`                                         | count       |
  | `gc.totalPause`, `gc.maxPause`                     | nanoseconds |
  | `backpressure.events`                              | count       |
  | `backpressure.totalStall`, `backpressure.maxStall` | nanoseconds |

- `comparison` — `'>'` or `'>='`.
- `threshold` — a non-negative safe integer in the metric's unit: 50 ms is `50_000_000`, 512 MiB
  is `536_870_912`. No floats and no unit suffixes.
- `forWindows` — how many adjacent windows in a row must breach before the rule fires, an integer
  of at least 1 (default 1). Windows are adjacent when one starts where the previous one ended; a
  gap resets the count.

A rule is edge-triggered: it raises one `firing` alert when it starts breaching and one `resolved`
alert on the first window that does not breach, not one alert per window. Its state carries across
`consume()` calls. `phargus serve --alert '<metric><op><threshold>[:<windows>]'` builds the same
rule from the command line, with unit suffixes (see the README).

**Sinks.** Each entry in `sinks` is a ready `AlertSink` (from `createStdoutSink`, `createFileSink`,
`createWebhookSink` or your own) or a config object; every entry may carry a `name` for its error
messages:

- `{ type: 'stdout', stream? }` — one JSON line per alert to `stream` (default `process.stdout`).
- `{ type: 'file', path }` — one JSON line per alert appended to `path` (created with mode `0600`).
- `{ type: 'webhook', url, ... }` — a `POST` of each alert as JSON:
  - `url` — `http:` or `https:`. A URL with a username or password is refused: put credentials in
    `headers`.
  - `headers` — extra request headers. `content-type` is reserved (always `application/json`).
    Values never appear in logs or errors.
  - `timeoutMs` — per-request timeout (default 5000).
  - `retries` — extra attempts after a network error, a timeout or a 5xx (default 2). A 4xx or a
    redirect is not retried, and redirects are never followed.
  - `backoffMs` — wait before the first retry, doubled for each later one (default 100).
  - `maxInFlight` — most alerts being delivered at once (default 100). Alerts beyond that are
    dropped and reported.
  - `closeTimeoutMs` — how long `close()` waits for in-flight requests before it aborts them
    (default `timeoutMs`).

An unknown sink type or a bad option throws when the collector is created. Every alert goes to every
sink, and a failing sink never stops the others. A sink counts its losses in `failed` and `dropped`.

**Persistence.** `persist: { path, maxBytes, maxQueueSize? }` appends each closed window as one JSON
line to `path` (created with mode `0600`). `maxBytes` (required, a positive integer) caps the file.
When the next line would pass it, the file is rewritten with the newest windows that fit in half of
`maxBytes`. The first `consume()` restores the windows already in the file into `collector.windows`.
`maxQueueSize` (default 1024) is how many windows may wait for the disk; when full, the oldest is
dropped and counted in `collector.persistence.dropped`. A disk failure never stops the collector:
it is counted in `collector.persistence.failed` and reported as a process warning.

Example, from `src/collector/collector-alert-sinks.ac3.integration.test.ts` (here `stream` is any
`Writable` and `server.url` a local HTTP endpoint):

```js
import { createCollector } from '@pharn-dev/phargus/collector';

const rules = [{ id: 'loop-max', metric: 'eventLoop.max', comparison: '>', threshold: 100 }];

const collector = createCollector({
  windowMs: 1000,
  capacity: 10,
  alerts: rules,
  sinks: [
    { type: 'stdout', stream },
    { type: 'webhook', url: server.url, retries: 0, timeoutMs: 2000 },
  ],
  onSinkError: (error) => {
    sinkErrors.push(error);
  },
});
```

The threshold `100` there is 100 nanoseconds, a test value. To persist windows too, add for example
`persist: { path, maxBytes: 1_000_000 }` (from `src/collector/collector-bounds.integration.test.ts`).

## `@pharn-dev/phargus/analyzer`

**Runtime exports**

- `DEFAULT_MAX_SNAPSHOT_BYTES` — default largest heap snapshot the analyzer reads
- `DEFAULT_MAX_SOURCE_FILE_BYTES` — default largest source or source map file the symbolizer reads
- `DEFAULT_RESOURCE_LIMITS` — default memory limits for worker threads
- `HeapSnapshotTooLargeError` — thrown when a heap snapshot exceeds the size limit
- `MalformedSourceMapError` — thrown when a source map cannot be parsed
- `WorkerCrashedError` — a worker thread exited while running a task
- `WorkerPoolClosedError` — a task was submitted to a closed pool
- `WorkerQueueFullError` — the pool queue is full
- `WorkerTaskError` — a task threw inside the worker
- `WorkerTaskTimeoutError` — a task ran longer than its timeout
- `createHeapSnapshotPool` — creates a worker pool for heap snapshot work
- `createSymbolizationPool` — creates a worker pool for stack-trace symbolization
- `createWorkerPool` — creates a general worker thread pool
- `diffHeapSnapshots` — compares two heap snapshot files by path: per-type count and self-size
  changes, unchanged types left out, growth and shrink ranked together by absolute size change
- `heapSnapshotTimeoutMs` — the default heap snapshot analysis timeout for a file of a given size
- `summarizeHeapSnapshot` — summarizes a heap snapshot file by constructor type
- `symbolizeStackFrames` — maps stack frames back to original source positions

**Types**

- `HeapSnapshotDiff` — the difference between two heap snapshots
- `HeapSnapshotDiffEntry` — one row of a snapshot diff
- `HeapSnapshotSummary` — a snapshot summary
- `HeapSnapshotTypeStats` — counts and sizes for one type in a summary
- `OriginalPosition` — a position in the original source
- `StackFrame` — a stack frame to symbolize
- `SymbolizedFrame` — a stack frame with its original position
- `WorkerPool` — the worker pool
- `WorkerPoolOptions` — options for `createWorkerPool`

## `@pharn-dev/phargus/dashboard`

**Runtime exports**

- `createDashboardServer` — creates the HTTP server that serves the dashboard and its SSE stream
- `isLoopbackHost` — true for `localhost`, `::1` and `127.0.0.0/8`

**Types**

- `DashboardServer` — the dashboard server
- `DashboardServerOptions` — options for `createDashboardServer`

## `@pharn-dev/phargus/plugin-runner`

**Runtime exports**

- `BuiltinRuleId` — the ids of the built-in rules
- `RuleErrorCode` — the error codes a rule run can report
- `RuleParameterError` — thrown for an invalid rule parameter
- `createPluginRunner` — creates the sandboxed rule runner
- `eventLoopLagRule` — the built-in event loop lag rule
- `gcPauseShareRule` — the built-in GC pause share rule
- `heapGrowthRule` — the built-in heap growth rule
- `loadRulesDirectory` — loads rule files from a directory
- `runRules` — runs a set of rules over aggregated windows

**Types**

- `EventLoopLagParams` — parameters of the event loop lag rule
- `GcPauseShareParams` — parameters of the GC pause share rule
- `HeapGrowthParams` — parameters of the heap growth rule
- `PluginRunner` — the rule runner
- `PluginRunnerOptions` — options for `createPluginRunner`
- `RuleDescriptor` — the description of a rule
- `RuleErrorCodeValue` — one value of `RuleErrorCode`
- `RuleFinding` — a finding a rule produced
- `RuleLoadFailure` — a rule file that failed to load
- `RuleResults` — the results of `runRules`
- `RuleRunResult` — the result of one rule
- `RulesDirectoryResult` — the result of `loadRulesDirectory`

### Writing a rule

The plugin runner needs `isolated-vm` 6.x, an optional peer dependency: `npm install isolated-vm`.
Without it every run fails with `PHARGUS_ISOLATED_VM_MISSING`.

A rule is the **body of a function** that receives `windows`, an array of collector windows
(`AggregatedWindow`, in the order you pass them). It returns an array of findings,
`[{ windowStart, message }]`, where `windowStart` is the `start` of the window the finding is about
(an integer) and `message` is a string. An empty array means nothing was found.

- The body runs synchronously in strict mode, in a fresh `isolated-vm` isolate inside a child
  process. It sees a JSON copy of the windows and plain JavaScript only: no `require`, no
  `process`, no Node APIs. A returned promise is not awaited.
- Window values use the units of the alert metrics above: nanoseconds for lag, pauses and stalls,
  bytes for memory, all integers.
- Findings are **returned to the caller, not raised as alerts**: `runner.run()` resolves to
  `{ ok: true, findings }` or `{ ok: false, error: { code, message } }`, and never rejects. Nothing
  goes to the collector's alerts or sinks.

Limits for one run, set through `createPluginRunner(options)`:

| Option           | Default | Exceeding it fails with                           |
| ---------------- | ------- | ------------------------------------------------- |
| `timeoutMs`      | 1000    | `PHARGUS_RULE_TIMEOUT`                            |
| `memoryLimitMb`  | 64      | `PHARGUS_RULE_MEMORY_LIMIT` (the minimum is 8)    |
| `maxFindings`    | 10 000  | `PHARGUS_RULE_INVALID_RESULT`                     |
| `maxResultBytes` | 1 MiB   | `PHARGUS_RULE_INVALID_RESULT` (the result's JSON) |

A rule that throws fails with `PHARGUS_RULE_THREW`, one that does not compile with
`PHARGUS_RULE_COMPILE_ERROR`, and a result that is not an array of `{ windowStart, message }` with
`PHARGUS_RULE_INVALID_RESULT`. A failing rule is not disabled; you decide whether to run it again.

**Rule files.** `loadRulesDirectory(dir)` reads every `.js` file directly inside `dir`
(subdirectories are not read) as rule text, sorted by name. The rule's id is the file name without
`.js`. The host process never imports or evaluates the text; only the sandbox runs it. A file over
1 MiB is not read and is reported in `failures` with `PHARGUS_RULE_FILE_UNREADABLE`; so is a file
that cannot be read. A directory that cannot be listed gives
`{ ok: false, error: { code: 'PHARGUS_RULES_DIR_UNREADABLE' } }`.
`runRules(runner, rules, windows)` runs the loaded rules (and the built-ins, if you add them) one
after another and returns one result per rule id. A duplicate id fails every copy with
`PHARGUS_RULE_DUPLICATE_ID`. You create and close the runner.

Example, from `src/plugin-runner/plugin-runner-sandbox.ac1.integration.test.ts`. Saved as a `.js`
file, `RULE_SOURCE` is also a rule file `loadRulesDirectory` can load:

```js
import { createPluginRunner } from '@pharn-dev/phargus/plugin-runner';

const RULE_SOURCE = `
const findings = [];
for (const w of windows) {
  if (w.eventLoop.max > 100) {
    findings.push({ windowStart: w.start, message: 'event-loop max ' + w.eventLoop.max });
  }
}
return findings;
`;

const runner = createPluginRunner();
const windows = [windowAt(1_000, 50), windowAt(2_000, 500), windowAt(3_000, 50)];
const result = await runner.run(RULE_SOURCE, windows);
// result: { ok: true, findings: [{ windowStart: 2000, message: 'event-loop max 500' }] }
await runner.close();
```

`windowAt(start, eventLoopMax)` is the test's helper that builds a full window.

## `@pharn-dev/phargus/otel`

**Runtime exports**

- `AGGREGATION_TEMPORALITY_DELTA` — the OTLP delta aggregation temporality value
- `SPAN_KIND_SERVER` — the OTLP server span kind value
- `STATUS_CODE_ERROR` — the OTLP error status code value
- `STATUS_CODE_UNSET` — the OTLP unset status code value
- `createOtlpMetricsExporter` — creates an OTLP/HTTP JSON exporter for collector windows
- `createOtlpTraceExporter` — creates an OTLP/HTTP JSON exporter for spans
- `toOtlpMetrics` — converts windows to an OTLP metrics request body
- `toOtlpTraces` — converts spans to an OTLP traces request body

**Types**

- `OtlpExporterOptions` — options shared by both exporters
- `OtlpMetric` — one OTLP metric
- `OtlpMetricsExporter` — the metrics exporter
- `OtlpMetricsExporterOptions` — options for `createOtlpMetricsExporter`
- `OtlpMetricsRequest` — an OTLP metrics request body
- `OtlpNumberDataPoint` — one OTLP number data point
- `OtlpSpan` — one OTLP span
- `OtlpTraceExporter` — the trace exporter
- `OtlpTraceExporterOptions` — options for `createOtlpTraceExporter`
- `OtlpTracesRequest` — an OTLP traces request body
