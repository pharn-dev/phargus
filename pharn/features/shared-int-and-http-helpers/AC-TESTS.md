---
spec_id: shared-int-and-http-helpers
spec_content_hash: f1400b63f1212a0c3962531fabe09f827b5395d6406f6ac298f6e7a5775cfcd3
---

## Files

- `src/agent/int.test.ts` — the tests for AC-1 and AC-2
- `src/agent/shared-int-and-http-helpers.ac3.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/agent/int.test.ts` | src/agent/int.ts#roundToNonNegativeInt(value: number): number
- AC-2 | unit | `src/agent/int.test.ts` | src/agent/int.ts#truncToNonNegativeInt(value: number): number
- AC-3 | unit | `src/agent/shared-int-and-http-helpers.ac3.test.ts` | source text of every non-test `.ts` file under src/agent plus src/collector/window.ts and src/otel/otlp-transport.ts (read with node:fs), and the module namespace of src/agent/index.ts (dynamic import) — no roundToNonNegativeInt / truncToNonNegativeInt export
