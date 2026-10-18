import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Test-controlled failing disk: for `targetPath`, reading reports ENOENT and opening for append
 * rejects with `appendError` (one Error instance).
 */
const disk = vi.hoisted(() => {
  const state = {
    targetPath: undefined as string | undefined,
    appendError: undefined as Error | undefined,
    openForAppendCalls: 0,
    reset(): void {
      state.targetPath = undefined;
      state.appendError = undefined;
      state.openForAppendCalls = 0;
    },
  };
  return state;
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();

  function isTarget(path: unknown): boolean {
    return disk.targetPath !== undefined && String(path) === disk.targetPath;
  }

  function enoent(path: unknown): Error {
    return Object.assign(new Error(`ENOENT: no such file or directory, open '${String(path)}'`), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'open',
      path: String(path),
    });
  }

  const open: typeof actual.open = async (path, flags, mode) => {
    const forAppend =
      (typeof flags === 'string' && flags.includes('a')) ||
      (typeof flags === 'number' && (flags & actual.constants.O_APPEND) !== 0);
    if (isTarget(path) && forAppend) {
      disk.openForAppendCalls += 1;
      throw disk.appendError ?? new Error('test disk: append error not configured');
    }
    return actual.open(path, flags, mode);
  };

  const readFile = async (...args: unknown[]): Promise<unknown> => {
    if (isTarget(args[0])) throw enoent(args[0]);
    return (actual.readFile as (...rest: unknown[]) => Promise<unknown>)(...args);
  };

  const appendFile = async (...args: unknown[]): Promise<unknown> => {
    if (isTarget(args[0])) {
      disk.openForAppendCalls += 1;
      throw disk.appendError ?? new Error('test disk: append error not configured');
    }
    return (actual.appendFile as (...rest: unknown[]) => Promise<unknown>)(...args);
  };

  const mocked = { ...actual, open, readFile, appendFile };
  return { ...mocked, default: mocked };
});

/** A full AgentSample-shaped object at the given timestamp. */
function makeSample(timestamp: number): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: 20, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 100, heapTotal: 200, rss: 1000, external: 0, arrayBuffers: 0 },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  };
}

type CollectorUnderTest = {
  readonly windows: { snapshot(): Array<Record<string, unknown>> };
  readonly persistence: { readonly dropped: number; readonly failed: number } | undefined;
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
  close(): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: {
    windowMs: number;
    capacity: number;
    persist?: { path: string; maxBytes: number; maxQueueSize?: number };
  }) => CollectorUnderTest;
};

/** Settles like `promise`, or rejects after `ms` so a hang fails the test instead of the run. */
function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

afterEach(() => {
  disk.reset();
});

describe('collector persistence queue — AC-3', () => {
  it('AC-3: a failing append rejects consume() with that same Error while the source stays open, counting the failure and reporting no unhandled rejection', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const dir = await mkdtemp(join(tmpdir(), 'phargus-persist-queue-ac3-'));
    const path = join(dir, 'windows.ndjson');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    // Samples spanning the three windows 0, 1000 and 2000; the source then never ends.
    const source = new Readable({ objectMode: true, read() {} });
    let consumed: Promise<void> | undefined;
    try {
      const appendError = new Error('test disk: open for append failed');
      disk.targetPath = path;
      disk.appendError = appendError;

      const collector = collectorModule.createCollector({
        windowMs: 1000,
        capacity: 10,
        persist: { path, maxBytes: 1_000_000 },
      });

      for (const timestamp of [100, 500, 1100, 1500, 2100, 2500])
        source.push(makeSample(timestamp));

      consumed = collector.consume(source);
      let rejection: unknown;
      try {
        await within(consumed, 3000, 'consume() to reject while the source stays open');
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBe(appendError);
      expect(disk.openForAppendCalls).toBeGreaterThanOrEqual(1);

      const failed = collector.persistence?.failed;
      expect(Number.isInteger(failed)).toBe(true);
      expect(failed).toBeGreaterThanOrEqual(1);
      expect(collector.persistence?.dropped).toBe(0);

      // Give any stray rejection time to be reported.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      source.destroy();
      if (consumed !== undefined) await Promise.allSettled([consumed]);
      process.off('unhandledRejection', onUnhandled);
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
