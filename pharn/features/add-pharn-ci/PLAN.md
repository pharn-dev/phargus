---
spec_id: add-pharn-ci
spec_content_hash: "60e68b31b40fd8f0a4e010a1eb4028946c11d99c54e39996dc90db64a13a3256"
applied_lessons: none
---

## Approach

ADVISORY (model work). Wire the pharn-ci diff-coverage check (`pharn-dev/pharn-ci`, 0.1.0) into the
existing `Test` job of `.github/workflows/ci.yml`, following the `pharn-ci-install` skill's "Existing test
job" recipe (`.claude/skills/pharn-ci-install/references/workflows.md`) and its vitest row in
`references/coverage.md`. Four pieces, each one file or one pair of files:

1. **Coverage command.** A new `test:coverage` script in `package.json` runs the same `vitest run` the
   `test` script runs, with the coverage options given on the command line: provider `v8`, reporter
   `lcov`, `include` `src/**/*.ts` (so a source file no test imports still gets an `SF:` record with zero
   hits) and `exclude` `src/**/*.test.ts`. The report lands in vitest's default `coverage/` directory as
   `coverage/lcov.info`. The options go on the command line, not into `vitest.config.mts`, because that
   root runner config is pinned by the test-infrastructure pin (`pharn/pharn-contracts/ac-tests.md`, "The
   test-infrastructure pin") and a build that edits it would read `test-infra-changed` at `/pharn-verify`.
   The `test` script itself stays `vitest run`, so the pinned `test` gate is unchanged and does not chain
   to the new script.
2. **Coverage provider.** `@vitest/coverage-v8` added as a devDependency at `5.0.3`, the version the lock
   resolves for `vitest` (`package-lock.json` `node_modules/vitest` is 5.0.3; `@vitest/coverage-v8@5.0.3`
   declares the peer `vitest: 5.0.3`, read from the registry this run). Installed with npm, so
   `package-lock.json` changes with it. No runtime `dependencies` entry is added.
3. **Ignore rules.** `.gitignore` gains `coverage/` (today `git check-ignore coverage/lcov.info` exits 1:
   not ignored, which pharn-ci would report as `COVERAGE_FILE_TRACKED` once committed), and its `.pharn/`
   line becomes `/.pharn/*` plus `!/.pharn/ci.yml`. Git cannot re-include a file under an excluded
   directory, so the directory pattern must become a contents pattern for the negation to work; every
   other path under `.pharn/` (PHARN's scratch, `writes-scope.json` included) stays ignored.
4. **Settings and workflow.** A committed `.pharn/ci.yml` with exactly the skill's template: one
   top-level `coverage` key, `file: coverage/lcov.info`, `threshold: 80`. In `ci.yml`, the `Test` job gets
   only the skill's listed edits: `fetch-depth: 0` on its checkout (keeping `persist-credentials: false`),
   `npm test` replaced by `npm run test:coverage` (the tests still run once), a job-level `permissions:`
   block of exactly `contents: read` and `pull-requests: write`, and two steps at the end: the pharn-ci step
   pinned to `a88e62a8febf5cd9a77b8e0252cd060c3b94782c # v0.1.0` with `timeout-minutes: 5`, no `with:`, and
   `if: github.event_name == 'pull_request' || github.event_name == 'merge_group'` (the job has no matrix,
   so the reference's matrix clause is dropped), then the report upload with
   `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2`, the pin the repository
   already uses in `nightly.yml` and `publish.yml` and the one the skill lists. No `concurrency:` block (the
   skill says not to add one to an existing workflow), no new trigger, no renamed job, no matrix.

## Applied lessons

- none — `node pharn/floor/check-lessons-index.mjs . --verdict` printed `NO_CANON`: this project has no
  `memory-bank/lessons-learned.md`, so there are no promoted lessons to apply.

## Steps

- Add `"test:coverage"` to `package.json` `scripts`, directly after `"test:watch"`:
  `vitest run --coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov --coverage.include=\"src/**/*.ts\" --coverage.exclude=\"src/**/*.test.ts\"`
  (the globs double-quoted inside the JSON string so `sh` never expands them). Leave `"test"` untouched.
- Run `npm install --save-dev @vitest/coverage-v8@5.0.3`, which writes the devDependency
  (`"^5.0.3"`, alphabetically before `eslint`) into `package.json` and updates `package-lock.json`. Confirm
  afterwards that `package.json` has no `dependencies` key and that the lock resolves
  `node_modules/@vitest/coverage-v8` and `node_modules/vitest` to the same version.
- Edit `.gitignore`: add a `coverage/` line (beside `dist/`), and replace the `.pharn/` line with
  `/.pharn/*` and `!/.pharn/ci.yml`, with a one-line comment saying only the pharn-ci settings file is
  committed. Check with `git check-ignore -v coverage/lcov.info` (ignored), `git check-ignore .pharn/ci.yml`
  (exit 1, not ignored) and `git check-ignore .pharn/writes-scope.json` (exit 0, ignored).
- Write `.pharn/ci.yml`: a comment line saying the pharn-ci Action and `pharn-ci check` both read it, then
  `coverage:` with two-space-indented `file: coverage/lcov.info` and `threshold: 80`. Spaces only, no tab.
- Edit the `test:` job in `.github/workflows/ci.yml` as the Approach lists, with a short comment above the
  job's `permissions:` saying why this one job gets `pull-requests: write` and why `contents: read` is
  repeated (a job-level block replaces the workflow-level one), and a comment on the pharn-ci step saying
  the event condition keeps it off `push`. Every other job, the triggers and the header comment stay as
  they are.
- Run `npm run test:coverage` locally: it must exit 0 and write `coverage/lcov.info` with an `SF:` line
  for every non-test `.ts` file under `src/`. Then run the skill's helper,
  `node .claude/skills/pharn-ci-install/scripts/check-coverage.mjs --coverage coverage/lcov.info`, and
  confirm `blocking` is `null` (it reads `.pharn/ci.yml` paths against the tracked files; untracked files
  show under `paths.untrackedOnDisk` until committed).
- Run `npm run check:pins`, `npx prettier --check package.json .gitignore .github/workflows/ci.yml`,
  `npm run format:check` and `npm run lint`. `.pharn/ci.yml` sits under `.prettierignore`'s `.pharn/` and
  eslint's `.pharn/**` ignores, so both gates pass it unread; it is hand-written to the skill's template.

## Files

- `package.json` — adds the `test:coverage` script and the `@vitest/coverage-v8` devDependency; `test` and every other script unchanged
- `package-lock.json` — updated by `npm install` for `@vitest/coverage-v8@5.0.3` and its transitive packages
- `.gitignore` — ignores `coverage/`; turns the `.pharn/` directory rule into `/.pharn/*` plus `!/.pharn/ci.yml`
- `.pharn/ci.yml` — new: pharn-ci settings, `coverage.file: coverage/lcov.info`, `coverage.threshold: 80`
- `.github/workflows/ci.yml` — the `Test` job: `fetch-depth: 0`, `npm run test:coverage`, job-level permissions, the pinned pharn-ci step and the report upload

### Explicitly not touched

- `vitest.config.mts` — the root runner config the test-infrastructure pin covers; coverage options go on the command line instead
- `src/**` — no source change (SPEC non-goal); the AC tests are mapped in `AC-TESTS.md`, not here
- `.prettierignore` — already lists `coverage/` and `.pharn/`
- `eslint.config.mjs` — already ignores `coverage/**` and `.pharn/**`
- `.github/workflows/codeql.yml` — unchanged; no other workflow changes
- `.github/workflows/gitleaks.yml` — unchanged
- `.github/workflows/nightly.yml` — unchanged
- `.github/workflows/node-latest.yml` — unchanged
- `.github/workflows/publish.yml` — unchanged
- `.github/dependabot.yml` — SPEC non-goal
- `pharn.config.json` — no gate or results-format change
- `.claude/skills/pharn-ci-install/SKILL.md` — the skills stay uncommitted (SPEC non-goal)
- `CHANGELOG.md` — a CI check is not a change to the published package

## Acceptance mapping

- **AC-1** (`npm run test:coverage` exits 0; `coverage/lcov.info` exists with an `SF:` record for every
  non-test `.ts` file under `src/`, including one no test imports; the file is git-ignored) → the
  `test:coverage` script with `--coverage.include="src/**/*.ts"` and `--coverage.exclude="src/**/*.test.ts"`,
  the `@vitest/coverage-v8` provider, and the `coverage/` line in `.gitignore`.
- **AC-2** (`.pharn/ci.yml` has only the `coverage` key, `file` `coverage/lcov.info`, `threshold` `80`, no
  tab; it is not ignored while `.pharn/writes-scope.json` still is) → the new `.pharn/ci.yml` and the
  `/.pharn/*` + `!/.pharn/ci.yml` rules in `.gitignore`.
- **AC-3** (the `Test` job keeps its name, checks out with `fetch-depth: 0`, runs `npm run test:coverage`,
  has job permissions of exactly `contents: read` + `pull-requests: write`, a pinned pharn-ci step limited
  to `pull_request` / `merge_group`; no `pull_request_target` anywhere; `npm run check:pins` exits 0) → the
  `ci.yml` `Test` job edits; the upload step's pin is a full SHA, so `check:pins` stays green.

## Risks & open questions

- **AC tests live under `src/`.** The only runner the gates have is `vitest run` with
  `include: ['src/**/*.test.ts']` (`vitest.config.mts`, pinned), so the AC tests are mapped to a new
  `src/ci/` directory. They are test files, excluded from the build (`tsconfig.esm.json` excludes
  `src/**/*.test.ts`) and from coverage; the SPEC's "no change under `src/`" non-goal is read as no
  source change. `/pharn-grill` may want that reading confirmed.
- **AC-1's test runs the whole suite again.** It spawns `npm run test:coverage`, which runs every
  `src/**/*.test.ts` file, the AC-1 test included. The test must (a) skip itself in that child run through
  an environment variable it sets only for the child, or it recurses, and (b) remove `PHARN_TEST_RESULTS`
  from the child's environment, or the child's vitest writes its own JSON report over the path the
  parent gate run reads (`vitest.config.mts`). The nested run roughly doubles the `test` gate's time and
  runs the suite twice at once, so the AC-1 test needs a long timeout (minutes) and timing-sensitive tests
  elsewhere may see more contention.
- **Coverage in CI.** The `Test` job now runs with v8 coverage on `push` to `main` as well as on pull
  requests; v8 coverage adds some overhead, which timing-sensitive tests may notice. The pharn-ci step
  itself is skipped on `push`.
- **Worker files.** Files loaded only inside Worker Threads or child processes
  (`src/analyzer/workers/*.ts`, `src/plugin-runner/workers/sandbox-child.ts`) appear in the report through
  `coverage.include`, but vitest's v8 provider does not collect from those threads, so their lines read as
  uncovered. That is honest for pharn-ci (the lines are not measured) but means a PR changing a worker
  file needs tests that reach the logic in-process to meet the threshold.
- **Version lock-step.** `@vitest/coverage-v8@5.0.3` peers on exactly `vitest@5.0.3`; a Dependabot bump of
  one without the other breaks `npm ci`. Worth grouping the two in Dependabot later (out of scope here).
- **Expected warnings on the setup PR.** pharn-ci will report `CONFIG_CHANGED_IN_DIFF` (verdict `warn`)
  and, adding no source under `src/`, `NO_COVERABLE_CHANGES` (SPEC assumption).
- **Network.** The build needs registry access for `npm install --save-dev @vitest/coverage-v8@5.0.3`.
