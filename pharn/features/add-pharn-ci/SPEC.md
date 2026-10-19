---
spec_id: add-pharn-ci
state: Approved
spec_content_hash: "60e68b31b40fd8f0a4e010a1eb4028946c11d99c54e39996dc90db64a13a3256"
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Phargus's pull requests are checked for format, lint, types, tests and build, but nothing tells a
reviewer whether the lines a pull request adds are exercised by tests. The maintainer wants the pharn-ci
diff-coverage check (the `pharn-dev/pharn-ci` GitHub Action, 0.1.x) on every pull request, set up the way
the locally installed `pharn-ci-install` skill describes: the project's own test run writes coverage that
pharn-ci can read, the settings live in one committed `.pharn/ci.yml`, and the workflow step is pinned to
the release commit, so each pull request gets a diff-coverage verdict against a threshold.

## Scope

**In scope:**

- A coverage-producing test command (`npm run test:coverage`) whose lcov report counts every non-test
  source file under `src/`, written to a git-ignored path.
- A committed `.pharn/ci.yml` holding the pharn-ci coverage file and threshold.
- Wiring pharn-ci into the existing `Test` job of `.github/workflows/ci.yml` on pull requests, with the
  report uploaded as a workflow artifact.

**Out of scope (non-goals):**

- The two-workflow `workflow_run` pattern that lets fork pull requests receive the sticky comment.
- A Dependabot or CODEOWNERS change (the repository already has both files; the skill only offers these).
- The `setup.require` / `setup.expect` agent setup inputs of `.pharn/ci.yml`.
- Committing the agent skills themselves (`.claude/skills/*` link into the git-ignored `.agents/`).
- Raising the project's existing test coverage, or any change under `src/`.

## Acceptance Criteria

- **AC-1** Given a checkout with dependencies installed by `npm ci` When `npm run test:coverage` runs
  Then it exits 0, the file `coverage/lcov.info` exists and has an `SF:` record for every non-test `.ts`
  file under `src/` (including a file no test imports), and `git check-ignore coverage/lcov.info` reports
  the file as ignored
  - verify: integration
- **AC-2** Given the repository When `.pharn/ci.yml` is read Then its only top-level key is `coverage`,
  it sets `coverage.file` to `coverage/lcov.info` and `coverage.threshold` to `80`, it contains no tab
  character, `git check-ignore .pharn/ci.yml` reports the file as NOT ignored, and
  `git check-ignore .pharn/writes-scope.json` still reports that scratch path as ignored
  - verify: unit
- **AC-3** Given `.github/workflows/ci.yml` When its `Test` job is read Then the job keeps the name
  `Test`, its checkout step sets `fetch-depth: 0`, it runs `npm run test:coverage`, its job-level
  permissions are exactly `contents: read` and `pull-requests: write`, it has a step using
  `pharn-dev/pharn-ci@a88e62a8febf5cd9a77b8e0252cd060c3b94782c` whose `if` limits it to the
  `pull_request` and `merge_group` events, no workflow under `.github/workflows/` uses
  `pull_request_target`, and `npm run check:pins` exits 0
  - verify: unit

## Constraints

- No runtime `dependencies` are added to the root `package.json`; any coverage tooling is a
  devDependency only, and `package-lock.json` is updated and committed with it (npm only).
- Every `uses:` line is pinned to a full 40-character commit SHA with its version as a comment, using the
  pins the `pharn-ci-install` skill's references list; never a tag, branch or short SHA.
- No existing CI check is weakened: the `ci.yml` job names (a contract with the `main` ruleset), triggers,
  steps and the absence of a `strategy.matrix` stay as they are, apart from the edits AC-3 names.
- pharn-ci never runs on `push` and no workflow uses `pull_request_target`.
- Every file written passes `npm run format:check` and `npm run lint`.

## Assumptions

- The threshold is 80: the request names none, and 80 is the skill's stated default; it is changed with
  `coverage.threshold` in `.pharn/ci.yml`.
- Adding a vitest coverage provider (`@vitest/coverage-v8`, at the version matching the installed
  `vitest`) as a devDependency is part of "add pharn ci": vitest writes no lcov without one. The skill asks
  before installing; under this unattended run the request itself is taken as that consent, and the pull
  request is where the maintainer can reject it.
- The existing `Test` job is extended rather than a separate `pharn-ci.yml` workflow added, following the
  skill's rule to extend a job that already runs the tests on pull requests so the tests run once.
- Same-repository pull requests are the target; fork pull requests are still measured, but whether they
  get a comment is not part of this increment.
- `.pharn/` is git-ignored today; the change makes `.pharn/ci.yml` committable while PHARN's own scratch
  under `.pharn/` stays ignored.
- The skills are already present in this worktree (`.claude/skills/*`, untracked, linking into the
  git-ignored `.agents/skills/`), so "move the skills to the worktree" needs no file change.
- Creating the pull request at the end is the orchestrator's step after a green run, not an acceptance
  criterion of this SPEC.
- The worktree has no `node_modules/` yet; the test and build stages run `npm ci` before the gates.
- The `test` runner PHARN finds is `vitest run` (`package.json` `scripts.test`) with per-test results
  configured through `pharn.config.json` `testResults.test`; the test stage's preflight decides whether
  each criterion's level has a runner.
- The setup pull request itself will show pharn-ci's `CONFIG_CHANGED_IN_DIFF` warning and, adding no
  source under `src/`, `NO_COVERABLE_CHANGES`, once the Action runs on it.
