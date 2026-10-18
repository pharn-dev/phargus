---
spec_id: shared-int-and-http-helpers
spec_content_hash: f1400b63f1212a0c3962531fabe09f827b5395d6406f6ac298f6e7a5775cfcd3
applied_lessons: none
---

## Approach

A pure refactor (review finding F20). One new agent-internal module, `src/agent/int.ts`, holds the two
integer helpers; the five local `toNonNegativeInt` copies are deleted and each call site imports the helper
with its current rounding mode. The OTel transport drops its private copies of the HTTP response helpers and
imports the collector's `src/collector/http-response.ts` by relative path. No entrypoint (`index.ts`) changes,
no helper's behaviour changes, nothing new is exported from the package.

Discovery this run (live reads): the rounding copies are in `src/agent/event-loop-sampler.ts`,
`src/agent/gc-sampler.ts` and `src/agent/backpressure-probe.ts` (NaN → 0, `Math.round`, negative → 0, cap at
`Number.MAX_SAFE_INTEGER`); the truncating copies are in `src/agent/heap-space-sampler.ts` (non-finite → 0,
`Math.trunc`, clamp) and `src/collector/window.ts` (NaN → 0, `Math.trunc`, negative → 0, cap).
`src/otel/otlp-transport.ts` carries private `MAX_RESPONSE_BODY_BYTES`, `discardResponseBody`, a
`RequestSignal` type, `createRequestSignal` and an inline redirect test, byte-for-byte equivalent to the
exports of `src/collector/http-response.ts` (which `src/collector/webhook-sink.ts` already uses). The otel
ESLint rule only forbids non-relative, non-`node:` imports, so `../collector/http-response.js` is allowed; the
collector has no import rule, so `../agent/int.js` is allowed; the agent rule allows `int.ts` (it imports
nothing).

## Applied lessons

- none — the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there
  are no promoted lessons to apply.

## Steps

- Create `src/agent/int.ts` with two exported functions, no imports:
  - `roundToNonNegativeInt(value: number): number` — `NaN` → `0`; `r = Math.round(value)`; `r <= 0` → literal
    `0` (so `-0`, negatives and `-Infinity` give positive zero, per the SPEC's Assumptions); `r >
Number.MAX_SAFE_INTEGER` → `Number.MAX_SAFE_INTEGER` (covers `+Infinity`); else `r`.
  - `truncToNonNegativeInt(value: number): number` — the same shape with `Math.trunc`.
  - A short doc comment on each naming the rounding mode and the clamp range.
- `src/agent/event-loop-sampler.ts`, `src/agent/gc-sampler.ts`, `src/agent/backpressure-probe.ts`: delete the
  local `toNonNegativeInt`, add `import { roundToNonNegativeInt } from './int.js';`, and rename each call site
  to `roundToNonNegativeInt(...)`. Leave `backpressure-probe.ts`'s own `saturatingAdd` alone.
- `src/agent/heap-space-sampler.ts`: delete the local copy, import `truncToNonNegativeInt` from `./int.js`, use
  it for the four size fields. (Only behaviour change: `+Infinity` now maps to `Number.MAX_SAFE_INTEGER` instead
  of `0`, accepted by the SPEC; V8 cannot produce it.)
- `src/collector/window.ts`: delete the local copy and its doc comment, add
  `import { truncToNonNegativeInt } from '../agent/int.js';` beside the existing `../agent/index.js` type
  import, rename every call site. Keep `saturatingAdd`.
- `src/otel/otlp-transport.ts`: delete `MAX_RESPONSE_BODY_BYTES`, `discardResponseBody`, the `RequestSignal`
  type and `createRequestSignal`; add `import { MAX_RESPONSE_BODY_BYTES, createRequestSignal,
discardResponseBody, isRedirect } from '../collector/http-response.js';`; keep the call
  `discardResponseBody(response, MAX_RESPONSE_BODY_BYTES)`; replace the inline
  `response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)` with
  `isRedirect(response)`. Every error message string stays byte-identical.
- Run `npx prettier --write` on each edited or created file, named one by one, then the gates: `npm run
format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check:exports`.

## Files

- `src/agent/int.ts` — new: `roundToNonNegativeInt` and `truncToNonNegativeInt`, Node core only (no imports)
- `src/agent/event-loop-sampler.ts` — drop local `toNonNegativeInt`, use `roundToNonNegativeInt` from `./int.js`
- `src/agent/gc-sampler.ts` — drop local `toNonNegativeInt`, use `roundToNonNegativeInt` from `./int.js`
- `src/agent/backpressure-probe.ts` — drop local `toNonNegativeInt`, use `roundToNonNegativeInt` from `./int.js`
- `src/agent/heap-space-sampler.ts` — drop local `toNonNegativeInt`, use `truncToNonNegativeInt` from `./int.js`
- `src/collector/window.ts` — drop local `toNonNegativeInt`, use `truncToNonNegativeInt` from `../agent/int.js`
- `src/otel/otlp-transport.ts` — drop duplicate HTTP response helpers, import them and `isRedirect` from `../collector/http-response.js`

### Explicitly not touched

- `src/agent/index.ts` — the integer helpers are not exported from the agent entrypoint (SPEC non-goal)
- `src/collector/index.ts` — not edited (SPEC constraint)
- `src/collector/http-response.ts` — reused as-is; its behaviour does not change
- `src/collector/webhook-sink.ts` — already imports the shared HTTP helpers
- `CHANGELOG.md` — no observable behaviour change, so no entry (SPEC non-goal)
- `package.json` — no `imports` field is added; relative paths are the house style

## Acceptance mapping

- AC-1 (rounding helper edge cases, unit) → `roundToNonNegativeInt` in `src/agent/int.ts`: the `r <= 0` branch
  returns positive `0` for NaN (checked first), negatives, negative fractions and `-Infinity`; `Math.round`
  gives 2.4 → 2, 2.5 → 3, 0.5 → 1; in-range integers pass through; above-range values and `+Infinity` hit the
  cap. Tested in `src/agent/int.test.ts` (AC-TESTS.md).
- AC-2 (truncating helper edge cases, unit) → `truncToNonNegativeInt`, same branches with `Math.trunc` (2.9 → 2,
  2.5 → 2, 0.5 → 0). Same test file.
- AC-3 (no duplicates, imports, entrypoint, unit) → the five local copies are deleted, so `int.ts` is the only
  definer of the three names under `src/agent`, `src/collector/window.ts` and `src/otel/otlp-transport.ts`;
  the transport defines none of `discardResponseBody`, `createRequestSignal`, `MAX_RESPONSE_BODY_BYTES` and
  imports all four names (with `isRedirect`) from `../collector/http-response.js`; `src/agent/index.ts` is
  untouched, so it exports neither helper.

## Risks & open questions

- `-0` → `+0` at call sites that `Math.round`/`Math.trunc` a value in (-1, 0): accepted by the SPEC's
  Assumptions (JSON/NDJSON serialize both as `0`). A discovery grep found no existing test asserting `-0`.
- The AC-3 test must read sources from disk relative to the repo; it lives in its own file so it never
  depends on `int.ts` loading. It fails before the build because the five copies still exist.
- The collector's deep import `../agent/int.js` bypasses the agent entrypoint; the SPEC records this as the
  user's explicit choice and no lint rule forbids it.
