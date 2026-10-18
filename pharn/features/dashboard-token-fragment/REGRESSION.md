# REGRESSION — dashboard-token-fragment

base: `335270fe39fb1e9e1b0c31cc5b2c5f3a6b935564` — chosen by: named with --base

**verdict: NO REGRESSIONS** — no deterministically-detectable breakage outside the feature.

BASE evidence: taken from this run's ENTRY gates — the run marker, the entry offer, the pre-run snapshot, the entry stamp (sha256 `2cfc33dc85467380676ce7d0e4f6114143d5d2b21731d07efc06fa4cbdc781de`) and its logs agree with this invocation's BASE slots at `335270fe39fb1e9e1b0c31cc5b2c5f3a6b935564`, so this invocation created no base worktree, ran no install and spawned no base gate (retained evidence not reused: `no-record`). The base stamp marks every slot `reused` from the entry run (`test`, `typecheck`, `build`). That they equal what a fresh BASE worktree would give is NOT claimed: the entry gates ran in this tree's real start environment.

install: none run by this invocation (the BASE evidence came from this run's entry gates).

HEAD install: checked — npm's record of the installed tree agrees with `package-lock.json` (24 absent dev/peer/optional package(s) not counted). That `node_modules` holds those packages is not itself checked (install-drift-core.mjs).

## Scope

inside (28):

```text
CHANGELOG.md
FEATURES.md
README.md
docs/LIMITS.md
docs/THREAT-MODEL.md
src/cli/serve.ts
src/cli/usage.ts
src/dashboard/auth.ts
src/dashboard/server.ts
src/dashboard/static-assets.ts
src/dashboard/ui/app-script.ts
pharn/features/dashboard-token-fragment/AC-TESTS.lock.json
pharn/features/dashboard-token-fragment/AC-TESTS.md
pharn/features/dashboard-token-fragment/BUILD.md
pharn/features/dashboard-token-fragment/GRILL.md
pharn/features/dashboard-token-fragment/PLAN.md
pharn/features/dashboard-token-fragment/SPEC.md
src/cli/dashboard-token-fragment.ac7.integration.test.ts
src/dashboard/dashboard-token-fragment.ac1.integration.test.ts
src/dashboard/dashboard-token-fragment.ac2.integration.test.ts
src/dashboard/dashboard-token-fragment.ac3.integration.test.ts
src/dashboard/dashboard-token-fragment.ac4.integration.test.ts
src/dashboard/dashboard-token-fragment.ac5.integration.test.ts
src/dashboard/dashboard-token-fragment.ac6.integration.test.ts
src/dashboard/plain-response.ts
src/dashboard/session-endpoint.ts
src/dashboard/ui/login-page.ts
src/dashboard/ui/login-script.ts
```

declared (22):

```text
src/dashboard/auth.ts
src/dashboard/plain-response.ts
src/dashboard/session-endpoint.ts
src/dashboard/static-assets.ts
src/dashboard/server.ts
src/dashboard/ui/login-page.ts
src/dashboard/ui/login-script.ts
src/dashboard/ui/app-script.ts
src/cli/serve.ts
src/cli/usage.ts
README.md
docs/THREAT-MODEL.md
docs/LIMITS.md
FEATURES.md
CHANGELOG.md
src/dashboard/dashboard-token-fragment.ac1.integration.test.ts
src/dashboard/dashboard-token-fragment.ac2.integration.test.ts
src/dashboard/dashboard-token-fragment.ac3.integration.test.ts
src/dashboard/dashboard-token-fragment.ac4.integration.test.ts
src/dashboard/dashboard-token-fragment.ac5.integration.test.ts
src/dashboard/dashboard-token-fragment.ac6.integration.test.ts
src/cli/dashboard-token-fragment.ac7.integration.test.ts
```

escape-exempt (6) — this feature's own pipeline artifacts or a hook-protected trusted doc, never a build escape:

```text
pharn/features/dashboard-token-fragment/AC-TESTS.lock.json
pharn/features/dashboard-token-fragment/AC-TESTS.md
pharn/features/dashboard-token-fragment/BUILD.md
pharn/features/dashboard-token-fragment/GRILL.md
pharn/features/dashboard-token-fragment/PLAN.md
pharn/features/dashboard-token-fragment/SPEC.md
```

pre-run snapshot: applied — no undeclared path was already changed when this run began.

## Gates

gate: base exit 0 -> head exit 0 — ok — id (quoted, untrusted): build
gate: base exit 0 -> head exit 0 — ok — id (quoted, untrusted): test
gate: base exit 0 -> head exit 0 — ok — id (quoted, untrusted): typecheck

style gates were SKIPPED (config-touch rule: no shared style config changed in scope).

## Pre-existing and regressions

pre_existing (0): (none)
regressions (0): (none)

_/pharn-regress catches exactly what the project's own deterministic suite catches, nothing more — but deterministically. This is not a claim that nothing broke._
