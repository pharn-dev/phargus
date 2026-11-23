import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Collector } from '../collector/index.js';
import {
  bearerToken,
  cookieValues,
  createHostPolicy,
  isLoopbackHost,
  parseAuthority,
  sessionCookieName,
  sessionValueFor,
  tokensMatch,
  type HostPolicy,
} from './auth.js';
import { createClientErrorReporter } from './client-error-reporter.js';
import { plain } from './plain-response.js';
import {
  ERROR_SECURITY_HEADERS,
  EVENTS_SECURITY_HEADERS,
  STATIC_SECURITY_HEADERS,
} from './security-headers.js';
import { handleSessionRequest } from './session-endpoint.js';
import { createSseClient, type SseClient } from './sse-client.js';
import { formatEvent } from './sse-format.js';
import { createLoginAssets, createStaticAssets, type StaticAsset } from './static-assets.js';

export type DashboardServerOptions = {
  collector: Collector;
  host: string;
  port: number;
  /**
   * Required off loopback, and whenever `allowedHosts` names a host that is not loopback (even on a
   * loopback bind). A browser opens `/login#token=<token>` once (the fragment never
   * reaches the server) and gets an HttpOnly session cookie through `POST /session`; API
   * clients send `Authorization: Bearer <token>`. A `?token=` query is not a credential.
   */
  token?: string;
  /**
   * Extra `Host` values to answer, beyond the bind address (and, for a loopback or any-address
   * bind, `localhost`, `127.0.0.1` and `[::1]`) on the bound port. A bare hostname matches on any
   * port; `host:port` matches exactly. Needed behind a reverse proxy or when reached by name. A
   * name that is not loopback requires a `token`.
   */
  allowedHosts?: readonly string[];
  heartbeatMs?: number;
  /**
   * Live events held per client while its socket is backed up (default 1000); past that the
   * oldest is dropped and counted in `droppedEvents`. The initial replay of the collector's
   * buffers on connect does not count against it and is never dropped.
   */
  maxBufferedEvents?: number;
  onError?: (error: Error) => void;
};

export type DashboardServer = {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly clientCount: number;
  readonly droppedEvents: number;
  close(): Promise<void>;
};

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_BUFFERED_EVENTS = 1000;
/** Concurrent `/events` clients per server; past this a new one gets `503` until one closes. */
const MAX_SSE_CLIENTS = 64;
/** At most one malformed-request report (plus one summary) per this many milliseconds. */
const CLIENT_ERROR_REPORT_INTERVAL_MS = 10_000;

/**
 * The 421 body: says how to allow a Host without echoing the rejected value back (it is
 * attacker-controlled in a DNS rebinding attempt, and nothing the user needs to see again).
 */
const MISDIRECTED_BODY =
  'misdirected request: this dashboard does not answer to the Host this request used.\n' +
  'To reach it by another hostname or IP (behind a proxy or a container port map), add that\n' +
  'host to the allowedHosts option of createDashboardServer(), or pass --allowed-host <host>\n' +
  'to phargus serve. A name that is not a loopback address also requires a token.\n';

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

/**
 * A peer that went away: a reset, an aborted request, or a write to a socket the peer already
 * closed (`EPIPE`, which an SSE stream meets whenever a client hangs up while events are queued).
 */
function isDisconnect(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ECONNRESET' || error.code === 'EPIPE' || error.message === 'aborted';
}

/** The first `allowedHosts` entry whose hostname is not loopback, if any. */
function firstNonLoopbackHost(allowedHosts: readonly string[]): string | undefined {
  return allowedHosts.find((entry) => !isLoopbackHost(parseAuthority(entry)?.hostname ?? ''));
}

/** A bodyless raw response for a connection the HTTP parser gave up on. */
function rawErrorResponse(error: NodeJS.ErrnoException): string {
  const [status, reason] =
    error.code === 'HPE_HEADER_OVERFLOW'
      ? [431, 'Request Header Fields Too Large']
      : error.code === 'ERR_HTTP_REQUEST_TIMEOUT'
        ? [408, 'Request Timeout']
        : [400, 'Bad Request'];
  const headers = Object.entries(ERROR_SECURITY_HEADERS)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
  return `HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n${headers}\r\n`;
}

export async function createDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServer> {
  const { collector, host, port, token } = options;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
  const allowedHosts = options.allowedHosts ?? [];
  requirePositiveInteger('heartbeatMs', heartbeatMs);
  requirePositiveInteger('maxBufferedEvents', maxBufferedEvents);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new RangeError('port must be an integer from 0 to 65535');
  }
  if (token !== undefined && (typeof token !== 'string' || token.length === 0)) {
    throw new RangeError('token must be a non-empty string');
  }
  if (!Array.isArray(allowedHosts)) {
    throw new RangeError('allowedHosts must be an array of host names');
  }
  // Validates every entry before anything binds; rebuilt with the bound port once listening.
  let hostPolicy: HostPolicy = createHostPolicy(host, port, allowedHosts);
  // One rule: a bind or an allowedHosts name that is not loopback needs a token of 16+ characters.
  const bindExposed = !isLoopbackHost(host);
  const exposedName = bindExposed ? undefined : firstNonLoopbackHost(allowedHosts);
  if (bindExposed || exposedName !== undefined) {
    if (token === undefined) {
      throw new Error(
        exposedName === undefined
          ? `a token is required to bind the dashboard to non-loopback host "${host}"`
          : `a token is required to allow non-loopback host "${exposedName}" in the dashboard's allowedHosts`,
      );
    }
    if (token.length < 16) {
      throw new RangeError('token must be at least 16 characters for non-loopback hosts');
    }
  }

  const report = (error: Error): void => {
    try {
      if (options.onError !== undefined) {
        options.onError(error);
        return;
      }
    } catch {
      // A throwing handler falls through to the warning below.
    }
    process.emitWarning(`dashboard server error: ${error.message}`);
  };
  const clientErrors = createClientErrorReporter(report, CLIENT_ERROR_REPORT_INTERVAL_MS);

  const assets = createStaticAssets();
  const loginAssets = createLoginAssets();
  const sessionValue = token === undefined ? undefined : sessionValueFor(token);
  // Set again from the bound port once listening (a port 0 bind picks its port then).
  let cookieName = sessionCookieName(port);

  const authenticated = (req: IncomingMessage): boolean => {
    if (token === undefined || sessionValue === undefined) {
      return true;
    }
    const bearer = bearerToken(req);
    if (bearer !== undefined && tokensMatch(bearer, token)) {
      return true;
    }
    return cookieValues(req, cookieName).some((value) => tokensMatch(value, sessionValue));
  };

  const unauthorized = (res: ServerResponse): void => {
    plain(res, 401, 'unauthorized\n', { 'www-authenticate': 'Bearer' });
  };

  const serveAsset = (req: IncomingMessage, res: ServerResponse, asset: StaticAsset): void => {
    const fail = (error: NodeJS.ErrnoException): void => {
      if (!isDisconnect(error)) {
        report(error);
      }
    };
    req.once('error', fail);
    res.once('error', fail);
    res.once('close', () => {
      req.off('error', fail);
      res.off('error', fail);
    });
    res.writeHead(200, {
      ...STATIC_SECURITY_HEADERS,
      'content-type': asset.contentType,
      'content-length': String(asset.body.byteLength),
    });
    res.end(asset.body);
  };

  let dropped = 0;
  const clients = new Set<SseClient>();
  const cleanups = new Set<() => void>();

  const handleSse = (req: IncomingMessage, res: ServerResponse): void => {
    if (clients.size >= MAX_SSE_CLIENTS) {
      plain(res, 503, 'too many dashboard event clients\n', { connection: 'close' });
      return;
    }
    // Snapshot, replay and subscribe in one synchronous block: nothing is missed or duplicated.
    // The replay is one write past the live-event drop queue, so a new client always gets the
    // whole history; most important first, in case the client goes away part-way. Taken
    // before the headers, so a throwing snapshot still gets a clean 500 and leaves no client.
    const replay = [
      ...collector.alerts.snapshot().map((a) => formatEvent('alert', a)),
      ...collector.windows.snapshot().map((w) => formatEvent('window', w)),
      ...collector.spans.snapshot().map((s) => formatEvent('span', s)),
    ].join('');
    res.writeHead(200, {
      ...EVENTS_SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    const client = createSseClient(res, {
      maxBufferedEvents,
      onDrop: (): void => {
        dropped += 1;
      },
    });
    clients.add(client);
    client.replay(replay);
    const unsubscribe = collector.subscribe({
      window: (w): void => client.send(formatEvent('window', w)),
      alert: (a): void => client.send(formatEvent('alert', a)),
      span: (s): void => client.send(formatEvent('span', s)),
    });

    let done = false;
    const cleanup = (): void => {
      if (done) {
        return;
      }
      done = true;
      cleanups.delete(cleanup);
      unsubscribe();
      client.end();
      clients.delete(client);
    };
    cleanups.add(cleanup);
    const fail = (error: NodeJS.ErrnoException): void => {
      // An ordinary client disconnect is cleanup, not an error worth a warning.
      if (!isDisconnect(error)) {
        report(error);
      }
      cleanup();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    req.on('error', fail);
    res.on('error', fail);
    res.socket?.on('error', fail);
  };

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    // DNS rebinding defence: answer only the hosts this server is reachable as.
    if (!hostPolicy.hostAllowed(req.headers.host)) {
      plain(res, 421, MISDIRECTED_BODY, { connection: 'close' });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      // `new URL` throws on targets such as `//[`: a bad request, not a crash of the host.
      plain(res, 400, 'bad request\n');
      return;
    }
    const origin = req.headers.origin;
    if (
      origin !== undefined &&
      (url.pathname === '/events' || req.method !== 'GET') &&
      !hostPolicy.originAllowed(origin)
    ) {
      plain(res, 403, 'forbidden\n');
      return;
    }
    if (token !== undefined) {
      // Before authentication: a visitor has no cookie yet. Neither route can leak the token.
      if (url.pathname === '/session' && sessionValue !== undefined) {
        handleSessionRequest(req, res, {
          token,
          sessionValue,
          cookieName,
          unauthorized,
          onBodyError: (error): void => {
            if (!isDisconnect(error)) {
              report(error);
            }
          },
        });
        return;
      }
      const loginAsset = loginAssets.get(url.pathname);
      if (loginAsset !== undefined) {
        if (req.method === 'GET') {
          serveAsset(req, res, loginAsset);
        } else {
          plain(res, 405, 'method not allowed\n', { allow: 'GET' });
        }
        return;
      }
      if (!authenticated(req)) {
        unauthorized(res);
        return;
      }
    }
    if (url.pathname === '/events') {
      if (req.method === 'GET') {
        handleSse(req, res);
      } else {
        plain(res, 405, 'method not allowed\n', { allow: 'GET' });
      }
      return;
    }
    // With a token the login assets were served above, before authentication; without one they
    // are served like any other asset (and a login link there ends in the 404 for /session).
    const asset = assets.get(url.pathname) ?? loginAssets.get(url.pathname);
    if (asset !== undefined) {
      if (req.method === 'GET') {
        serveAsset(req, res, asset);
      } else {
        plain(res, 405, 'method not allowed\n', { allow: 'GET' });
      }
      return;
    }
    plain(res, 404, 'not found\n');
  };

  // Nothing a request does may reach the host process as an uncaught exception.
  const server: Server = createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (error) {
      report(error instanceof Error ? error : new Error(String(error)));
      if (!res.headersSent) {
        plain(res, 500, 'internal server error\n');
      } else {
        res.destroy();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', report);
  server.on('clientError', (error: NodeJS.ErrnoException, socket: Duplex) => {
    // An abrupt disconnect is routine; anything else is reported, rate-limited, because any
    // unauthenticated client can send malformed requests as fast as it likes.
    if (!isDisconnect(error)) {
      clientErrors.record(error);
    }
    if (error.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    socket.end(rawErrorResponse(error), () => {
      socket.destroy();
    });
  });

  const boundPort = (server.address() as AddressInfo).port;
  cookieName = sessionCookieName(boundPort);
  hostPolicy = createHostPolicy(host, boundPort, allowedHosts);
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      client.heartbeat();
    }
  }, heartbeatMs);
  heartbeat.unref();

  let closing: Promise<void> | undefined;

  return {
    host,
    port: boundPort,
    url: `http://${urlHost}:${boundPort}`,
    get clientCount(): number {
      return clients.size;
    },
    get droppedEvents(): number {
      return dropped;
    },
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve, reject) => {
        clearInterval(heartbeat);
        clientErrors.close();
        for (const cleanup of [...cleanups]) {
          cleanup();
        }
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
          } else {
            resolve();
          }
        });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
