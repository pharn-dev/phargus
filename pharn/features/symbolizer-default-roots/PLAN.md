---
spec_id: symbolizer-default-roots
spec_content_hash: 476bfd89889fa33979f3d7ad9a069ce50a56937e737a40537e07107eb75a9fb3
applied_lessons: none
---

## Approach

> ADVISORY — model work. The floor checks only this file's frontmatter and its `## Files` scope.

The confinement algorithm already lives in the worker (`src/analyzer/workers/symbolize.worker.ts`:
`realRoots` + `confine`, realpath of both the built file and its map, `..` and symlink escapes left
unsymbolized). The worker treats an absent `roots` in its payload as unconfined. So the whole behaviour
change is made in the API layer, `src/analyzer/stack-symbolization.ts`, by changing what it puts in the
payload:

- `roots` left out, or `roots: undefined` → the payload carries `roots: [resolve(process.cwd())]`, with
  `process.cwd()` read inside `symbolizeStackFrames` on every call (never cached at module load).
- `roots: null` → the payload carries no `roots`, i.e. today's unconfined behaviour, now opt-in.
- `roots: [...]` → exactly as today (each entry validated as a non-empty string and `resolve`d).
- Anything else (a string, a number, `false`, an object) → `TypeError`, rejected (not thrown
  synchronously, because `checkRoots` runs inside the `async` function, as today).

The worker, its payload validation (`parseLimits`), `maxFileBytes`, the error shapes and `data:` map
handling are untouched. Then the in-repo tests that legitimately read from `os.tmpdir()` are given explicit
`roots` (or `roots: null`), and the security docs and changelog describe the new default and what
`roots: null` re-opens.

## Applied lessons

- none — `check-lessons-index.mjs --verdict` printed `NO_CANON`: this project has no
  `memory-bank/lessons-learned.md` yet, so there are no promoted lessons to apply.

## Steps

1. **`src/analyzer/stack-symbolization.ts`**
   - Type the option as `roots?: readonly string[] | null | undefined;` (`exactOptionalPropertyTypes` is on
     in `tsconfig.base.json`, so `| undefined` is what lets a caller spread an optional value, per the SPEC's
     assumption that explicit `undefined` equals left out).
   - Rewrite its doc comment: left out, reads are confined to the current working directory (read on each
     call); an array confines reads to those directories (realpath of the built file and of its map must lie
     inside one; frames outside come back unchanged, with no `original` and no `error`); `null` turns
     confinement off so any local file a frame or `sourceMappingURL` names may be read; a broad working
     directory such as `/` or `$HOME` confines little.
   - Change `checkRoots(roots: readonly string[] | null | undefined): string[] | undefined`:
     `undefined` → `[resolve(process.cwd())]`; `null` → `undefined` (the payload then omits `roots`, as the
     existing spread `...(roots === undefined ? {} : { roots })` already does); non-array → `TypeError`
     (message updated to say `roots must be null or an array of directory paths`); array → the existing
     per-entry check and `resolve`, unchanged.
   - No other change in this file; `symbolizeStackFrames`'s signature and return shape stay the same.
2. **`src/analyzer/symbolize-protocol.ts`** — update the `roots` field comment: absolute directories reads
   are confined to; absent means unconfined, which the API sends only for an explicit `roots: null` (it sends
   the working directory when the caller leaves `roots` out). Types only; no shape change.
3. **Existing tests that read outside the working directory** (the SPEC's in-scope test updates):
   - `src/analyzer/stack-symbolization.ac1.integration.test.ts` — pass `roots: [dir]` (the `realpath`ed
     `mkdtemp` directory) to the `symbolizeStackFrames` call and widen the local `SymbolizeModule` options
     type to `{ timeoutMs?: number; roots?: readonly string[] }`. Assertions unchanged.
   - `src/analyzer/stack-symbolization.ac2.integration.test.ts` — same: `roots: [dir]`, widened local type.
   - `src/analyzer/stack-symbolization-roots.integration.test.ts`:
     - "still reads any local file without roots, but never puts file bytes in the error" becomes a
       `roots: null` test (title says `roots: null`), assertions unchanged — it still proves the secret never
       reaches the error message.
     - "caps the size of files read": pass `roots: [base]` to both calls so the size cap, not the new
       default confinement, is what the test exercises (the second call must read `cap/a.js.map` under
       `os.tmpdir()` to produce the `100-byte maxFileBytes limit` error).
     - "refuses a file cap … and validates roots": keep the `roots: ['']` `TypeError` assertion and add one
       for a non-array value (`roots: 'dist' as never`) rejecting with `TypeError`, since `checkRoots`'s
       non-array branch is the one this change edits.
   - `src/analyzer/stack-symbolization.ac3.integration.test.ts` needs no change: its closed-pool and
     non-array-frames cases reject before any file is read.
4. **`docs/THREAT-MODEL.md`**
   - Row E2 mitigation: by default every built file and source map is resolved with `realpath` and read only
     if it lies inside the current working directory (read on each call) or, when `roots` is passed, inside
     one of those roots; `..` and symlink escapes are left unsymbolized; parse errors use fixed reasons; name
     `stack-symbolization-roots.integration.test.ts` and the new `symbolizer-default-roots.ac*` tests.
     **Residual:** `roots: null` turns confinement off (any local file a frame or `sourceMappingURL` names can
     be read again); a broad working directory such as `/` or `$HOME` confines little; frames come from the
     host, not from the network. Status column stays **`Partly enforced`** (one of the document's existing
     values; the gap is stated as a residual, which is what that value means in the header).
   - Residual risk 6: retitle from "unconfined by default" to "confined only to the working directory by
     default (E2)"; say `roots: null` re-opens unconfined reads, and that a broad working directory such as
     `/` or `$HOME` confines little, so pass `roots` naming your build output when frames may come from
     anywhere other than your own build.
5. **`FEATURES.md`** line 57: "with directory confinement (`roots`; default the working directory,
   `roots: null` to turn it off)".
6. **`docs/LIMITS.md`** §4 Security limits: add one bullet — the symbolizer reads only files inside the
   working directory unless `roots` names other directories; `roots: null` turns confinement off; a broad
   working directory (`/`, `$HOME`) confines little, and Phargus does not detect or refuse one.
7. **`SECURITY.md`** best practice 4: reads are confined to the working directory by default; pass `roots`
   naming your build output when the working directory is broad, and avoid `roots: null` unless frames come
   only from your own build.
8. **`CHANGELOG.md`** `[Unreleased]` → `### Security` (the section already exists): a new bullet stating the
   behaviour change — `symbolizeStackFrames` now confines reads to the working directory when `roots` is left
   out; frames whose built file or source map lies outside the working directory are no longer read (they
   come back unchanged) unless the caller passes `roots`, or `roots: null` for the old unconfined behaviour.
9. Run `npx prettier --write` on each edited file by name, then the gates: `npm run typecheck`,
   `npm run lint`, `npm run format:check`, `npm test`, `npm run build`, `npm run check:exports`.

## Files

- `src/analyzer/stack-symbolization.ts` — `roots` accepts `readonly string[] | null | undefined`; left out it becomes `[resolve(process.cwd())]` per call, `null` omits it from the payload; doc comment and `checkRoots` updated
- `src/analyzer/symbolize-protocol.ts` — `roots` field comment describes the new default and `roots: null`
- `src/analyzer/stack-symbolization.ac1.integration.test.ts` — passes explicit `roots: [dir]` for its temporary directory
- `src/analyzer/stack-symbolization.ac2.integration.test.ts` — passes explicit `roots: [dir]` for its temporary directory
- `src/analyzer/stack-symbolization-roots.integration.test.ts` — the unconfined test becomes a `roots: null` test; the cap test passes `roots: [base]`; one non-array `roots` `TypeError` assertion added
- `docs/THREAT-MODEL.md` — row E2 and residual risk 6 describe working-directory confinement by default, what `roots: null` re-opens, and the broad-working-directory caveat
- `FEATURES.md` — the symbolization line names the new default and `roots: null`
- `docs/LIMITS.md` — §4 gains a bullet on default confinement, `roots: null` and broad working directories
- `SECURITY.md` — best practice 4 matches the new default
- `CHANGELOG.md` — `[Unreleased]` `### Security` entry for the behaviour change

### Explicitly not touched

- `src/analyzer/workers/symbolize.worker.ts` — confinement algorithm, payload validation and header comment unchanged (absent `roots` in the payload still means unconfined there)
- `src/analyzer/index.ts` — exports unchanged
- `src/analyzer/stack-symbolization.ac3.integration.test.ts` — rejects before any read; no change needed
- `scripts/install-smoke.mjs` — already passes `roots: [process.cwd()]`
- `bench/lib/soak-collector.mjs` — its frame is `import.meta.resolve('@pharn-dev/phargus/agent')`, the package's own build inside the repository, and it only counts calls that resolve; an unchanged frame still counts
- `docs/API.md` — lists `symbolizeStackFrames` without its options
- `THREAT-MODEL.md` — PHARN's own, write-protected; out of scope per the SPEC

## Acceptance mapping

- AC-1 (no `roots`: two outside-the-working-directory built files, one with a valid and one with a malformed
  map, come back equal to their input; an inside file maps) → step 1's `undefined` → `[cwd]` default; the
  worker's existing `confine` returns `'none'` for the outside built files before either map is read, so no
  `original` and no `error`; the inside file's built file and map pass `confine`. Tested by the new
  `symbolizer-default-roots.ac1` integration test (AC-TESTS.md).
- AC-2 (inside built file whose `sourceMappingURL` names an outside map, no `roots`) → same default; the
  worker confines the map path separately, so the frame comes back unchanged. Tested by
  `symbolizer-default-roots.ac2`.
- AC-3 (`roots: null` on the two outside files: valid map → `original`, malformed map → `error` instanceof
  `MalformedSourceMapError`) → step 1's `null` → payload without `roots` → today's unconfined worker path.
  Tested by `symbolizer-default-roots.ac3`.
- Constraint "invalid `roots` still rejects with `TypeError`" → step 1 keeps both `TypeError` branches;
  step 3 keeps the `['']` assertion and adds a non-array one.
- Constraint "dependency boundaries, dual build, gates" → no import changes; step 9 runs every gate.

## Risks & open questions

- **Fixture inside the working directory.** The AC tests must create their "inside" files under
  `process.cwd()` (the repository root under `vitest run`) and remove them in `finally`/`afterAll`. A dot-led
  `mkdtemp(join(process.cwd(), '.phargus-symbolize-roots-'))` keeps them out of the way; a crash mid-test
  could leave the directory behind until the next run. Advisory.
- **Test workers' working directory.** The SPEC assumes vitest workers run with the repository root as
  `process.cwd()` and that `os.tmpdir()` lies outside it (true on macOS and Linux CI; on Windows `%TEMP%` is
  under the user profile, also outside the checkout). If a CI job ran tests from a checkout under
  `os.tmpdir()`, AC-1/AC-2's "outside" fixtures would be inside the working directory. Flag for the test
  stage's preflight.
- **macOS `/var` → `/private/var`.** The worker realpaths both roots and files, so a symlinked working
  directory still matches; nothing to change, but the AC tests should not compare frame URLs against
  `realpath`ed paths when asserting "equal to input" — compare to the input frame object.
- **Downstream callers** that relied on unconfined reads outside their working directory now get unchanged
  frames silently (no error), by design; the CHANGELOG `### Security` entry is the only notice. Documented,
  not detected.
- `roots: []` (an explicit empty array) keeps today's meaning — confined to nothing, every file frame comes
  back unchanged. Not changed and not criterion-tested.
