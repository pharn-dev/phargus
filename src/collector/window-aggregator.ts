import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import type { AgentSample } from '../agent/index.js';
import {
  addSample,
  closeWindow,
  openWindow,
  windowStartOf,
  type WindowAccumulator,
} from './window.js';

export type WindowAggregatorOptions = { windowMs: number };

/**
 * A sample more than this many windows older than the open window is a clock reset (an NTP step,
 * a VM resume), not a late sample: the open window is emitted and a new one starts at its time.
 */
export const MAX_LATE_WINDOWS = 60;

/** Object-mode Transform: AgentSample in, AggregatedWindow out, one window per aligned interval. */
export function createWindowAggregator(options: WindowAggregatorOptions): Transform {
  const { windowMs } = options;
  let open: WindowAccumulator | undefined;

  return new Transform({
    objectMode: true,
    transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
      try {
        const sample = chunk as AgentSample;
        const start = windowStartOf(sample.timestamp, windowMs);
        if (open === undefined) {
          open = openWindow(start);
        } else if (start < open.start && open.start - start <= MAX_LATE_WINDOWS * windowMs) {
          // Late: a closed window is never re-opened.
          open.late += 1;
          callback();
          return;
        } else if (start !== open.start) {
          // A later window, or a clock step back of more than MAX_LATE_WINDOWS windows.
          this.push(closeWindow(open, windowMs));
          open = openWindow(start);
        }
        addSample(open, sample);
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
    flush(callback: TransformCallback): void {
      try {
        if (open !== undefined) {
          this.push(closeWindow(open, windowMs));
          open = undefined;
        }
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}
