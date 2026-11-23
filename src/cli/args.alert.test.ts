import { describe, expect, it } from 'vitest';
import { parseServeArgs, UsageError, type ServeOptions } from './args.js';

function serveOptions(argv: readonly string[]): ServeOptions {
  const parsed = parseServeArgs(['serve', ...argv], {});
  if (parsed.kind !== 'serve') {
    throw new Error(`expected serve, got ${parsed.kind}`);
  }
  return parsed.options;
}

function usageError(argv: readonly string[]): UsageError {
  try {
    parseServeArgs(['serve', ...argv], {});
  } catch (error) {
    if (error instanceof UsageError) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected a usage error for ${argv.join(' ')}`);
}

describe('phargus serve --alert', () => {
  it('turns a nanosecond rule with a unit and a window count into an AlertRule', () => {
    expect(serveOptions(['--alert', 'eventLoop.p99>50ms:3']).alerts).toEqual([
      {
        id: 'eventLoop.p99>50ms:3',
        metric: 'eventLoop.p99',
        comparison: '>',
        threshold: 50_000_000,
        forWindows: 3,
      },
    ]);
  });

  it('turns a byte rule with >= and MiB into an AlertRule with one window', () => {
    expect(serveOptions(['--alert', 'memory.rssLast>=512MiB']).alerts).toEqual([
      {
        id: 'memory.rssLast>=512MiB',
        metric: 'memory.rssLast',
        comparison: '>=',
        threshold: 536_870_912,
        forWindows: 1,
      },
    ]);
  });

  it('reads s, GiB and a bare integer in the metric unit, and keeps every rule in order', () => {
    const alerts = serveOptions([
      '--alert',
      'gc.maxPause>2s',
      '--alert',
      'memory.heapUsedMax>1GiB:2',
      '--alert',
      'gc.count>=10',
      '--alert',
      'backpressure.maxStall>1500',
    ]).alerts;
    expect(alerts.map((rule) => [rule.metric, rule.threshold, rule.forWindows])).toEqual([
      ['gc.maxPause', 2_000_000_000, 1],
      ['memory.heapUsedMax', 1_073_741_824, 2],
      ['gc.count', 10, 1],
      ['backpressure.maxStall', 1500, 1],
    ]);
  });

  it('defines no rule without --alert', () => {
    expect(serveOptions([]).alerts).toEqual([]);
  });

  it('rejects an unknown metric, quoting the flag and listing the valid names', () => {
    const error = usageError(['--alert', 'eventLoop.p95>50ms']);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('"eventLoop.p95>50ms"');
    expect(error.message).toContain('unknown metric "eventLoop.p95"');
    expect(error.message).toContain('eventLoop.p99');
    expect(error.message).toContain('memory.rssLast');
    expect(error.message).toContain('backpressure.maxStall');
  });

  it.each([
    ['eventLoop.p99<50ms', 'operator'],
    ['eventLoop.p99=50ms', 'operator'],
    ['eventLoop.p99', 'operator'],
    ['eventLoop.p99>', 'threshold'],
    ['eventLoop.p99>-5ms', 'threshold'],
    ['eventLoop.p99>5.5ms', 'threshold'],
    ['eventLoop.p99>50ms:', 'threshold'],
    ['eventLoop.p99>50ms:0', 'window count'],
    ['eventLoop.p99>50ms:x', 'threshold'],
    ['eventLoop.p99>50us', 'unknown unit "us"'],
    ['eventLoop.p99>50MiB', 'unit "MiB" does not fit eventLoop.p99'],
    ['memory.rssLast>50ms', 'unit "ms" does not fit memory.rssLast'],
    ['gc.count>5s', 'unit "s" does not fit gc.count'],
    ['memory.rssLast>9007199254740992', 'larger than'],
    ['memory.rssLast>8388608GiB', 'larger than'],
    ['eventLoop.p99>1ms:9007199254740992', 'window count'],
  ])('rejects --alert %s as a usage error quoting the flag (%s)', (value, problem) => {
    const error = usageError(['--alert', value]);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain(`--alert "${value}"`);
    expect(error.message).toContain(problem);
  });

  it('rejects the same --alert twice', () => {
    const error = usageError(['--alert', 'gc.count>1', '--alert', 'gc.count>1']);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('--alert "gc.count>1"');
    expect(error.message).toContain('more than once');
  });
});
