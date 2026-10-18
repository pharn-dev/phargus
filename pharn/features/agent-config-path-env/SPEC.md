---
spec_id: agent-config-path-env
state: Approved
spec_content_hash: 988843b6c77d799eadd17b78ba9e95c7ed4b0757ac845a790afecf5e4b0dbd70
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Today the agent (`src/agent`) looks for `phargus.config.json` or `phargus.config.js` in the process's working
directory and, for the `.js` form, executes that file as code. An operator who starts a monitored process from
a directory they do not fully control (a shared checkout, a container's working directory, a deploy directory
other people can write to) has no way to say "load this one config file and nothing else": whatever
`phargus.config.js` sits in the cwd runs inside their process. This increment adds a `PHARGUS_CONFIG=<path>`
environment variable that pins the agent to exactly one config file and skips the cwd lookup, and records the
agent config file as a surface in the project's threat model, so the operator can close that gap and the
risk is written down where reviewers look.

## Scope

**In scope:**

- A `PHARGUS_CONFIG=<path>` environment variable read by the agent's config loading (`loadAgentConfig`,
  exported from the agent entrypoint). When it is set, the agent loads exactly that file, with the path
  resolved relative to the cwd passed to `loadAgentConfig`, and does not look for `phargus.config.json` or
  `phargus.config.js` in the cwd at all.
- A pinned file ending in `.json` is parsed as JSON; a pinned file ending in `.js` is loaded the same way the
  cwd `phargus.config.js` is loaded today; any other extension is rejected with `PhargusConfigError`.
- A set-but-empty `PHARGUS_CONFIG`, a path that does not exist, or a file that cannot be read rejects with a
  `PhargusConfigError` whose message names `PHARGUS_CONFIG`, in the same style the existing config failures are
  reported; the agent never falls back to the cwd lookup in any of these cases.
- The pinned file is validated exactly like a cwd config file today (same keys, same value checks), and a
  relative `output` path inside it keeps resolving against the cwd, not against the pinned file's directory.
- `PHARGUS_CONFIG` is a known `PHARGUS_*` name: it does not trigger the "ignoring unknown environment variable"
  warning, and it is not itself a config key (it never appears in the resolved config).
- `docs/THREAT-MODEL.md` §2 gains a row `I1` for the surface "Agent config file (`phargus.config.js`)": the
  file is executed as code from a cwd the operator must trust; the mitigation is `PHARGUS_CONFIG`, which pins
  an explicit path and skips the cwd lookup; with Permission Model notes (under `--permission`, read access to
  the cwd is enough for the agent to run a `phargus.config.js` found there); plus residual-risk or
  trust-assumption wording where the row needs it.
- `PHARGUS_CONFIG` documented in `README.md`, `FEATURES.md` and `docs/PERMISSIONS.md`, and a `CHANGELOG.md`
  `[Unreleased]` `### Added` entry.

**Out of scope (non-goals):**

- The root `THREAT-MODEL.md` (PHARN's own, write-protected) is not edited.
- No parent-directory search, no search path list, and no support for more than one pinned file.
- No new config file formats: `.cjs`, `.mjs`, `.ts`, YAML and other extensions stay unsupported.
- No change to the precedence of the existing `PHARGUS_*` variables over the file's values, and no change to
  how the cwd lookup behaves when `PHARGUS_CONFIG` is unset.
- No sandboxing or integrity check of a `.js` config file's code; pinning a path narrows which file runs, it
  does not make that file safe.

## Acceptance Criteria

- **AC-1** Given a temporary cwd that contains a valid `phargus.config.json` with one `intervalMs` value, and a
  subdirectory file `pinned/custom.json` with a different `intervalMs` and a relative `output` such as
  `out/agent.ndjson` When `loadAgentConfig` from the agent entrypoint is called with that cwd, an env of
  `{ PHARGUS_CONFIG: 'pinned/custom.json' }` and an `onWarning` collector Then it resolves with the pinned
  file's `intervalMs` (not the cwd file's), with `output` equal to the cwd joined with `out/agent.ndjson` (not
  the `pinned` directory joined with it), with no `PHARGUS_CONFIG`-named key in the returned config, and with
  `onWarning` never called
  - verify: integration
- **AC-2** Given a temporary cwd that contains both `phargus.config.json` and `phargus.config.js` (a pair that
  makes the cwd lookup reject with "both exist"), and a subdirectory file `pinned/custom.js` whose
  `module.exports` is a plain object with a valid `queueBound` When `loadAgentConfig` from the agent entrypoint
  is called with that cwd and an env of `{ PHARGUS_CONFIG: 'pinned/custom.js' }` Then it resolves (does not
  reject) with the pinned file's `queueBound`, and the other keys equal the agent's default config
  - verify: integration
- **AC-3** Given a temporary cwd that contains a valid `phargus.config.json` When `loadAgentConfig` from the
  agent entrypoint is called with that cwd and, in separate calls, `PHARGUS_CONFIG` set to the empty string,
  to a path that does not exist, to a directory named `dir.json` (a path that exists but cannot be read as a
  file), and to an existing `settings.yaml` file Then every call rejects with an error that is an instance of
  the exported `PhargusConfigError` and whose message contains `PHARGUS_CONFIG`, and no call resolves with the
  cwd file's values
  - verify: integration

## Constraints

- `src/agent` imports Node core modules only: zero third-party dependencies and no imports from other `src/`
  modules; no `async_hooks` import outside the agent's context module.
- Failures are explicit: every `PHARGUS_CONFIG` problem surfaces as a rejected `PhargusConfigError`; no silent
  fallback to the cwd lookup, no swallowed error.
- A `.js` file is loaded the same way in the ESM and CJS builds (as the cwd `phargus.config.js` is today), and
  the package's dual ESM/CJS build, typecheck, lint and format gates keep passing.
- Every edited or created file passes `npm run format:check`.
- Node 22.18.0 floor; TypeScript strict mode.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these integration criteria, with per-test
  results; the test stage's preflight decides whether that holds.
- "Resolved relative to cwd" means relative to the `cwd` argument passed to `loadAgentConfig` (the same
  directory the cwd lookup uses), and an absolute `PHARGUS_CONFIG` path is used as is.
- Extension matching is exact and case-sensitive on the final extension: only `.json` and `.js` are accepted;
  `.JSON`, `.cjs`, `.mjs` and every other extension are rejected as unsupported.
- A whitespace-only `PHARGUS_CONFIG` is treated like any other path (it names a file that does not exist) and
  so also rejects; only the exactly-empty value is criterion-tested as "set but empty".
- "Cannot be read" is criterion-tested with a directory at the pinned path, which is portable and works when
  the tests run as root; a permission-denied file (mode `000`) is covered by the same error path but is not
  criterion-tested.
- The error's source names `PHARGUS_CONFIG` (and may also include the pinned path); the exact reason wording
  for each failure is the PLAN's choice, in the style of the existing `phargus config: <source>: <reason>`
  messages.
- Whether `PHARGUS_CONFIG` is offered as a "did you mean" suggestion for a mistyped variable (for example
  `PHARGUS_CONFG`) is the PLAN's choice; it is not criterion-tested.
- Validation and `output` resolution of the pinned file reuse the existing cwd-file rules, so a pinned file
  with an unknown key or an invalid value rejects exactly as a cwd file does today; the error may name the
  pinned file or `PHARGUS_CONFIG` as its source.
- The threat-model row's status column uses one of the document's existing values (for example "Partly
  enforced"), chosen by the PLAN; the docs changes are reviewed by reading, not criterion-tested.
