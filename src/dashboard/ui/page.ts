/**
 * The dashboard page. Its asset and SSE URLs are plain relative paths: the page carries no
 * credential, the browser's session cookie authorizes each request.
 */
export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="phargus-events" content="events">
<title>Phargus</title>
<link rel="stylesheet" href="app.css">
<script src="app.js" defer></script>
</head>
<body>
<header>
<h1>Phargus</h1>
<p id="status">connecting</p>
<p id="dropped" hidden></p>
</header>
<main>
<section>
<h2>Event loop lag</h2>
<p id="lag" class="figure">–</p>
<p class="window-end"></p>
</section>
<section>
<h2>Memory</h2>
<p id="memory" class="figure">–</p>
<p class="window-end"></p>
</section>
<section>
<h2>GC</h2>
<p id="gc" class="figure">–</p>
<p class="window-end"></p>
</section>
<section>
<h2>Backpressure</h2>
<p id="backpressure" class="figure">–</p>
<p class="window-end"></p>
<ol id="hotspots" aria-label="Backpressure call sites"></ol>
</section>
<section>
<h2>Alerts</h2>
<ul id="alerts"></ul>
<p id="alerts-empty">No alerts yet</p>
</section>
<section aria-labelledby="waterfall-heading">
<h2 id="waterfall-heading">Recent requests</h2>
<ol id="waterfall" aria-label="Trace waterfall"></ol>
<p id="waterfall-empty">No requests yet</p>
<p id="waterfall-dropped" hidden>The agent dropped spans, so older requests may be missing.</p>
</section>
</main>
</body>
</html>
`;
}
