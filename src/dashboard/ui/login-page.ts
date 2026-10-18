/**
 * The login page: public, static, and it carries no data and no credential. The token reaches it
 * only in the URL fragment, which the browser never sends; `login.js` reads it, removes it from the
 * address bar, and trades it for the session cookie. No stylesheet (the dashboard's is gated), and
 * no inline script, so the page's CSP needs nothing beyond `script-src 'self'`.
 */
export function renderLoginPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Phargus login</title>
<script src="login.js" defer></script>
</head>
<body>
<h1>Phargus</h1>
<p id="status">signing in</p>
</body>
</html>
`;
}
