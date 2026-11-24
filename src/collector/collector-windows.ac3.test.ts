import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { makeSample } from '../../test/support.js';

type CollectorUnderTest = {
  readonly windows: { snapshot(): Array<{ start: number }> };
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: { windowMs: number; capacity: number }) => CollectorUnderTest;
};

describe('collector windows — AC-3', () => {
  it('AC-3: a collector with capacity 2 keeps the two newest windows, resolves on source end, and rejects with a source error', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const collector = collectorModule.createCollector({ windowMs: 1000, capacity: 2 });
    const source = Readable.from(
      [100, 500, 1100, 1900, 2100, 2500, 3100, 3800].map((timestamp) => makeSample(timestamp)),
    );
    await expect(collector.consume(source)).resolves.toBeUndefined();

    const snapshot = collector.windows.snapshot();
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((window) => window.start)).toEqual([2000, 3000]);

    const failing = collectorModule.createCollector({ windowMs: 1000, capacity: 2 });
    const sourceError = new Error('source failed');
    let emitted = false;
    const erroringSource = new Readable({
      objectMode: true,
      read() {
        if (!emitted) {
          emitted = true;
          this.push(makeSample(100));
          return;
        }
        this.destroy(sourceError);
      },
    });
    await expect(failing.consume(erroringSource)).rejects.toBe(sourceError);
  }, 10_000);
});
