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

const WINDOW_COUNT = 10;

afterEach(() => {
  disk.release?.();
  disk.reset();
});

describe('collector persistence queue — AC-2', () => {
  it('AC-2: with maxQueueSize 2 and a stalled disk, the oldest queued windows are dropped and counted, and the file ends with the last emitted window', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const dir = await mkdtemp(join(tmpdir(), 'phargus-persist-queue-ac2-'));
    const path = join(dir, 'windows.ndjson');
    let consumed: Promise<void> | undefined;
    try {
      disk.targetPath = path;
      disk.holdFirstAppend = true;

      const collector = collectorModule.createCollector({
        windowMs: 1000,
        capacity: 50,
        persist: { path, maxBytes: 10_000_000, maxQueueSize: 2 },
      });

      consumed = collector.consume(Readable.from(samplesSpanning(WINDOW_COUNT)));
      // Handled here so a rejection while the test is still waiting is never unhandled; the
      // assertion below awaits the same promise.
      consumed.catch(() => undefined);

      await until('the first append to be held', () => disk.release !== undefined);
      await until(
        `all ${WINDOW_COUNT} windows to be in collector.windows while the first append is held`,
        () => collector.windows.snapshot().length === WINDOW_COUNT,
      );

      disk.release?.();
      await expect(consumed).resolves.toBeUndefined();

      const snapshot = collector.windows.snapshot();
      expect(snapshot).toHaveLength(WINDOW_COUNT);

      const text = await readFile(path, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      const lines = text.split('\n').slice(0, -1);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines.length).toBeLessThanOrEqual(3);

      const persisted = lines.map((line) => JSON.parse(line) as Window);
      // Every persisted line is a window of collector.windows, in emission order.
      const positions = persisted.map((window) =>
        snapshot.findIndex((candidate) => candidate['start'] === window['start']),
      );
      for (const [index, position] of positions.entries()) {
        expect(position).toBeGreaterThanOrEqual(0);
        expect(persisted[index]).toEqual(snapshot[position]);
      }
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(new Set(positions).size).toBe(positions.length);
      // ...ending with the last emitted window.
      expect(persisted[persisted.length - 1]).toEqual(snapshot[WINDOW_COUNT - 1]);

      const dropped = collector.persistence?.dropped;
      expect(Number.isInteger(dropped)).toBe(true);
      expect(dropped).toBe(WINDOW_COUNT - lines.length);
      expect(collector.persistence?.failed).toBe(0);
    } finally {
      disk.release?.();
      if (consumed !== undefined) await Promise.allSettled([consumed]);
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('AC-2: creating a collector with persist.maxQueueSize 0, -1 or 1.5 throws synchronously naming maxQueueSize', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const dir = await mkdtemp(join(tmpdir(), 'phargus-persist-queue-ac2-invalid-'));
    try {
      const path = join(dir, 'windows.ndjson');
      for (const maxQueueSize of [0, -1, 1.5]) {
        expect(
          () =>
            collectorModule.createCollector({
              windowMs: 1000,
              capacity: 10,
              persist: { path, maxBytes: 1_000_000, maxQueueSize },
            }),
          `maxQueueSize ${maxQueueSize}`,
        ).toThrow(/maxQueueSize/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
