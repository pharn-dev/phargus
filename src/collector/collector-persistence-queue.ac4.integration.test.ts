import type * as FsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Test-controlled disk: appends the store makes to `targetPath` go through `gate()`, which holds
 * the first one until the test calls `release()`.
 */
const disk = vi.hoisted(() => {
  const state = {
    targetPath: undefined as string | undefined,
    holdFirstAppend: false,
    appendCalls: 0,
    release: undefined as (() => void) | undefined,
    reset(): void {
      state.targetPath = undefined;
      state.holdFirstAppend = false;
      state.appendCalls = 0;
      state.release = undefined;
    },
    async gate(): Promise<void> {
      state.appendCalls += 1;
      if (state.appendCalls !== 1 || !state.holdFirstAppend) return;
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    },
  };
  return state;
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();

  function isTarget(path: unknown): boolean {
    return disk.targetPath !== undefined && String(path) === disk.targetPath;
  }

  function holdAppends(handle: FileHandle): FileHandle {
    return new Proxy(handle, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        const method = value as (...args: unknown[]) => unknown;
        if (property === 'appendFile' || property === 'write') {
          return async (...args: unknown[]): Promise<unknown> => {
            await disk.gate();
            return method.apply(target, args);
          };
        }
        return method.bind(target);
      },
    });
  }

  const open: typeof actual.open = async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    return isTarget(path) ? holdAppends(handle) : handle;
  };

  const appendFile = async (...args: unknown[]): Promise<unknown> => {
    if (isTarget(args[0])) await disk.gate();
    return (actual.appendFile as (...rest: unknown[]) => Promise<unknown>)(...args);
  };

  const mocked = { ...actual, open, appendFile };
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

/** Two samples in each of `count` consecutive 1000 ms windows starting at 0. */
function samplesSpanning(count: number): Array<Record<string, unknown>> {
  const samples: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index += 1) {
    samples.push(makeSample(index * 1000 + 100), makeSample(index * 1000 + 600));
  }
  return samples;
}

type Window = Record<string, unknown>;

type CollectorUnderTest = {
  readonly windows: { snapshot(): Window[] };
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

async function until(label: string, condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const WINDOW_COUNT = 5;

afterEach(() => {
  disk.release?.();
  disk.reset();
});

describe('collector persistence queue — AC-4', () => {
  it('AC-4: close() waits for the queued windows to be appended, then close() and consume() resolve with all 5 windows on disk in order', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const dir = await mkdtemp(join(tmpdir(), 'phargus-persist-queue-ac4-'));
    const path = join(dir, 'windows.ndjson');
    let consumed: Promise<void> | undefined;
    let closed: Promise<void> | undefined;
    try {
      disk.targetPath = path;
      disk.holdFirstAppend = true;

      const collector = collectorModule.createCollector({
        windowMs: 1000,
        capacity: 20,
        persist: { path, maxBytes: 10_000_000 },
      });

      consumed = collector.consume(Readable.from(samplesSpanning(WINDOW_COUNT)));
      // Handled here so a rejection while the test is still waiting is never unhandled; the
      // assertions below await the same promise.
      consumed.catch(() => undefined);

      await until('the first append to be held', () => disk.release !== undefined);
      await until(
        `all ${WINDOW_COUNT} windows to be in collector.windows while the first append is held`,
        () => collector.windows.snapshot().length === WINDOW_COUNT,
      );

      let closeSettled = false;
      closed = collector.close();
      closed.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        },
      );

      // The append is still held: close() must keep waiting for it.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(closeSettled).toBe(false);

      disk.release?.();
      await expect(closed).resolves.toBeUndefined();
      await expect(consumed).resolves.toBeUndefined();

      const snapshot = collector.windows.snapshot();
      expect(snapshot.map((window) => window['start'])).toEqual(
        Array.from({ length: WINDOW_COUNT }, (_, index) => index * 1000),
      );

      const text = await readFile(path, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      const lines = text.split('\n').slice(0, -1);
      expect(lines).toHaveLength(WINDOW_COUNT);
      expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual(snapshot);

      expect(collector.persistence?.dropped).toBe(0);
      expect(collector.persistence?.failed).toBe(0);
    } finally {
      disk.release?.();
      await Promise.allSettled([consumed, closed].filter((p) => p !== undefined));
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
