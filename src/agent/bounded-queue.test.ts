import { describe, expect, it } from 'vitest';
import { createBoundedQueue } from './bounded-queue.js';

describe('createBoundedQueue', () => {
  it('is first-in first-out and reports each drop', () => {
    const queue = createBoundedQueue<number>(3);
    expect([1, 2, 3, 4, 5].map((n) => queue.push(n))).toEqual([
      undefined,
      undefined,
      undefined,
      1,
      2,
    ]);
    expect(queue.size).toBe(3);
    expect([queue.shift(), queue.shift(), queue.shift(), queue.shift()]).toEqual([
      3,
      4,
      5,
      undefined,
    ]);
    expect(queue.size).toBe(0);
  });

  it('keeps only the newest items in order when nobody ever shifts', () => {
    const queue = createBoundedQueue<number>(100);
    for (let i = 0; i < 100_000; i += 1) {
      queue.push(i);
    }
    expect(queue.size).toBe(100);
    expect(queue.snapshot()).toEqual(Array.from({ length: 100 }, (_, k) => 100_000 - 100 + k));
  });

  it('takes up to n of the oldest items and snapshots without removing', () => {
    const queue = createBoundedQueue<string>(10);
    for (const item of ['a', 'b', 'c', 'd']) {
      queue.push(item);
    }
    expect(queue.snapshot()).toEqual(['a', 'b', 'c', 'd']);
    expect(queue.take(3)).toEqual(['a', 'b', 'c']);
    expect(queue.take(5)).toEqual(['d']);
    expect(queue.take(1)).toEqual([]);
    expect(queue.size).toBe(0);
  });

  it('keeps order across growth while the ring wraps', () => {
    const queue = createBoundedQueue<number>(1000);
    const expected: number[] = [];
    for (let i = 0; i < 500; i += 1) {
      queue.push(i);
      expected.push(i);
      if (i % 3 === 0) {
        expect(queue.shift()).toBe(expected.shift());
      }
    }
    expect(queue.snapshot()).toEqual(expected);
  });

  it('clears every item and stays usable', () => {
    const queue = createBoundedQueue<number>(2);
    queue.push(1);
    queue.push(2);
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.shift()).toBeUndefined();
    expect(queue.push(3)).toBeUndefined();
    expect(queue.snapshot()).toEqual([3]);
  });

  it('does not allocate a huge capacity up front', () => {
    // `new Array(Number.MAX_SAFE_INTEGER)` throws, so this only works when slots grow on demand.
    const queue = createBoundedQueue<number>(Number.MAX_SAFE_INTEGER);
    for (let i = 0; i < 1000; i += 1) {
      expect(queue.push(i)).toBeUndefined();
    }
    expect(queue.capacity).toBe(Number.MAX_SAFE_INTEGER);
    expect(queue.take(1000)).toEqual(Array.from({ length: 1000 }, (_, k) => k));
  });

  it('rejects a non-positive capacity', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createBoundedQueue(capacity)).toThrow(RangeError);
    }
  });
});
