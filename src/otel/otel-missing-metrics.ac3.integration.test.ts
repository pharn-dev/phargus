import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { AggregatedWindow } from '../collector/index.js';

type KeyValue = { key: string; value: { stringValue?: string; intValue?: string } };

type MetricsRequest = {
  resourceMetrics: { resource: { attributes: KeyValue[] } }[];
};

type Exporter = {
  export(windows: AggregatedWindow | readonly AggregatedWindow[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
};

type OtelModule = {
  toOtlpMetrics: (windows: AggregatedWindow) => MetricsRequest;
  createOtlpMetricsExporter: (options: {
    url: string;
    serviceName?: string;
    serviceInstanceId?: string;
    onError?: (error: Error) => void;
  }) => Exporter;
};

type TestServer = {
  readonly url: string;
  readonly bodies: string[];
  stop(): Promise<void>;
};

async function startServer(): Promise<TestServer> {
  const bodies: string[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'POST') {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
      }
      response.statusCode = 200;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    bodies,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

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

function instanceId(request: MetricsRequest): string | undefined {
  return request.resourceMetrics[0]?.resource.attributes.find(
    (kv) => kv.key === 'service.instance.id',
  )?.value.stringValue;
}

describe('otel missing metrics — AC-3', () => {
  it('AC-3: exporters send the shared default service.instance.id or the override, and reject an empty one', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const server = await startServer();
    const errors: Error[] = [];
    const onError = (error: Error): void => {
      errors.push(error);
    };
    const exporters: Exporter[] = [];
    try {
      exporters.push(otel.createOtlpMetricsExporter({ url: server.url, onError }));
      exporters.push(otel.createOtlpMetricsExporter({ url: server.url, onError }));
      exporters.push(
        otel.createOtlpMetricsExporter({
          url: server.url,
          serviceInstanceId: 'instance-b',
          onError,
        }),
      );
      for (const exporter of exporters) {
        exporter.export(window);
        await exporter.flush();
      }

      expect(errors).toEqual([]);
      expect(server.bodies).toHaveLength(3);
      const ids = server.bodies.map((body) => instanceId(JSON.parse(body) as MetricsRequest));
      const defaultId = instanceId(otel.toOtlpMetrics(window));
      expect(defaultId).toBeTypeOf('string');
      expect(ids).toEqual([defaultId, defaultId, 'instance-b']);

      expect(() =>
        otel.createOtlpMetricsExporter({ url: server.url, serviceInstanceId: '' }),
      ).toThrow(TypeError);
    } finally {
      for (const exporter of exporters) {
        await exporter.close();
      }
      await server.stop();
    }
  });
});
