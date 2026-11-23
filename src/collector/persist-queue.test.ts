import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersistQueue } from './persist-queue.js';
import type { AggregatedWindow } from './window.js';

function makeWindow(start: number): AggregatedWindow {
  return { start } as unknown as AggregatedWindow;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function warningMessages(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
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
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

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
    // Two failures in a row are one run: one warning.
    expect(warningMessages(warn)).toEqual([
      'window persistence failed: window persistence is closed; the window was not persisted; later failures are counted in persistence.failed until an append succeeds',
    ]);
    await expect(queue.close()).resolves.toBeUndefined();
  });

  it('resolves at once when nothing is queued', async () => {
    const queue = createPersistQueue({ maxQueueSize: 1, append: () => Promise.resolve() });
    await expect(queue.close()).resolves.toBeUndefined();
  });
});

describe('persist queue failures', () => {
  it('counts every failure and warns once per run of consecutive failures, never throwing', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    // Windows 0 and 1000 fail, 2000 succeeds, 3000 and 4000 fail.
    const outcomes = new Map<number, boolean>([
      [0, false],
      [1000, false],
      [2000, true],
      [3000, false],
      [4000, false],
    ]);
    const queue = createPersistQueue({
      maxQueueSize: 8,
      append: (window) =>
        outcomes.get(window.start) === true
          ? Promise.resolve()
          : Promise.reject(new Error(`disk refused ${window.start}`)),
    });
    for (const start of outcomes.keys()) {
      queue.push(makeWindow(start));
    }
    await expect(queue.drained()).resolves.toBeUndefined();

    expect(queue.failed).toBe(4);
    expect(queue.dropped).toBe(0);
    expect(warningMessages(warn)).toEqual([
      'window persistence failed: disk refused 0; later failures are counted in persistence.failed until an append succeeds',
      'window persistence failed: disk refused 3000; later failures are counted in persistence.failed until an append succeeds',
    ]);
    expect(warn.mock.calls.every((call) => String(call[1]) === 'PhargusPersistenceWarning')).toBe(
      true,
    );
  });

  it('report() counts a failure outside an append and joins the current run', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const queue = createPersistQueue({ maxQueueSize: 1, append: () => Promise.resolve() });
    queue.report(new Error('close failed'));
    queue.report('not an Error');
    expect(queue.failed).toBe(2);
    expect(warningMessages(warn)).toEqual([
      'window persistence failed: close failed; later failures are counted in persistence.failed until an append succeeds',
    ]);
  });
});
