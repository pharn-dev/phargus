import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { excludeFromBackpressure } from './backpressure-probe.js';
import { createBoundedQueue } from './bounded-queue.js';

export type NdjsonExporterOptions = {
  /**
   * Maximum queued lines in each lane (`export()` records and `exportSpan()` lines) before that
   * lane drops its oldest. Defaults to 1024.
   */
  queueBound?: number;
};

export type NdjsonExporter = {
  /** Encode one record and queue it for the destination. Spans never evict it. */
  export(record: unknown): void;
  /**
   * Encode one span record and queue it in the span lane. The span lane has its own bound and is
   * written only while no `export()` record is waiting, so a burst of spans never displaces a sample.
   */
  exportSpan(record: unknown): void;
  /** Integer count of `export()` records discarded without reaching the destination. */
  readonly droppedRecords: number;
  /** Integer count of `exportSpan()` records discarded without reaching the destination. */
  readonly droppedSpans: number;
  /** Flush both lanes, end the destination, and return `done`. */
  stop(): Promise<void>;
  /** The pipeline() result: resolves on a clean stop, rejects with the destination's error. */
  readonly done: Promise<void>;
};

const DEFAULT_QUEUE_BOUND = 1024;

/**
 * Encode one record as a single NDJSON line (JSON text plus a trailing newline).
 * Encode failures (a cycle, a BigInt) propagate as the TypeError JSON.stringify throws.
 */
export function encodeNdjsonLine(record: unknown): string {
  const text = JSON.stringify(record) as string | undefined;
  if (text === undefined) {
    throw new TypeError('record is not JSON-serializable (undefined, function or symbol)');
  }
  return `${text}\n`;
}

export function createNdjsonExporter(
  destination: Writable,
  options: NdjsonExporterOptions = {},
): NdjsonExporter {
  excludeFromBackpressure(destination);
  const queueBound = options.queueBound ?? DEFAULT_QUEUE_BOUND;
  // createBoundedQueue validates the bound and throws RangeError.
  const records = createBoundedQueue<string>(queueBound);
  const spans = createBoundedQueue<string>(queueBound);
  let droppedRecords = 0;
  let droppedSpans = 0;
  let stopping = false;
  let closed = false;
  let wake: (() => void) | undefined;

  const wakeSource = (): void => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };

  async function* source(): AsyncGenerator<string, void, undefined> {
    for (;;) {
      // Records first: a span line is written only when no sample is waiting.
      const line = records.shift() ?? spans.shift();
      if (line !== undefined) {
        yield line;
        continue;
      }
      if (stopping || closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  const done = pipeline(source(), destination);

  const onClosed = (): void => {
    closed = true;
    while (records.shift() !== undefined) {
      droppedRecords += 1;
    }
    while (spans.shift() !== undefined) {
      droppedSpans += 1;
    }
    wakeSource();
  };
  // Observes settlement only; the rejection still reaches every caller of `done`.
  done.then(onClosed, onClosed);

  return {
    export(record: unknown): void {
      if (closed || stopping) {
        droppedRecords += 1;
        return;
      }
      const line = encodeNdjsonLine(record);
      if (records.push(line) !== undefined) {
        droppedRecords += 1;
      }
      wakeSource();
    },
    exportSpan(record: unknown): void {
      if (closed || stopping) {
        droppedSpans += 1;
        return;
      }
      const line = encodeNdjsonLine(record);
      if (spans.push(line) !== undefined) {
        droppedSpans += 1;
      }
      wakeSource();
    },
    get droppedRecords(): number {
      return droppedRecords;
    },
    get droppedSpans(): number {
      return droppedSpans;
    },
    stop(): Promise<void> {
      stopping = true;
      wakeSource();
      return done;
    },
    done,
  };
}
