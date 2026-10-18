import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { AggregatedWindow } from '../collector/index.js';

type AnyValue = { stringValue?: string; intValue?: string };
type KeyValue = { key: string; value: AnyValue };

type MetricsRequest = {
  resourceMetrics: { resource: { attributes: KeyValue[] } }[];
};

type OtelModule = {
  toOtlpMetrics: (
    windows: AggregatedWindow,
    options?: { serviceName?: string; serviceInstanceId?: string },
  ) => MetricsRequest;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const window: AggregatedWindow = {
  start: 1700000000000,
  end: 1700000001000,
  count: 1,
  late: 0,
  eventLoop: { max: 0, p99: 0, mean: 0 },
  memory: { heapUsedLast: 0, heapUsedMax: 0, rssLast: 0, rssMax: 0 },
  gc: { count: 0, totalPause: 0, maxPause: 0 },
  backpressure: { events: 0, totalStall: 0, maxStall: 0 },
};

function attribute(request: MetricsRequest, key: string): AnyValue | undefined {
  return request.resourceMetrics[0]?.resource.attributes.find((kv) => kv.key === key)?.value;
}

describe('otel missing metrics — AC-2', () => {
  it('AC-2: the resource carries service.name, a stable default service.instance.id, host.name and process.pid', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const first = otel.toOtlpMetrics(window);
    const second = otel.toOtlpMetrics(window);
    const overridden = otel.toOtlpMetrics(window, { serviceInstanceId: 'instance-a' });

    for (const request of [first, second, overridden]) {
      expect(attribute(request, 'service.name')).toEqual({ stringValue: 'phargus' });
      expect(attribute(request, 'host.name')).toEqual({ stringValue: hostname() });
      expect(attribute(request, 'process.pid')).toEqual({ intValue: String(process.pid) });
    }

    const firstId = attribute(first, 'service.instance.id')?.stringValue;
    expect(firstId).toMatch(UUID);
    expect(attribute(second, 'service.instance.id')).toEqual({ stringValue: firstId });
    expect(attribute(overridden, 'service.instance.id')).toEqual({ stringValue: 'instance-a' });
  });

  it('AC-2: an empty or non-string serviceInstanceId is rejected with a TypeError', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    expect(() => otel.toOtlpMetrics(window, { serviceInstanceId: '' })).toThrow(TypeError);
    expect(() =>
      otel.toOtlpMetrics(window, { serviceInstanceId: 42 as unknown as string }),
    ).toThrow(TypeError);
  });
});
