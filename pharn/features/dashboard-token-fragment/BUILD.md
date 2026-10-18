# BUILD — dashboard-token-fragment

Advisory build record.

- Plan built: `pharn/features/dashboard-token-fragment/PLAN.md`
- Chain gate: GREEN (`check-plan-spec-agree.mjs`)
- Test-stage gate (verbatim token): `READY test-first`
- skills: mode=none (catalogue exit 0, no installed skills)

## Scope set (fix #7, from the plan's `## Files`)

`src/dashboard/auth.ts`, `src/dashboard/plain-response.ts`, `src/dashboard/session-endpoint.ts`,
`src/dashboard/static-assets.ts`, `src/dashboard/server.ts`, `src/dashboard/ui/login-page.ts`,
`src/dashboard/ui/login-script.ts`, `src/dashboard/ui/app-script.ts`, `src/cli/serve.ts`,
`src/cli/usage.ts`, `README.md`, `docs/THREAT-MODEL.md`, `docs/LIMITS.md`, `FEATURES.md`,
`CHANGELOG.md`

## Gate result

`build-gate.mjs --mode full`: passed (exit 0; test, lint, format:check, typecheck, build).
The targeted run over the 7 declared AC test files was also exit 0.

## Files written

- New: `src/dashboard/plain-response.ts`, `src/dashboard/session-endpoint.ts`,
  `src/dashboard/ui/login-page.ts`, `src/dashboard/ui/login-script.ts`
- Edited: `src/dashboard/auth.ts`, `src/dashboard/static-assets.ts`, `src/dashboard/server.ts`,
  `src/dashboard/ui/app-script.ts`, `src/cli/serve.ts`, `src/cli/usage.ts`, `README.md`,
  `docs/THREAT-MODEL.md`, `docs/LIMITS.md`, `FEATURES.md`, `CHANGELOG.md`

## Notes

- With no token configured, `/login` and `/login.js` are served (static) while `/session` is not
  routed and answers 404, as the plan's risks section describes.

Built within the named scope from a current approved plan — this is NOT a judgment that the code
is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
