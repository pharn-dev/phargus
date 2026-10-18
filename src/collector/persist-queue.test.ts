import { describe, expect, it } from 'vitest';
import { createPersistQueue } from './persist-queue.js';
import type { AggregatedWindow } from './window.js';

function makeWindow(start: number): AggregatedWindow {
  return { start } as unknown as AggregatedWindow;
}

describe('persist queue close()', () => {
  it('stops accepting windows, so pushes during the drain cannot hold close() open', async () => {
    const appended: number[] = [];
    const releases: Array<() => void> = [];
    const queue = createPersistQueue({
      maxQueueSize: 4,
      append: (window) =>
        new Promise<void>((resolve) => {
          releases.push(() => {
            appended.push(window.start);
            resolve();
          });
        }),
    });
    const failures: Error[] = [];
    queue.onFailure((error) => failures.push(error));

    queue.push(makeWindow(0)); // in flight
    queue.push(makeWindow(1000)); // queued
    let closed = false;
    const closing = queue.close().then(() => {
      closed = true;
    });
    // A source that keeps producing while close() drains.
    queue.push(makeWindow(2000));
    queue.push(makeWindow(3000));

    releases.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    releases.shift()?.();
    await closing;

    expect(closed).toBe(true);
    expect(appended).toEqual([0, 1000]);
    expect(releases).toHaveLength(0);
    expect(queue.failed).toBe(2);
    expect(queue.dropped).toBe(0);
    expect(failures.map((error) => error.message)).toEqual([
      'window persistence is closed; the window was not persisted',
      'window persistence is closed; the window was not persisted',
    ]);
    await expect(queue.close()).resolves.toBeUndefined();
  });

  it('resolves at once when nothing is queued', async () => {
    const queue = createPersistQueue({ maxQueueSize: 1, append: () => Promise.resolve() });
    await expect(queue.close()).resolves.toBeUndefined();
  });
});
