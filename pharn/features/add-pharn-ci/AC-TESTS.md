---
spec_id: add-pharn-ci
spec_content_hash: "60e68b31b40fd8f0a4e010a1eb4028946c11d99c54e39996dc90db64a13a3256"
---

## Files

- `src/ci/pharn-ci-coverage.ac1.integration.test.ts` — the tests for AC-1
- `src/ci/pharn-ci-config.ac2.test.ts` — the tests for AC-2
- `src/ci/pharn-ci-workflow.ac3.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/ci/pharn-ci-coverage.ac1.integration.test.ts` | CLI `npm run test:coverage` spawned via node:child_process spawnSync (`npm`, args `['run', 'test:coverage']`, encoding utf8, a timeout of several minutes, matching vitest test timeout), cwd = repo root (resolved from import.meta.url), env = process.env WITHOUT `PHARN_TEST_RESULTS` and WITH a recursion-guard variable set to `1`, the whole describe skipped (describe.skipIf) when that variable is already `1` so the child run never re-spawns itself; observed: exit status 0; `coverage/lcov.info` exists; the set of `SF:` paths (made repo-relative) contains every `.ts` file under `src/` whose name does not end in `.test.ts`, enumerated from disk with a recursive node:fs readdir, and names `src/cli/bin.ts` explicitly as the file no test imports (the test also asserts no `src/**/*.test.ts` file contains an import specifier ending `cli/bin.js`, so that premise stays true); and `git check-ignore coverage/lcov.info` (spawnSync `git`, cwd repo root) exits 0
- AC-2 | unit | `src/ci/pharn-ci-config.ac2.test.ts` | file `.pharn/ci.yml` read with node:fs readFileSync from the repo root (resolved from import.meta.url), parsed line by line with no YAML dependency; observed: the top-level keys (non-comment, non-blank lines starting at column 0, text before the first `:`) are exactly `['coverage']`; under `coverage:` an indented `file: coverage/lcov.info` and an indented `threshold: 80`; the text contains no `\t`; and via spawnSync `git` (cwd repo root) `git check-ignore .pharn/ci.yml` exits 1 (not ignored) while `git check-ignore .pharn/writes-scope.json` exits 0 (ignored)
- AC-3 | unit | `src/ci/pharn-ci-workflow.ac3.test.ts` | file `.github/workflows/ci.yml` read with node:fs readFileSync from the repo root and sliced to the `test:` job block (from the line `  test:` to the next two-space-indented job key or end of file), with no YAML dependency; observed: the block has `name: Test`; its `actions/checkout@` step's `with:` has `fetch-depth: 0`; it has a step whose `run:` is `npm run test:coverage`; its job-level `permissions:` block (four-space indent, directly under the job) has exactly the two entries `contents: read` and `pull-requests: write`; it has a step with `uses: pharn-dev/pharn-ci@a88e62a8febf5cd9a77b8e0252cd060c3b94782c` whose `if:` names `github.event_name == 'pull_request'` and `github.event_name == 'merge_group'` and no other event; no `.yml`/`.yaml` file under `.github/workflows/` (node:fs readdirSync) contains `pull_request_target`; and `npm run check:pins` spawned via spawnSync (`npm`, cwd repo root, encoding utf8, a timeout) exits 0
