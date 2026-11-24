export type BoundedQueue<T> = {
  readonly capacity: number;
  /** Append an item. Returns the oldest item when it was evicted to make room, else `undefined`. */
  push(item: T): T | undefined;
  /** Remove and return the oldest item, or `undefined` when empty. */
  shift(): T | undefined;
  /** Remove and return up to `count` of the oldest items, oldest first. */
  take(count: number): T[];
  /** A fresh array, oldest first, newest last. */
  snapshot(): T[];
  /** Drop every item. */
  clear(): void;
  readonly size: number;
};

/** The ring starts small and doubles on demand, so a huge `capacity` costs nothing until used. */
const INITIAL_SLOTS = 16;

/**
 * Drop-oldest FIFO of at most `capacity` items, backed by a ring that grows to `capacity` on
 * demand. Removed items are released at once. Items must not be `undefined`.
 */
export function createBoundedQueue<T>(capacity: number): BoundedQueue<T> {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError(`capacity must be a positive safe integer, got ${String(capacity)}`);
  }
  let slots: (T | undefined)[] = [];
  let head = 0;
  let size = 0;

  const reset = (): void => {
    slots = new Array<T | undefined>(Math.min(capacity, INITIAL_SLOTS));
    head = 0;
    size = 0;
  };
  reset();

  const shift = (): T | undefined => {
    if (size === 0) {
      return undefined;
    }
    const item = slots[head];
    slots[head] = undefined;
    head = (head + 1) % slots.length;
    size -= 1;
    return item;
  };

  const take = (count: number): T[] => {
    const out: T[] = [];
    while (out.length < count && size > 0) {
      out.push(shift() as T);
    }
    return out;
  };

  return {
    capacity,
    push(item: T): T | undefined {
      if (size === capacity) {
        // Full, so `slots.length === capacity`: the oldest item's slot takes the newest.
        const evicted = slots[head];
        slots[head] = item;
        head = (head + 1) % capacity;
        return evicted;
      }
      if (size === slots.length) {
        const next = new Array<T | undefined>(Math.min(capacity, slots.length * 2));
        for (let i = 0; i < size; i += 1) {
          next[i] = slots[(head + i) % slots.length];
        }
        slots = next;
        head = 0;
      }
      slots[(head + size) % slots.length] = item;
      size += 1;
      return undefined;
    },
    shift,
    take,
    snapshot(): T[] {
      const out: T[] = [];
      for (let i = 0; i < size; i += 1) {
        out.push(slots[(head + i) % slots.length] as T);
      }
      return out;
    },
    clear: reset,
    get size(): number {
      return size;
    },
  };
}
