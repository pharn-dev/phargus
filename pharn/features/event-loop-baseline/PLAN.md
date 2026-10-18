---
spec_id: event-loop-baseline
spec_content_hash: 6fd92ea83637b02a29b004180f597906813f4ec526be4e4f36403b38a0801d1f
applied_lessons: none
---

## Approach

> ADVISORY model work, derived from the Approved SPEC (`pharn/ARCHITECTURE.md §6` plan stage).

Today `createEventLoopSampler()` in `src/agent/event-loop-sampler.ts` calls `monitorEventLoopDelay()` with
no options, so every recorded value includes the full timer interval (10 ms by default) and an idle loop
reports p50 of about 11 ms. The fix stays inside that one file:

1. `createEventLoopSampler(options?: EventLoopSamplerOptions)` takes an optional
   `{ resolution?: number }`. Omitted options, or an object without `resolution`, mean 10 ms.
2. The resolution is validated synchronously, before the histogram is created: it must be a finite
   positive integer (`Number.isInteger(resolution) && resolution > 0`). Otherwise it throws a
   `RangeError` whose message names `resolution` and quotes the value received (`0`, `-1`, `1.5`, `NaN`,
   `Infinity` all fail; `Number.isInteger` rejects `NaN`, `Infinity` and `1.5`, and `> 0` rejects `0` and
   `-1`).
3. The histogram is created with `monitorEventLoopDelay({ resolution })`, explicit, never relying on
   Node's default.
4. A baseline `resolution * 1_000_000` ns (an integer, computed once) is subtracted from each of min,
   max, mean, p50 and p99 before rounding/clamping, reusing the existing `toNonNegativeInt` unchanged:
   `toNonNegativeInt(histogram.min - baselineNs)` and so on. That keeps every exported value an integer
   number of nanoseconds, clamped at 0 and at `Number.MAX_SAFE_INTEGER`.
5. The empty-window branch (`histogram.count === 0`) still returns all zeros, and `reset()` still runs
   after every `sample()`.

The sample's shape, field names and units do not change, so the controller, collector, windows, alert
evaluation, NDJSON and OTel export are untouched. The agent stays Node-core only (`node:perf_hooks`).

Thresholds review (SPEC scope item, recorded here and in the CHANGELOG entry): read live this run, the
collector has no built-in alert defaults (`src/collector/alert-rules.ts` takes only user rules); the
plugin-runner `eventLoopLagRule` default is `thresholdNs` 100_000_000 (100 ms, `src/plugin-runner/builtin-rules.ts`);
the example app alerts on `eventLoop.max >= 50_000_000` (`examples/express-app/index.mjs`). All sit far
above the 10 ms interval, so the new meaning shifts them by at most 10 ms of headroom and none needs to
change. The build confirms this by re-reading those files, not by editing them.

## Applied lessons

- none — `check-lessons-index.mjs --verdict` returned `NO_CANON`: this project has no
  `memory-bank/lessons-learned.md` yet, so there is no lesson to apply.

## Steps

- In `src/agent/event-loop-sampler.ts`: add and export `type EventLoopSamplerOptions = { resolution?: number }`;
  add a `DEFAULT_RESOLUTION_MS = 10` constant; add a small `validateResolution(value: unknown): number`
  that throws `RangeError` with a message containing `resolution`; change `createEventLoopSampler` to
  take the optional options, validate, call `monitorEventLoopDelay({ resolution })`, and subtract the
  integer baseline in `sample()` as described in Approach step 4. Update the `EventLoopSample` doc comment
  to say "delay beyond the expected timer interval, integer nanoseconds".
- In `src/agent/index.ts`: also export the type `EventLoopSamplerOptions` next to `EventLoopSample` and
  `EventLoopSampler` (additive, type-only; the runtime export list is unchanged).
- Docs, stating the new meaning ("delay beyond the expected timer interval", an idle loop reads close to
  0): the README runtime samples row; the `FEATURES.md` event loop lag line; the `ARCHITECTURE.md`
  collection paragraph that names `monitorEventLoopDelay`; and a `docs/LIMITS.md` bullet under the
  existing event loop limit noting that delays shorter than the timer resolution (10 ms by default) read
  as 0 and that the baseline is the configured resolution, not a measured idle baseline.
- `CHANGELOG.md`: one entry under `## [Unreleased]` `### Fixed` (the section already exists) saying event
  loop min/max/mean/p50/p99 now report delay beyond the timer resolution (an idle loop reads near 0
  instead of about 11 ms), that `createEventLoopSampler` accepts `{ resolution }` (positive integer ms,
  default 10), and that the existing alert and rule defaults (100 ms rule default, user-supplied
  collector alerts) were reviewed and kept.
- Existing tests: read live this run, no existing test asserts the old raw values — `samplers.ac1.test.ts`
  checks non-negative integers only, `samplers.ac2.test.ts` checks a ~100 ms block gives max >= 50 ms
  (still true: about 90 ms after the 10 ms baseline), and the collector, dashboard and plugin-runner tests
  feed synthetic samples. So no existing test file is in scope; if the build's run shows one failing on
  the old meaning, that is a stop-and-report, not an edit outside this list.
- Run `npx prettier --write` on each edited file by name, then `npm run format:check`, `npm run lint`,
  `npm run typecheck`, `npm test`.

## Files

- `src/agent/event-loop-sampler.ts` — explicit `resolution` option (default 10, validated), `monitorEventLoopDelay({ resolution })`, baseline subtraction before `toNonNegativeInt`
- `src/agent/index.ts` — additionally export the `EventLoopSamplerOptions` type
- `README.md` — runtime samples row: event loop values are delay beyond the expected timer interval
- `FEATURES.md` — event loop lag line: same new meaning
- `ARCHITECTURE.md` — collection paragraph: the sampler subtracts the timer resolution
- `docs/LIMITS.md` — sub-resolution delays read as 0; the baseline is the configured resolution
- `CHANGELOG.md` — `[Unreleased]` `### Fixed` entry, including the thresholds review

### Explicitly not touched

- `src/agent/sampler-controller.ts` — keeps calling `createEventLoopSampler()` with no options (default 10 ms); the SPEC keeps `resolution` off the controller and config
- `src/agent/config.ts` — no config or environment variable for `resolution` (SPEC non-goal)
- `src/collector/alert-rules.ts` — no built-in alert defaults to change; reviewed only
- `src/collector/window.ts` — window aggregation unchanged (SPEC non-goal)
- `src/plugin-runner/builtin-rules.ts` — the 100 ms `eventLoopLagRule` default stays; reviewed only
- `examples/express-app/index.mjs` — the 50 ms example alert stays; reviewed only
- `src/agent/samplers.ac1.test.ts` — still passes unchanged
- `src/agent/samplers.ac2.test.ts` — the stall-visibility constraint test; must keep passing unchanged
- `package.json` — no dependency added

## Acceptance mapping

- AC-1 (no options, idle ~300 ms: five values non-negative integers, p50 < 5_000_000; never-enabled
  sampler returns all zeros) → default resolution 10 is passed explicitly and 10_000_000 ns is subtracted,
  so an idle p50 of about 11 ms becomes about 1 ms; `toNonNegativeInt` keeps every value a non-negative
  integer; the unchanged `count === 0` branch returns zeros for a never-enabled sampler.
- AC-2 (`{ resolution: 20 }`, idle: p50 < 5_000_000, all non-negative integers) → the option is passed
  to `monitorEventLoopDelay` and the baseline becomes 20_000_000 ns, so an idle p50 of about 21 ms becomes
  about 1 ms.
- AC-3 (`resolution` 0, -1, 1.5, NaN, Infinity each throw with `resolution` in the message) →
  `validateResolution` runs before the histogram is created and throws `RangeError` naming `resolution`.

## Risks & open questions

- Timing-based ACs on shared CI: the 5 ms idle bound leaves about 4 ms headroom over a typical ~1 ms
  residual; a heavily loaded runner could still exceed it. The SPEC's Assumptions accept this.
- Very large integers (for example above 2^31) pass this validation but may be rejected by Node's own
  `monitorEventLoopDelay` validation with Node's error, which also names `resolution`. The SPEC asks only
  for positive-integer validation, so no upper bound is added.
- The baseline is the nominal interval, not a measured idle floor: real per-tick overhead (about 0.1 to
  1 ms) remains in the figures. That is the SPEC's stated meaning and is documented in `docs/LIMITS.md`.
- Semantics change for users who set alert thresholds on raw values: a threshold set just above 10 ms now
  fires only on genuine delay. Called out in the CHANGELOG entry.
