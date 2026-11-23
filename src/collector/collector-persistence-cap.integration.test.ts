import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AggregatedWindow } from './window.js';
import { serializeWindow } from './window-codec.js';
import { createWindowStore } from './window-store.js';

const CAPACITY = 300;
const MAX_BYTES = 64 * 1024;
const APPENDS = 2000;

/** A window with production-sized figures, so its NDJSON line is about 300 bytes. */
function makeWindow(index: number): AggregatedWindow {
  const start = 1_700_000_000_000 + index * 1000;
  return {
    start,
    end: start + 1000,
    count: 10,
    late: 0,
    eventLoop: { max: 123_456, p99: 98_765, mean: 45_678 },
    memory: {
      heapUsedLast: 123_456_789,
      heapUsedMax: 134_567_890,
      rssLast: 456_789_012,
      rssMax: 467_890_123,
    },
    gc: { count: 12, totalPause: 345_678, maxPause: 123_456 },
    backpressure: { events: 3, totalStall: 456_789, maxStall: 123_456, hotspots: [] },
    dropped: { samples: 0, spans: 0 },
  };
}

describe('window store byte cap (CORE-246)', () => {
  it('keeps the file within maxBytes and rewrites it rarely when capacity windows exceed maxBytes, and restores the newest windows in order', async () => {
    const lineBytes = Buffer.byteLength(serializeWindow(makeWindow(0)));
    // The case the cap must handle: the ring alone holds more than maxBytes of lines.
    expect(CAPACITY * lineBytes).toBeGreaterThan(MAX_BYTES);

    const dir = await mkdtemp(join(tmpdir(), 'phargus-persist-cap-'));
    try {
      const path = join(dir, 'windows.ndjson');
      const store = createWindowStore({ path, maxBytes: MAX_BYTES, capacity: CAPACITY });
      let rewrites = 0;
      let inode: number | undefined;
      let largest = 0;
      for (let index = 0; index < APPENDS; index += 1) {
        await store.append(makeWindow(index));
        const info = await stat(path);
        if (inode !== undefined && info.ino !== inode) {
          rewrites += 1;
        }
        inode = info.ino;
        largest = Math.max(largest, info.size);
      }
      await store.close();

      const finalSize = (await stat(path)).size;
      expect(finalSize).toBeLessThanOrEqual(MAX_BYTES);
      expect(largest).toBeLessThanOrEqual(MAX_BYTES);
      expect(store.bytes).toBe(finalSize);
      expect(rewrites).toBeGreaterThan(0);
      expect(rewrites).toBeLessThan(50);
      expect(await readdir(dir)).toEqual(['windows.ndjson']);

      // A restart restores the newest persisted windows, oldest first, ending with the last one.
      const restarted = createWindowStore({ path, maxBytes: MAX_BYTES, capacity: CAPACITY });
      const restored = await restarted.restore();
      expect(restored.length).toBeGreaterThan(0);
      expect(restarted.skipped).toBe(0);
      const expected = Array.from({ length: restored.length }, (_, offset) =>
        makeWindow(APPENDS - restored.length + offset),
      );
      expect(restored).toEqual(expected);
      await restarted.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps at least the newest window when one line is larger than half of maxBytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phargus-persist-cap-one-'));
    try {
      const path = join(dir, 'windows.ndjson');
      const maxBytes = Buffer.byteLength(serializeWindow(makeWindow(0))) + 10;
      const store = createWindowStore({ path, maxBytes, capacity: 4 });
      for (let index = 0; index < 5; index += 1) {
        await store.append(makeWindow(index));
      }
      await store.close();
      const restarted = createWindowStore({ path, maxBytes, capacity: 4 });
      expect(await restarted.restore()).toEqual([makeWindow(4)]);
      await restarted.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
