import { describe, expect, it } from 'vitest';
import type { AggregatedWindow } from '../collector/index.js';

type DataPoint = { startTimeUnixNano?: string; timeUnixNano: string; asInt: string };

type Metric = {
  name: string;
  unit: string;
  gauge?: { dataPoints: DataPoint[] };
  sum?: { dataPoints: DataPoint[]; aggregationTemporality: number; isMonotonic: boolean };
};

type MetricsRequest = {
  resourceMetrics: { scopeMetrics: { metrics: Metric[] }[] }[];
};

type OtelModule = {
  toOtlpMetrics: (windows: AggregatedWindow | readonly AggregatedWindow[]) => MetricsRequest;
};

const window: AggregatedWindow = {
  start: 1700000000000,
  end: 1700000001000,
  count: 10,
  late: 2,
  eventLoop: { max: 5000000, p99: 4000000, mean: 2000000 },
  memory: { heapUsedLast: 1000, heapUsedMax: 2000, rssLast: 3000, rssMax: 4000 },
  gc: { count: 3, totalPause: 4500000, maxPause: 2000000 },
  backpressure: { events: 5, totalStall: 7000000, maxStall: 3000000 },
};

// [name, unit, asInt]
const GAUGES: [string, string, string][] = [
  ['phargus.event_loop.lag.max', 'ns', '5000000'],
  ['phargus.event_loop.lag.p99', 'ns', '4000000'],
  ['phargus.event_loop.lag.mean', 'ns', '2000000'],
  ['phargus.memory.heap_used.last', 'By', '1000'],
  ['phargus.memory.heap_used.max', 'By', '2000'],
  ['phargus.memory.rss.last', 'By', '3000'],
  ['phargus.memory.rss.max', 'By', '4000'],
  ['phargus.gc.pause.max', 'ns', '2000000'],
  ['phargus.backpressure.stall.max', 'ns', '3000000'],
];

const SUMS: [string, string, string][] = [
  ['phargus.gc.count', '{collection}', '3'],
  ['phargus.gc.pause.total', 'ns', '4500000'],
  ['phargus.backpressure.events', '{event}', '5'],
  ['phargus.backpressure.stall.total', 'ns', '7000000'],
  ['phargus.window.samples', '{sample}', '10'],
  ['phargus.window.late_samples', '{sample}', '2'],
];

describe('otel missing metrics — AC-1', () => {
  it('AC-1: exports every AggregatedWindow field as fifteen typed metrics with exact integer values', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const result = otel.toOtlpMetrics(window);
    const metrics = result.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];

    for (const [name] of [...GAUGES, ...SUMS]) {
      expect(
        metrics.filter((metric) => metric.name === name),
        name,
      ).toHaveLength(1);
    }

    for (const [name, unit, value] of GAUGES) {
      const metric = metrics.find((m) => m.name === name);
      expect(metric?.unit, name).toBe(unit);
      expect(metric?.sum, name).toBeUndefined();
      expect(metric?.gauge?.dataPoints, name).toEqual([
        { timeUnixNano: '1700000001000000000', asInt: value },
      ]);
    }

    for (const [name, unit, value] of SUMS) {
      const metric = metrics.find((m) => m.name === name);
      expect(metric?.unit, name).toBe(unit);
      expect(metric?.gauge, name).toBeUndefined();
      expect(metric?.sum?.aggregationTemporality, name).toBe(1);
      expect(metric?.sum?.isMonotonic, name).toBe(true);
      expect(metric?.sum?.dataPoints, name).toEqual([
        {
          startTimeUnixNano: '1700000000000000000',
          timeUnixNano: '1700000001000000000',
          asInt: value,
        },
      ]);
    }
  });
});
