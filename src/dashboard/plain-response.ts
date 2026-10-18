import type { ServerResponse } from 'node:http';
import { ERROR_SECURITY_HEADERS } from './security-headers.js';

/** A small text response with the error security headers; `extra` headers win over the defaults. */
export function plain(
  res: ServerResponse,
  status: number,
  body: string,
  extra?: Record<string, string>,
): void {
  res.writeHead(status, {
    ...ERROR_SECURITY_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...extra,
  });
  res.end(body);
}
