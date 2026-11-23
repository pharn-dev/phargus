import type { Alert } from '../collector/index.js';

/** A sink for the CLI's diagnostics: stderr in production, a collector array in tests. */
export type LineWriter = (text: string) => void;

export type Counts = {
  invalid: number;
  oversized: number;
  foreign: number;
  ignored: number;
  droppedEvents: number;
  passthroughDropped: number;
  droppedSamples: number;
  droppedSpans: number;
};

/** True when `PHARGUS_DEBUG` is set to anything non-empty. */
export function isDebug(env: NodeJS.ProcessEnv): boolean {
  const value = env['PHARGUS_DEBUG'];
  return value !== undefined && value !== '';
}

/** One `phargus: ...` diagnostic line on stderr. */
export function writeLine(text: string): void {
  process.stderr.write(`phargus: ${text}\n`);
}

/** The `counts:` line; integers only, names fixed so a script can parse it. */
export function formatCounts(counts: Counts): string {
  return (
    `counts: decoder.invalid=${String(counts.invalid)} decoder.oversized=${String(counts.oversized)}` +
    ` decoder.foreign=${String(counts.foreign)} collector.ignored=${String(counts.ignored)}` +
    ` dashboard.droppedEvents=${String(counts.droppedEvents)}` +
    ` passthrough.dropped=${String(counts.passthroughDropped)}` +
    ` agent.droppedSamples=${String(counts.droppedSamples)} agent.droppedSpans=${String(counts.droppedSpans)}`
  );
}

/**
 * The stderr line for one alert edge, e.g.
 * `alert firing "eventLoop.p99>50ms": eventLoop.p99 is 61000000 in the window starting 1700000001000`.
 */
export function formatAlert(alert: Alert): string {
  return (
    `alert ${alert.state} "${alert.ruleId}": ${alert.metric} is ${String(alert.observed)}` +
    ` in the window starting ${String(alert.windowStart)}`
  );
}

/** The message of an error, or its stack when debugging. Never includes a token. */
export function describeError(error: unknown, debug: boolean): string {
  if (error instanceof Error) {
    return debug && error.stack !== undefined ? error.stack : error.message;
  }
  return String(error);
}
