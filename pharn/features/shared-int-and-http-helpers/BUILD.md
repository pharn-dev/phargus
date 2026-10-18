# BUILD — shared-int-and-http-helpers

- Plan built: `pharn/features/shared-int-and-http-helpers/PLAN.md` (spec_content_hash `f1400b63f1212a0c3962531fabe09f827b5395d6406f6ac298f6e7a5775cfcd3`).
- Chain gate: GREEN, by `check-plan-spec-agree.mjs`.
- Test-stage gate (`check-test-stage.mjs`, verbatim): `READY test-first — the mapping holds and the lock records a red run over the pinned tests`.
- Writes-scope set from the plan's `## Files` (authorized paths):
  - `src/agent/int.ts`
  - `src/agent/event-loop-sampler.ts`
  - `src/agent/gc-sampler.ts`
  - `src/agent/backpressure-probe.ts`
  - `src/agent/heap-space-sampler.ts`
  - `src/collector/window.ts`
  - `src/otel/otlp-transport.ts`
- Gate: `build-gate.mjs --mode full` passed (exit 0): test, lint, format:check, typecheck, build. The targeted run was also exit 0.
- Files written:
  - `src/agent/int.ts` (new: `roundToNonNegativeInt`, `truncToNonNegativeInt`)
  - `src/agent/event-loop-sampler.ts`, `src/agent/gc-sampler.ts`, `src/agent/backpressure-probe.ts` (local copy deleted, import `roundToNonNegativeInt`)
  - `src/agent/heap-space-sampler.ts`, `src/collector/window.ts` (local copy deleted, import `truncToNonNegativeInt`)
  - `src/otel/otlp-transport.ts` (private HTTP response helpers deleted, imported from `../collector/http-response.js`, inline redirect test replaced by `isRedirect`)
- skills: mode=none (catalogue exit 0, no installed skills)
- Seams: none touched; no seam walk run.

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
