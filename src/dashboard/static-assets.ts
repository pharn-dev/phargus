import { renderPage } from './ui/page.js';
import { APP_SCRIPT } from './ui/app-script.js';
import { APP_STYLE } from './ui/app-style.js';
import { renderLoginPage } from './ui/login-page.js';
import { LOGIN_SCRIPT } from './ui/login-script.js';

export type StaticAsset = { readonly contentType: string; readonly body: Buffer };

function asset(contentType: string, text: string): StaticAsset {
  return { contentType, body: Buffer.from(text, 'utf8') };
}

/**
 * The page and its two assets, keyed by pathname. None of them carries a credential: the browser
 * authenticates every request with the session cookie that `POST /session` (or the deprecated
 * `GET /?token=` exchange) set. These are the gated assets; see `createLoginAssets` for the others.
 */
export function createStaticAssets(): ReadonlyMap<string, StaticAsset> {
  return new Map<string, StaticAsset>([
    ['/', asset('text/html; charset=utf-8', renderPage())],
    ['/app.css', asset('text/css; charset=utf-8', APP_STYLE)],
    ['/app.js', asset('text/javascript; charset=utf-8', APP_SCRIPT)],
  ]);
}

/**
 * The login page and its script, keyed by pathname. These are the only paths served without
 * authentication (a visitor has no cookie yet); both are static, and neither is built from, or
 * contains, the token.
 */
export function createLoginAssets(): ReadonlyMap<string, StaticAsset> {
  return new Map<string, StaticAsset>([
    ['/login', asset('text/html; charset=utf-8', renderLoginPage())],
    ['/login.js', asset('text/javascript; charset=utf-8', LOGIN_SCRIPT)],
  ]);
}
