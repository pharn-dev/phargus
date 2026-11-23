import { describe, expect, it } from 'vitest';
import { requestFailureReason } from './http-request.js';

describe('requestFailureReason', () => {
  it('turns a TypeError from building the request into a fixed text', () => {
    // The shape fetch throws for a bad header value: a TypeError with no cause that quotes it.
    const error = new TypeError('Headers.append: "Bearer SECRET\nx" is an invalid header value.');
    expect(requestFailureReason(error)).toBe('request could not be built');
  });

  it('names the code of a network failure and nothing else', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    });
    expect(requestFailureReason(new TypeError('fetch failed', { cause }))).toBe(
      'fetch failed (ECONNREFUSED)',
    );
    expect(requestFailureReason(new TypeError('fetch failed', { cause: new Error('x') }))).toBe(
      'fetch failed',
    );
    // A code that is not a plain system code is not echoed.
    const odd = Object.assign(new Error('x'), { code: 'http://user:pw@host/' });
    expect(requestFailureReason(odd)).toBe('fetch failed');
  });
});
