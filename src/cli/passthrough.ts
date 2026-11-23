import type { Writable } from 'node:stream';
import type { NdjsonSkip } from '../collector/index.js';
import type { LineWriter } from './report.js';

/** Bytes that may wait in the output before further lines are dropped and counted (1 MiB). */
export const MAX_PENDING_BYTES = 1_048_576;

export type Passthrough = {
  /** The decoder's `onSkipped`: writes a text or foreign JSON line and a newline; never an oversized one. */
  readonly onSkipped: (skip: NdjsonSkip) => void;
  /** Lines not written because more than MAX_PENDING_BYTES were already waiting. */
  readonly dropped: number;
};

/**
 * Copies the app's own lines to `output` (stdout), resolved on the first line. A slow reader costs
 * at most MAX_PENDING_BYTES of memory: past that, lines are dropped and counted. A write error
 * (`EPIPE` when stdout closes) stops the copy with one line through `report`; nothing else changes.
 */
export function createPassthrough(output: () => Writable, report: LineWriter): Passthrough {
  let out: Writable | undefined;
  let stopped = false;
  let dropped = 0;
  const onError = (error: NodeJS.ErrnoException): void => {
    if (!stopped) {
      stopped = true;
      report(`passthrough stopped: stdout failed (${error.code ?? error.message})`);
    }
  };
  return {
    onSkipped(skip): void {
      if (skip.reason === 'oversized' || stopped) {
        return;
      }
      if (out === undefined) {
        out = output();
        out.on('error', onError);
      }
      if (out.writableLength > MAX_PENDING_BYTES) {
        dropped = dropped === Number.MAX_SAFE_INTEGER ? dropped : dropped + 1;
        return;
      }
      out.write(`${skip.line}\n`);
    },
    get dropped(): number {
      return dropped;
    },
  };
}
