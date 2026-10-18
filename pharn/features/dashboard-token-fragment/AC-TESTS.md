---
spec_id: dashboard-token-fragment
spec_content_hash: b94920c3e392913a1fff547d52f5385df41985346bb55f3f4753938c179d8d7e
---

## Files

- `src/dashboard/dashboard-token-fragment.ac1.integration.test.ts` — the tests for AC-1
- `src/dashboard/dashboard-token-fragment.ac2.integration.test.ts` — the tests for AC-2
- `src/dashboard/dashboard-token-fragment.ac3.integration.test.ts` — the tests for AC-3
- `src/dashboard/dashboard-token-fragment.ac4.integration.test.ts` — the tests for AC-4
- `src/dashboard/dashboard-token-fragment.ac5.integration.test.ts` — the tests for AC-5
- `src/dashboard/dashboard-token-fragment.ac6.integration.test.ts` — the tests for AC-6
- `src/cli/dashboard-token-fragment.ac7.integration.test.ts` — the tests for AC-7

## Mapping

- AC-1 | integration | `src/dashboard/dashboard-token-fragment.ac1.integration.test.ts` | GET /login, GET /login.js, POST /session, GET /events on createDashboardServer from src/dashboard/index.ts, driven by a happy-dom Window at /login#token=s3cret through a recording TCP proxy
- AC-2 | integration | `src/dashboard/dashboard-token-fragment.ac2.integration.test.ts` | GET /login, GET /login.js, POST /session on createDashboardServer from src/dashboard/index.ts, driven by a happy-dom Window at /login#token=wrong, visible text "token rejected"
- AC-3 | integration | `src/dashboard/dashboard-token-fragment.ac3.integration.test.ts` | POST /session (application/json) and GET /events and GET /?token= on createDashboardServer from src/dashboard/index.ts
- AC-4 | integration | `src/dashboard/dashboard-token-fragment.ac4.integration.test.ts` | POST /session and GET /session on createDashboardServer from src/dashboard/index.ts
- AC-5 | integration | `src/dashboard/dashboard-token-fragment.ac5.integration.test.ts` | POST /session with no token configured, and GET /login, /login.js, /, /app.js, /app.css, /events on createDashboardServer from src/dashboard/index.ts
- AC-6 | integration | `src/dashboard/dashboard-token-fragment.ac6.integration.test.ts` | GET /?token= and POST /session on createDashboardServer from src/dashboard/index.ts, with the process 'warning' event
- AC-7 | integration | `src/cli/dashboard-token-fragment.ac7.integration.test.ts` | node dist/esm/cli/bin.js serve --port 0 with PHARGUS_TOKEN (stderr login line) and node dist/esm/cli/bin.js --help (stdout)
