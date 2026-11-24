import { createBoundedQueue } from '../agent/bounded-queue.js';

export type RingBuffer<T> = {
  readonly capacity: number;
  push(item: T): void;
  /** A fresh array, oldest first, newest last. */
  snapshot(): T[];
  size(): number;
};

/** A drop-oldest buffer of the last `capacity` items. Throws `RangeError` for a bad capacity. */
export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  const queue = createBoundedQueue<T>(capacity);
  return {
    capacity,
    push: (item) => void queue.push(item),
    snapshot: () => queue.snapshot(),
    size: () => queue.size,
  };
}
