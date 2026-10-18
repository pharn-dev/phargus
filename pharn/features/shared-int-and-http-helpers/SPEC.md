---
spec_id: shared-int-and-http-helpers
state: Approved
spec_content_hash: "f1400b63f1212a0c3962531fabe09f827b5395d6406f6ac298f6e7a5775cfcd3"
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Review finding F20: the package carries five near-identical local copies of a "clamp a number to a
non-negative safe integer" helper (in the event loop, GC, backpressure and heap-space samplers and in the
collector's window aggregation), and the OTel transport carries its own copies of the HTTP response helpers
the collector already exports (body discard, request signal, body-size cap, redirect test). Maintainers want
one shared, tested definition of each so a fix lands once and the copies cannot drift apart. This is a
refactor: what the monitored process, the collector and the OTel exporter emit stays the same.

## Scope

**In scope:**

- One internal agent module, Node core only, holding two clearly named integer helpers: one that rounds to
  the nearest integer and one that truncates toward zero, both clamping the result to the range 0 to
  `Number.MAX_SAFE_INTEGER`.
- The three samplers that round today (event loop, GC, backpressure) use the rounding helper; the heap-space
  sampler and the collector window, which truncate today, use the truncating helper. The five local copies
  are removed and every call site keeps its current rounding mode.
- The OTel transport reuses the collector's HTTP response helpers (body discard, request signal, body-size
  cap, redirect test) and its own duplicate copies are removed.
- Unit tests for both shared integer helpers.

**Out of scope (non-goals):**

- Exporting the integer helpers from the `@pharn-dev/phargus/agent` or `@pharn-dev/phargus/collector`
  entrypoints, or editing either module's `index.ts`.
- Any change to the HTTP response helpers' own behaviour, to OTel error messages, or to any other module.
- A CHANGELOG entry or a release: there is no observable behaviour change to record.

## Acceptance Criteria

- **AC-1** Given the shared rounding helper roundToNonNegativeInt When it is called with NaN, a negative
  number, -Infinity, a fraction, a fraction ending in .5, a negative fraction, a value above
  `Number.MAX_SAFE_INTEGER` and +Infinity Then it returns 0 for NaN, every negative input, every negative
  fraction and -Infinity; `Math.round` of a non-negative fraction (2.4 returns 2, 2.5 returns 3, 0.5
  returns 1); an integer from 0 to `Number.MAX_SAFE_INTEGER` unchanged; and `Number.MAX_SAFE_INTEGER`
  for every value above it and for +Infinity
  - verify: unit
- **AC-2** Given the shared truncating helper truncToNonNegativeInt When it is called with NaN, a negative
  number, -Infinity, a fraction, a fraction ending in .5, a negative fraction, a value above
  `Number.MAX_SAFE_INTEGER` and +Infinity Then it returns 0 for NaN, every negative input, every negative
  fraction and -Infinity; `Math.trunc` of a non-negative fraction (2.9 returns 2, 2.5 returns 2, 0.5
  returns 0); an integer from 0 to `Number.MAX_SAFE_INTEGER` unchanged; and `Number.MAX_SAFE_INTEGER`
  for every value above it and for +Infinity
  - verify: unit
- **AC-3** Given the package sources and the agent entrypoint module `src/agent/index.ts` When a test reads
  the source of every non-test file under `src/agent`, `src/collector/window.ts` and
  `src/otel/otlp-transport.ts`, and imports the agent entrypoint module Then no file other than the shared integer module defines a function named
  toNonNegativeInt, roundToNonNegativeInt or truncToNonNegativeInt; `src/otel/otlp-transport.ts` defines
  none of discardResponseBody, createRequestSignal or MAX_RESPONSE_BODY_BYTES and imports them and
  isRedirect from the collector's HTTP response module; and the agent entrypoint exports neither
  roundToNonNegativeInt nor truncToNonNegativeInt
  - verify: unit

## Constraints

- The shared integer module lives in `src/agent` and imports Node core only (the agent's zero-dependency
  rule and its ESLint import rule).
- The collector reaches it by relative path (`../agent/int.js`), the house style; the package has no
  `imports` field. The OTel transport reaches the collector's HTTP response module the same way, which the
  otel ESLint rule allows for package-internal relative imports.
- `src/agent/index.ts` and `src/collector/index.ts` are not edited.
- Every existing test, lint, typecheck, format and build gate keeps passing; each sampler's and the
  collector window's emitted values are unchanged for every finite input.
- The only accepted behaviour difference: the heap-space sampler maps +Infinity to
  `Number.MAX_SAFE_INTEGER` instead of 0, which `v8.getHeapSpaceStatistics()` cannot produce.

## Assumptions

- "Returns 0" means positive zero: an input that `Math.round` or `Math.trunc` turns into -0 (for example
  -0.4 or -0.5) yields +0 from the shared helpers. Today's local copies return -0 there; -0 and +0
  serialize identically in JSON and NDJSON, so no emitted output changes.
- The test file for both helpers is `src/agent/int.test.ts`, as the description names it; AC-3's
  source-reading test may live in a separate test file.
- The file and function names (`src/agent/int.ts`, roundToNonNegativeInt, truncToNonNegativeInt) are the
  user's own choices from the increment description, not open design forks.
- A `test` runner PHARN can find exists: `package.json` `scripts.test` is `vitest run`. The test stage's own
  preflight decides whether unit-level per-test results are available.
- The collector's deep import of `../agent/int.js` (rather than through `../agent/index.js`, which every
  other collector import uses today) is accepted as the user's explicit choice; no lint rule forbids it.
