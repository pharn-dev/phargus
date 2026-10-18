---
spec_id: otel-missing-metrics
spec_content_hash: 60ac6edb628acde00d674c8a23ce34f1628c7f2194651b83575238dfce83b2da
applied_lessons: none
---

## Approach

> ADVISORY: model work, derived from the Approved SPEC. Nothing here is a guarantee.

The OTLP metrics converter (`src/otel/otlp-metrics.ts`, read this run) builds seven gauges from a `GAUGES`
table and then pushes one hand-written delta sum (`phargus.gc.count`). The resource is a one-element
attribute list holding `service.name`. The work has three parts.

1. **Metrics, table-driven.** Add the two new maxima (`phargus.gc.pause.max`, `phargus.backpressure.stall.max`,
   unit `ns`) to `GAUGES`. Replace the inline `phargus.gc.count` push with a `SUMS` table of the same
   `{ name, description, unit, read }` shape, holding `phargus.gc.count` (`{collection}`, unchanged),
   `phargus.gc.pause.total` (`ns`, `w.gc.totalPause`), `phargus.backpressure.events` (`{event}`,
   `w.backpressure.events`), `phargus.backpressure.stall.total` (`ns`, `w.backpressure.totalStall`),
   `phargus.window.samples` (`{sample}`, `w.count`) and `phargus.window.late_samples` (`{sample}`, `w.late`).
   Every sum is built the way `phargus.gc.count` is today: `startTimeUnixNano = msToUnixNano(window.start)`,
   `timeUnixNano = msToUnixNano(window.end)`, `asInt = toIntString(read(window))`, `aggregationTemporality:
   AGGREGATION_TEMPORALITY_DELTA`, `isMonotonic: true`. That gives 9 gauges + 6 sums = 15 metrics, every
   `AggregatedWindow` numeric field except `start`/`end` (which are the timestamps). The existing helpers
   `msToUnixNano` and `toIntString` keep the integer-exact decimal-string encoding (BigInt for nanoseconds),
   so no float rounding is introduced.
2. **Resource identity, in its own file.** A new `src/otel/otlp-resource.ts` owns the one reason to change
   "which attributes identify the emitter" (P3 of the Phargus convention: one axis per file). It holds a
   module-level `DEFAULT_SERVICE_INSTANCE_ID = randomUUID()` from `node:crypto` (generated once per loaded
   module instance, so every `toOtlpMetrics` call and every metrics exporter in the process share it), a
   validator `requireServiceInstanceId(value: unknown): void` that throws
   `TypeError('serviceInstanceId must be a non-empty string')` when the value is present and is not a
   non-empty string, and `otlpResourceAttributes({ serviceName, serviceInstanceId }): OtlpKeyValue[]`
   returning `service.name`, `service.instance.id`, `host.name` (`os.hostname()` as `stringValue`) and
   `process.pid` (`{ intValue: String(process.pid) }`). `host.name` and `process.pid` are read each time the
   attributes are built, i.e. when a request body is encoded (settles the SPEC's read-time assumption).
3. **Options.** `toOtlpMetrics`'s options widen to `{ serviceName?: string; serviceInstanceId?: string }`;
   it calls `requireServiceInstanceId` on the option (settling the SPEC's informed guess: an empty or
   non-string `serviceInstanceId` passed to `toOtlpMetrics` throws a `TypeError`), and builds the resource
   with `otlpResourceAttributes`. The metrics exporter gains a **metrics-only** option:
   `OtlpMetricsExporterOptions = OtlpExporterOptions & { serviceInstanceId?: string }` in
   `src/otel/otlp-exporter.ts`. The shared `OtlpExporterOptions` and `resolveOtlpExporterOptions` are not
   changed, so the traces exporter cannot change behaviour. `createOtlpMetricsExporter` calls
   `requireServiceInstanceId(options.serviceInstanceId)` synchronously before creating the queue (so
   `serviceInstanceId: ""` throws a `TypeError` at construction, AC-3), resolves it to
   `options.serviceInstanceId ?? DEFAULT_SERVICE_INSTANCE_ID`, and passes it to `toOtlpMetrics` in `encode`.

`OtlpAnyValue` in `src/otel/otlp-types.ts` widens to `{ stringValue: string } | { intValue: string }`. It is
used only by the metrics types (the traces types have their own `OtlpTraceAnyValue`, read this run), so the
traces converter is untouched. `src/otel/index.ts` needs no change: `toOtlpMetrics`, `createOtlpMetricsExporter`
and `OtlpMetricsExporterOptions` are already exported from the entrypoint, and the widened option rides on
those exports.

Only Node core is used (`node:crypto`, `node:os`, `process`). No file under `src/agent` or `src/collector` is
edited, and `package.json` gains no dependency.

## Applied lessons

- none — `check-lessons-index.mjs --verdict` printed `NO_CANON`: the project has no `memory-bank/` yet, so
  there are no promoted lessons to apply.

## Steps

- Widen `OtlpAnyValue` in `src/otel/otlp-types.ts` to the two-member union with `{ intValue: string }`.
- Create `src/otel/otlp-resource.ts` with `DEFAULT_SERVICE_INSTANCE_ID`, `requireServiceInstanceId` and
  `otlpResourceAttributes`, importing `randomUUID` from `node:crypto` and `hostname` from `node:os`.
- In `src/otel/otlp-metrics.ts`: add the two gauges to `GAUGES`; add the `SUMS` table and build all sums from
  it (moving `phargus.gc.count` into it unchanged in name, unit, description and value); widen the options
  type; validate `serviceInstanceId`; build the resource from `otlpResourceAttributes` with
  `serviceName ?? 'phargus'` (default unchanged) and `serviceInstanceId ?? DEFAULT_SERVICE_INSTANCE_ID`.
- In `src/otel/otlp-exporter.ts`: define `OtlpMetricsExporterOptions` as the metrics-only extension; validate
  and resolve `serviceInstanceId` in `createOtlpMetricsExporter` before the queue is created; pass it to
  `toOtlpMetrics` in `encode`. Update the doc comment of the type to describe the option.
- README.md: under `## What you get`, after the feature table, add an `### OpenTelemetry metrics` subsection
  listing the fifteen exported metrics (name, type, unit, source field) and the four resource attributes,
  and naming the `serviceInstanceId` option and its default (a per-process UUID).
- FEATURES.md: extend the OpenTelemetry bullet in the collector section to name the exported metrics
  (event loop, memory, GC count/pause, backpressure events/stall, window sample and late-sample counts) and
  the resource attributes `service.name`, `service.instance.id`, `host.name` and `process.pid`.
- CHANGELOG.md: add an entry under `## [Unreleased]` `### Added` describing the seven new metrics, the three
  new resource attributes and the `serviceInstanceId` option.
- Run `npx prettier --write` on each edited or created file, named one by one, then the gates: `npm run build`,
  `npm run check:exports`, `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check`.

## Files

- `src/otel/otlp-types.ts` — `OtlpAnyValue` widened to allow `{ intValue: string }`
- `src/otel/otlp-resource.ts` — new: the per-process default `service.instance.id`, its validator, and the resource attribute builder
- `src/otel/otlp-metrics.ts` — two new gauges, a `SUMS` table with the six delta sums, `serviceInstanceId` option, resource built from `otlp-resource.ts`
- `src/otel/otlp-exporter.ts` — metrics-only `serviceInstanceId` option, validated at construction and passed to the converter
- `README.md` — OpenTelemetry metrics subsection listing the exported metrics and resource attributes
- `FEATURES.md` — OpenTelemetry bullet names the exported metrics and resource attributes
- `CHANGELOG.md` — `## [Unreleased]` `### Added` entry

### Explicitly not touched

- `src/otel/index.ts` — the needed exports already exist; unchanged
- `src/otel/otlp-exporter-options.ts` — shared exporter options stay as they are, so traces are unaffected
- `src/otel/otlp-traces.ts` — trace converter, out of scope
- `src/otel/otlp-trace-exporter.ts` — traces exporter, out of scope
- `src/otel/otlp-trace-types.ts` — trace types, out of scope
- `src/collector/window.ts` — `AggregatedWindow` is read, never changed
- `src/agent/index.ts` — the agent stays untouched and never imports `src/otel`
- `src/otel/otel-metrics-export.ac1.test.ts` — another feature's AC test; it looks metrics up by name and keeps passing
- `package.json` — no dependency or script change

## Acceptance mapping

- AC-1 (fifteen metrics, types, units, values, sum temporality/monotonicity, timestamps) → the `GAUGES` table
  (nine entries) and the `SUMS` table (six entries) in `otlp-metrics.ts`, each data point built with the
  existing `msToUnixNano` / `toIntString` helpers; the test calls `toOtlpMetrics` from `src/otel/index.ts`.
- AC-2 (four resource attributes, stable default UUID, override) → `otlpResourceAttributes` and the
  module-level `DEFAULT_SERVICE_INSTANCE_ID` in `otlp-resource.ts`, used by `toOtlpMetrics`; `host.name` from
  `os.hostname()`, `process.pid` as `{ intValue: String(process.pid) }`.
- AC-3 (exporters share the converter's default, the override is sent, `""` throws a `TypeError`) →
  `createOtlpMetricsExporter` resolves `serviceInstanceId ?? DEFAULT_SERVICE_INSTANCE_ID` from the same
  module the converter uses and validates it before creating the queue.

## Risks & open questions

- The default instance id is per loaded module instance: an ESM and a CJS copy of `@pharn-dev/phargus/otel`
  loaded side by side each hold their own UUID (the SPEC's stated assumption). The dual build compiles
  `otlp-resource.ts` once per format, so within one format every exporter and every `toOtlpMetrics` call
  share it.
- README.md has no OpenTelemetry heading today (only a row in the `## What you get` table, read this run);
  the plan adds an `### OpenTelemetry metrics` subsection there. If the `## Contents` list enumerates
  subsections, the build may need to add a line to it (same file, in scope).
- `toOtlpMetrics` now throws a `TypeError` for an empty or non-string `serviceInstanceId`. Inside the
  exporter that cannot happen because the factory validates first; a direct caller sees the throw, which is
  how `toIntString`/`msToUnixNano` already report bad input.
- Existing tests in `src/otel/otel-metrics-export.*.test.ts` look metrics up by name and do not assert the
  resource attribute list or the metric count (read this run), so the added metrics and attributes should not
  break them; `/pharn-regress` confirms.
