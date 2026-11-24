import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SpanRecord } from '../agent/index.js';
import { createRecordGuard, type IgnoredRecordHandler } from './record-guard.js';
import { createAlertEvaluatorState, evaluateAlerts, type Alert } from './alert-evaluator.js';
import { validateAlertRules, type AlertRule } from './alert-rules.js';
import type { AlertSink, SinkErrorHandler } from './alert-sink.js';
import { createSinkDispatcher } from './sink-dispatcher.js';
import { createRingBuffer, type RingBuffer } from './ring-buffer.js';
import type { AggregatedWindow } from './window.js';
import { createWindowAggregator } from './window-aggregator.js';
import { createWindowStore, type PersistOptions } from './window-store.js';
import { createPersistQueue, DEFAULT_PERSIST_QUEUE_SIZE } from './persist-queue.js';

export const DEFAULT_SPAN_CAPACITY = 1024;

export type CollectorOptions = {
  windowMs: number;
  capacity: number;
  spanCapacity?: number;
  alerts?: readonly AlertRule[];
  sinks?: readonly AlertSink[];
  onSinkError?: SinkErrorHandler;
  persist?: PersistOptions;
  /**
   * Called once per record `consume()` skips, after `ignored` is incremented. Foreign records
   * (not agent data), malformed ones (agent-shaped but unusable) and samples from a process other
   * than the first `pid` a run saw (`other-process`) are skipped and counted, never thrown. A hook
   * that throws rejects `consume()` with that error.
   */
  onIgnored?: IgnoredRecordHandler;
};

/** Live view over the window store; counters are integers. */
export type WindowPersistence = {
  readonly path: string;
  readonly maxBytes: number;
  readonly skipped: number;
  readonly restored: number;
  readonly bytes: number;
  /** Windows dropped from a full persistence queue (integer, saturating). */
  readonly dropped: number;
  /**
   * Persistence failures, counted and warned about but never thrown (integer, saturating): windows
   * whose append (or the compaction it triggered) failed, windows that arrived after `close()`, and
   * a file that could not be restored or released.
   */
  readonly failed: number;
};

export type Collector = {
  readonly windows: RingBuffer<AggregatedWindow>;
  readonly alerts: RingBuffer<Alert>;
  readonly spans: RingBuffer<SpanRecord>;
  readonly sinks: readonly AlertSink[];
  readonly persistence: WindowPersistence | undefined;
  /** Records `consume()` skipped (any `IgnoredReason`), across all runs (integer, saturating). */
  readonly ignored: number;
  subscribe(listener: CollectorListener): () => void;
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
  close(): Promise<void>;
};

/** A live observer of the collector's recorded windows, alerts and spans. */
export type CollectorListener = {
  window?(window: AggregatedWindow): void;
  alert?(alert: Alert): void;
  span?(span: SpanRecord): void;
};

/** A sink is an object with `send` and `close`; a configuration object is told its factory. */
function checkSink(sink: unknown, index: number): AlertSink {
  const { send, close, type } = (sink ?? {}) as Record<string, unknown>;
  if (typeof send === 'function' && typeof close === 'function') {
    return sink as AlertSink;
  }
  const factory =
    typeof type === 'string' && ['stdout', 'file', 'webhook'].includes(type)
      ? `create${type.charAt(0).toUpperCase()}${type.slice(1)}Sink`
      : 'createStdoutSink, createFileSink or createWebhookSink';
  throw new TypeError(`sinks[${String(index)}] is not an alert sink: build it with ${factory}`);
}

export function createCollector(options: CollectorOptions): Collector {
  const { windowMs, capacity } = options;
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new RangeError('windowMs must be a positive safe integer');
  }
  // Validated once here; every consume() reuses the resolved rules.
  const rules = validateAlertRules(options.alerts ?? []);
  const { onIgnored } = options;
  if (onIgnored !== undefined && typeof onIgnored !== 'function') {
    throw new TypeError('onIgnored must be a function');
  }
  let ignored = 0;
  const windows = createRingBuffer<AggregatedWindow>(capacity);
  const alerts = createRingBuffer<Alert>(capacity);
  const spans = createRingBuffer<SpanRecord>(options.spanCapacity ?? DEFAULT_SPAN_CAPACITY);
  // One alert state for every consume(): a rule firing at the end of one run stays firing.
  const alertState = createAlertEvaluatorState(rules.length);
  if (options.sinks !== undefined && !Array.isArray(options.sinks)) {
    throw new TypeError('sinks must be an array');
  }
  const sinks = (options.sinks ?? []).map(checkSink);
  const dispatcher = createSinkDispatcher(sinks, options.onSinkError);
  const store =
    options.persist === undefined ? undefined : createWindowStore({ ...options.persist, capacity });
  const queue =
    store === undefined
      ? undefined
      : createPersistQueue({
          append: (window) => store.append(window),
          // Only `undefined` means "default"; anything else reaches the validator.
          maxQueueSize:
            options.persist?.maxQueueSize === undefined
              ? DEFAULT_PERSIST_QUEUE_SIZE
              : options.persist.maxQueueSize,
        });
  const persistence: WindowPersistence | undefined =
    store === undefined || queue === undefined
      ? undefined
      : {
          path: store.path,
          maxBytes: store.maxBytes,
          get skipped(): number {
            return store.skipped;
          },
          get restored(): number {
            return store.restored;
          },
          get bytes(): number {
            return store.bytes;
          },
          get dropped(): number {
            return queue.dropped;
          },
          get failed(): number {
            return queue.failed;
          },
        };
  let restoring: Promise<void> | undefined;
  const restoreOnce = (): Promise<void> => {
    if (store === undefined) {
      return Promise.resolve();
    }
    // A file that cannot be read is a persistence failure like any other: counted and warned
    // about, and the collector starts without the persisted windows.
    restoring ??= store.restore().then(
      (restored) => {
        for (const window of restored) {
          windows.push(window);
        }
      },
      (error: unknown) => {
        queue?.report(error);
      },
    );
    return restoring;
  };
  const listeners = new Set<CollectorListener>();
  /** Calls `event` on every listener; a listener that throws is reported and the rest still run. */
  const emit = <E extends keyof CollectorListener>(
    event: E,
    value: Parameters<Required<CollectorListener>[E]>[0],
  ): void => {
    for (const listener of [...listeners]) {
      try {
        (listener[event] as ((v: typeof value) => void) | undefined)?.call(listener, value);
      } catch (error) {
        process.emitWarning(
          `collector listener threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  return {
    windows,
    alerts,
    spans,
    sinks,
    persistence,
    get ignored(): number {
      return ignored;
    },
    subscribe(listener: CollectorListener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    async consume(source: Readable | AsyncIterable<unknown>): Promise<void> {
      const guard = createRecordGuard(
        (record, reason) => {
          ignored = ignored >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : ignored + 1;
          onIgnored?.(record, reason);
        },
        (span) => {
          spans.push(span);
          emit('span', span);
        },
      );
      const aggregator = createWindowAggregator({ windowMs });
      const recordWindows = new Transform({
        objectMode: true,
        transform(window: AggregatedWindow, _encoding, callback): void {
          try {
            windows.push(window);
            // Hands the window to the persistence queue without waiting for the disk.
            queue?.push(window);
            emit('window', window);
            callback(null, window);
          } catch (error) {
            callback(error as Error);
          }
        },
      });
      try {
        await restoreOnce();
        await pipeline(
          source,
          guard,
          aggregator,
          recordWindows,
          evaluateAlerts(rules, alertState),
          async function (emitted: AsyncIterable<unknown>) {
            for await (const alert of emitted) {
              alerts.push(alert as Alert);
              emit('alert', alert as Alert);
              dispatcher.deliver(alert as Alert);
            }
          },
        );
      } finally {
        await dispatcher.settle();
        // Windows still queued are attempted before the file is released. A persistence failure is
        // counted in `persistence.failed` and warned about, never thrown: it cannot stop consume().
        await queue?.drained();
        if (store !== undefined) {
          try {
            await store.release();
          } catch (releaseError) {
            queue?.report(releaseError);
          }
        }
      }
    },
    async close(): Promise<void> {
      await dispatcher.close();
      // Stops accepting windows, then lets the queued appends finish, so no queued window is lost
      // to the latch below and a still-running consume() cannot keep the drain open.
      await queue?.close();
      // Latches the store: a consume() still running cannot reopen the file after close().
      await store?.close();
    },
  };
}
