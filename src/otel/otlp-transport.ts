import {
  MAX_RESPONSE_BODY_BYTES,
  createRequestSignal,
  discardResponseBody,
  isRedirect,
} from '../collector/http-response.js';

export type OtlpTarget = {
  url: string;
  /** Scheme, host and port only; the sole part of the URL ever put in an error message. */
  origin: string;
  headers: Record<string, string>;
  timeoutMs: number;
};

/**
 * Sends one OTLP JSON body with a single POST. Never throws or rejects: it resolves `undefined`
 * on a 2xx response and an `Error` otherwise. Only the origin appears in messages, never the
 * path, query or headers, which may carry a credential. A redirect is never followed (it is a
 * failure, and the redirect target is never contacted) and the response body is never buffered.
 * `abort`, when given, cancels the request early (used by a bounded `close()`).
 */
export async function postOtlpJson(
  target: OtlpTarget,
  body: string,
  abort?: AbortSignal,
): Promise<Error | undefined> {
  const request = createRequestSignal(target.timeoutMs, abort);
  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: { ...target.headers, 'content-type': 'application/json' },
      body,
      redirect: 'manual',
      signal: request.signal,
    });
    await discardResponseBody(response, MAX_RESPONSE_BODY_BYTES);
    if (response.status >= 200 && response.status < 300) return undefined;
    if (isRedirect(response)) {
      return new Error(
        `OTLP export to ${target.origin} failed: redirect (status ${String(response.status)}) not followed`,
      );
    }
    return new Error(`OTLP export to ${target.origin} failed: status ${String(response.status)}`);
  } catch (cause) {
    if (abort?.aborted === true) {
      return new Error(`OTLP export to ${target.origin} failed: aborted by close()`, { cause });
    }
    const name = cause instanceof Error ? cause.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new Error(
        `OTLP export to ${target.origin} failed: timed out after ${String(target.timeoutMs)}ms`,
        { cause },
      );
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new Error(`OTLP export to ${target.origin} failed: ${reason}`, { cause });
  } finally {
    request.dispose();
  }
}
