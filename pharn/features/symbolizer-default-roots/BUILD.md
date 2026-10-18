# BUILD — symbolizer-default-roots

- **Plan built:** `pharn/features/symbolizer-default-roots/PLAN.md` (carried spec_content_hash `476bfd89889fa33979f3d7ad9a069ce50a56937e737a40537e07107eb75a9fb3`).
- **Chain gate:** GREEN, by `check-plan-spec-agree.mjs`.
- **Test-stage gate:** `READY test-first` (`check-test-stage.mjs`, exit 0).
- **Writes-scope (fix #7), from the plan's `## Files`:**
  - `src/analyzer/stack-symbolization.ts`
  - `src/analyzer/symbolize-protocol.ts`
  - `src/analyzer/stack-symbolization.ac1.integration.test.ts`
  - `src/analyzer/stack-symbolization.ac2.integration.test.ts`
  - `src/analyzer/stack-symbolization-roots.integration.test.ts`
  - `docs/THREAT-MODEL.md`
  - `FEATURES.md`
  - `docs/LIMITS.md`
  - `SECURITY.md`
  - `CHANGELOG.md`
- **Gate (`build-gate.mjs --mode full`):** passed (exit 0): test, lint, format:check, typecheck, build. Targeted run: exit 0. `npm run check:exports` was not part of the gate runner and was not run.
- **Files written:** the ten paths above, plus this record. `npx prettier --write` was run on each by name; it reflowed table column widths in `docs/THREAT-MODEL.md`.
- **skills:** mode=none (catalogue exit 0, no installed skills).
- **Seams:** none touched; Step 2c was a no-op.

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
