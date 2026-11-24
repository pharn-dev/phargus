import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSample } from '../../test/support.js';

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

type CollectorUnderTest = {
  readonly windows: { snapshot(): Array<Record<string, unknown>> };
  subscribe(listener: { window?: (window: Record<string, unknown>) => void }): () => void;
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
  it('AC-3: a failing append never rejects consume(): every window still reaches the ring and the subscribers, each failure is counted, one warning is emitted, and no rejection is unhandled', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const dir = await mkdtemp(join(tmpdir(), 'phargus-persist-queue-ac3-'));
    const path = join(dir, 'windows.ndjson');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    try {
      const appendError = new Error('test disk: open for append failed');
      disk.targetPath = path;
      disk.appendError = appendError;

      const collector = collectorModule.createCollector({
        windowMs: 1000,
        capacity: 10,
        persist: { path, maxBytes: 1_000_000 },
      });
      const seen: number[] = [];
      collector.subscribe({ window: (window) => seen.push(window['start'] as number) });

      // Samples spanning the four windows 0, 1000, 2000 and 3000.
      const samples = [100, 500, 1100, 1500, 2100, 2500, 3100].map(makeSample);
      await within(collector.consume(Readable.from(samples)), 3000, 'consume() to resolve');

      const starts = collector.windows.snapshot().map((window) => window['start']);
      expect(starts).toEqual([0, 1000, 2000, 3000]);
      expect(seen).toEqual([0, 1000, 2000, 3000]);
      expect(disk.openForAppendCalls).toBeGreaterThanOrEqual(1);

      const failed = collector.persistence?.failed;
      expect(Number.isInteger(failed)).toBe(true);
      expect(failed).toBe(4);
      expect(collector.persistence?.dropped).toBe(0);
      const persistenceWarnings = warn.mock.calls.filter(
        (call) => String(call[1]) === 'PhargusPersistenceWarning',
      );
      expect(persistenceWarnings).toHaveLength(1);
      expect(String(persistenceWarnings[0]?.[0])).toContain(appendError.message);

      await expect(collector.close()).resolves.toBeUndefined();
      // Give any stray rejection time to be reported.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
