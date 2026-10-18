---
spec_id: dashboard-token-fragment
state: Approved
spec_content_hash: b94920c3e392913a1fff547d52f5385df41985346bb55f3f4753938c179d8d7e
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
---

## Intent

Review finding F28 (Low, Security). A token-gated dashboard's one-time browser login today is
`GET /?token=<token>`: the token travels in the HTTP request line, so it lands in reverse-proxy and
load-balancer access logs, and in the browser history entry of that first navigation, before the
server swaps it for a session cookie. Operators who expose the dashboard behind a proxy want the
browser login to keep the token out of every request line and out of browser history, while the
login stays one link they can open. A URL fragment is never sent by browsers, so the login link moves
to `http://<host>:<port>/login#token=<token>`: a small public login page reads the fragment, removes
it from the address bar and history, and trades the token for the same session cookie through a
same-origin `POST /session`. The old `?token=` link keeps working for one release, with a
deprecation warning, so existing bookmarks and scripts do not break.

## Scope

**In scope:**

- A public login page `GET /login` (static HTML with no data and no credential, the same CSP and
  security headers as the dashboard page, scripts only by `<script src>`) and its script
  `GET /login.js` (vanilla JS, no framework, no bundler, a few dozen lines). These two are the only
  paths served without authentication; `/`, `/app.js`, `/app.css` and `/events` stay gated exactly as
  today (session cookie or `Authorization: Bearer`).
- The login script: reads `token` from the fragment, drops the fragment from the address bar and the
  history entry before anything else, POSTs `{"token":"…"}` as `application/json` with same-origin
  credentials to `POST /session`, goes to `/` on success, and on rejection shows a plain
  "token rejected" status as text only.
- `POST /session`: the existing Host check (421) and Origin check (403 for a present, foreign
  Origin); POST only (405 with `allow: POST`); `application/json` only, optionally with a charset
  parameter (else 415); body capped at 4096 bytes (else 413, without reading further); malformed
  JSON or a missing or non-string `token` field is 400; the token compared in constant time; a match
  answers 204 with exactly the session cookie the legacy exchange sets (one shared cookie builder);
  a mismatch answers 401 like other unauthorized responses; with no token configured, 404. Request
  body read errors are handled explicitly.
- The legacy `GET /?token=` exchange keeps working unchanged for one release and emits one
  `DeprecationWarning` with code `PHARGUS_DEP_TOKEN_QUERY` per server, the first time it is used;
  the warning never contains the token.
- `phargus serve`: the printed login line and the `--token` help text show the fragment form
  `/login#token=<token>` (the literal placeholder, never the token value).
- The dashboard script's 401 status text points at the new login link.
- Docs: README "Dashboard access", `docs/THREAT-MODEL.md` row B3 (and B5 where it describes the
  printed URL), `docs/LIMITS.md` (the SameSite direct-link limit no longer applies to the fragment
  flow), the `FEATURES.md` token-exchange line, the `DashboardServerOptions.token` doc comment, the
  static-assets and auth comments, and a `### Security` entry under `## [Unreleased]` in
  `CHANGELOG.md` noting the deprecation.

**Out of scope (non-goals):**

- Removing the legacy `GET /?token=` exchange (a later release does that).
- A form on the login page for typing a token; the page only consumes the link's fragment.
- Any change to the Bearer header flow, to the session cookie's value or attributes, or to the CSP.
- Rate limiting or lockout of token guesses on `POST /session`.
- TLS, cookie revocation, or any other residual already listed for row B3.
- Any change to `src/agent`.
- Editing the root `THREAT-MODEL.md`, which belongs to PHARN.
- Bumping the package version or cutting a release.

## Scenarios

- An operator runs `PHARGUS_TOKEN=… npx phargus serve --host 0.0.0.0` behind nginx, reads the login
  line `http://<host>:<port>/login#token=<token>` on stderr, substitutes the token and opens it. The
  address bar briefly shows the link, then the dashboard at `/` loads with live data. The nginx
  access log shows `GET /login`, `GET /login.js`, `POST /session`, `GET /` and the asset and
  `/events` requests, none carrying the token; the browser history shows `/login` and `/` with no
  fragment.
- The same operator mistypes the token: the login page shows "token rejected" and no cookie is set.
- A user with an old `/?token=…` bookmark opens it: the dashboard still loads, and the server process
  prints one deprecation warning naming the new login link form.

## Acceptance Criteria

- **AC-1** Given a dashboard server created with `createDashboardServer` and token `s3cret`, behind
  a recording TCP proxy that captures every request the server receives When a happy-dom browser
  opens `http://<proxy>/login#token=s3cret` and the login flow runs, and the session cookie set by
  the `POST /session` response is then sent on a `GET /events` through the same proxy Then the
  `POST /session` is answered 204, the `GET /events` is answered 200 with a `text/event-stream`
  content type, no request line the server received contains `s3cret`, and the browser window's
  `location.href` afterwards contains neither `#` nor `s3cret`
  - verify: integration
- **AC-2** Given a dashboard server with token `s3cret` When a happy-dom browser opens
  `/login#token=wrong` and the login flow runs Then the `POST /session` is answered 401 with no
  `Set-Cookie` header, the page shows visible text containing `token rejected`, and the window's
  `location.href` contains neither `#` nor `wrong`
  - verify: integration
- **AC-3** Given a dashboard server with token `s3cret` When `POST /session` is sent with
  `content-type: application/json` and the body `{"token":"s3cret"}` and either no Origin or the
  server's own origin Then it is answered 204 with a `Set-Cookie` header carrying `HttpOnly`,
  `SameSite=Strict` and `Path=/` whose cookie value is not `s3cret`; that cookie alone authorizes
  `GET /events` (200, `text/event-stream`); and the cookie name and value equal those the legacy
  `GET /?token=s3cret` sets on the same server
  - verify: integration
- **AC-4** Given a dashboard server with token `s3cret` When `POST /session` is sent with a wrong
  token, and separately with the right token and a foreign `Origin` header Then the wrong token gets
  401 and the foreign Origin gets 403, and neither response has a `Set-Cookie` header; and When
  `POST /session` is sent with `content-type: text/plain`, with no content type, with a body larger
  than 4096 bytes, with malformed JSON, with no `token` field, and with a non-string `token` Then
  these get 415, 415, 413, 400, 400 and 400 respectively, none with a `Set-Cookie` header; and When
  `GET /session` is sent Then it gets 405 with an `allow: POST` header; and When `POST /session` is
  sent with a foreign `Host` header Then it gets 421
  - verify: integration
- **AC-5** Given a dashboard server with no token configured When `POST /session` is sent with a
  JSON body Then it is answered 404; and given a dashboard server with token `s3cret` When `/login`,
  `/login.js`, `/`, `/app.js`, `/app.css` and `/events` are requested with `GET` and no credentials
  Then `/login` and `/login.js` answer 200 while `/`, `/app.js`, `/app.css` and `/events` answer 401;
  the `/login` and `/login.js` responses carry the same `content-security-policy` header value as an
  authenticated `GET /`; every `<script>` element in the `/login` body has a `src` attribute and no
  inline content; and neither body contains `s3cret`
  - verify: integration
- **AC-6** Given a dashboard server with token `s3cret` When the legacy `GET /?token=s3cret` is sent
  twice to that server Then each answer is 303 with `location: /` and the same `Set-Cookie` cookie
  name and value that `POST /session` sets, and the process emits exactly one warning whose name is
  `DeprecationWarning`, whose code is `PHARGUS_DEP_TOKEN_QUERY`, and whose message does not contain
  `s3cret`
  - verify: integration
- **AC-7** Given `PHARGUS_TOKEN` set to a value in the environment When `phargus serve --port 0` is
  run, and separately `phargus --help` is run Then the `serve` run's stderr contains a line with
  `http://127.0.0.1:<port>/login#token=<token>` (the literal `<token>` placeholder and the bound
  port) and does not contain the token value, and the `--help` output describes the `--token` login
  with `/login#token=`
  - verify: integration

## Constraints

- Zero runtime `dependencies`; Node core only. `src/agent` is untouched. Node 22.18.0 floor; npm
  only.
- TypeScript strict mode; no `any` without an explanatory comment; no `.pipe()`; every touched file
  passes `npm run format:check`; lint, typecheck, build and `check:exports` stay green.
- The login page and script are vanilla JS with no framework and no bundler; the page has no inline
  script; status text is written with `textContent` only, never `innerHTML`.
- The login request uses the non-simple content type `application/json` and same-origin credentials,
  so a foreign page would need a CORS preflight the server never grants.
- The token is never logged, printed, or put in a warning message, a response body, or a request
  line by Phargus.
- Tokens are compared with the existing constant-time comparison; the session cookie's name, value
  and attributes are byte-for-byte those the legacy exchange sets today, `Secure` included on TLS
  sockets.
- No silent failures: request-body read errors on `/session` are handled explicitly.
- Existing tests that use the legacy `GET /?token=` exchange stay valid without edits to their
  assertions.
- The happy-dom DOM test dependency is loaded with `await import('happy-dom')`; tests use ephemeral
  ports and event-driven waits with generous timeouts, never fixed sleeps.

## Assumptions

- "The same CSP" means the identical `content-security-policy` header value the dashboard page `/`
  sends today; the other security headers match the static-asset headers as well.
- The cap of 4096 bytes is on the request body; a declared `content-length` over the cap gets 413
  without the body being read, and a body without a declared length that grows past the cap gets 413
  as soon as it crosses it.
- A `POST /session` with no `Origin` header (for example from `curl`) is allowed, matching how the
  server treats other non-GET requests today.
- The Host (421) and Origin (403) checks on `/session` run before the content-type, size and token
  checks, as they do for every request today; with no token configured `/session` answers 404 for
  every method.
- A `?token=` query on `/login`, `/login.js` or `/session` is rejected with 401 like any other
  non-`/` path today.
- With no `token` in the fragment, the login script sends no request and shows a plain status text;
  its wording is a plan decision with no criterion of its own.
- If happy-dom cannot hold or replay the HttpOnly session cookie on its own `GET /events`, AC-1's
  test sends the cookie that the proxy recorded on the `POST /session` response; the criterion only
  requires that the cookie set by that response authorizes `/events`.
- The `Secure` attribute on TLS sockets is kept by construction (the shared cookie builder) and is not
  a criterion, because the dashboard serves plain HTTP (`docs/LIMITS.md`).
- The dashboard script's 401 status text, the README, `docs/THREAT-MODEL.md`, `docs/LIMITS.md`,
  `FEATURES.md`, doc comments and CHANGELOG edits have no criterion of their own; review and the
  format, lint, typecheck and build gates check them.
- The project has a findable test runner (`npm test` runs `vitest run`); the test stage's preflight
  confirms it.
