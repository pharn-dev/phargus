---
spec_id: otel-missing-metrics
state: Draft
spec_content_hash: ""
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Users who send Phargus metrics to an OpenTelemetry backend through the opt-in `@pharn-dev/phargus/otel`
adapter today see only part of each collector window. The OTLP metrics converter (`toOtlpMetrics`, used by
`createOtlpMetricsExporter`) exports the seven event-loop and memory gauges and the `phargus.gc.count` delta
sum, so GC pause totals and maxima, stream backpressure events and stalls, and the window's sample and late
sample counts never reach a backend. The exported resource also carries only `service.name`, so several
instances of one service collapse into one series. This increment makes the metrics export carry every
numeric field of the collector's `AggregatedWindow` and identify the emitting instance with OpenTelemetry
semantic-convention resource attributes, so a backend can chart GC pauses and backpressure per instance.

## Scope

**In scope:**

- Seven new metrics in the OTLP metrics export, following the converter's existing conventions (`phargus.*`
  names, UCUM units, integer `asInt` decimal strings, per-window totals as delta monotonic sums whose
  `startTimeUnixNano` is the window start, per-window maxima as gauges): `phargus.gc.pause.total` (sum, `ns`),
  `phargus.gc.pause.max` (gauge, `ns`), `phargus.backpressure.events` (sum, `{event}`),
  `phargus.backpressure.stall.total` (sum, `ns`), `phargus.backpressure.stall.max` (gauge, `ns`),
  `phargus.window.samples` (sum, `{sample}`, from the window's `count`) and `phargus.window.late_samples`
  (sum, `{sample}`, from the window's `late`).
- Three new resource attributes beside `service.name`: `service.instance.id` (a UUID generated once per
  process, overridable through a new optional non-empty-string `serviceInstanceId` option on the metrics
  exporter options and on the `toOtlpMetrics` options), `host.name` (the OS host name) and `process.pid`
  (an integer attribute value, the process id as a decimal string).
- The OTLP attribute value type widened to allow an integer value (`{ intValue: string }`).
- Tests asserting every `AggregatedWindow` numeric field in the OTLP JSON and the four resource attributes.
- Documentation: the exported metrics and resource attributes listed in README.md (OpenTelemetry section)
  and FEATURES.md, and a CHANGELOG.md entry under `## [Unreleased]` `### Added`.

**Out of scope (non-goals):**

- Any change to the traces exporter or to the trace converter (`src/otel/otlp-traces.ts`); other increments
  own them.
- Any change to the collector's `AggregatedWindow` type (`src/collector/window.ts`).
- Per-kind GC breakdowns, histograms, exemplars, or any metric not derived from an `AggregatedWindow` field.
- Any third-party or `@opentelemetry/*` dependency, and any change to `src/agent`.

## Acceptance Criteria

- **AC-1** Given an aggregated window with start 1700000000000, end 1700000001000, count 10, late 2,
  event-loop max 5000000, p99 4000000 and mean 2000000, heapUsedLast 1000, heapUsedMax 2000, rssLast 3000,
  rssMax 4000, GC count 3, totalPause 4500000 and maxPause 2000000, and backpressure events 5, totalStall
  7000000 and maxStall 3000000 When it is passed to `toOtlpMetrics` imported from the otel module entrypoint
  Then the returned metrics contain exactly one metric for each of these fifteen names with this type, unit
  and `asInt` value: gauges `phargus.event_loop.lag.max` `ns` "5000000", `phargus.event_loop.lag.p99` `ns`
  "4000000", `phargus.event_loop.lag.mean` `ns` "2000000", `phargus.memory.heap_used.last` `By` "1000",
  `phargus.memory.heap_used.max` `By` "2000", `phargus.memory.rss.last` `By` "3000",
  `phargus.memory.rss.max` `By` "4000", `phargus.gc.pause.max` `ns` "2000000" and
  `phargus.backpressure.stall.max` `ns` "3000000"; and sums `phargus.gc.count` `{collection}` "3",
  `phargus.gc.pause.total` `ns` "4500000", `phargus.backpressure.events` `{event}` "5",
  `phargus.backpressure.stall.total` `ns` "7000000", `phargus.window.samples` `{sample}` "10" and
  `phargus.window.late_samples` `{sample}` "2"; every sum has `aggregationTemporality` 1 and `isMonotonic`
  true and its data point's `startTimeUnixNano` is "1700000000000000000"; every data point's
  `timeUnixNano` is "1700000001000000000"
  - verify: unit
- **AC-2** Given the otel module entrypoint When `toOtlpMetrics` is called twice with an aggregated window
  and no `serviceInstanceId`, and once with `serviceInstanceId` "instance-a" Then each returned resource
  carries the attributes `service.name`, `service.instance.id`, `host.name` equal to `os.hostname()` as a
  `stringValue`, and `process.pid` as `{ intValue: String(process.pid) }`; the two default
  `service.instance.id` string values are equal to each other and match the UUID pattern
  `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`; and the third call's
  `service.instance.id` is "instance-a"
  - verify: unit
- **AC-3** Given a local HTTP server listening on 127.0.0.1 that answers 200 When two metrics exporters
  created from the otel module entrypoint without `serviceInstanceId` and a third created with
  `serviceInstanceId` "instance-b" each export one aggregated window and are flushed, and a fourth exporter
  is created with `serviceInstanceId` "" Then the server has received three POST bodies whose resource
  `service.instance.id` values are, for the first two, equal to each other and to the default value
  `toOtlpMetrics` returns without the option, and for the third "instance-b"; and creating the fourth
  exporter throws a `TypeError`
  - verify: integration

## Constraints

- Only Node core is used (`node:crypto` `randomUUID`, `node:os` `hostname`, `process.pid`); the root
  `package.json` gains no runtime `dependencies`, and `src/agent` stays untouched and never imports
  `src/otel`.
- Request bodies follow the OTLP/HTTP JSON encoding: 64-bit integer fields (`timeUnixNano`,
  `startTimeUnixNano`, `asInt`, `intValue`) are decimal strings, computed exactly from integers with no
  float rounding.
- Existing metrics keep their names, types, units and values, and `service.name` keeps its default and
  override behaviour.
- `npm run build`, `npm run check:exports`, `npm run typecheck`, `npm test`, `npm run lint` and
  `npm run format:check` keep passing; every edited file is formatted with prettier. TypeScript strict mode.
- Tests use only local HTTP servers bound to 127.0.0.1, never the network.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these unit and integration criteria, with
  per-test results; the test stage's preflight decides whether that holds.
- The default `service.instance.id` is generated once per process (per loaded module instance) and shared by
  every `toOtlpMetrics` call and every metrics exporter in that process; an ESM and a CJS copy of the module
  loaded side by side may each hold their own value.
- `serviceInstanceId` is "validated like `serviceName`": the metrics exporter factory throws a `TypeError`
  when it is present and not a non-empty string; `toOtlpMetrics` given an empty-string or non-string
  `serviceInstanceId` also throws a `TypeError`, an informed guess the PLAN may settle.
- `host.name` and `process.pid` are read when the request body is built; their exact read time is left to
  the PLAN.
- The order of resource attributes and of metrics within the scope is not part of the contract; tests look
  metrics and attributes up by name or key.
- `serviceInstanceId` is added to the metrics exporter's options only; whether the shared exporter options
  type carries it or a metrics-only extension does is left to the PLAN, as long as the traces exporter's
  behaviour does not change.
- The README.md, FEATURES.md and CHANGELOG.md updates are checked by review at verify, not by an acceptance
  test.
