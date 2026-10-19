# BUILD — add-pharn-ci

Built from `pharn/features/add-pharn-ci/PLAN.md` (iteration 1, quick mode).

- **Chain gate:** GREEN (`check-plan-spec-agree.mjs`).
- **Test-stage gate:** `READY test-first — the mapping holds and the lock records a red run over the pinned tests`.
- **Scope set (fix #7):** `package.json`, `package-lock.json`, `.gitignore`, `.pharn/ci.yml`, `.github/workflows/ci.yml`.
- **Gate result:** passed — `build-gate.mjs --mode full` exit 0 (test, lint, format:check, typecheck, build). The targeted run was green on its second attempt (exit 0).
- **skills:** mode=none (catalogue exit 0, no installed skills; the three `pharn-ci-*` entries were excluded as symlinks).

## Files written

- `package.json`: `test:coverage` script and the `@vitest/coverage-v8` devDependency (`^5.0.3`).
- `package-lock.json`: updated by `npm install --save-dev @vitest/coverage-v8@5.0.3` (12 packages added).
- `.gitignore`: `coverage/` ignored; `.pharn/` directory rule became `/.pharn/*` plus `!/.pharn/ci.yml`.
- `.pharn/ci.yml`: new, `coverage.file: coverage/lcov.info`, `coverage.threshold: 80`.
- `.github/workflows/ci.yml`: the `Test` job (`fetch-depth: 0`, `npm run test:coverage`, job-level permissions, pinned pharn-ci step, report upload).

## Deviations from the plan, for the human to weigh

- **The `test:coverage` script also carries `--exclude "**/pharn-ci-coverage.ac1.integration.test.ts"`.** The plan's script, run as the CI `Test` step, makes the AC-1 test spawn a second `npm run test:coverage` inside the first; vitest refuses two coverage runs in one `coverage/` directory ("already in use by another Vitest process"), so the AC-1 test failed inside the coverage run itself. Excluding that one file from the coverage run avoids it. Consequence: the AC-1 test runs under `npm test` and the build gate, not in the CI coverage step (that step is itself the evidence AC-1 asks for). No AC test or pinned test-infrastructure file was edited.
- **Timing-sensitive tests under load.** Host load average was 50 to 280 during this build. `plugin-runner-sandbox.ac2`, `plugin-runner-caps` and `samplers.ac3` failed with sandbox timeouts under both `npm run test:coverage` and plain `vitest run` while the host was loaded, and passed when load fell. The CI `Test` job now runs with v8 coverage, which adds overhead (the plan's Risks name this).

## Checks run

- `git check-ignore`: `coverage/lcov.info` ignored; `.pharn/ci.yml` not ignored; `.pharn/writes-scope.json` ignored.
- `npm run check:pins`: ok. `npx prettier --check` on `package.json` and `ci.yml`: ok (`.gitignore` has no prettier parser).
- A subset coverage run (`src/ci/pharn-ci-config`, `src/ci/pharn-ci-workflow`, `src/dashboard`) wrote `coverage/lcov.info` with 118 `SF:` records, one per non-test `.ts` file under `src/` (118), including `src/cli/bin.ts`; `check-coverage.mjs` reported `blocking: null`.
- Not run as one clean pass on an idle host: the whole `npm run test:coverage` (red from load-induced timeouts until the gate runs, which were green).

built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
