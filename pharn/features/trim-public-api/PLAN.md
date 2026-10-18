---
spec_id: trim-public-api
spec_content_hash: a046bbb4474181efca54426a886dd3ea228ecd9b7e090a4c27a88c4954782732
applied_lessons: none
---

> ADVISORY — this plan is model work derived from the Approved SPEC (`pharn/ARCHITECTURE.md §6`, plan stage).
> Only the frontmatter declaration and the `## Files` scope are floor-checked; the content below is not.

## Approach

Cut the two over-wide entrypoints (`src/agent/index.ts`, `src/collector/index.ts`) down to the supported
surface, drop the four scaffold placeholder types and the three placeholder-only tests, and re-point every
in-package user of a removed name at the file that defines it. Then make the cut deliberate: give
`scripts/check-exports.mjs` an exact expected runtime export list per subpath and fail on drift in either
direction, per format. Write the supported surface down in a new `docs/API.md`, link it from the README
Documentation table, and record the break in `CHANGELOG.md` `## [Unreleased]`.

Live state read this run (built `dist/` at HEAD 6770909, keys via `import` and `require`, declarations via the
TypeScript checker): ESM and CJS key sets are identical for every subpath, and no `default`/`__esModule`/
`module.exports` key appears in either (`__esModule` is non-enumerable in the tsc CJS output). The expected
lists below therefore contain no interop key.

## Applied lessons

- none — `check-lessons-index.mjs --verdict` printed `NO_CANON`: this project has no `memory-bank/lessons-learned.md`
  yet, so there are no lessons to apply.

## Steps

1. **Agent entry (`src/agent/index.ts`).** Delete the `PhargusAgentPlaceholder` type and its comment. Delete the
   re-exports of `encodeNdjsonLine`; `enable`, `disable`, `drainSpans`, `DEFAULT_SPAN_BUFFER_SIZE` and type
   `HttpTracingOptions`; type `SpanDrain` (keep `TraceSpan` from `span-buffer.js`); `toSpanRecord` and
   `isSpanRecord` (keep `SPAN_RECORD_TYPE` and types `SpanRecord`, `AgentLossCounters`, `AgentSampleLine`);
   `createSpanExport` and type `SpanExport`. Every other line stays. `src/agent/auto.ts` is unchanged
   (`export * from './index.js'` carries the cut through).
2. **Collector entry (`src/collector/index.ts`).** Delete the `PhargusAgentPlaceholder` import and the
   `CollectorPlaceholder` type; delete the `createWindowAggregator`/`WindowAggregatorOptions`, `createSpanRouter`
   and `serializeWindow`/`parseWindowLine` re-exports. Keep `export type { SpanRecord } from '../agent/index.js'`
   and everything else.
3. **Dashboard and plugin-runner entries.** Delete the `CollectorPlaceholder` import and the
   `DashboardPlaceholder` / `PluginRunnerPlaceholder` type from `src/dashboard/index.ts` and
   `src/plugin-runner/index.ts`.
4. **Internal users.** `src/collector/record-guard.ts` and `src/collector/span-router.ts` import `isSpanRecord`
   from `'../agent/span-record.js'` instead of `'../agent/index.js'` (their `SpanRecord` type import may stay on
   the index, which still exports it). `src/collector/collector.ts`, `window-store.ts` and `src/agent/auto-start.ts`
   already import from the defining files; no change.
5. **Benchmark (`bench/lib/bench-target.mjs`).** In the `tracing` variant, load `enable`/`drainSpans` from
   `new URL('./http-tracing.js', indexUrl)` and `createSpanExport` from `new URL('./span-export.js', indexUrl)`
   (the built files next to `dist/esm/agent/index.js`); `createNdjsonExporter` and `createSamplerController` stay on
   the index. Update the header comment that says both variants load the library API from `BENCH_AGENT_INDEX`.
   Behaviour of the variant is unchanged.
6. **Tests that took a removed name from an entrypoint** (behaviour checked is unchanged; only the import moves):
   - `src/agent/trace-context.ac2.integration.test.ts` — `loadApi()` takes `currentTraceId` from `./index.js` and
     `enable`/`disable` from `./http-tracing.js`; the thrown message names the file each is expected in.
   - `src/agent/trace-context.ac3.integration.test.ts` — same, plus `drainSpans` from `./http-tracing.js`.
   - `src/collector/collector-windows.ac1.test.ts`, `src/collector/collector-windows.ac2.test.ts` — import
     `createWindowAggregator` from `./window-aggregator.js`.
   - `src/collector/collector-foreign-records.ac3.integration.test.ts` — `encodeNdjsonLine` from
     `../agent/ndjson-encoder.js`, `toSpanRecord` from `../agent/span-record.js`.
   - `src/cli/phargus-serve-cli.ac4.integration.test.ts` (line ~404) and
     `src/cli/phargus-serve-cli.ac6.integration.test.ts` (line ~417) — `encodeNdjsonLine` from
     `../agent/ndjson-encoder.js` (test files are outside the CLI ESLint rule's scope).
7. **Delete** `src/collector/index.test.ts`, `src/dashboard/index.test.ts`, `src/plugin-runner/index.test.ts` (each
   only asserts a placeholder `undefined` is `undefined`).
8. **Exact-list check (`scripts/check-exports.mjs`).** Add a top-level `EXPECTED_EXPORTS` object keyed by
   subpath (`'./agent'`, … `'./otel'`), each a sorted array (default JS `sort()`, code-unit order) — the lists
   below. In the existing per-subpath × per-format loop, after a successful load compute
   `Object.keys(mod).sort()` (ESM namespace for `import`, `module.exports` for `require`), diff against the
   expected list, and:
   - equal → keep the existing `ok   <format> <specifier>` line;
   - different → set `failed`, print to **stderr** exactly
     `FAIL <format padded to 7> <specifier>: runtime exports differ from the expected list; added: <a, b | none>; missing: <c | none>`
     where `added` = loaded − expected and `missing` = expected − loaded, each sorted and joined with `, `.
   - A subpath in `package.json` `exports` (other than `./package.json`) with no `EXPECTED_EXPORTS` entry, or an
     `EXPECTED_EXPORTS` key that is not an `exports` subpath, is a `FAIL` line too (fail closed).
   Update the header comment to say it also checks the exact list. The `bin` check is untouched.
9. **`docs/API.md` (new).** One `## \`@pharn-dev/phargus/<subpath>\`` heading per subpath, in `exports` order;
   under each, a "Runtime exports" list and a "Types" list, one item per name written as `` `name` `` with a
   one-line description. Near the top, the sentence: "Anything not listed on this page is internal: it can change
   or disappear in any release, including a patch release." Note under the agent heading that importing the
   subpath also starts the agent. Mention that `npm run check:exports` enforces the runtime lists.
10. **README.** Add a row `` | [`docs/API.md`](./docs/API.md) | Every supported export, per subpath | `` to the
    `## Documentation` table (after `ARCHITECTURE.md`); re-run Prettier so the table realigns.
11. **CHANGELOG `## [Unreleased]`.** Under `### Added`, one bullet for `docs/API.md` and the exact-list
    `npm run check:exports` check. Add a `### Removed` subsection (after `### Changed`, before `## [0.1.0]`)
    that says the change is **breaking** for 0.x consumers (review findings F18, F19) and names, per subpath and
    each in backticks: agent — `encodeNdjsonLine`, `createSpanExport`, `SpanExport`, `enable`, `disable`,
    `drainSpans`, `DEFAULT_SPAN_BUFFER_SIZE`, `HttpTracingOptions`, `SpanDrain`, `toSpanRecord`, `isSpanRecord`,
    `PhargusAgentPlaceholder`; collector — `createWindowAggregator`, `WindowAggregatorOptions`,
    `createSpanRouter`, `parseWindowLine`, `serializeWindow`, `CollectorPlaceholder`; dashboard —
    `DashboardPlaceholder`; plugin-runner — `PluginRunnerPlaceholder`.
12. **Gates.** `npx prettier --write` each edited/created file by name; then `npm run build`,
    `npm run check:exports`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`.

### Expected runtime export lists (post-change, sorted)

- `./agent` (25): `ANONYMOUS_FUNCTION`, `DEFAULT_ALLOCATION_SAMPLING_DURATION_MS`,
  `DEFAULT_ALLOCATION_SAMPLING_INTERVAL`, `DEFAULT_ALLOCATION_SITE_LIMIT`, `DEPENDENT_CODE_KIND`,
  `PhargusConfigError`, `PhargusPermissionError`, `SPAN_RECORD_TYPE`, `assertPermission`, `checkPermission`,
  `createBackpressureProbe`, `createDeoptParser`, `createEventLoopSampler`, `createGcSampler`,
  `createNdjsonExporter`, `createSamplerController`, `currentTraceId`, `defaultAgentConfig`,
  `isPermissionModelEnabled`, `loadAgentConfig`, `runWithTrace`, `sampleAllocations`, `sampleHeapSpaces`,
  `sampleMemory`, `takeHeapSnapshot`
- `./collector` (12): `DEFAULT_MAX_LINE_BYTES`, `DEFAULT_SPAN_CAPACITY`, `createAlertEvaluator`,
  `createCollector`, `createFileSink`, `createNdjsonDecoder`, `createRingBuffer`, `createSinks`,
  `createStdoutSink`, `createWebhookSink`, `createWindowStore`, `validateAlertRules`
- `./analyzer` (16, unchanged): `DEFAULT_MAX_SNAPSHOT_BYTES`, `DEFAULT_MAX_SOURCE_FILE_BYTES`,
  `DEFAULT_RESOURCE_LIMITS`, `HeapSnapshotTooLargeError`, `MalformedSourceMapError`, `WorkerCrashedError`,
  `WorkerPoolClosedError`, `WorkerQueueFullError`, `WorkerTaskError`, `WorkerTaskTimeoutError`,
  `createHeapSnapshotPool`, `createSymbolizationPool`, `createWorkerPool`, `diffHeapSnapshots`,
  `summarizeHeapSnapshot`, `symbolizeStackFrames`
- `./dashboard` (2, unchanged): `createDashboardServer`, `isLoopbackHost`
- `./plugin-runner` (9, unchanged): `BuiltinRuleId`, `RuleErrorCode`, `RuleParameterError`, `createPluginRunner`,
  `eventLoopLagRule`, `gcPauseShareRule`, `heapGrowthRule`, `loadRulesDirectory`, `runRules`
- `./otel` (8, unchanged): `AGGREGATION_TEMPORALITY_DELTA`, `SPAN_KIND_SERVER`, `STATUS_CODE_ERROR`,
  `STATUS_CODE_UNSET`, `createOtlpMetricsExporter`, `createOtlpTraceExporter`, `toOtlpMetrics`, `toOtlpTraces`

### Type-only exports to document (post-change)

- agent: `AgentConfig`, `AgentLossCounters`, `AgentSample`, `AgentSampleLine`, `AllocationSamplingOptions`,
  `AllocationSite`, `BackpressureHotspot`, `BackpressureProbe`, `BackpressureProbeOptions`, `BackpressureSample`,
  `DeoptEvent`, `DeoptLocation`, `DeoptParser`, `DeoptParserOptions`, `EventLoopSample`, `EventLoopSampler`,
  `EventLoopSamplerOptions`, `GcSample`, `GcSampler`, `HeapSnapshotOptions`, `HeapSnapshotResult`,
  `HeapSpaceEntry`, `HeapSpaceSample`, `LoadAgentConfigOptions`, `MemorySample`, `NdjsonExporter`,
  `NdjsonExporterOptions`, `PermissionCheck`, `PermissionScope`, `SamplerController`, `SpanRecord`, `TraceSpan`
- collector: `AggregatedWindow`, `Alert`, `AlertComparison`, `AlertMetric`, `AlertRule`, `AlertSink`,
  `AlertState`, `Collector`, `CollectorListener`, `CollectorOptions`, `FileSinkOptions`, `IgnoredReason`,
  `IgnoredRecordHandler`, `NdjsonDecoder`, `NdjsonDecoderOptions`, `NdjsonSkip`, `PersistOptions`, `RingBuffer`,
  `SinkConfig`, `SinkErrorHandler`, `SinkInput`, `SpanRecord`, `StdoutSinkOptions`, `WebhookSinkOptions`,
  `WindowPersistence`, `WindowStore`
- analyzer: `HeapSnapshotDiff`, `HeapSnapshotDiffEntry`, `HeapSnapshotSummary`, `HeapSnapshotTypeStats`,
  `OriginalPosition`, `StackFrame`, `SymbolizedFrame`, `WorkerPool`, `WorkerPoolOptions`
- dashboard: `DashboardServer`, `DashboardServerOptions`
- plugin-runner: `EventLoopLagParams`, `GcPauseShareParams`, `HeapGrowthParams`, `PluginRunner`,
  `PluginRunnerOptions`, `RuleDescriptor`, `RuleErrorCodeValue`, `RuleFinding`, `RuleLoadFailure`, `RuleResults`,
  `RuleRunResult`, `RulesDirectoryResult`
- otel: `OtlpExporterOptions`, `OtlpMetric`, `OtlpMetricsExporter`, `OtlpMetricsExporterOptions`,
  `OtlpMetricsRequest`, `OtlpNumberDataPoint`, `OtlpSpan`, `OtlpTraceExporter`, `OtlpTraceExporterOptions`,
  `OtlpTracesRequest`

## Files

- `src/agent/index.ts` — drop the placeholder type and the eleven internal re-exports (step 1)
- `src/collector/index.ts` — drop the placeholder import/type and the five internal re-exports (step 2)
- `src/dashboard/index.ts` — drop `CollectorPlaceholder` import and `DashboardPlaceholder` (step 3)
- `src/plugin-runner/index.ts` — drop `CollectorPlaceholder` import and `PluginRunnerPlaceholder` (step 3)
- `src/collector/record-guard.ts` — import `isSpanRecord` from `../agent/span-record.js` (step 4)
- `src/collector/span-router.ts` — import `isSpanRecord` from `../agent/span-record.js` (step 4)
- `bench/lib/bench-target.mjs` — `tracing` variant loads `http-tracing.js` / `span-export.js` next to the index (step 5)
- `src/agent/trace-context.ac2.integration.test.ts` — `enable`/`disable` from `./http-tracing.js` (step 6)
- `src/agent/trace-context.ac3.integration.test.ts` — `enable`/`disable`/`drainSpans` from `./http-tracing.js` (step 6)
- `src/collector/collector-windows.ac1.test.ts` — `createWindowAggregator` from `./window-aggregator.js` (step 6)
- `src/collector/collector-windows.ac2.test.ts` — `createWindowAggregator` from `./window-aggregator.js` (step 6)
- `src/collector/collector-foreign-records.ac3.integration.test.ts` — encoder and span-record from their files (step 6)
- `src/cli/phargus-serve-cli.ac4.integration.test.ts` — `encodeNdjsonLine` from `../agent/ndjson-encoder.js` (step 6)
- `src/cli/phargus-serve-cli.ac6.integration.test.ts` — `encodeNdjsonLine` from `../agent/ndjson-encoder.js` (step 6)
- `src/collector/index.test.ts` — deleted (step 7)
- `src/dashboard/index.test.ts` — deleted (step 7)
- `src/plugin-runner/index.test.ts` — deleted (step 7)
- `scripts/check-exports.mjs` — `EXPECTED_EXPORTS` and the per-subpath, per-format exact-list diff (step 8)
- `docs/API.md` — new API reference, every supported runtime export and type per subpath (step 9)
- `README.md` — Documentation table row linking `docs/API.md` (step 10)
- `CHANGELOG.md` — `### Added` bullet and new `### Removed` subsection under `## [Unreleased]` (step 11)

### Explicitly not touched

- `src/agent/auto.ts` — `export * from './index.js'` carries the cut; unchanged
- `src/agent/auto-start.ts` — already imports tracing and span export from their defining files
- `src/agent/http-tracing.ts` — behaviour unchanged; only no longer re-exported
- `src/agent/span-export.ts` — behaviour unchanged; only no longer re-exported
- `src/agent/ndjson-encoder.ts` — behaviour unchanged; only no longer re-exported
- `src/agent/span-record.ts` — behaviour unchanged; only no longer re-exported
- `src/agent/span-buffer.ts` — behaviour unchanged
- `src/collector/window-aggregator.ts` — behaviour unchanged
- `src/collector/window-codec.ts` — behaviour unchanged
- `src/collector/collector.ts` — already imports from defining files
- `src/collector/window-store.ts` — already imports from defining files
- `src/agent/index.test.ts` — asserts the entry loads; not a placeholder-type test, kept
- `src/analyzer/index.test.ts` — asserts the entry loads; kept
- `src/agent/int.ts` — owned by a parallel change (SPEC non-goal); also every sampler file
- `package.json` — no `exports`/`bin`/version change (SPEC non-goals)
- `ARCHITECTURE.md` — its `check:exports` line stays true; not in SPEC scope
- `CONTRIBUTING.md` — its `check:exports` comment stays true; not in SPEC scope
- `vitest.config.mts` — test infrastructure; never in the build's scope

## Acceptance mapping

- AC-1 → steps 1–4 remove the twelve runtime names and eight types from what the six subpaths' entries (and
  their declarations, via `auto.d.ts` → `index.d.ts` and the collector/dashboard/plugin-runner `index.d.ts`)
  expose, while every kept name named in AC-1 stays; steps 4–6 keep the package compiling and every subpath
  loading; step 12 builds it. Test: `src/release/public-api-surface.ac1.integration.test.ts` (AC-TESTS.md).
- AC-2 → step 8: the unmodified build matches every expected list (exit 0); an extra ESM key or a missing CJS
  key on a copy prints a `FAIL <format> <specifier>: … added: …; missing: …` line and exits 1. Test:
  `src/release/public-api-surface.ac2.integration.test.ts`.
- AC-3 → steps 9–11: `docs/API.md` sections per subpath naming every runtime and type export listed above plus
  the "not listed … internal" sentence; README table row; `### Removed` naming all twenty names and the word
  `breaking`. Test: `src/release/public-api-surface.ac3.integration.test.ts`.

## Risks & open questions

- **Parallel samplers change.** The SPEC says a parallel change owns the samplers and `src/agent/int.ts`. If it
  lands first and adds or renames an agent export, `EXPECTED_EXPORTS['./agent']` and `docs/API.md` must include
  it, or `check:exports` (by design) fails. Rebase-time concern for whichever lands second.
- **Other features' pinned AC tests are edited** (step 6: `agent-trace-context`, `collector-windows`,
  `collector-foreign-records`, `phargus-serve-cli`). The SPEC approves this; only the import moves. Their
  `AC-TESTS.lock.json` pins will no longer match those files; nothing in this feature's gates reads them, but a
  human re-running those features' `--check` would see the change.
- **`check:exports` starts the agent** when it imports `./agent` (auto-start), so NDJSON goes to stdout; the
  drift `FAIL` lines go to stderr. AC-2's test should read stderr (or run with `PHARGUS_OUTPUT=none`).
- **Deletions.** Step 7 removes three files; the build stage needs a deletion path that its writes-scope allows.
