# REGRESSION — collector-persistence-queue

base: `67709097bb271430342c2a16236584e18c2eb715` — chosen by: named with --base

**verdict: NO REGRESSIONS** — no deterministically-detectable breakage outside the feature.

BASE evidence: taken from this run's ENTRY gates — the run marker, the entry offer, the pre-run snapshot, the entry stamp (sha256 `a1dd1c68c11d9efe3116257624bf77d4d99c7bd38754181d22833589c6ed2978`) and its logs agree with this invocation's BASE slots at `67709097bb271430342c2a16236584e18c2eb715`, so this invocation created no base worktree, ran no install and spawned no base gate (retained evidence not reused: `no-record`). The base stamp marks every slot `reused` from the entry run (`test`, `typecheck`, `build`). That they equal what a fresh BASE worktree would give is NOT claimed: the entry gates ran in this tree's real start environment.

install: none run by this invocation (the BASE evidence came from this run's entry gates).

HEAD install: checked — npm's record of the installed tree agrees with `package-lock.json` (24 absent dev/peer/optional package(s) not counted). That `node_modules` holds those packages is not itself checked (install-drift-core.mjs).

## Scope

inside (17):

```text
ARCHITECTURE.md
CHANGELOG.md
FEATURES.md
docs/LIMITS.md
src/collector/collector.ts
src/collector/window-store.ts
pharn/features/collector-persistence-queue/AC-TESTS.lock.json
pharn/features/collector-persistence-queue/AC-TESTS.md
pharn/features/collector-persistence-queue/BUILD.md
pharn/features/collector-persistence-queue/GRILL.md
pharn/features/collector-persistence-queue/PLAN.md
pharn/features/collector-persistence-queue/SPEC.md
src/collector/collector-persistence-queue.ac1.integration.test.ts
src/collector/collector-persistence-queue.ac2.integration.test.ts
src/collector/collector-persistence-queue.ac3.integration.test.ts
src/collector/collector-persistence-queue.ac4.integration.test.ts
src/collector/persist-queue.ts
```

declared (11):

```text
src/collector/persist-queue.ts
src/collector/collector.ts
src/collector/window-store.ts
ARCHITECTURE.md
docs/LIMITS.md
FEATURES.md
CHANGELOG.md
src/collector/collector-persistence-queue.ac1.integration.test.ts
src/collector/collector-persistence-queue.ac2.integration.test.ts
src/collector/collector-persistence-queue.ac3.integration.test.ts
src/collector/collector-persistence-queue.ac4.integration.test.ts
```

escape-exempt (6) — this feature's own pipeline artifacts or a hook-protected trusted doc, never a build escape:

```text
pharn/features/collector-persistence-queue/AC-TESTS.lock.json
pharn/features/collector-persistence-queue/AC-TESTS.md
pharn/features/collector-persistence-queue/BUILD.md
pharn/features/collector-persistence-queue/GRILL.md
pharn/features/collector-persistence-queue/PLAN.md
pharn/features/collector-persistence-queue/SPEC.md
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
