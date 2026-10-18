import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { OtlpKeyValue } from './otlp-types.js';

/**
 * The default `service.instance.id`: one random UUID per loaded module, so every `toOtlpMetrics`
 * call and every metrics exporter in a process report the same instance. An ESM and a CJS copy of
 * the module loaded side by side each hold their own value.
 */
export const DEFAULT_SERVICE_INSTANCE_ID: string = randomUUID();

/** Throws a TypeError when `value` is present and is not a non-empty string. */
export function requireServiceInstanceId(value: unknown): void {
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    throw new TypeError('serviceInstanceId must be a non-empty string');
  }
}

/**
 * The OTel semantic-convention resource attributes that identify the emitter. `host.name` and
 * `process.pid` are read on every call.
 */
export function otlpResourceAttributes(options: {
  serviceName: string;
  serviceInstanceId: string;
}): OtlpKeyValue[] {
  return [
    { key: 'service.name', value: { stringValue: options.serviceName } },
    { key: 'service.instance.id', value: { stringValue: options.serviceInstanceId } },
    { key: 'host.name', value: { stringValue: hostname() } },
    { key: 'process.pid', value: { intValue: String(process.pid) } },
  ];
}
