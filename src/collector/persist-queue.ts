import type { AggregatedWindow } from './window.js';

/** Default most windows waiting for the disk; matches the agent's default `queueBound`. */
export const DEFAULT_PERSIST_QUEUE_SIZE = 1024;

export type PersistQueueOptions = {
  /** Writes one window; called one at a time, oldest first. A rejection is counted, never thrown. */
  append: (window: AggregatedWindow) => Promise<void>;
  /** Most windows kept waiting; a positive safe integer. The window being appended is not counted. */
  maxQueueSize: unknown;
};

export type PersistQueue = {
  /** Windows dropped from a full queue (integer, saturating). */
  readonly dropped: number;
  /** Windows whose append rejected (integer, saturating). */
  readonly failed: number;
  /**
   * Queues one window and returns at once. When the queue is full the oldest queued window is
   * dropped and counted. Never throws and never waits for the disk.
   */
  push(window: AggregatedWindow): void;
  /** Registers a callback for each failed append; returns its unsubscribe. */
  onFailure(listener: (error: Error) => void): () => void;
  /** Resolves when nothing is queued and no append is in flight. Never rejects. */
  drained(): Promise<void>;
};

function increment(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function reportListenerError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.emitWarning(`persist queue failure listener threw: ${message}`);
}

/**
 * A bounded drop-oldest FIFO of windows with one serial drain loop. It exists so that a slow disk
 * costs dropped windows, not a slower pipeline.
 */
export function createPersistQueue(options: PersistQueueOptions): PersistQueue {
  const { append, maxQueueSize } = options;
  if (
    typeof maxQueueSize !== 'number' ||
    !Number.isSafeInteger(maxQueueSize) ||
    maxQueueSize <= 0
  ) {
    throw new RangeError('persist.maxQueueSize must be a positive safe integer');
  }
  const limit: number = maxQueueSize;

  // An array plus a head index: no per-item shift and no up-front allocation of `limit` slots.
  let items: AggregatedWindow[] = [];
  let head = 0;
  let dropped = 0;
  let failed = 0;
  let running = false;
  let waiters: Array<() => void> = [];
  const listeners = new Set<(error: Error) => void>();

  function size(): number {
    return items.length - head;
  }

  function take(): AggregatedWindow {
    const window = items[head] as AggregatedWindow;
    head += 1;
    if (head * 2 >= items.length) {
      items = items.slice(head);
      head = 0;
    }
    return window;
  }

  function fail(error: Error): void {
    failed = increment(failed);
    for (const listener of [...listeners]) {
      try {
        listener(error);
      } catch (listenerError) {
        reportListenerError(listenerError);
      }
    }
  }

  async function drain(): Promise<void> {
    while (size() > 0) {
      const window = take();
      try {
        await append(window);
      } catch (error) {
        fail(toError(error));
      }
    }
    running = false;
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) {
      resolve();
    }
  }

  return {
    get dropped(): number {
      return dropped;
    },
    get failed(): number {
      return failed;
    },
    push(window: AggregatedWindow): void {
      if (size() >= limit) {
        take();
        dropped = increment(dropped);
      }
      items.push(window);
      if (!running) {
        running = true;
        // The loop catches every append failure itself; this guards the impossible rest.
        drain().catch((error: unknown) => {
          running = false;
          fail(toError(error));
        });
      }
    },
    onFailure(listener: (error: Error) => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    drained(): Promise<void> {
      if (!running && size() === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}
