import { describe, expect, it } from 'vitest';
import { parseServeArgs, UsageError } from './args.js';

describe('phargus serve: token length', () => {
  it('rejects a short --token off loopback as a usage error without echoing the value', () => {
    let caught: unknown;
    try {
      parseServeArgs(['serve', '--host', '0.0.0.0', '--token', 'secret-short'], {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).exitCode).toBe(2);
    expect((caught as Error).message).toContain('16 characters');
    expect((caught as Error).message).not.toContain('secret-short');
  });

  it('rejects a short PHARGUS_TOKEN off loopback', () => {
    expect(() =>
      parseServeArgs(['serve', '--host', '0.0.0.0'], { PHARGUS_TOKEN: 'secret-short' }),
    ).toThrowError(UsageError);
  });

  it('accepts a 16-character off-loopback token and a one-character loopback token', () => {
    expect(() =>
      parseServeArgs(['serve', '--host', '0.0.0.0', '--token', '0123456789abcdef'], {}),
    ).not.toThrow();
    expect(() =>
      parseServeArgs(['serve', '--host', '127.0.0.1', '--token', 'a'], {}),
    ).not.toThrow();
  });
});
