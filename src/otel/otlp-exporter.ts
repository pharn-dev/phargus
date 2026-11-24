import type { AggregatedWindow, CollectorListener, SpanRecord } from '../collector/index.js';
import { createOtlpBatchQueue } from './otlp-batch-queue.js';
import { resolveOtlpExporterOptions, type OtlpExporterOptions } from './otlp-exporter-options.js';
import {
  DEFAULT_SERVICE_INSTANCE_ID,
  requireServiceInstanceId,
  toOtlpMetrics,
} from './otlp-metrics.js';
import { toOtlpTraces } from './otlp-traces.js';

/** An OTLP/HTTP JSON exporter of items (collector windows or spans). */
export type OtlpExporter<T> = {
  /**
   * Adds items to the pending queue. Synchronous; never throws, never awaits. Pending items are
   * batched: one request carries up to `maxBatchSize` items and is sent when a full batch is
   * pending or after `flushIntervalMs`. When more than `maxQueueSize` items are pending, the
   * OLDEST are dropped, counted and reported. Call `close()` or `flush()` before the process
   * exits: items still pending at exit are not delivered.
   */
  export(items: T | readonly T[]): void;
  /**
   * Sends the items pending at the call and resolves once they, and the request in flight, are
   * done. Never rejects for an export failure.
   */
  flush(): Promise<void>;
  /**
   * Stops accepting items, then flushes for at most `closeTimeoutMs` (default `timeoutMs`); items
   * still pending then are dropped and reported, the request in flight is aborted. Items exported
   * after `close()` are dropped and counted. Idempotent.
   */
  close(): Promise<void>;
  /** Export calls that lost at least one item, each counted once. */
  readonly droppedBatches: number;
  /** Requests that failed, or whose items could not be encoded. */
  readonly failedBatches: number;
  /** Items dropped: evicted from a full queue, exported after `close()`, or dropped by `close()`. */
  readonly droppedItems: number;
  /** Items the endpoint accepted (a 2xx answer). */
  readonly exportedItems: number;
  /** Items in a failed request, or in a batch that could not be encoded. */
  readonly failedItems: number;
  /** For `collector.subscribe(exporter.listener)`: one item per callback. */
  readonly listener: CollectorListener;
};

export type OtlpMetricsExporterOptions = OtlpExporterOptions & {
  /**
   * The `service.instance.id` resource attribute: a non-empty string. Defaults to a random UUID
   * generated once per process, shared by every metrics exporter in it.
   */
  serviceInstanceId?: string;
};

/** Exports collector windows as OTLP metrics; `listener.window` receives them. */
export type OtlpMetricsExporter = OtlpExporter<AggregatedWindow>;

export type OtlpTraceExporterOptions = OtlpExporterOptions;

/** Exports span records as OTLP traces; `listener.span` receives them. */
export type OtlpTraceExporter = OtlpExporter<SpanRecord>;

/**
 * The one exporter behind both public factories: validates `options`, builds the batch queue with
 * `encode` and exposes it. `listen` maps the export function onto the collector callback.
 */
function createOtlpExporter<T>(
  options: OtlpExporterOptions,
  encode: (batch: readonly T[], serviceName: string) => string,
  listen: (exportItems: (item: T) => void) => CollectorListener,
): OtlpExporter<T> {
  const { serviceName, ...queueOptions } = resolveOtlpExporterOptions(options);
  const queue = createOtlpBatchQueue<T>({
    ...queueOptions,
    encode: (batch) => encode(batch, serviceName),
  });

  function exportItems(items: T | readonly T[]): void {
    queue.push(Array.isArray(items) ? (items as readonly T[]) : [items as T]);
  }

  return {
    export: exportItems,
    flush: () => queue.flush(),
    close: () => queue.close(),
    get droppedBatches() {
      return queue.droppedBatches;
    },
    get failedBatches() {
      return queue.failedBatches;
    },
    get droppedItems() {
      return queue.droppedItems;
    },
    get exportedItems() {
      return queue.exportedItems;
    },
    get failedItems() {
      return queue.failedItems;
    },
    listener: listen(exportItems),
  };
}

export function createOtlpMetricsExporter(
  options: OtlpMetricsExporterOptions,
): OtlpMetricsExporter {
  requireServiceInstanceId(options.serviceInstanceId);
  const serviceInstanceId = options.serviceInstanceId ?? DEFAULT_SERVICE_INSTANCE_ID;
  return createOtlpExporter<AggregatedWindow>(
    options,
    (batch, serviceName) =>
      JSON.stringify(toOtlpMetrics(batch, { serviceName, serviceInstanceId })),
    (exportItems) => ({ window: exportItems }),
  );
}

export function createOtlpTraceExporter(options: OtlpTraceExporterOptions): OtlpTraceExporter {
  return createOtlpExporter<SpanRecord>(
    options,
    (batch, serviceName) => JSON.stringify(toOtlpTraces(batch, { serviceName })),
    (exportItems) => ({ span: exportItems }),
  );
}
