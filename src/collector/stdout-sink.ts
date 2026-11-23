import type { Writable } from 'node:stream';
import type { Alert } from './alert-evaluator.js';
import {
  reportSinkError,
  sinkLabel,
  toError,
  type AlertSink,
  type SinkErrorHandler,
} from './alert-sink.js';

export type StdoutSinkOptions = {
  stream?: Writable;
  name?: string;
  onError?: SinkErrorHandler;
};

/** Writes each alert as one NDJSON line, in send order. Never ends or destroys the stream. */
export function createStdoutSink(options: StdoutSinkOptions = {}): AlertSink {
  const stream = options.stream ?? process.stdout;
  const { name, onError } = options;
  let failed = 0;
  let dropped = 0;
  let closed = false;
  let tail: Promise<void> = Promise.resolve();

  const sink: AlertSink = {
    type: 'stdout',
    name,
    get failed(): number {
      return failed;
    },
    get dropped(): number {
      return dropped;
    },
    send(alert: Alert): Promise<void> {
      if (closed) {
        dropped += 1;
        return Promise.resolve();
      }
      tail = tail.then(() => writeLine(alert));
      return tail;
    },
    async close(): Promise<void> {
      closed = true;
      await tail;
    },
  };

  async function writeLine(alert: Alert): Promise<void> {
    try {
      if (stream.destroyed) {
        throw new Error('stream is destroyed');
      }
      const line = `${JSON.stringify(alert)}\n`;
      // Node emits `drain` before it runs the write callback, so the callback is the backpressure
      // signal; it also receives the write error.
      await new Promise<void>((resolve, reject) => {
        stream.write(line, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    } catch (error) {
      failed += 1;
      const cause = toError(error);
      reportSinkError(
        onError,
        new Error(`${sinkLabel('stdout', name)}: write failed: ${cause.message}`, { cause }),
        sink,
      );
    }
  }

  return sink;
}
