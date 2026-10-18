---
spec_id: dashboard-token-fragment
spec_content_hash: b94920c3e392913a1fff547d52f5385df41985346bb55f3f4753938c179d8d7e
applied_lessons: none
---

## Approach

ADVISORY model work, derived from the Approved SPEC (review finding F28). The dashboard keeps its
single request handler in `src/dashboard/server.ts`; three small new units carry the new axes of
change so `server.ts` only gains routing:

1. **A shared cookie builder** in `src/dashboard/auth.ts` (`sessionCookie(value, secure)`), used by
   both the legacy `GET /?token=` exchange and the new `POST /session`, so the cookie name, value
   and attributes (`HttpOnly; SameSite=Strict; Path=/`, plus `; Secure` on a TLS socket) are one
   string built in one place. `isTlsRequest(req)` moves next to it.
2. **The `POST /session` handler** in a new `src/dashboard/session-endpoint.ts`: method,
   content type, size cap, bounded body read, JSON parse, field check, constant-time compare
   (`tokensMatch`), 204 with the shared cookie or 401.
3. **The public login page and script** in new `src/dashboard/ui/login-page.ts` and
   `src/dashboard/ui/login-script.ts`, served as static assets from a second, public asset map in
   `src/dashboard/static-assets.ts` with the same `STATIC_SECURITY_HEADERS` (so the CSP header value
   is identical to `GET /`).

`plain()` (the text-response helper) moves from `server.ts` into a new
`src/dashboard/plain-response.ts` so `session-endpoint.ts` can answer 405/413/415/400/401 the same
way without importing `server.ts` (no cycle). Behaviour of `plain()` is unchanged.

Request order in `server.ts` after this change (the first four are today's order, unchanged):

1. Host check (421) — unchanged.
2. Origin check (403 for a present, foreign Origin on `/events` or any non-GET) — unchanged; it
   already covers `POST /session`.
3. With a token configured, a `?token=` query: on `GET /` the legacy exchange (now also emitting the
   one-time deprecation warning); on any other path, 401 — unchanged, so `?token=` on `/login`,
   `/login.js` and `/session` is 401.
4. **New:** with a token configured, `url.pathname === '/session'` goes to the session handler
   before the authentication check (any method; the handler answers 405 for non-POST). With no
   token configured, `/session` is not routed and falls to the existing 404 for every method.
5. **New:** a path in the public login-asset map (`/login`, `/login.js`) is served with `GET` (405
   `allow: GET` otherwise) before the authentication check.
6. The authentication check (session cookie or Bearer) and everything after it — unchanged, so `/`,
   `/app.js`, `/app.css` and `/events` stay gated exactly as today.

The legacy exchange's deprecation warning is a per-server boolean set on the first `GET /?token=`
the exchange handles: `process.emitWarning(message, { type: 'DeprecationWarning', code:
'PHARGUS_DEP_TOKEN_QUERY' })`, with a fixed message that names the new link form using the literal
`<token>` placeholder and never the presented or configured token.

## Applied lessons

- none — the lessons index check returned `NO_CANON`: this project has no
  `memory-bank/lessons-learned.md`, so there are no promoted lessons to apply.

## Steps

- `src/dashboard/auth.ts`: add `export function sessionCookie(value: string, secure: boolean):
  string` returning `` `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/${secure ?
  '; Secure' : ''}` `` (byte-for-byte today's legacy string), and `export function
  isTlsRequest(req: IncomingMessage): boolean` (today's `(req.socket as { encrypted?: unknown
  }).encrypted === true`). Update the `SESSION_COOKIE` doc comment to name both exchanges.
- `src/dashboard/plain-response.ts` (new): move `plain(res, status, body, extra?)` out of
  `server.ts` verbatim (it imports `ERROR_SECURITY_HEADERS`). `server.ts` imports it.
- `src/dashboard/session-endpoint.ts` (new): export `SESSION_BODY_LIMIT_BYTES = 4096` and
  `handleSessionRequest(req, res, deps)` where `deps` is `{ token: string; sessionValue: string;
  unauthorized: (res) => void; onBodyError: (error: NodeJS.ErrnoException) => void }`. In order:
  - method not `POST` → `plain(res, 405, 'method not allowed\n', { allow: 'POST' })`;
  - media type: split `content-type` on `;`, the first part trimmed and lowercased must be
    `application/json`, and every remaining parameter must be a `charset=…` parameter (name compared
    case-insensitively); absent or anything else → 415 (`unsupported media type\n`);
  - a declared `content-length` that is not a valid non-negative integer → 400; one over
    `SESSION_BODY_LIMIT_BYTES` → 413 with `connection: close`, without reading the body;
  - read the body with `data`/`end`/`error` listeners (no `.pipe()`), counting bytes; as soon as
    the running total crosses the cap → 413 with `connection: close`, stop accumulating and leave
    the rest unread (the server closes the socket after the response); a `req` `error` → call
    `deps.onBodyError(error)` and destroy the request if no response was written yet; a single
    `done` flag guards against answering twice;
  - decode the body as UTF-8 with `new TextDecoder('utf-8', { fatal: true })` and `JSON.parse` it
    in a `try`/`catch`; a decode or parse error, a non-object value (including `null` and arrays),
    a missing `token` field, or a non-string `token` → 400 (`bad request\n`);
  - `tokensMatch(presented, deps.token)` false → `deps.unauthorized(res)` (401 with
    `www-authenticate: Bearer`, no cookie);
  - match → `res.writeHead(204, { ...ERROR_SECURITY_HEADERS, 'set-cookie':
    sessionCookie(deps.sessionValue, isTlsRequest(req)) })` and `res.end()` (no body, no
    content-type).
  None of these responses contains the token; nothing is logged.
- `src/dashboard/ui/login-page.ts` (new): `renderLoginPage(): string` — a static HTML page with
  `<meta charset>`, `<meta name="viewport">`, `<meta name="referrer" content="no-referrer">`,
  `<title>Phargus login</title>`, no stylesheet link (`app.css` is gated and would 401 before
  login), the only script `<script src="login.js" defer></script>` with no inline content, and a
  `<p id="status">signing in</p>` the script writes to. No data, no credential.
- `src/dashboard/ui/login-script.ts` (new): `export const LOGIN_SCRIPT: string` — one classic
  script in a `String.raw` template (no backtick, no `${`), vanilla JS, an IIFE with
  `'use strict'`:
  - read `window.location.hash`, strip the leading `#`, parse with `URLSearchParams`, take
    `token`;
  - immediately `window.history.replaceState(null, '', window.location.pathname +
    window.location.search)` so the fragment leaves the address bar and the current history entry
    before any other work;
  - no token (null or empty) → status text `no login token in the link: open /login#token=<token>`
    and send nothing;
  - else `fetch('/session', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: token }), credentials: 'same-origin', cache: 'no-store' })`;
    204 → `window.location.assign('/')`; 401 → status `token rejected`; any other status →
    `login failed: HTTP <status>`; a rejected fetch → `login failed: network error`.
  - every status write is `element.textContent = …`, never `innerHTML`.
- `src/dashboard/static-assets.ts`: add `createLoginAssets(): ReadonlyMap<string, StaticAsset>`
  with `/login` (`text/html; charset=utf-8`, `renderLoginPage()`) and `/login.js`
  (`text/javascript; charset=utf-8`, `LOGIN_SCRIPT`); update the comment on `createStaticAssets`
  (the gated page and assets; the session cookie comes from `POST /session` or the deprecated
  `?token=` exchange) and document that the login assets are the only unauthenticated paths.
- `src/dashboard/server.ts`:
  - import `plain` from `./plain-response.js`, `sessionCookie`/`isTlsRequest` from `./auth.js`,
    `handleSessionRequest` from `./session-endpoint.js`, `createLoginAssets`;
  - `exchangeToken` builds its `set-cookie` with `sessionCookie(sessionValue, isTlsRequest(req))`
    and, before checking the token, emits the deprecation warning once per server
    (`let tokenQueryWarned = false`); message: `the dashboard login link /?token=<token> is
    deprecated and will be removed in a later release; open /login#token=<token> instead`;
  - route `/session` (token configured) to `handleSessionRequest` with `onBodyError` reporting
    through `report` unless `isDisconnect(error)`, then the login assets, both before the
    `authenticated(req)` check, per the order in `## Approach`;
  - update the `DashboardServerOptions.token` doc comment: a browser opens
    `/login#token=<token>` once (the fragment never reaches the server) and gets an HttpOnly
    session cookie through `POST /session`; `/?token=<token>` still works for one release and is
    deprecated; API clients send `Authorization: Bearer <token>`.
- `src/dashboard/ui/app-script.ts`: the 401/403 status text becomes `unauthorized — open the
  dashboard login link /login#token=… again`.
- `src/cli/serve.ts`: the token line becomes `a token is required: open
  ${dashboard.url}/login#token=<token> once, or send Authorization: Bearer <token>` (the literal
  `<token>`; the `dashboard at …` line stays first and unchanged).
- `src/cli/usage.ts`: the `--token` line becomes `Require this token (Authorization: Bearer, or
  open /login#token=<token> once).`, wrapped to the existing column layout if it grows past the
  current width.
- Docs (no criterion; gated by format and review): README "Dashboard access" bullets describe the
  `/login#token=<token>` link, the `POST /session` exchange, that the fragment is never sent and is
  removed from history, and that `?token=` on `/` is deprecated for one release; `docs/THREAT-MODEL.md`
  row B3 mitigation names the fragment login, `POST /session` (JSON, 4096-byte cap, Origin check,
  constant-time compare) and the deprecated query exchange, with the residual that the legacy link
  still puts the token in a request line until it is removed; row B5 says the stderr hint is
  `/login#token=<token>`; `docs/LIMITS.md` §4 "direct link" bullet says it applies only to the
  deprecated `?token=` link (the fragment flow sets the cookie on a same-origin `fetch`);
  `FEATURES.md` line 79 names the fragment login; `CHANGELOG.md` gets a `### Security` subsection
  under `## [Unreleased]` describing the change and the `PHARGUS_DEP_TOKEN_QUERY` deprecation.
- Run `npx prettier --write` on each touched file by name, then `npm run lint`, `npm run
  typecheck`, `npm test`, `npm run build`, `npm run check:exports`, `npm run format:check`.

## Files

- `src/dashboard/auth.ts` — add the shared `sessionCookie()` builder and `isTlsRequest()`; doc comment on `SESSION_COOKIE`
- `src/dashboard/plain-response.ts` — new; `plain()` moved verbatim out of `server.ts`
- `src/dashboard/session-endpoint.ts` — new; the `POST /session` handler with its bounded body read
- `src/dashboard/static-assets.ts` — add `createLoginAssets()` for `/login` and `/login.js`; comments
- `src/dashboard/server.ts` — route `/session` and the login assets before auth; shared cookie in the legacy exchange; one-time `DeprecationWarning`; `token` doc comment
- `src/dashboard/ui/login-page.ts` — new; the static login page HTML
- `src/dashboard/ui/login-script.ts` — new; the vanilla login script served as `/login.js`
- `src/dashboard/ui/app-script.ts` — the 401/403 status text points at `/login#token=…`
- `src/cli/serve.ts` — the printed login line uses `/login#token=<token>`
- `src/cli/usage.ts` — the `--token` help text uses `/login#token=<token>`
- `README.md` — "Dashboard access" describes the fragment login and the deprecation
- `docs/THREAT-MODEL.md` — rows B3 and B5 describe the fragment login and the printed hint
- `docs/LIMITS.md` — the SameSite direct-link limit is scoped to the deprecated `?token=` link
- `FEATURES.md` — the token-exchange line names the fragment login
- `CHANGELOG.md` — a `### Security` entry under `## [Unreleased]` with the deprecation

### Explicitly not touched

- `src/agent/` — out of scope; the agent is never changed
- `THREAT-MODEL.md` — the root file belongs to PHARN
- `LIMITS.md` — the root file belongs to PHARN
- `package.json` — no dependency or version change (happy-dom is already a devDependency)
- `package-lock.json` — no dependency change
- `vitest.config.mts` — test infrastructure, unchanged
- `src/dashboard/security-headers.ts` — the CSP and header sets are reused, not changed
- `src/dashboard/ui/page.ts` — the dashboard page is unchanged
- `src/dashboard/dashboard-security.integration.test.ts` — existing legacy-exchange tests stay as they are

## Acceptance mapping

- AC-1 → the login page and script (`/login`, `/login.js`) are public; the script reads the
  fragment, calls `history.replaceState` first, POSTs JSON to `/session`, which answers 204 with
  the shared session cookie; that cookie passes the unchanged `authenticated()` check on
  `GET /events` (200 `text/event-stream`). The token only ever travels in the `POST /session`
  body, never in a request line; `location.href` loses the fragment through `replaceState`.
- AC-2 → `tokensMatch` fails → `unauthorized()` (401, no `Set-Cookie`); the script writes
  `token rejected` with `textContent`; the fragment was already removed.
- AC-3 → `handleSessionRequest` 204 with `sessionCookie(sessionValue, …)` — the same builder and
  the same per-server `sessionValue` the legacy exchange uses, so name and value are equal; the
  global Origin check passes for no Origin or the server's own origin.
- AC-4 → 401 from the compare; 403 from the existing global Origin check (non-GET); 415 for
  `text/plain` and for no content type; 413 from the declared-length or streamed cap; 400 for
  malformed JSON, no `token`, non-string `token`; 405 `allow: POST` for `GET /session`; 421 from
  the existing Host check. Only the 204 path writes `Set-Cookie`.
- AC-5 → with no token `/session` is never routed, so the existing fallthrough answers 404; with a
  token the login-asset map is served before auth (200) while `/`, `/app.js`, `/app.css`, `/events`
  stay behind `authenticated()` (401); both maps use `STATIC_SECURITY_HEADERS`, so the CSP value
  equals `GET /`'s; the login page has one `<script src="login.js">` with no inline content; no
  asset body is built from the token.
- AC-6 → `exchangeToken` keeps its 303 `location: /` and now builds the cookie with the shared
  builder; the per-server `tokenQueryWarned` flag emits exactly one `DeprecationWarning` with code
  `PHARGUS_DEP_TOKEN_QUERY` and a fixed message with no token.
- AC-7 → `serve.ts` prints `${dashboard.url}/login#token=<token>` (bound port from
  `dashboard.url`, literal `<token>`); `usage.ts` `--token` line contains `/login#token=`.

## Risks & open questions

- The recording TCP proxy in AC-1 forwards the browser's `Host` (and `Origin`) naming the proxy's
  port, which the Host policy rejects with 421 unless the test passes
  `allowedHosts: ['127.0.0.1']` (a bare name matches any port) or the proxy rewrites `Host`. The
  test stage should choose `allowedHosts`; no product change is needed for it.
- happy-dom may not keep or replay the HttpOnly cookie on its own requests, and
  `location.assign('/')` makes happy-dom navigate to `/` (which loads `app.js`). The SPEC's
  assumption covers the cookie: the test may send the cookie recorded on the `POST /session`
  response. The test must wait on an event (the recorded `POST /session` reply, then the location
  change) rather than sleep, and close the happy-dom window so `app.js`'s `/events` fetch does not
  hold the test open.
- With no token configured, `/login` and `/login.js` are still served (static, no credential) and
  a link opened there gets `login failed: HTTP 404`; the SPEC sets no criterion for this case and
  the plan keeps the routing simple rather than adding a branch.
- `process.emitWarning` with `type: 'DeprecationWarning'` is suppressed by `--no-deprecation` and
  thrown by `--throw-deprecation`; that is standard Node behaviour, and the warning is emitted before
  the token check so a `--throw-deprecation` process fails on the first legacy request, not
  silently.
- A 413 for a streamed body leaves the rest unread and answers with `connection: close`; the build
  must check the response is still delivered before the socket closes (do not `req.destroy()`
  before `res.end()` completes).
- `server.ts` is already large; moving `plain()` out and putting the session logic in its own file
  keeps its new code to routing only.
