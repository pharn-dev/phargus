import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Alert } from './alert-evaluator.js';
import type { AlertSink } from './alert-sink.js';
import { createCollector } from './collector.js';
import { createStdoutSink } from './stdout-sink.js';

function makeAlert(observed: number, state: Alert['state'] = 'firing'): Alert {
  return {
    ruleId: 'loop-max',
    metric: 'eventLoop.max',
    comparison: '>',
    threshold: 100,
    observed,
    windowStart: 1000,
    windowEnd: 2000,
    state,
  };
}

/** A full AgentSample-shaped object at the given timestamp with the given event-loop max. */
function makeSample(timestamp: number, eventLoopMax: number): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: eventLoopMax, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 100, heapTotal: 200, rss: 1000, external: 0, arrayBuffers: 0 },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  };
}

/** Rejects if `promise` has not settled within `ms`, so a hang fails fast instead of timing out. */
function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A small-buffer destination that completes each write on a later tick, so `write()` returns false. */
function slowStream(): { stream: Writable; chunks: string[]; writeResults: boolean[] } {
  const chunks: string[] = [];
  const writeResults: boolean[] = [];
  const stream = new Writable({
    highWaterMark: 64,
    write(chunk: Buffer | string, _encoding, callback): void {
      setImmediate(() => {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        callback();
      });
    },
  });
  const write = stream.write.bind(stream) as (
    chunk: string,
    cb?: (e?: Error | null) => void,
  ) => boolean;
  stream.write = ((chunk: string, cb?: (error?: Error | null) => void): boolean => {
    const result = write(chunk, cb);
    writeResults.push(result);
    return result;
  }) as Writable['write'];
  return { stream, chunks, writeResults };
}

describe('stdout alert sink', () => {
  it('keeps delivering, in order, when the destination reports backpressure', async () => {
    const { stream, chunks, writeResults } = slowStream();
    const errors: Error[] = [];
    const sink = createStdoutSink({ stream, onError: (error) => errors.push(error) });

    const sends = [makeAlert(500), makeAlert(600), makeAlert(50, 'resolved')].map((alert) =>
      sink.send(alert),
    );
    await within(Promise.all(sends));

    expect(writeResults).toEqual([false, false, false]);
    expect(chunks.map((chunk) => (JSON.parse(chunk) as Alert).observed)).toEqual([500, 600, 50]);
    expect(chunks.every((chunk) => chunk.endsWith('\n'))).toBe(true);

    await within(sink.close());
    expect(sink.failed).toBe(0);
    expect(sink.dropped).toBe(0);
    expect(errors).toEqual([]);
    expect(stream.writableEnded).toBe(false);
    expect(stream.destroyed).toBe(false);
  });

  it('lets collector.close() and consume() resolve with a backed-up stdout sink', async () => {
    const { stream, chunks } = slowStream();
    const collector = createCollector({
      windowMs: 1000,
      capacity: 10,
      alerts: [{ id: 'loop-max', metric: 'eventLoop.max', comparison: '>', threshold: 100 }],
      sinks: [createStdoutSink({ stream })],
    });
    const source = Readable.from([
      makeSample(100, 50),
      makeSample(1100, 500),
      makeSample(2100, 50),
      makeSample(3100, 500),
      makeSample(4100, 50),
    ]);

    await within(collector.consume(source));
    await within(collector.close());

    expect(chunks.map((chunk) => (JSON.parse(chunk) as Alert).state)).toEqual([
      'firing',
      'resolved',
      'firing',
      'resolved',
    ]);
    const [sink] = collector.sinks as [AlertSink];
    expect(sink.failed).toBe(0);
    expect(stream.writableEnded).toBe(false);
    expect(stream.destroyed).toBe(false);
  });

  it('counts a failed write once and reports it through onError', async () => {
    const stream = new Writable({
      highWaterMark: 64,
      write(_chunk, _encoding, callback): void {
        setImmediate(() => callback(new Error('disk full')));
      },
    });
    // The stream's owner handles its 'error' event; the sink reports through onError.
    const streamErrors: Error[] = [];
    stream.on('error', (error) => streamErrors.push(error));
    const errors: Error[] = [];
    const sink = createStdoutSink({ stream, name: 'out', onError: (error) => errors.push(error) });

    await within(sink.send(makeAlert(500)));
    await within(sink.close());

    expect(sink.failed).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('stdout sink "out": write failed: disk full');
    expect((errors[0]?.cause as Error).message).toBe('disk full');
    expect(streamErrors.map((error) => error.message)).toEqual(['disk full']);
  });
});
