import type { Transform } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createAlertEvaluator } from './index.js';
import { createAlertEvaluatorState, type Alert } from './alert-evaluator.js';
import type { AlertRule } from './alert-rules.js';
import type { AggregatedWindow } from './window.js';

const WINDOW_MS = 1000;
const TEN_MINUTES = 600_000;

const lag3: AlertRule = {
  id: 'lag',
  metric: 'eventLoop.p99',
  comparison: '>',
  threshold: 100,
  forWindows: 3,
};

function makeWindow(start: number, p99: number): AggregatedWindow {
  return {
    start,
    end: start + WINDOW_MS,
    count: 1,
    late: 0,
    eventLoop: { max: p99, p99, mean: 10 },
    memory: { heapUsedLast: 100, heapUsedMax: 100, rssLast: 1000, rssMax: 1000 },
    gc: { count: 0, totalPause: 0, maxPause: 0 },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  };
}

/** Writes `[start, p99]` windows through `evaluator`, ends it, and returns `[state, windowStart]`. */
async function run(
  evaluator: Transform,
  windows: ReadonlyArray<readonly [number, number]>,
): Promise<Array<[string, number]>> {
  const collected: Alert[] = [];
  const drained = (async () => {
    for await (const alert of evaluator) {
      collected.push(alert as Alert);
    }
  })();
  for (const [start, p99] of windows) {
    evaluator.write(makeWindow(start, p99));
  }
  evaluator.end();
  await drained;
  return collected.map((alert) => [alert.state, alert.windowStart]);
}

describe('alert evaluator: N consecutive windows are adjacent windows', () => {
  it('does not fire forWindows: 3 on three breaching windows separated by gaps', async () => {
    const alerts = await run(createAlertEvaluator([lag3]), [
      [0, 500],
      [TEN_MINUTES, 500],
      [2 * TEN_MINUTES, 500],
    ]);
    expect(alerts).toEqual([]);
  });

  it('fires forWindows: 3 on three adjacent breaching windows, counting from the last gap', async () => {
    const alerts = await run(createAlertEvaluator([lag3]), [
      [0, 500],
      [1000, 500],
      [TEN_MINUTES, 500],
      [TEN_MINUTES + 1000, 500],
      [TEN_MINUTES + 2000, 500],
    ]);
    expect(alerts).toEqual([['firing', TEN_MINUTES + 2000]]);
  });

  it('treats a window that starts before the previous end (a clock step back) as a gap', async () => {
    const alerts = await run(createAlertEvaluator([lag3]), [
      [TEN_MINUTES, 500],
      [TEN_MINUTES + 1000, 500],
      [0, 500],
      [1000, 500],
      [2000, 500],
    ]);
    expect(alerts).toEqual([['firing', 2000]]);
  });

  it('keeps a firing rule firing across a gap, and resolves it when it stops breaching', async () => {
    const alerts = await run(createAlertEvaluator([lag3]), [
      [0, 500],
      [1000, 500],
      [2000, 500],
      [TEN_MINUTES, 500],
      [TEN_MINUTES + 1000, 50],
    ]);
    expect(alerts).toEqual([
      ['firing', 2000],
      ['resolved', TEN_MINUTES + 1000],
    ]);
  });

  it('a standalone evaluator behaves as before for adjacent windows', async () => {
    const alerts = await run(createAlertEvaluator([lag3]), [
      [0, 500],
      [1000, 500],
      [2000, 50],
      [3000, 500],
      [4000, 500],
      [5000, 500],
      [6000, 500],
      [7000, 50],
    ]);
    expect(alerts).toEqual([
      ['firing', 5000],
      ['resolved', 7000],
    ]);
  });
});

describe('alert evaluator: shared state', () => {
  it('carries a firing rule from one evaluator to the next without a second firing', async () => {
    const state = createAlertEvaluatorState(1);
    const first = await run(createAlertEvaluator([lag3], state), [
      [0, 500],
      [1000, 500],
      [2000, 500],
    ]);
    const second = await run(createAlertEvaluator([lag3], state), [
      [3000, 500],
      [4000, 500],
      [5000, 500],
      [6000, 50],
    ]);
    expect(first).toEqual([['firing', 2000]]);
    expect(second).toEqual([['resolved', 6000]]);
  });

  it('refuses a state made for a different number of rules', () => {
    expect(() => createAlertEvaluator([lag3], createAlertEvaluatorState(2))).toThrow(RangeError);
  });
});
