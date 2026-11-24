/** OTLP aggregation temporality enum value for delta, emitted as the JSON integer. */
export const AGGREGATION_TEMPORALITY_DELTA = 1;

/** OTLP span kind enum value for SERVER, emitted as the JSON integer. */
export const SPAN_KIND_SERVER = 2;

/** OTLP status code enum value for UNSET, emitted as the JSON integer. */
export const STATUS_CODE_UNSET = 0;

/** OTLP status code enum value for ERROR, emitted as the JSON integer. */
export const STATUS_CODE_ERROR = 2;

/** An attribute value. OTLP JSON carries 64-bit integers as decimal strings. */
export type OtlpAnyValue = { stringValue: string } | { intValue: string };

export type OtlpKeyValue = { key: string; value: OtlpAnyValue };

export type OtlpNumberDataPoint = {
  startTimeUnixNano?: string;
  timeUnixNano: string;
  asInt: string;
};

export type OtlpGauge = { dataPoints: OtlpNumberDataPoint[] };

export type OtlpSum = {
  dataPoints: OtlpNumberDataPoint[];
  aggregationTemporality: 1;
  isMonotonic: boolean;
};

export type OtlpMetric = { name: string; description: string; unit: string } & (
  { gauge: OtlpGauge } | { sum: OtlpSum }
);

export type OtlpMetricsRequest = {
  resourceMetrics: [
    {
      resource: { attributes: OtlpKeyValue[] };
      scopeMetrics: [{ scope: { name: string }; metrics: OtlpMetric[] }];
    },
  ];
};

export type OtlpStatus = {
  code: typeof STATUS_CODE_UNSET | typeof STATUS_CODE_ERROR;
  message?: string;
};

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  /** Present only for a span that continued an inbound W3C `traceparent`. */
  parentSpanId?: string;
  name: string;
  kind: typeof SPAN_KIND_SERVER;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: OtlpStatus;
};

export type OtlpTracesRequest = {
  resourceSpans: [
    {
      resource: { attributes: OtlpKeyValue[] };
      scopeSpans: [{ scope: { name: string }; spans: OtlpSpan[] }];
    },
  ];
};
