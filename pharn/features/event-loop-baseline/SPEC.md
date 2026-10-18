---
spec_id: event-loop-baseline
state: Draft
spec_content_hash: ""
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Review finding F16. The agent's event loop sampler (`src/agent/event-loop-sampler.ts`) calls
`monitorEventLoopDelay()` with no options, and Node's histogram records the full timer interval
(its `resolution`, 10 ms by default) on every tick. An idle process therefore reports a min of about
10.09 ms and a p50 of about 11.06 ms, the dashboard shows "p99 11.x ms" as if it were lag, and any alert
threshold below about 12 ms always fires. A developer reading Phargus at 2am needs the event loop figures
to mean "delay beyond the expected timer interval", so that an idle loop reports close to 0 and a real
stall stands out.

## Scope

**In scope:**

- `createEventLoopSampler` passes an explicit integer `resolution` in milliseconds to
  `monitorEventLoopDelay`: 10 by default, optionally set through an options argument
  (`createEventLoopSampler({ resolution })`) that is validated as a positive integer.
- Before export, `resolution * 1_000_000` ns is subtracted from min, max, mean, p50 and p99, each value
  clamped at 0 and kept as integer nanoseconds, reusing the existing `toNonNegativeInt` helper as it is.
- An empty window still exports all zeros.
- Documentation of the new meaning ("delay beyond the expected timer interval") in `README.md` (the
  runtime samples row), `FEATURES.md`, `ARCHITECTURE.md` and `docs/LIMITS.md`, plus a `CHANGELOG.md`
  entry under `[Unreleased]` `### Fixed`.
- A check that the collector alert defaults and the plugin-runner event-loop-lag default (100 ms) still
  make sense under the new meaning, and updates to any existing tests that assert the old raw values.

**Out of scope (non-goals):**

- Refactoring or replacing `toNonNegativeInt` (a later PR replaces it).
- Exposing `resolution` through the agent's configuration, environment variables or the sampler
  controller; the option exists only on `createEventLoopSampler`.
- Changing the sample's shape, field names or units, or the collector's window and alert logic.
- Adding any dependency; `src/agent` stays Node-core only.

## Acceptance Criteria

- **AC-1** Given an event loop sampler created from the agent entrypoint with no options and enabled on an
  otherwise idle process When about 300 ms pass and `sample()` is called Then the returned min, max, mean,
  p50 and p99 are all non-negative integers and the returned p50 is below 5_000_000 (5 ms in
  nanoseconds), and a `sample()` call on a fresh sampler that was never enabled returns 0 for all five
  values
  - verify: unit
- **AC-2** Given an event loop sampler created from the agent entrypoint with `{ resolution: 20 }` and
  enabled on an otherwise idle process When about 300 ms pass and `sample()` is called Then the returned
  p50 is below 5_000_000 (5 ms in nanoseconds) and every returned value is a non-negative integer
  - verify: unit
- **AC-3** Given the agent entrypoint's `createEventLoopSampler` When it is called with a `resolution` of
  0, -1, 1.5, NaN or Infinity Then each call throws an error whose message contains `resolution`
  - verify: unit

## Constraints

- `src/agent` imports Node core modules only: zero third-party dependencies and no imports from the
  other modules.
- Exported event loop values stay integer nanoseconds, never negative and never above
  `Number.MAX_SAFE_INTEGER`.
- A real stall stays visible: the existing samplers test that a ~100 ms block raises one window's max to
  at least 50 ms must keep passing with the default resolution.
- Every file written passes `npm run format:check`, `npm run lint` and `npm run typecheck`.

## Assumptions

- An invalid `resolution` throws synchronously from `createEventLoopSampler`; the error type (TypeError
  or RangeError) is the plan's choice, as long as its message names `resolution`.
- Omitting the options argument, or passing an options object without `resolution`, both mean the default
  of 10 ms.
- The 5 ms idle bound in AC-1 and AC-2 leaves headroom for shared CI runners; the observed idle raw p50
  of about 11 ms (10 ms default) or about 21 ms (20 ms resolution) is what the criteria rule out.
- The collector alert defaults and the plugin-runner event-loop-lag default of 100 ms are expected to stay
  unchanged, since they sit well above the timer interval; the build confirms this and records it rather
  than changing them without cause.
- No `--gates` entry is needed: `package.json` has a `test` script (`vitest run`), and the test stage's
  own preflight decides whether it serves these criteria.
