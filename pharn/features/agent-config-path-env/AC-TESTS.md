---
spec_id: agent-config-path-env
spec_content_hash: 988843b6c77d799eadd17b78ba9e95c7ed4b0757ac845a790afecf5e4b0dbd70
---

## Files

- `src/agent/config-path-env.ac1.integration.test.ts` — the tests for AC-1
- `src/agent/config-path-env.ac2.integration.test.ts` — the tests for AC-2
- `src/agent/config-path-env.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/agent/config-path-env.ac1.integration.test.ts` | src/agent/index.ts#loadAgentConfig(cwd: string, env: Readonly<Record<string, string | undefined>>, options?: { onWarning?: (message: string) => void }): Promise<AgentConfig> — a temp cwd with phargus.config.json { intervalMs: A } and pinned/custom.json { intervalMs: B, output: "out/agent.ndjson" }; env { PHARGUS_CONFIG: "pinned/custom.json" }; expects intervalMs B, output path.join(cwd, "out/agent.ndjson"), no PHARGUS_CONFIG key in the result, onWarning never called
- AC-2 | integration | `src/agent/config-path-env.ac2.integration.test.ts` | src/agent/index.ts#loadAgentConfig(cwd, env): Promise<AgentConfig> and defaultAgentConfig — a temp cwd with both phargus.config.json and phargus.config.js, plus pinned/custom.js assigning module.exports = { queueBound: N }; env { PHARGUS_CONFIG: "pinned/custom.js" }; expects it resolves to { ...defaultAgentConfig, queueBound: N }
- AC-3 | integration | `src/agent/config-path-env.ac3.integration.test.ts` | src/agent/index.ts#loadAgentConfig(cwd, env): Promise<AgentConfig> rejects, and src/agent/index.ts#PhargusConfigError — a temp cwd with a valid phargus.config.json; four separate calls with PHARGUS_CONFIG "", "missing.json", "dir.json" (an existing directory) and "settings.yaml" (an existing file); each rejection is instanceof PhargusConfigError and its message contains PHARGUS_CONFIG
