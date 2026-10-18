---
spec_id: symbolizer-default-roots
state: Approved
spec_content_hash: 476bfd89889fa33979f3d7ad9a069ce50a56937e737a40537e07107eb75a9fb3
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Today the analyzer's stack-trace symbolizer (`symbolizeStackFrames`, exported from the analyzer entrypoint)
reads any local file a frame or a `sourceMappingURL` comment names unless the caller passes `roots`. A
caller who forgets the option, or does not know it exists, lets frame data steer reads of arbitrary local
files (review finding F26). This increment makes confinement the default: when `roots` is left out, reads
are confined to the current working directory, resolved at call time, and the old unconfined behaviour is
available only by asking for it explicitly with `roots: null`. The change and what it re-opens are written
down in the project's security documents, so operators and reviewers see the new default and the escape
hatch.

## Scope

**In scope:**

- The `symbolizeStackFrames` option `roots` accepts `readonly string[] | null` or is left out. Left out,
  it behaves as `[process.cwd()]`, with the working directory read at call time; an explicit `roots: null`
  opts into the old unconfined behaviour (any local file a frame or `sourceMappingURL` names may be read);
  an explicit array behaves exactly as today.
- Confinement stays the existing worker logic, unchanged: the realpath of both the built file and its
  source map must lie inside a root, so `..` and symlink escapes stay out, and a frame whose built file or
  map lies outside comes back unchanged, with no `original` and no `error`.
- The `roots` option's doc comment and the symbolize protocol comment describe the new default and
  `roots: null`.
- `docs/THREAT-MODEL.md` row E2 and residual risk 6: reads are now confined to the working directory by
  default; say what `roots: null` re-opens, and that a broad working directory such as `/` or `$HOME`
  confines little.
- `FEATURES.md`, `docs/LIMITS.md` and `SECURITY.md` item 4 updated to match the new default.
- A `CHANGELOG.md` `[Unreleased]` `### Security` entry saying this is a behaviour change: frames outside the
  working directory are no longer read unless the caller passes `roots`.
- In-repo tests that legitimately read outside the working directory are updated: the existing
  `stack-symbolization.ac1`, `stack-symbolization.ac2` and `stack-symbolization-roots` integration tests that
  use temporary directories pass explicit `roots`, and the existing "still reads any local file without
  roots" test becomes a `roots: null` test. Explicit-roots confinement and the invalid-roots `TypeError`s
  stay covered by the existing `stack-symbolization-roots.integration.test.ts`.

**Out of scope (non-goals):**

- The root `THREAT-MODEL.md` (PHARN's own, write-protected) is not edited.
- No change to the worker's confinement algorithm, to `maxFileBytes`, to the error shapes, or to how
  `data:` source maps are handled.
- No new way to configure roots (no environment variable, no config-file key, no per-frame roots).
- No attempt to detect or refuse a broad working directory such as `/` or `$HOME`; that is documented, not
  enforced.
- No change to callers outside this repository; they get the new default and must pass `roots` (or
  `roots: null`) to read outside their working directory.

## Acceptance Criteria

- **AC-1** Given a temporary directory outside the working directory holding a built file with a valid
  source map and a second built file with a malformed source map, and a built file with a valid source map
  inside the working directory When `symbolizeStackFrames` from the analyzer entrypoint is called on one
  frame for each of the three files with no `roots` option Then the returned frames for both outside files
  are equal to their input frames (no `original` and no `error` property), and the returned frame for the
  inside file carries an `original` position from its source map
  - verify: integration
- **AC-2** Given a built file inside the working directory whose `sourceMappingURL` names a valid source
  map in a temporary directory outside the working directory When `symbolizeStackFrames` from the analyzer
  entrypoint is called on a frame for that built file with no `roots` option Then the returned frame is
  equal to its input frame (no `original` and no `error` property)
  - verify: integration
- **AC-3** Given the same two outside-the-working-directory built files as AC-1 (one with a valid source
  map, one with a malformed source map) When `symbolizeStackFrames` from the analyzer entrypoint is called
  on a frame for each with `roots: null` Then the frame for the valid one carries an `original` position
  from its source map, and the frame for the malformed one carries an `error` that is an instance of the
  exported `MalformedSourceMapError`
  - verify: integration

## Constraints

- `src/analyzer` keeps its existing dependency boundaries: Node core only plus its own files, CPU work in
  Worker Threads under `src/analyzer/workers/`, no inline or `eval`-based workers.
- Failures stay explicit: an invalid `roots` value (neither left out, `null`, nor an array of non-empty
  strings) still rejects with a `TypeError`; no silent fallback and no swallowed error.
- The package's dual ESM/CJS build, `check:exports`, typecheck, lint and format gates keep passing; every
  edited or created file passes `npm run format:check`.
- Node 22.18.0 floor; TypeScript strict mode.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these integration criteria, with per-test
  results, and runs with the repository root as the working directory; the test stage's preflight decides
  whether that holds.
- The tests may create, and must remove, their own fixture directory inside the working directory for the
  "inside" built files and maps; the operating system's temporary directory (`os.tmpdir()`) lies outside
  the repository's working directory, as it does on macOS and Linux CI.
- An explicit `roots: undefined` is treated the same as leaving the option out (confined to the working
  directory), since TypeScript callers may spread an optional value.
- "Resolved at call time" means `process.cwd()` is read on each `symbolizeStackFrames` call, not once at
  module load; this is not criterion-tested because the test workers cannot change their working directory.
- `scripts/install-smoke.mjs` already passes `roots: [process.cwd()]` and `bench/lib/soak-collector.mjs`
  symbolizes a frame that resolves inside the working directory, so neither needs a change; the PLAN may
  confirm this.
- `docs/API.md` lists `symbolizeStackFrames` without describing its options, so it needs no change unless
  the PLAN finds otherwise.
- The documentation changes are reviewed by reading, not criterion-tested; the threat-model row's status
  column keeps one of the document's existing values, chosen by the PLAN.
