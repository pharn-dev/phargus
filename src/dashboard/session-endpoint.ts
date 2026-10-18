import type { IncomingMessage, ServerResponse } from 'node:http';
import { isTlsRequest, sessionCookie, tokensMatch } from './auth.js';
import { plain } from './plain-response.js';
import { ERROR_SECURITY_HEADERS } from './security-headers.js';

/** The largest `POST /session` body read; a login body is a short JSON object. */
export const SESSION_BODY_LIMIT_BYTES = 4096;

export type SessionEndpointDeps = {
  /** The configured token the presented one is compared against. */
  token: string;
  /** The per-server opaque value the session cookie carries. */
  sessionValue: string;
  /** Answers a wrong token: 401 with `WWW-Authenticate`, no cookie. */
  unauthorized: (res: ServerResponse) => void;
  /** Reports a request stream error that is not a routine disconnect. */
  onBodyError: (error: NodeJS.ErrnoException) => void;
};

/** True for `application/json`, optionally with only `charset=…` parameters. */
function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) {
    return false;
  }
  const [mediaType, ...parameters] = header.split(';');
  if (mediaType?.trim().toLowerCase() !== 'application/json') {
    return false;
  }
  return parameters.every((parameter) => {
    const eq = parameter.indexOf('=');
    return eq !== -1 && parameter.slice(0, eq).trim().toLowerCase() === 'charset';
  });
}

/** The `token` string of a JSON body, or `undefined` when the body is not `{ "token": "…" }`. */
function presentedToken(body: Buffer): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const value = (parsed as { token?: unknown }).token;
  return typeof value === 'string' ? value : undefined;
}

function tooLarge(res: ServerResponse): void {
  plain(res, 413, 'payload too large\n', { connection: 'close' });
}

/**
 * `POST /session`: trade a JSON `{ "token": "…" }` body for the session cookie, so the token
 * travels in a body (never in a request line) and a wrong one sets nothing. No response here
 * contains the token and nothing is logged.
 */
export function handleSessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SessionEndpointDeps,
): void {
  if (req.method !== 'POST') {
    plain(res, 405, 'method not allowed\n', { allow: 'POST' });
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    plain(res, 415, 'unsupported media type\n');
    return;
  }
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    if (!/^[0-9]+$/.test(declared.trim())) {
      plain(res, 400, 'bad request\n');
      return;
    }
    if (Number(declared.trim()) > SESSION_BODY_LIMIT_BYTES) {
      tooLarge(res);
      return;
    }
  }

  const chunks: Buffer[] = [];
  let received = 0;
  let done = false;

  const finish = (): void => {
    done = true;
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('error', onError);
  };
  const onData = (chunk: Buffer): void => {
    if (done) {
      return;
    }
    received += chunk.length;
    if (received > SESSION_BODY_LIMIT_BYTES) {
      finish();
      chunks.length = 0;
      tooLarge(res);
      // The rest is discarded, not buffered; the response closes the connection.
      req.on('error', deps.onBodyError);
      req.resume();
      return;
    }
    chunks.push(chunk);
  };
  const onEnd = (): void => {
    if (done) {
      return;
    }
    finish();
    const presented = presentedToken(Buffer.concat(chunks));
    if (presented === undefined) {
      plain(res, 400, 'bad request\n');
      return;
    }
    if (!tokensMatch(presented, deps.token)) {
      deps.unauthorized(res);
      return;
    }
    res.writeHead(204, {
      ...ERROR_SECURITY_HEADERS,
      'set-cookie': sessionCookie(deps.sessionValue, isTlsRequest(req)),
    });
    res.end();
  };
  const onError = (error: NodeJS.ErrnoException): void => {
    if (done) {
      return;
    }
    finish();
    deps.onBodyError(error);
    if (!res.headersSent) {
      req.destroy();
    }
  };

  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onError);
}
