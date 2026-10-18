# RUN REPORT — dashboard-token-fragment

Every line below is derived by `pharn/floor/render-run-report.mjs` from artifacts this run already
produced. No line is authored by a model.

**Trust split (P2).** The values this report reads from deterministic tool output — verdicts, exit
codes, token counts, paths — are the enum-gated / floor-verifiable class. Everything shown inside a
fenced block is **free text that inherits its source's untrusted tag** and is rendered as DATA:
quoted for a person to read, never executed, and never an instruction to any later stage.

**This report ANNOTATES a run and gates nothing.** No proceed/stop anywhere reads it. It is not a
judgment that the change is good, correct, or worth its cost.

## Outcome

The `decision` below is copied verbatim from `LOOP.md`'s frontmatter by the ledger; this report
introduces no second source of truth for it.

```text
decision         STOP_GREEN
iterations       1
blocked          none
base             335270fe39fb1e9e1b0c31cc5b2c5f3a6b935564
command          /pharn-loop
skills_version   6.55.0
ledger coverage  partial
run membership   bounded
```

## Tokens — stage x iteration x model

**Measured population: the RUN'S OWN CONTEXTS inside its window** (`run-window/2`) — only requests of the
selected session that fall inside the window below AND come from the context that printed the run's
markers or an agent that context tree spawned during the run. Earlier and later activity in that session,
and other contexts working inside the window (a concurrent run, its agents, the main thread), are excluded
and counted, never summed. This is NOT a feature's lifetime cost, other sessions' requests are not
collected, and the request that opened the window falls just before it. A floor on this run's spend,
never the total.

```text
status             bounded
method             run-window/2
window start       2026-10-18T12:49:07.673Z
window end         2026-10-18T13:18:44.758Z
selected session   ea997e0b-c47c-4484-a962-328114b9e355
run context        agent:a35b48a60d6bab0ff
run contexts       agent:a35b48a60d6bab0ff, agent:a39c141947f1177ec, agent:a4597e703ea436090, agent:ae00a163148c9dfa2, agent:aef31ca13b6f3bf1b
excluded requests  1284
```

Copied from `cost.json`'s stored views, never recomputed here — `check-cost-ledger.mjs` already
holds those views to a recompute from `requests[]`, so this is one number with one owner.

**TOKENS ONLY.** There is no price table here or in `cost.json`; money is the reader's own
multiplication against their own list, and `output_thinking` is a SUBSET of `output`, not a seventh
class. `unattributed` is an honest STAGE bucket — run requests before the first stage marker — never
folded into a neighbouring stage.

```text
stage           iter  model              reqs  input  cache_write_5m  cache_write_1h  cache_read  output  output_thinking
--------------  ----  -----------------  ----  -----  --------------  --------------  ----------  ------  ---------------
(unattributed)  -     claude-opus-5-5      17     34           42832               0     2829749    1317                0
pharn-build     1     claude-opus-5-5       2      4            1745               0      314372      32                0
pharn-build     1     claude-sonnet-5-5    23     46          101328               0     2648376   13634             1341
pharn-grill     -     claude-opus-5-5       5     10           11991               0      728640      72                0
pharn-plan      -     claude-opus-5-5      24     48          108829               0     2656501    7625              627
pharn-regress   1     claude-opus-5-5       1      2             412               0      159031      16                0
pharn-spec      -     claude-opus-5-5      21     42           87052               0     2134234    4855               14
pharn-test      -     claude-opus-5-5      50    100          281957               0     6919096   28765             1611
pharn-verify    1     claude-opus-5-5       1      2             375               0      159820      16                0
TOTAL           -     -                   144    288          636521               0    18549819   56332             3593
unattributed    -     -                    17     34           42832               0     2829749    1317                0
```

## Stage elapsed and deterministic work

**Observed elapsed** is wall-clock time between two PHARN markers — the stage's start and the orchestrator's
return — read by two different processes. It is NOT CPU time, model time or tool time, it is not monotonic, and
it includes orchestration, subprocesses, waiting and any answer a human gave inside the stage. An `unmeasured`
row names why no interval could be paired, and is never a zero. **Deterministic work** is counted from each
`/pharn-regress` and `/pharn-verify` execution's own gate-run stamp at its `done` exit; an execution that ended any
other way recorded none. Nothing here is subtracted from anything else.

```text
observed elapsed — wall clock between PHARN's stage markers (not CPU, model or tool time; not monotonic)
  stage              iter  run  elapsed
  pharn-spec            -    1  236.8 s
  pharn-plan            -    1  300.8 s
  pharn-grill           -    1  35.0 s
  pharn-test            -    1  788.4 s
  pharn-build           1    1  196.5 s
  pharn-regress         1    1  42.9 s
  pharn-verify          1    1  47.1 s

deterministic work — gate processes run vs taken from reused evidence (counted from each stage's gate-run stamp)
  pharn-regress iter 1 run 1: HEAD gates 3 run, 0 reused, 0 nothing-to-run, of 3; BASE from the entry gates (no worktree, no install, 0 base gate processes; 3 results from this run's entry check)
  pharn-verify iter 1 run 1: gates 5 run, 2 reused, 0 nothing-to-run, of 7
```

## Entry gates (background)

The **entry check** runs the project's gates in a background process while the spec, plan and grill stages work.
Its **lifetime** runs from `--start` to the record of the process that ended it: wall clock across processes,
placement only, not CPU or gate time. A **segment** is one runner or takeover process, timed on its own monotonic
clock. A **wait call** is the foreground time one `--wait` line took, and a takeover runs inside it and is never
added to it. Totals are interval unions, never sums. `INCOMPLETE` means no end was recorded before the run-stop
marker, and it is never a zero.

```text
entry gates — the background check, observed apart from the stage rows (never added to them)
  invocation 9c070fc0: start started (call 534 ms); lifetime 57.0 s (wall clock, start to the runner end record; placement, not CPU or gate time)
    runner 5f5236: 56.4 s monotonic, 6 gate(s), ended done
    execution union: 56.4 s
    of it inside measured stage rows (wall-clock placement only — not proof both were active, not a saving): 49.6 s
    wait calls: 1 (29 ms green); union 29 ms foreground
    abort: nothing running
```

## Files

Changed since `335270fe39fb1e9e1b0c31cc5b2c5f3a6b935564`, plus untracked files. **This is a changed-since-base observation, not a
record of what the build wrote** — a path can appear here because another stage, a generator, or a
person touched it. A `not named in PLAN ## Files` marker is therefore not a scope violation; the
scope question is `check-bash-reconcile.mjs`'s and this report never answers it.

The tree was clean before the run, so no path below is marked `dirty-before-run`.

Rendered after `cost.json` was written and before any commit this run may make, so `cost.json`
appears below and this report itself does not.

- `CHANGELOG.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `CHANGELOG.md` — a `### Security` entry under `## [Unreleased]` with the deprecation
  ```

- `FEATURES.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `FEATURES.md` — the token-exchange line names the fragment login
  ```

- `README.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `README.md` — "Dashboard access" describes the fragment login and the deprecation
  ```

- `docs/LIMITS.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `docs/LIMITS.md` — the SameSite direct-link limit is scoped to the deprecated `?token=` link
  ```

- `docs/THREAT-MODEL.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `docs/THREAT-MODEL.md` — rows B3 and B5 describe the fragment login and the printed hint
  ```

- `src/cli/serve.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/cli/serve.ts` — the printed login line uses `/login#token=<token>`
  ```

- `src/cli/usage.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/cli/usage.ts` — the `--token` help text uses `/login#token=<token>`
  ```

- `src/dashboard/auth.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/dashboard/auth.ts` — add the shared `sessionCookie()` builder and `isTlsRequest()`; doc comment on `SESSION_COOKIE`
  ```

- `src/dashboard/server.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/dashboard/server.ts` — route `/session` and the login assets before auth; shared cookie in the legacy exchange; one-time `DeprecationWarning`; `token` doc comment
  ```

- `src/dashboard/static-assets.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/dashboard/static-assets.ts` — add `createLoginAssets()` for `/login` and `/login.js`; comments
  ```

- `src/dashboard/ui/app-script.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/dashboard/ui/app-script.ts` — the 401/403 status text points at `/login#token=…`
  ```

- `pharn/features/dashboard-token-fragment/AC-TESTS.lock.json` — _not named in PLAN ## Files_
- `pharn/features/dashboard-token-fragment/AC-TESTS.md` — _not named in PLAN ## Files_
- `pharn/features/dashboard-token-fragment/BUILD.md` — _not named in PLAN ## Files_
- `pharn/features/dashboard-token-fragment/GRILL.md` — _not named in PLAN ## Files_
- `pharn/features/dashboard-token-fragment/LOOP.md` — _not named in PLAN ## Files_
- `pharn/features/dashboard-token-fragment/PLAN.md` — _not named in PLAN ## Files_
- `pharn/features/dashboard-token-fragment/REGRESSION.md` — _not named in PLAN ## Files_
- `pharn/features/dashboard-token-fragment/SPEC.md` — _not named in PLAN ## Files_
- `pharn/features/dashboard-token-fragment/VERIFY.md` — _not named in PLAN ## Files_
- `pharn/features/dashboard-token-fragment/cost.json` — _not named in PLAN ## Files_
- `pharn/features/dashboard-token-fragment/regression-report.json` — _not named in PLAN ## Files_
- `pharn/features/dashboard-token-fragment/verify-report.json` — _not named in PLAN ## Files_
- `src/cli/dashboard-token-fragment.ac7.integration.test.ts` — _not named in PLAN ## Files_
- `src/dashboard/dashboard-token-fragment.ac1.integration.test.ts` — _not named in PLAN ## Files_
- `src/dashboard/dashboard-token-fragment.ac2.integration.test.ts` — _not named in PLAN ## Files_
- `src/dashboard/dashboard-token-fragment.ac3.integration.test.ts` — _not named in PLAN ## Files_
- `src/dashboard/dashboard-token-fragment.ac4.integration.test.ts` — _not named in PLAN ## Files_
- `src/dashboard/dashboard-token-fragment.ac5.integration.test.ts` — _not named in PLAN ## Files_
- `src/dashboard/dashboard-token-fragment.ac6.integration.test.ts` — _not named in PLAN ## Files_
- `src/dashboard/plain-response.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/dashboard/plain-response.ts` — new; `plain()` moved verbatim out of `server.ts`
  ```

- `src/dashboard/session-endpoint.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/dashboard/session-endpoint.ts` — new; the `POST /session` handler with its bounded body read
  ```

- `src/dashboard/ui/login-page.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/dashboard/ui/login-page.ts` — new; the static login page HTML
  ```

- `src/dashboard/ui/login-script.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/dashboard/ui/login-script.ts` — new; the vanilla login script served as `/login.js`
  ```

## Verdicts

**iteration 1 (final) only.** `/pharn-loop` OVERWRITES `verify-report.json` and `regression-report.json`
in place whenever it re-runs those stages, so earlier iterations' verdicts are not on disk at the
stop and this
report will not invent them. Per-iteration **cost** is genuine and is in `## Tokens` above.

- verify: `PASS`

  failing_gates, quoted as DATA:

  ```text
  (none)
  ```

- acceptance criteria: `PASS` (test-first)

  the AC gate — id, level, status, reason, matched test ids — quoted as DATA:

  ```text
  AC-1  integration  passed  delivered  src/dashboard/dashboard-token-fragment.ac1.integration.test.ts::dashboard fragment login — AC-1 › AC-1: /login#token=s3cret in a DOM window behind a recording proxy gets a 204 session cookie that opens /events, with no token in any request line and none left in location.href
  AC-2  integration  passed  delivered  src/dashboard/dashboard-token-fragment.ac2.integration.test.ts::dashboard fragment login — AC-2 › AC-2: /login#token=wrong in a DOM window gets a 401 with no Set-Cookie, shows "token rejected", and leaves neither # nor the token in location.href
  AC-3  integration  passed  delivered  src/dashboard/dashboard-token-fragment.ac3.integration.test.ts::dashboard POST /session — AC-3 › AC-3: POST /session with {"token":"s3cret"} (no Origin, or its own origin) answers 204 with an HttpOnly SameSite=Strict Path=/ cookie that is not the token, opens /events, and equals the legacy ?token= cookie
  AC-4  integration  passed  delivered  src/dashboard/dashboard-token-fragment.ac4.integration.test.ts::dashboard POST /session refusals — AC-4 › AC-4: POST /session answers 401 to a wrong token, 403 to a foreign Origin, 415/415/413/400/400/400 to bad bodies, 405 with allow: POST to GET, and 421 to a foreign Host, with no Set-Cookie on any refusal
  AC-5  integration  passed  delivered  src/dashboard/dashboard-token-fragment.ac5.integration.test.ts::dashboard public login assets — AC-5 › AC-5: with no token POST /session is 404; with a token /login and /login.js answer 200 with the page CSP while /, /app.js, /app.css and /events answer 401, the login page has only src scripts, and neither body holds the token
  AC-6  integration  passed  delivered  src/dashboard/dashboard-token-fragment.ac6.integration.test.ts::dashboard legacy ?token= exchange — AC-6 › AC-6: GET /?token=s3cret twice answers 303 to / with the POST /session cookie each time, and emits exactly one PHARGUS_DEP_TOKEN_QUERY DeprecationWarning without the token
  AC-7  integration  passed  delivered  src/cli/dashboard-token-fragment.ac7.integration.test.ts::phargus serve: the fragment login link › AC-7: serve --port 0 with PHARGUS_TOKEN prints http://127.0.0.1:<port>/login#token=<token> on stderr with the literal placeholder and never the token, and --help describes --token with /login#token=
  note  an AC is delivered = a locked, once-red test titled AC-<n>:, in a file mapped to AC-<n>, passed on this head run. PHARN does not judge whether that test fully captures the AC's intent.
  ```

- regress: `no-regressions`

  regressions, quoted as DATA:

  ```text
  (none)
  ```

## Briefing

_n/a — no BRIEFING.md beside this report — not every command renders one, and a run that stops before its post-verify gate never does_

## What the run ran into

Quoted verbatim from `LOOP.md`'s `## Handoff`, as untrusted DATA. Each block is fenced with a
delimiter longer than any back-tick run inside it, so a heading in the quoted text stays text.
**The Handoff is a run's own account of itself — it is not verified by anything**, and nothing here
checks that it is accurate, complete, or useful.

### investigated

```text
How the dashboard bootstraps a browser session without a credential in a request line. Making `/`, `/app.js`
and `/app.css` public was considered and set aside: it would change the existing gated-asset tests and expose the
dashboard shell; a separate public `/login` page and `/login.js` keep every existing gate unchanged.
```

### learned

```text
happy-dom sends no Origin header on a same-origin POST, and `location.assign('/')` changes the href without a
request (from the test stage's report, DATA). The recording proxy needs `allowedHosts: ['127.0.0.1']` so its
own port passes the Host check.
```

### next_steps

```text
Remove the deprecated `GET /?token=` exchange in a later release, together with its deprecation warning and the
LIMITS.md note about the redirected cookie.
```
