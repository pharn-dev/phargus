---
spec_id: event-loop-baseline
spec_content_hash: 6fd92ea83637b02a29b004180f597906813f4ec526be4e4f36403b38a0801d1f
---

## Files

- `src/agent/event-loop-baseline.ac1.test.ts` — the tests for AC-1
- `src/agent/event-loop-baseline.ac2.test.ts` — the tests for AC-2
- `src/agent/event-loop-baseline.ac3.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/agent/event-loop-baseline.ac1.test.ts` | src/agent/index.ts#createEventLoopSampler(options?: { resolution?: number }): EventLoopSampler — enable(), sample(): { min, max, mean, p50, p99 }
- AC-2 | unit | `src/agent/event-loop-baseline.ac2.test.ts` | src/agent/index.ts#createEventLoopSampler(options?: { resolution?: number }): EventLoopSampler — called with { resolution: 20 }, then enable(), sample()
- AC-3 | unit | `src/agent/event-loop-baseline.ac3.test.ts` | src/agent/index.ts#createEventLoopSampler(options?: { resolution?: number }): EventLoopSampler — throws synchronously, message contains `resolution`
