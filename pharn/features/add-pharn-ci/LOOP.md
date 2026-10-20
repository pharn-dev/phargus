---
decision: STOP_GREEN_QUICK
iterations: 1
cap: 3
mode: quick
commit: 08d736fd9554fdc0d0e6e9761730a6fc31816fc6
date: 2026-10-19
---

# LOOP — add-pharn-ci

- Stages that ran: `/pharn-spec --quick --model-approve` (routed, model opus) → Approved, pinned,
  `approved_by: model`; `/pharn-plan` (routed, model opus); `/pharn-grill --quick` (inline, floor stops
  only); `/pharn-test --unattended` (routed, model opus) — test-first, 3 ACs, 7 tests, red before build,
  locked; iteration 1: `/pharn-build` (routed, model sonnet) → `gate:pass`; the quick scope check (no
  escapes); `/pharn-verify` (inline by policy) → `PASS`.
- Iteration 1 verdict: verify `PASS`. No regression verdict was read (quick mode never runs
  `/pharn-regress`).
- `check-loop.mjs` exit 0 at iter=1/cap=3: `STOP_GREEN_QUICK` — "floor-GREEN (quick table — the SPEC's
  spec_kind is quick): /pharn-verify PASS; no regression verdict was read — stop".
- Freshness (`check-loop-fresh.mjs --front`, iter 1): `FRESH` — checks A–F, I, J pass; G and H skipped
  (quick mode). No re-run was needed.
- No standing reds.
- Pointers: `pharn/features/add-pharn-ci/GRILL.md`, `pharn/features/add-pharn-ci/VERIFY.md`,
  `pharn/features/add-pharn-ci/BUILD.md`.
- One deviation from `PLAN.md`, recorded in `BUILD.md`: the `test:coverage` script excludes
  `src/ci/pharn-ci-coverage.ac1.integration.test.ts` from its own run (the test spawns
  `npm run test:coverage` itself; without the exclusion the coverage run would try to nest inside
  itself). AC-1 still runs, under the plain `test` gate.

## Not checked in quick mode

- **Regressions outside the feature** — no base-vs-head comparison ran; the quick scope check (no escapes
  beyond the plan's declared files) did.
- **The plan interrogation** — `/pharn-grill --quick` ran its two floor stops only (chain + lessons); the
  plan was not interrogated and no griller ran.
- **`RUN-REPORT.md`** — not rendered in quick mode; `cost.json` is kept.

## Handoff

### investigated

Whether the worktree's pre-existing entry-gate red (`lint` exit 1) reflected the base repo or this run's
own setup: it was the latter. Copying the full `.agents/skills/` tree into the worktree (to make the
installed pharn-ci skills usable there) also pulled in unrelated `phargus-*` skill bundles whose
`scripts/types.d.ts` files are not covered by any tsconfig project, which ESLint's typed linting rejected
with a parsing error. Removed the unrelated skill copies (`phargus-diagnose`, `phargus-memory`,
`phargus-rules`, `phargus-setup`, `phargus-verify`, `pharn-cli`), kept only `pharn-ci-install`,
`pharn-ci-cover`, `pharn-ci-explain`, and re-ran entry-gates green. Also ruled out running the AC-1
coverage test inside its own coverage run (vitest refuses a second coverage provider over the same
output directory) — fixed by excluding that one file from `test:coverage`'s own glob.

### learned

The repo's `.gitignore` ignored all of `.pharn/`, so the build had to carve out `!/.pharn/ci.yml` while
keeping `.pharn/writes-scope.json` and PHARN's other scratch files ignored — both AC-2 tests check this
split explicitly. `ci.yml`'s `Test` job name is a contract with the `main` branch ruleset (per a comment
in the workflow), so the plan extended that job instead of adding a new workflow or job. The AC-1
integration test roughly doubles the `test` gate's wall time because it shells out to a second full
`npm run test:coverage` run; under contended load three timing-sensitive tests
(`plugin-runner-sandbox.ac2`, `plugin-runner-caps`, `samplers.ac3`) flaked and then passed once load
dropped — worth watching if CI's coverage step is ever flaky.

### next_steps

Open the pull request from branch `pharn-loop/add-pharn-ci` against `main`; expect pharn-ci's own check
on that PR to report `CONFIG_CHANGED_IN_DIFF` and `NO_COVERABLE_CHANGES` (expected, since the PR only
adds CI plumbing, not covered source). A person should review the one documented plan deviation (AC-1
excluded from its own `test:coverage` run) before merging, and confirm the 80% threshold in
`.pharn/ci.yml` is the value they want (the SPEC used the skill's default since the request named none).
