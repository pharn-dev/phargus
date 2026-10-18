---
spec_id: agent-config-path-env
spec_content_hash: 988843b6c77d799eadd17b78ba9e95c7ed4b0757ac845a790afecf5e4b0dbd70
applied_lessons: none
---

## Approach

> ADVISORY: model work, derived from the Approved SPEC `agent-config-path-env` (`spec_kind: quick`).

Discovery (live, this run):

- `src/agent/config.ts` exports `loadAgentConfig(cwd, env, options)`. It calls `readConfigEnv(env, cwd, warn)`
  first (synchronous), then `readConfigFile(cwd)`, and returns
  `Object.freeze({ ...defaultAgentConfig, ...fromFile, ...fromEnv })`. `src/agent/index.ts` already re-exports
  `loadAgentConfig`, `PhargusConfigError` and `defaultAgentConfig`, so no entrypoint change is needed.
- `src/agent/config-file.ts`: `exists(cwd, name)` (`stat`; `ENOENT` → absent, other errors →
  `PhargusConfigError(name, undefined, 'cannot be accessed', { cause })`), `loadRaw(cwd, name)` (`.json`:
  `readFile` + `JSON.parse`, with `'cannot be read'` / `'not valid JSON'`; `.js`:
  `createRequire(path.join(cwd, 'noop.js'))(file)`, unwrapping a module namespace's `default`, with
  `'failed to load'`), then the plain-object check, the per-key `isConfigKey` / `validateConfigValue` loop and
  the `output` resolution with `path.resolve(cwd, value)`.
- `src/agent/config-env.ts`: `VARIABLES` maps the four `PHARGUS_*` config variables; `CLI_VARIABLES`
  (`PHARGUS_TOKEN`, `PHARGUS_DEBUG`) are skipped silently; any other `PHARGUS_` name gets
  `unknownVariableWarning(name)`, whose "did you mean" candidate list is `Object.keys(VARIABLES)`.
- `src/agent/config-schema.ts`: `PhargusConfigError(source, key, reason, options)` renders
  `phargus config: <source>[: <key>]: <reason>`.
- `src/agent/auto-start.ts` calls `loadAgentConfig(process.cwd(), process.env)`, so the variable reaches the
  real agent with no change there; a rejection takes the existing "agent disabled" path.
- `docs/THREAT-MODEL.md` (the project's own, not PHARN's root `THREAT-MODEL.md`) has a prettier-aligned §2
  table with rows `A1` to `H1` and the statuses `Enforced today` / `Partly enforced` / `Documented limit`.

The change, split by reason to change:

1. **Env layer knows the name** (`src/agent/config-env.ts`). Add `export const CONFIG_FILE_VARIABLE =
'PHARGUS_CONFIG'`. In `readConfigEnv`, skip it exactly like the CLI names (no warning, no config key). Add it
   to the suggestion candidates in `suggest()` (candidates = `Object.keys(VARIABLES)` plus
   `CONFIG_FILE_VARIABLE`), so a typo such as `PHARGUS_CONFG` warns with `(did you mean PHARGUS_CONFIG?)`. That
   is the PLAN's choice for the SPEC's open "did you mean" question: a mistyped pin silently falls back to the
   cwd lookup, which is the very risk this feature closes, so the hint is worth giving. Existing suggestions are
   unaffected (`INTERVAL`, `OUTPT` and `FOO` are all far from `CONFIG`).
2. **File layer reads either source** (`src/agent/config-file.ts`). Refactor without changing the cwd lookup's
   behaviour or messages:
   - `loadRaw(cwd, file, format: 'json' | 'js', source)`, taking the absolute file and the error source label
     instead of deriving both from the cwd name. The `.js` branch keeps
     `createRequire(path.join(cwd, 'noop.js'))(file)` and the namespace `default` unwrap, so a pinned `.js` loads
     the same way in the ESM and CJS builds.
   - `toConfig(source, raw, cwd)`: the existing plain-object check, unknown-key check, `validateConfigValue`
     loop and `output` resolution against `cwd` (never the pinned file's directory).
   - `readConfigFile(cwd)` keeps its current flow and source labels (`phargus.config.json` /
     `phargus.config.js`) and calls the two helpers.
   - New `readPinnedConfigFile(cwd, variable, value): Promise<Partial<AgentConfig>>`. Steps, each failure a
     `PhargusConfigError` whose source names the variable:
     1. `value === ''` → source `PHARGUS_CONFIG`, reason `is set but empty; unset it to use the working
directory lookup`.
     2. `file = path.resolve(cwd, value)` (an absolute value is used as is). Source label for every later
        failure: `` `${variable} (${file})` ``, so the message contains both `PHARGUS_CONFIG` and the path.
     3. `path.extname(file)`: exactly `.json` → format `json`, exactly `.js` → format `js`; anything else
        (including `''`, `.JSON`, `.cjs`, `.mjs`, `.yaml`) → reason
        `` `unsupported extension ${JSON.stringify(ext)}; use .json or .js` ``. The check runs before any file
        system access, so an unsupported pin is refused even if the file is missing.
     4. `stat(file)`: `ENOENT` → reason `file does not exist`; any other error (`EACCES`, `ERR_ACCESS_DENIED`
        under `--permission`, …) → `cannot be accessed`, with `cause`; a result that is not `isFile()` (the
        `dir.json` directory) → `not a regular file`.
     5. `loadRaw(cwd, file, format, source)`, then `toConfig(source, raw, cwd)`.
        There is no try/catch that falls back to `readConfigFile`; every failure propagates.
3. **Loader picks the source** (`src/agent/config.ts`). After `readConfigEnv`, read
   `env[CONFIG_FILE_VARIABLE]`: `undefined` → `readConfigFile(cwd)` (today's behaviour, unchanged); any string,
   including `''` → `readPinnedConfigFile(cwd, CONFIG_FILE_VARIABLE, value)`, and the cwd is never searched.
   Precedence stays defaults < file < env. Update the doc comment to name `PHARGUS_CONFIG`.
4. **A unit test pins the env-layer choice** (`src/agent/config-env.unknown.test.ts`, not an AC test): add a
   case that `PHARGUS_CONFIG` alone produces no warning, and one that `PHARGUS_CONFG` warns with
   `(did you mean PHARGUS_CONFIG?)`. The `PHARGUS_CONFIG` case points at a valid pinned `.json` in the temp dir
   so the call resolves.
5. **Docs.**
   - `docs/THREAT-MODEL.md` §2: new row `I1` after `H1`, surface "Agent config file (`phargus.config.js`)".
     Threat: a `phargus.config.js` in the working directory is executed as code inside the host process, so
     anyone who can write to that directory runs code in the monitored process. Mitigation: `PHARGUS_CONFIG`
     pins one explicit `.json` or `.js` path, resolved against the working directory, and skips the cwd lookup;
     a pin that is empty, missing, unreadable, not a file or of another extension rejects with
     `PhargusConfigError` and never falls back (the three `config-path-env.ac*.integration.test.ts` files). A
     `.json` config is parsed, never executed. Permission Model note: under `--permission`, `require` needs only
     a read grant, so read access to the cwd is enough for the agent to run a `phargus.config.js` found there;
     with `PHARGUS_CONFIG` the grant can name the one file. Residual: the pin is opt-in, so without it the cwd
     lookup still runs; a pinned `.js` file still runs with the host's full privileges, so it and its directory
     must be writable only by the operator; the file's code is not sandboxed or integrity-checked. Status:
     `Partly enforced`. Add §3 item 9 naming the same accepted residual in one or two sentences.
   - `docs/PERMISSIONS.md`: in the agent grant table, add a row `--allow-fs-read=<PHARGUS_CONFIG file>`
     (reading the pinned config file), and a sentence below the table: with `PHARGUS_CONFIG` set, the agent reads
     only that file for its config, and a `.js` config is executed with only a read grant, so prefer a pinned
     `.json` file or a directory only the operator can write.
   - `README.md` `## Configuration`: add a `PHARGUS_CONFIG` row (default none; "path to the one config file to
     load, `.json` or `.js`; skips the working-directory lookup") and one sentence after the table: when it is set,
     `phargus.config.json` / `phargus.config.js` in the working directory are not read, and a problem with the
     pinned file disables the agent like any invalid value.
   - `FEATURES.md` line 22–23: name `PHARGUS_CONFIG` in the config bullet.
   - `CHANGELOG.md` `## [Unreleased]` `### Added`: one bullet for `PHARGUS_CONFIG` (behaviour, the extensions,
     the no-fallback errors, the threat-model row).
6. Run `npx prettier --write` on each edited file by name (the README and threat-model tables re-align), then
   `npm run typecheck`, `npm run lint`, `npx vitest run src/agent` and `npm run build`.

Constraints held by construction: only `node:fs/promises`, `node:path`, `node:module` and `node:util` are used
(no new import), nothing outside `src/agent` is imported, and no `async_hooks` use is added.

## Applied lessons

- none — the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`, and
  `memory-bank/` does not exist), so there are no lessons to apply.

## Steps

- Add `CONFIG_FILE_VARIABLE` to `src/agent/config-env.ts`, skip it in `readConfigEnv`, add it to the
  suggestion candidates.
- Refactor `src/agent/config-file.ts` into `loadRaw` / `toConfig` helpers, keep `readConfigFile` byte-for-byte
  in behaviour, add `readPinnedConfigFile` with the five ordered checks above.
- Branch in `src/agent/config.ts` on `env.PHARGUS_CONFIG !== undefined`.
- Add the two env-layer cases to `src/agent/config-env.unknown.test.ts`.
- Edit `docs/THREAT-MODEL.md`, `docs/PERMISSIONS.md`, `README.md`, `FEATURES.md`, `CHANGELOG.md`.
- Format each edited file by name; run typecheck, lint, the agent tests and the build.

## Files

- `src/agent/config-env.ts` — export `CONFIG_FILE_VARIABLE`; skip it silently; offer it as a "did you mean" candidate
- `src/agent/config-file.ts` — shared `loadRaw` / `toConfig` helpers; new `readPinnedConfigFile`
- `src/agent/config.ts` — choose the pinned file or the cwd lookup from `PHARGUS_CONFIG`
- `src/agent/config-env.unknown.test.ts` — two cases: no warning for `PHARGUS_CONFIG`, a suggestion for `PHARGUS_CONFG`
- `docs/THREAT-MODEL.md` — §2 row `I1` (Partly enforced) and §3 residual item 9
- `docs/PERMISSIONS.md` — read grant for the pinned file and the `.js` read-is-execute note
- `README.md` — `PHARGUS_CONFIG` row and sentence in `## Configuration`
- `FEATURES.md` — name `PHARGUS_CONFIG` in the config bullet
- `CHANGELOG.md` — `[Unreleased]` `### Added` entry

### Explicitly not touched

- `THREAT-MODEL.md` — PHARN's own root threat model, write-protected and out of scope
- `src/agent/index.ts` — already exports `loadAgentConfig`, `PhargusConfigError` and `defaultAgentConfig`
- `src/agent/config-schema.ts` — keys, validators and the error class are reused as they are
- `src/agent/auto-start.ts` — already passes `process.env`; its error path is reused
- `package.json` — no dependency or script change
- `vitest.config.mts` — the existing `src/**/*.test.ts` include already collects the new tests

## Acceptance mapping

- AC-1 (pinned `.json` wins over the cwd file, relative `output` against cwd, no `PHARGUS_CONFIG` key, no
  warning) → `config.ts` takes the pinned branch so the cwd `phargus.config.json` is never read; `toConfig`
  resolves `output` with `path.resolve(cwd, …)`; the returned object is built only from defaults, file and env
  key layers; `readConfigEnv` skips `PHARGUS_CONFIG` without calling `warn`.
- AC-2 (pinned `.js` resolves even though the cwd holds both config files) → the pinned branch never calls
  `readConfigFile`, so the "both exist" check does not run; the `.js` is loaded by the shared `loadRaw`
  `createRequire` path; unset keys come from `defaultAgentConfig`.
- AC-3 (empty, missing, `dir.json` directory, `settings.yaml` all reject with `PhargusConfigError` naming
  `PHARGUS_CONFIG`, never the cwd values) → checks 1, 4 (`ENOENT`), 4 (`not a regular file`) and 3
  (unsupported extension) of `readPinnedConfigFile`; every source label starts with `PHARGUS_CONFIG`; there is no
  fallback path.

## Risks & open questions

- AC-2's pinned `pinned/custom.js` uses `module.exports`. With no `package.json` above the temp dir it loads as
  CommonJS, but a `package.json` with `"type": "module"` higher up would make it ESM and fail; the test stage may
  write `pinned/package.json` `{"type":"commonjs"}`, as the existing `config.ac2` test does, for determinism.
- `createRequire` caches by absolute path. Each test uses a fresh temp dir, so no cross-test cache hit is
  expected; reloading an edited pinned `.js` in one process is not a supported flow (same as the cwd file today).
- A whitespace-only value resolves to a path whose `extname` is `''`, so it is rejected as an unsupported
  extension rather than as a missing file. It still rejects with `PHARGUS_CONFIG` in the message, which is what
  the SPEC's assumption requires; the reason wording differs from "does not exist".
- The `I1` row cites the AC test files by name; they are written by `/pharn-test`, so the citation is accurate
  only once that stage has run (it runs before the build that edits the doc).
