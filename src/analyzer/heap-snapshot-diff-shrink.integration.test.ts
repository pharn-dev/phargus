import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { diffHeapSnapshots } from './index.js';

class PhargusShrinkMarker {
  f0: number;
  f1: number;
  f2: number;
  f3: number;
  f4: number;
  f5: number;
  f6: number;
  f7: number;

  constructor(seed: number) {
    this.f0 = seed;
    this.f1 = seed + 1;
    this.f2 = seed + 2;
    this.f3 = seed + 3;
    this.f4 = seed + 4;
    this.f5 = seed + 5;
    this.f6 = seed + 6;
    this.f7 = seed + 7;
  }
}

describe('heap snapshot diff ordering', () => {
  it('ranks a type that shrank first, drops unchanged rows and orders growth and shrink by absolute size change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phargus-diff-shrink-'));
    try {
      let held: PhargusShrinkMarker[] = [];
      for (let i = 0; i < 5_000; i += 1) held.push(new PhargusShrinkMarker(i));
      const beforePath = writeHeapSnapshot(join(dir, 'before.heapsnapshot'));
      expect(held.length).toBe(5_000);
      held = [];
      // Writing a snapshot runs a full GC first, so the released objects are gone from this one.
      const afterPath = writeHeapSnapshot(join(dir, 'after.heapsnapshot'));

      const all = await diffHeapSnapshots(beforePath, afterPath, {
        top: 100_000,
        timeoutMs: 120_000,
      });

      const first = all.entries[0];
      expect(first?.name).toBe('PhargusShrinkMarker');
      expect(first?.countDelta).toBeLessThanOrEqual(-5_000);
      expect(first?.selfSizeDelta).toBeLessThan(0);

      for (const entry of all.entries) {
        expect(entry.countDelta !== 0 || entry.selfSizeDelta !== 0).toBe(true);
      }
      expect(all.entries.some((entry) => entry.selfSizeDelta > 0)).toBe(true);
      for (let i = 1; i < all.entries.length; i += 1) {
        const previous = all.entries[i - 1];
        const current = all.entries[i];
        expect(Math.abs(previous?.selfSizeDelta ?? 0)).toBeGreaterThanOrEqual(
          Math.abs(current?.selfSizeDelta ?? Infinity),
        );
      }

      const topOne = await diffHeapSnapshots(beforePath, afterPath, { top: 1, timeoutMs: 120_000 });
      expect(topOne.entries).toEqual([first]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
