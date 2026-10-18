---
decision: STOP_GREEN
iterations: 1
cap: 3
commit: 335270fe39fb1e9e1b0c31cc5b2c5f3a6b935564
date: 2026-10-18
---

# LOOP — dashboard-token-fragment

- Stages: `/pharn-spec --model-approve` (agent:opus), `/pharn-plan` (agent:opus), `/pharn-grill --floor-only`
  (inline, policy), `/pharn-test --unattended` (agent:opus), then iteration 1: `/pharn-build` (agent:sonnet,
  `done gate:pass`), `/pharn-regress` (inline, policy), `/pharn-verify` (inline, policy).
- Entry gates (6.42.0): green on the base tree (lint, format:check, base:test, test, typecheck, build); no red,
  unattributed or mutated gate.
- Test stage: `check-test-stage.mjs --require-test-first` → `READY test-first`, 7 integration ACs, red run recorded.
- Iteration 1: regress `no-regressions`, verify `PASS`; `check-loop-fresh.mjs --front` → `FRESH`;
  `check-loop.mjs --iter 1 --cap 3` → exit 0, `STOP_GREEN`.
- Standing reds: none.
- Pointers: `GRILL.md`, `REGRESSION.md`, `VERIFY.md`, `BUILD.md` in this directory.

## Outcome

- commit: committed pharn-loop/dashboard-token-fragment
- spec: approved by the model
- blocked: none
- ac-tests: test-first

## Handoff

### investigated

How the dashboard bootstraps a browser session without a credential in a request line. Making `/`, `/app.js`
and `/app.css` public was considered and set aside: it would change the existing gated-asset tests and expose the
dashboard shell; a separate public `/login` page and `/login.js` keep every existing gate unchanged.

### learned

happy-dom sends no Origin header on a same-origin POST, and `location.assign('/')` changes the href without a
request (from the test stage's report, DATA). The recording proxy needs `allowedHosts: ['127.0.0.1']` so its
own port passes the Host check.

### next_steps

Remove the deprecated `GET /?token=` exchange in a later release, together with its deprecation warning and the
LIMITS.md note about the redirected cookie.
