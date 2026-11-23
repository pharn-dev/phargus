import type { Alert } from './alert-evaluator.js';
import { reportSinkError, sinkLabel, type AlertSink, type SinkErrorHandler } from './alert-sink.js';
import {
  refuseUrlCredentials,
  requestFailureReason,
  resolveRequestHeaders,
} from './http-request.js';
import { createRequestSignal, discardResponseBody, isRedirect } from './http-response.js';

export type WebhookSinkOptions = {
  url: string;
  name?: string;
  /**
   * Extra request headers, for example `{ authorization: 'Bearer …' }`. Copied when the sink is
   * created. Names must be HTTP tokens and values may hold no control characters (tab aside) or
   * characters above U+00FF. Put credentials here, never in `url`: a URL with a username or
   * password is refused. `content-type` is reserved (always `application/json`); a name given
   * twice in different case, and `__proto__`, are rejected. Values are never logged or put in an
   * error.
   */
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  maxInFlight?: number;
  /**
   * How long `close()` waits for in-flight deliveries before aborting them. Defaults to
   * `timeoutMs`. Retries stop as soon as `close()` is called.
   */
  closeTimeoutMs?: number;
  onError?: SinkErrorHandler;
};

type Outcome = { ok: boolean; retry: boolean; reason: string };

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 100;
const DEFAULT_MAX_IN_FLIGHT = 100;

/**
 * POSTs each alert as JSON (plus any caller `headers`) with a per-request timeout, bounded retries
 * and a bounded in-flight count. Redirects are never followed (a 3xx is a failed delivery) and the
 * response body is never buffered. `close()` stops retries and, after `closeTimeoutMs`, aborts what
 * is still in flight.
 */
export function createWebhookSink(options: WebhookSinkOptions): AlertSink {
  const { name, onError } = options;
  const label = sinkLabel('webhook', name);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const closeTimeoutMs = options.closeTimeoutMs ?? timeoutMs;

  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch (error) {
    throw new TypeError(`${label}: url is not a valid URL`, { cause: error });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${label}: url protocol must be http: or https:, got ${parsed.protocol}`);
  }
  refuseUrlCredentials(label, parsed);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${label}: timeoutMs must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight <= 0) {
    throw new RangeError(`${label}: maxInFlight must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw new RangeError(`${label}: retries must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(backoffMs) || backoffMs < 0) {
    throw new RangeError(`${label}: backoffMs must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 0) {
    throw new RangeError(`${label}: closeTimeoutMs must be a non-negative safe integer`);
  }
  const headers: [string, string][] = [
    ...resolveRequestHeaders(label, options.headers),
    ['content-type', 'application/json'],
  ];

  const url = parsed.href;
  const origin = parsed.origin;
  let failed = 0;
  let dropped = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let inFlight = 0;
  const pending = new Set<Promise<void>>();
  /** Aborted when `close()` is called: no new retry starts after that. */
  const stopRetries = new AbortController();
  /** Aborted when `closeTimeoutMs` elapses after `close()`: cancels in-flight requests. */
  const abortInFlight = new AbortController();

  async function attempt(alert: Alert): Promise<Outcome> {
    const request = createRequestSignal(timeoutMs, abortInFlight.signal);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(alert),
        redirect: 'manual',
        signal: request.signal,
      });
      await discardResponseBody(response);
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, retry: false, reason: '' };
      }
      if (isRedirect(response)) {
        return {
          ok: false,
          retry: false,
          reason: `redirect (status ${response.status}) not followed`,
        };
      }
      return {
        ok: false,
        retry: response.status >= 500,
        reason: `status ${response.status}`,
      };
    } catch (error) {
      if (abortInFlight.signal.aborted) {
        return {
          ok: false,
          retry: false,
          reason: `aborted, sink closed and closeTimeoutMs ${closeTimeoutMs} elapsed`,
        };
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        return { ok: false, retry: true, reason: `timed out after ${timeoutMs}ms` };
      }
      // Never the platform's message: it can quote the URL or a header value.
      return { ok: false, retry: true, reason: requestFailureReason(error) };
    } finally {
      request.dispose();
    }
  }

  /** Waits `ms`, or less if `close()` is called meanwhile. Never rejects. */
  function backoff(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        stopRetries.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      stopRetries.signal.addEventListener('abort', done, { once: true });
    });
  }

  async function deliver(alert: Alert): Promise<void> {
    let last: Outcome = { ok: false, retry: true, reason: 'no attempt made' };
    for (let n = 0; n <= retries; n += 1) {
      last = await attempt(alert);
      if (last.ok) {
        return;
      }
      if (!last.retry || n === retries) {
        break;
      }
      if (!closed) {
        await backoff(backoffMs * 2 ** n);
      }
      if (closed) {
        last = { ...last, reason: `${last.reason} (retries stopped, sink closed)` };
        break;
      }
    }
    failed += 1;
    reportSinkError(
      onError,
      new Error(`${label}: delivery to ${origin} failed: ${last.reason}`),
      sink,
    );
  }

  async function shutdown(): Promise<void> {
    closed = true;
    stopRetries.abort();
    if (pending.size === 0) {
      return;
    }
    const settled = Promise.allSettled([...pending]).then(() => true);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), closeTimeoutMs);
    });
    const done = await Promise.race([settled, deadline]);
    clearTimeout(timer);
    if (!done) {
      abortInFlight.abort();
      await settled;
    }
  }

  const sink: AlertSink = {
    type: 'webhook',
    name,
    get failed(): number {
      return failed;
    },
    get dropped(): number {
      return dropped;
    },
    send(alert: Alert): Promise<void> {
      if (closed || inFlight >= maxInFlight) {
        dropped += 1;
        reportSinkError(
          onError,
          new RangeError(
            `${label}: alert dropped (${closed ? 'sink closed' : `maxInFlight ${maxInFlight} reached`})`,
          ),
          sink,
        );
        return Promise.resolve();
      }
      inFlight += 1;
      const delivery = deliver(alert).finally(() => {
        inFlight -= 1;
        pending.delete(delivery);
      });
      pending.add(delivery);
      return delivery;
    },
    close(): Promise<void> {
      closing ??= shutdown();
      return closing;
    },
  };

  return sink;
}
