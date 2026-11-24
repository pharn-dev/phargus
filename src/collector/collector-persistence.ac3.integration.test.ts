import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { makeSample } from '../../test/support.js';

type CollectorUnderTest = {
  readonly windows: { snapshot(): Array<Record<string, unknown>> };
  readonly persistence: { readonly failed: number } | undefined;
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: {
    windowMs: number;
    capacity: number;
    persist?: { path: string; maxBytes: number };
  }) => CollectorUnderTest;
};

const WINDOW_COUNT = 8;

describe('collector persistence — AC-3', () => {
  it('AC-3: compacts the file to a contiguous tail of windows past maxBytes, counts and warns about append errors without rejecting, and validates path and maxBytes', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const dir = await mkdtemp(join(tmpdir(), 'phargus-persist-ac3-'));
    try {
      // Compaction past a small maxBytes.
      const path = join(dir, 'windows.ndjson');
      const collector = collectorModule.createCollector({
        windowMs: 1000,
        capacity: 3,
        persist: { path, maxBytes: 600 },
      });
      const timestamps = Array.from({ length: WINDOW_COUNT }, (_, index) => [
        index * 1000 + 100,
        index * 1000 + 600,
      ]).flat();
      await expect(
        collector.consume(Readable.from(timestamps.map((timestamp) => makeSample(timestamp)))),
      ).resolves.toBeUndefined();

      const consumedStarts = Array.from({ length: WINDOW_COUNT }, (_, index) => index * 1000);
      const text = await readFile(path, 'utf8');
      const fileLines = text.split('\n').filter((line) => line.length > 0);
      const parsed = fileLines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed.length).toBeLessThan(WINDOW_COUNT);
      const starts = parsed.map((window) => window['start']);
      expect(starts).toEqual(consumedStarts.slice(WINDOW_COUNT - parsed.length));
      for (const window of parsed) {
        expect(window['count']).toBe(2);
      }
      const last = collector.windows.snapshot().at(-1);
      expect(parsed.at(-1)).toEqual(last);
      expect(await readdir(dir)).toEqual(['windows.ndjson']);

      // Append errors are counted and warned about, never thrown: the persistence path is a
      // directory.
      const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      try {
        const failing = collectorModule.createCollector({
          windowMs: 1000,
          capacity: 3,
          persist: { path: dir, maxBytes: 600 },
        });
        await expect(
          failing.consume(Readable.from([100, 1100].map((timestamp) => makeSample(timestamp)))),
        ).resolves.toBeUndefined();
        expect(failing.windows.snapshot()).toHaveLength(2);
        expect(failing.persistence?.failed).toBeGreaterThan(0);
        expect(
          warn.mock.calls.filter((call) => String(call[1]) === 'PhargusPersistenceWarning'),
        ).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }

      // Synchronous validation at creation.
      expect(() =>
        collectorModule.createCollector({
          windowMs: 1000,
          capacity: 3,
          persist: { path, maxBytes: 0 },
        }),
      ).toThrow(/maxBytes/);
      expect(() =>
        collectorModule.createCollector({
          windowMs: 1000,
          capacity: 3,
          persist: { path, maxBytes: -1 },
        }),
      ).toThrow(/maxBytes/);
      expect(() =>
        collectorModule.createCollector({
          windowMs: 1000,
          capacity: 3,
          persist: { path: '', maxBytes: 600 },
        }),
      ).toThrow(/path/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
