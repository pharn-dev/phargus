---
spec_id: otel-missing-metrics
spec_content_hash: 60ac6edb628acde00d674c8a23ce34f1628c7f2194651b83575238dfce83b2da
---

## Files

- `src/otel/otel-missing-metrics.ac1.test.ts` — the tests for AC-1
- `src/otel/otel-missing-metrics.ac2.test.ts` — the tests for AC-2
- `src/otel/otel-missing-metrics.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/otel/otel-missing-metrics.ac1.test.ts` | src/otel/index.ts#toOtlpMetrics(windows: AggregatedWindow | readonly AggregatedWindow[], options?: { serviceName?: string; serviceInstanceId?: string }): OtlpMetricsRequest — called with one AggregatedWindow { start 1700000000000, end 1700000001000, count 10, late 2, eventLoop { max 5000000, p99 4000000, mean 2000000 }, memory { heapUsedLast 1000, heapUsedMax 2000, rssLast 3000, rssMax 4000 }, gc { count 3, totalPause 4500000, maxPause 2000000 }, backpressure { events 5, totalStall 7000000, maxStall 3000000 } }; observed, looking metrics up by name in resourceMetrics[0].scopeMetrics[0].metrics: exactly one metric per each of the fifteen SPEC names with the SPEC's type (gauge or sum), unit and single data point asInt; every sum has aggregationTemporality 1, isMonotonic true and startTimeUnixNano "1700000000000000000"; every data point has timeUnixNano "1700000001000000000"
- AC-2 | unit | `src/otel/otel-missing-metrics.ac2.test.ts` | src/otel/index.ts#toOtlpMetrics(windows: AggregatedWindow, options?: { serviceName?: string; serviceInstanceId?: string }): OtlpMetricsRequest — called twice without serviceInstanceId and once with { serviceInstanceId: "instance-a" }; observed, looking attributes up by key in resourceMetrics[0].resource.attributes: service.name present; host.name { stringValue: os.hostname() }; process.pid { intValue: String(process.pid) }; service.instance.id stringValue equal across the two default calls and matching ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$; "instance-a" on the third call
- AC-3 | integration | `src/otel/otel-missing-metrics.ac3.integration.test.ts` | route POST / on a node:http server bound to 127.0.0.1 port 0 answering 200 and recording each body, driven by src/otel/index.ts#createOtlpMetricsExporter(options: { url: string; serviceInstanceId?: string; serviceName?: string; onError?: (error: Error) => void }): OtlpMetricsExporter — two exporters without serviceInstanceId and one with serviceInstanceId "instance-b" each export one AggregatedWindow then await flush() (closed in cleanup); a fourth createOtlpMetricsExporter({ url, serviceInstanceId: "" }) call; observed: three POST bodies whose resourceMetrics[0].resource.attributes service.instance.id stringValues are, for the first two, equal to each other and to the value src/otel/index.ts#toOtlpMetrics(window) returns without the option, and "instance-b" for the third; the fourth call throws a TypeError
