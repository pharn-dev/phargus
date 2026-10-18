---
spec_id: trim-public-api
state: Approved
spec_content_hash: a046bbb4474181efca54426a886dd3ea228ecd9b7e090a4c27a88c4954782732
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Review findings F18 and F19: the public API of `@pharn-dev/phargus` is wider than intended. Its
entrypoints still carry four scaffold placeholder types, and they re-export wiring internals (the
NDJSON line encoder, span-export plumbing, the tracing switch, the window aggregator and span router,
the persistence codec) that consumers were never meant to depend on. Every name a 0.x consumer can
import today is, by default, a promise. The maintainer wants the surface cut down to what is meant to
be supported, the cut made deliberate (a build check that fails when a subpath's runtime export list
drifts from an exact expected list) and written down (an API reference listing every supported name),
and the breaking change recorded for 0.x consumers. The scaffold-only tests that assert nothing are
removed with the placeholders.

## Scope

**In scope:**

- Remove the placeholder types `PhargusAgentPlaceholder` (agent), `CollectorPlaceholder` (collector),
  `DashboardPlaceholder` (dashboard) and `PluginRunnerPlaceholder` (plugin-runner), and delete the three
  tests `src/collector/index.test.ts`, `src/dashboard/index.test.ts` and `src/plugin-runner/index.test.ts`
  that only assert `undefined` is `undefined`.
- Stop exposing from the `./agent` subpath (whose entry re-exports `src/agent/index.ts`):
  `encodeNdjsonLine`, `createSpanExport`, type `SpanExport`, `enable`, `disable`, `drainSpans`,
  `DEFAULT_SPAN_BUFFER_SIZE`, type `HttpTracingOptions`, type `SpanDrain`, `toSpanRecord` and
  `isSpanRecord`. The wire-format types `SpanRecord`, `AgentSampleLine`, `AgentLossCounters`, `TraceSpan`,
  the `SPAN_RECORD_TYPE` constant and every other current export stay.
- Stop exposing from the `./collector` subpath: `createWindowAggregator`, type `WindowAggregatorOptions`,
  `createSpanRouter`, `parseWindowLine` and `serializeWindow`. Every other current export stays.
- Code inside the package that needs a removed name (collector modules, tests, the benchmark target's
  `tracing` variant) reaches it through the file that defines it instead of through an entrypoint.
- `npm run check:exports` additionally requires, for each of the six subpaths (agent, collector,
  analyzer, dashboard, plugin-runner, otel) and through both `import` and `require`, that the sorted
  runtime export names of the loaded module equal an exact expected list kept in that script, and fails
  naming the added and the missing names otherwise.
- A new `docs/API.md` listing, per subpath, every supported runtime export and exported type with a
  one-line description each, stating that anything not listed is internal, linked from the README
  Documentation table.
- `CHANGELOG.md` `## [Unreleased]`: a `### Removed` subsection naming every removed export per subpath
  (the four placeholder types included) and saying this is breaking for 0.x consumers; the exact-list
  check and `docs/API.md` mentioned under `### Added` or `### Changed`.

**Out of scope (non-goals):**

- The samplers, and any `src/agent/int.ts` (a parallel change owns those).
- Changing the behavior of any kept or removed function; only where it is reachable from changes.
- Adding, renaming or removing an `exports` subpath, or changing the `bin`.
- Bumping the package version or cutting a release.

## Acceptance Criteria

- **AC-1** Given the package built with `npm run build` When each of the six `exports` subpaths is
  loaded through `import` and through `require`, and the type declarations each subpath's `types`
  condition resolves to (following its re-exports) are read Then every load succeeds; no loaded module
  has any of the runtime names `encodeNdjsonLine`, `createSpanExport`, `enable`, `disable`, `drainSpans`,
  `DEFAULT_SPAN_BUFFER_SIZE`, `toSpanRecord`, `isSpanRecord`, `createWindowAggregator`,
  `createSpanRouter`, `parseWindowLine`, `serializeWindow`; the agent module still has
  `SPAN_RECORD_TYPE`, `currentTraceId`, `runWithTrace`, `createNdjsonExporter` and
  `createSamplerController`, and the collector module still has `createCollector`, `createWindowStore`
  and `createNdjsonDecoder`; and no declaration reachable from a subpath exports `SpanExport`,
  `HttpTracingOptions`, `SpanDrain`, `WindowAggregatorOptions`, `PhargusAgentPlaceholder`,
  `CollectorPlaceholder`, `DashboardPlaceholder` or `PluginRunnerPlaceholder`, while the agent's
  declarations still export `SpanRecord`, `AgentSampleLine`, `AgentLossCounters` and `TraceSpan`
  - verify: integration
- **AC-2** Given the built package When `npm run check:exports` runs on it unmodified, and again on a
  copy of the built package in which one subpath's ESM entry gains an extra runtime export and another
  subpath's CommonJS entry loses one of its runtime exports Then the unmodified run exits 0, and the
  modified run exits non-zero with output naming the extra name as added and the dropped name as missing,
  each with its subpath and its format (`import` or `require`)
  - verify: integration
- **AC-3** Given the repository's `docs/API.md`, `README.md` and `CHANGELOG.md` When they are read
  Then `docs/API.md` has a section for each of the six subpaths that names every runtime export the
  built subpath has and every type its declarations export, and states that anything not listed is
  internal; the README Documentation table links `docs/API.md`; and the `## [Unreleased]` section of
  `CHANGELOG.md` has a `### Removed` subsection that names every removed name from AC-1 (runtime and
  type, the four placeholder types included) and the word `breaking`
  - verify: integration

## Constraints

- `src/agent` imports Node core modules and its own files only: no third-party dependency and no import
  from another module; the root `package.json` gains no runtime `dependencies`.
- Modules import each other by relative path (ARCHITECTURE.md); the agent-boundary and CLI ESLint rules
  stay satisfied.
- Dual package: every subpath keeps loading through both `import` and `require`, each with its own
  types; TypeScript strict mode; Node 22.18.0 or later.
- `npm run build`, `npm run check:exports`, `npm run typecheck`, `npm run lint`, `npm run format:check`
  and `npm test` all pass, and every file written or edited is Prettier-formatted.
- This is a breaking change for 0.x consumers of the removed names, and the changelog says so.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these integration criteria, with per-test
  results; the test stage's preflight decides whether that holds.
- "Runtime export names" means the own enumerable keys of the loaded module namespace (ESM) or
  `module.exports` object (CJS), sorted; a CJS interop key such as `default` or `__esModule`, if the build
  emits one, is part of the expected list the PLAN writes down rather than special-cased away.
- Existing tests that take a removed name from an entrypoint, including an earlier feature's acceptance
  test that asserts `enable`, `disable` and `drainSpans` are exported from `src/agent/index.ts`
  (`src/agent/trace-context.ac3.integration.test.ts`), are updated to load the name from its defining
  file; the behavior they check is unchanged.
- The benchmark target's `tracing` variant keeps working by loading the tracing and span-export pieces
  from the built files next to the agent index, not from the public subpath.
- How AC-2's modified copy of the build is produced, and whether the expected lists are shared with the
  AC-1 and AC-3 tests or restated in them, is left to the PLAN.
- AC-3's per-subpath sections are recognized by the subpath names (`@pharn-dev/phargus/agent` and so on)
  as headings; the exact layout and descriptions are left to the PLAN.
- No other code outside `src/`, `bench/` and `scripts/` (examples, README snippets) uses a removed name;
  a live search this run found none.
