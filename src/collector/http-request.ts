/**
 * Request-side checks shared by the HTTP clients (the webhook sink and the OTLP exporters). Every
 * message here leaves out the URL and header values, which may hold a credential.
 */

/** RFC 9110 `token`: the characters a header name may use. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** RFC 9110 field-content characters: HTAB, SP, VCHAR and obs-text. No CR, LF, NUL or DEL. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
/** A system error code such as `ECONNREFUSED` or `UND_ERR_SOCKET`. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Refuses a URL with a username or password. `fetch` rejects such a URL with a message that quotes
 * it whole, query string included, so it is refused at creation instead, without quoting it.
 */
export function refuseUrlCredentials(label: string, url: URL): void {
  if (url.username !== '' || url.password !== '') {
    throw new TypeError(
      `${label}: url must not include credentials; send them with the headers option`,
    );
  }
}

/**
 * Validates and copies the caller's headers. Every message names the header, never its value,
 * which may be a credential. Checking here also keeps `fetch` from rejecting a bad value later
 * with an error that quotes it. `content-type` is reserved: the clients always send JSON.
 */
export function resolveRequestHeaders(label: string, headers: unknown): [string, string][] {
  if (headers === undefined) {
    return [];
  }
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new TypeError(`${label}: headers must be an object of header names to string values`);
  }
  const resolved: [string, string][] = [];
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    // The name is not quoted either: a malformed one may be a whole `name: value` line.
    if (!HEADER_NAME.test(name)) {
      throw new TypeError(`${label}: a header name is not a valid HTTP token`);
    }
    const lower = name.toLowerCase();
    if (lower === '__proto__') {
      // Node's fetch silently drops this name; refuse it rather than send less than asked.
      throw new TypeError(`${label}: header ${name} cannot be sent by fetch`);
    }
    if (lower === 'content-type') {
      throw new TypeError(`${label}: header ${name} is reserved, the body is always JSON`);
    }
    if (seen.has(lower)) {
      throw new TypeError(`${label}: header ${name} is given more than once`);
    }
    seen.add(lower);
    if (typeof value !== 'string') {
      throw new TypeError(`${label}: header ${name} must have a string value`);
    }
    if (!HEADER_VALUE.test(value)) {
      throw new TypeError(`${label}: header ${name} has a value with an invalid character`);
    }
    resolved.push([name, value]);
  }
  return resolved;
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) {
    return undefined;
  }
  const code = value.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined;
}

/**
 * A fixed description of a failed `fetch`, for a message that has no `cause`: never the platform's
 * own text, which can quote the URL or a header value. A network failure names its code (for
 * example `fetch failed (ECONNREFUSED)`); a `TypeError` with no cause was thrown while building the
 * request.
 */
export function requestFailureReason(error: unknown): string {
  const code = errorCode(error) ?? errorCode(error instanceof Error ? error.cause : undefined);
  if (code !== undefined) {
    return `fetch failed (${code})`;
  }
  if (error instanceof TypeError && error.cause === undefined) {
    return 'request could not be built';
  }
  return 'fetch failed';
}
