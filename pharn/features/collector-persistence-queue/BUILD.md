# BUILD — collector-persistence-queue

Advisory build record (thin). Not a judgment that the code is correct.

- **Plan built:** `pharn/features/collector-persistence-queue/PLAN.md` (spec_id `collector-persistence-queue`).
- **Chain gate:** GREEN, by `check-plan-spec-agree.mjs` (spec→plan hash chain holds).
- **Test-stage gate:** `READY test-first` (`check-test-stage.mjs`, exit 0).
- **skills:** mode=none (catalogue exit 0, no installed skills).
- **Writes-scope set from the plan (authorized paths):**
  - `src/collector/persist-queue.ts`
  - `src/collector/collector.ts`
  - `src/collector/window-store.ts`
  - `ARCHITECTURE.md`
  - `docs/LIMITS.md`
  - `FEATURES.md`
  - `CHANGELOG.md`
- **Files written:** the seven paths above. `persist-queue.ts` is new; the others were edited.
- **Gate result:** passed. `build-gate.mjs --mode full` exited 0 (test, lint, format:check, typecheck, build all exit 0). The targeted run over the four AC test files exited 0. One lint error (`unbound-method` on a destructured `append`) was fixed within scope between the first and second full run.

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
