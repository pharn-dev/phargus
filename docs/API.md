# API reference

This page lists every supported export of `@pharn-dev/phargus`, one section per `exports` subpath.
Anything not listed on this page is internal: it can change or disappear in any release, including
a patch release. That covers files you could reach by a deep path such as
`@pharn-dev/phargus/dist/esm/agent/http-tracing.js` too.

`npm run check:exports` enforces the runtime lists below: it loads each subpath through `import` and
`require` and fails when the loaded names differ from the expected list, in either direction. The
type lists are not runtime exports and are checked by reading the declaration files.

## `@pharn-dev/phargus/agent`

Importing this subpath also starts the agent (it reads `PHARGUS_*` variables and writes NDJSON to
the configured output). The functions below are the library API for code that wants the pieces
without relying on the auto-start.

**Runtime exports**

- `ANONYMOUS_FUNCTION` — the function name the deopt parser reports for an unnamed function
- `DEFAULT_ALLOCATION_SAMPLING_DURATION_MS` — default length of one allocation sampling run
- `DEFAULT_ALLOCATION_SAMPLING_INTERVAL` — default allocation sampling interval, in bytes
- `DEFAULT_ALLOCATION_SITE_LIMIT` — default number of allocation sites returned
- `DEPENDENT_CODE_KIND` — the deopt event kind reported for dependent-code deoptimizations
- `PhargusConfigError` — thrown for an invalid agent configuration value
- `PhargusPermissionError` — thrown when the Node permission model denies something the agent needs
- `SPAN_RECORD_TYPE` — the `type` value of a span line in the NDJSON stream
- `assertPermission` — throws `PhargusPermissionError` unless a permission scope is granted
- `checkPermission` — reports whether a permission scope is granted
- `createBackpressureProbe` — creates the stream backpressure probe
- `createDeoptParser` — creates a parser for `--trace-deopt` output
- `createEventLoopSampler` — creates the event loop delay sampler
- `createGcSampler` — creates the garbage collection sampler
- `createNdjsonExporter` — creates an exporter that writes records as NDJSON with backpressure
- `createSamplerController` — creates the controller that runs all samplers on an interval
- `currentTraceId` — returns the trace id of the current async context, if any
- `defaultAgentConfig` — the agent configuration used when nothing is set
- `isPermissionModelEnabled` — reports whether the process runs with the permission model
- `loadAgentConfig` — builds the agent configuration from the environment
- `runWithTrace` — runs a function inside a given trace id
- `sampleAllocations` — takes an allocation profile and returns the top allocation sites
- `sampleHeapSpaces` — samples `v8.getHeapSpaceStatistics()`
- `sampleMemory` — samples process memory usage
- `takeHeapSnapshot` — writes a heap snapshot to disk on demand

**Types**

- `AgentConfig` — the validated agent configuration
- `AgentLossCounters` — counters for samples and spans the agent dropped
- `AgentSample` — one combined sampler reading
- `AgentSampleLine` — the NDJSON line shape for a sample
- `AllocationSamplingOptions` — options for `sampleAllocations`
- `AllocationSite` — one allocation site in an allocation profile
- `BackpressureHotspot` — one stream with recorded backpressure stalls
- `BackpressureProbe` — the backpressure probe
- `BackpressureProbeOptions` — options for `createBackpressureProbe`
- `BackpressureSample` — one backpressure reading
- `DeoptEvent` — one parsed deoptimization event
- `DeoptLocation` — a source location in a deoptimization event
- `DeoptParser` — the deopt output parser
- `DeoptParserOptions` — options for `createDeoptParser`
- `EventLoopSample` — one event loop delay reading
- `EventLoopSampler` — the event loop sampler
- `EventLoopSamplerOptions` — options for `createEventLoopSampler`
- `GcSample` — one garbage collection reading
- `GcSampler` — the garbage collection sampler
- `HeapSnapshotOptions` — options for `takeHeapSnapshot`
- `HeapSnapshotResult` — the result of `takeHeapSnapshot`
- `HeapSpaceEntry` — one V8 heap space reading
- `HeapSpaceSample` — all heap spaces at one moment
- `LoadAgentConfigOptions` — options for `loadAgentConfig`
- `MemorySample` — one memory reading
- `NdjsonExporter` — the NDJSON exporter
- `NdjsonExporterOptions` — options for `createNdjsonExporter`
- `PermissionCheck` — the result of `checkPermission`
- `PermissionScope` — a permission-model scope name
- `SamplerController` — the sampler controller
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
- `diffHeapSnapshots` — compares two heap snapshot summaries
- `heapSnapshotTimeoutMs` — the default heap snapshot analysis timeout for a file of a given size
- `summarizeHeapSnapshot` — summarizes a heap snapshot file by constructor type
- `symbolizeStackFrames` — maps stack frames back to original source positions

**Types**

- `HeapSnapshotDiff` — the difference between two snapshot summaries
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
