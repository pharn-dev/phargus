import type { AggregatedWindow } from '../collector/index.js';
import {
  DEFAULT_SERVICE_INSTANCE_ID,
  otlpResourceAttributes,
  requireServiceInstanceId,
} from './otlp-resource.js';
import {
  AGGREGATION_TEMPORALITY_DELTA,
  type OtlpMetric,
  type OtlpMetricsRequest,
  type OtlpNumberDataPoint,
} from './otlp-types.js';

/** Converts epoch milliseconds to an exact epoch-nanosecond decimal string. */
export function msToUnixNano(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError(`timestamp must be a non-negative safe integer, got ${String(ms)}`);
  }
  return (BigInt(ms) * 1_000_000n).toString();
}

/** Converts a non-negative safe integer to its decimal string (OTLP JSON `asInt`). */
export function toIntString(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`metric value must be a non-negative safe integer, got ${String(value)}`);
  }
  return String(value);
}

type MetricSpec = {
  name: string;
  description: string;
  unit: string;
  read: (window: AggregatedWindow) => number;
};

const GAUGES: readonly MetricSpec[] = [
  {
    name: 'phargus.event_loop.lag.max',
    description: 'Maximum event loop lag in the window',
    unit: 'ns',
    read: (w) => w.eventLoop.max,
  },
  {
    name: 'phargus.event_loop.lag.p99',
    description: '99th percentile event loop lag in the window',
    unit: 'ns',
    read: (w) => w.eventLoop.p99,
  },
  {
    name: 'phargus.event_loop.lag.mean',
    description: 'Mean event loop lag in the window',
    unit: 'ns',
    read: (w) => w.eventLoop.mean,
  },
  {
    name: 'phargus.memory.heap_used.last',
    description: 'Heap used at the end of the window',
    unit: 'By',
    read: (w) => w.memory.heapUsedLast,
  },
  {
    name: 'phargus.memory.heap_used.max',
    description: 'Maximum heap used in the window',
    unit: 'By',
    read: (w) => w.memory.heapUsedMax,
  },
  {
    name: 'phargus.memory.rss.last',
    description: 'Resident set size at the end of the window',
    unit: 'By',
    read: (w) => w.memory.rssLast,
  },
  {
    name: 'phargus.memory.rss.max',
    description: 'Maximum resident set size in the window',
    unit: 'By',
    read: (w) => w.memory.rssMax,
  },
  {
    name: 'phargus.gc.pause.max',
    description: 'Longest garbage collection pause in the window',
    unit: 'ns',
    read: (w) => w.gc.maxPause,
  },
  {
    name: 'phargus.backpressure.stall.max',
    description: 'Longest stream backpressure stall in the window',
    unit: 'ns',
    read: (w) => w.backpressure.maxStall,
  },
];

/** Per-window totals: delta, monotonic sums whose interval is the window. */
const SUMS: readonly MetricSpec[] = [
  {
    name: 'phargus.gc.count',
    description: 'Garbage collections in the window',
    unit: '{collection}',
    read: (w) => w.gc.count,
  },
  {
    name: 'phargus.gc.pause.total',
    description: 'Total garbage collection pause time in the window',
    unit: 'ns',
    read: (w) => w.gc.totalPause,
  },
  {
    name: 'phargus.backpressure.events',
    description: 'Stream backpressure stalls in the window',
    unit: '{event}',
    read: (w) => w.backpressure.events,
  },
  {
    name: 'phargus.backpressure.stall.total',
    description: 'Total stream backpressure stall time in the window',
    unit: 'ns',
    read: (w) => w.backpressure.totalStall,
  },
  {
    name: 'phargus.window.samples',
    description: 'Agent samples aggregated into the window',
    unit: '{sample}',
    read: (w) => w.count,
  },
  {
    name: 'phargus.window.late_samples',
    description: 'Agent samples that arrived after their window had closed',
    unit: '{sample}',
    read: (w) => w.late,
  },
];

/**
 * Converts aggregated windows to an OTLP/HTTP JSON metrics request. Pure and synchronous; the
 * result contains only plain objects, arrays and strings. Every numeric field of the window is
 * exported: maxima and last values as gauges, per-window totals as delta sums. The resource carries
 * `service.name`, `service.instance.id` (a per-process UUID unless `serviceInstanceId` is given),
 * `host.name` and `process.pid`. Throws a TypeError for an empty or non-string `serviceInstanceId`.
 */
export function toOtlpMetrics(
  windows: AggregatedWindow | readonly AggregatedWindow[],
  options: { serviceName?: string; serviceInstanceId?: string } = {},
): OtlpMetricsRequest {
  requireServiceInstanceId(options.serviceInstanceId);
  const list: readonly AggregatedWindow[] = Array.isArray(windows)
    ? (windows as readonly AggregatedWindow[])
    : [windows as AggregatedWindow];

  const gauges: OtlpMetric[] = GAUGES.map((spec) => ({
    name: spec.name,
    description: spec.description,
    unit: spec.unit,
    gauge: {
      dataPoints: list.map((window): OtlpNumberDataPoint => ({
        timeUnixNano: msToUnixNano(window.end),
        asInt: toIntString(spec.read(window)),
      })),
    },
  }));

  const sums: OtlpMetric[] = SUMS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    unit: spec.unit,
    sum: {
      dataPoints: list.map((window): OtlpNumberDataPoint => ({
        startTimeUnixNano: msToUnixNano(window.start),
        timeUnixNano: msToUnixNano(window.end),
        asInt: toIntString(spec.read(window)),
      })),
      aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
      isMonotonic: true,
    },
  }));

  const metrics: OtlpMetric[] = [...gauges, ...sums];

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: otlpResourceAttributes({
            serviceName: options.serviceName ?? 'phargus',
            serviceInstanceId: options.serviceInstanceId ?? DEFAULT_SERVICE_INSTANCE_ID,
          }),
        },
        scopeMetrics: [{ scope: { name: 'phargus' }, metrics }],
      },
    ],
  };
}
