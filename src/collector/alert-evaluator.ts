import { Transform } from 'node:stream';
import {
  readAlertMetric,
  validateAlertRules,
  type AlertComparison,
  type AlertMetric,
  type AlertRule,
  type ResolvedAlertRule,
} from './alert-rules.js';
import type { AggregatedWindow } from './window.js';

export type AlertState = 'firing' | 'resolved';

export type Alert = {
  ruleId: string;
  metric: AlertMetric;
  comparison: AlertComparison;
  threshold: number;
  observed: number;
  windowStart: number;
  windowEnd: number;
  state: AlertState;
};

/** Each rule's state, plus the end of the last window seen (to tell adjacent windows from a gap). */
export type AlertEvaluatorState = {
  readonly rules: Array<{ consecutive: number; firing: boolean }>;
  previousEnd: number | undefined;
};

/** Fresh state for `ruleCount` rules. Hand one to several evaluators to carry state across them. */
export function createAlertEvaluatorState(ruleCount: number): AlertEvaluatorState {
  return {
    rules: Array.from({ length: ruleCount }, () => ({ consecutive: 0, firing: false })),
    previousEnd: undefined,
  };
}

/**
 * Object-mode Transform: AggregatedWindow in, edge-triggered Alert out, in rule order.
 * "N consecutive windows" means adjacent ones: a window whose `start` is not the previous window's
 * `end` (a gap, or a start before it) resets every rule's count. A firing rule stays firing.
 * `sharedState` (optional) carries that state across evaluators, such as one per `consume()`.
 */
export function createAlertEvaluator(
  rules: readonly AlertRule[],
  sharedState?: AlertEvaluatorState,
): Transform {
  const resolved = validateAlertRules(rules);
  return evaluateAlerts(resolved, sharedState ?? createAlertEvaluatorState(resolved.length));
}

/** `createAlertEvaluator` over rules `validateAlertRules` already resolved. */
export function evaluateAlerts(
  resolved: readonly ResolvedAlertRule[],
  evaluatorState: AlertEvaluatorState,
): Transform {
  const states = evaluatorState.rules;
  if (states.length !== resolved.length) {
    throw new RangeError(
      `alert evaluator state holds ${states.length} rules, but ${resolved.length} were given`,
    );
  }

  return new Transform({
    objectMode: true,
    transform(window: AggregatedWindow, _encoding, callback): void {
      try {
        const out: Alert[] = [];
        const { previousEnd } = evaluatorState;
        const adjacent = previousEnd === undefined || window.start === previousEnd;
        evaluatorState.previousEnd = window.end;
        resolved.forEach((rule, i) => {
          const state = states[i] as { consecutive: number; firing: boolean };
          if (!adjacent) {
            state.consecutive = 0;
          }
          const observed = readAlertMetric(window, rule.metric);
          if (!Number.isSafeInteger(observed) || observed < 0) {
            throw new TypeError(
              `alert rule "${rule.id}": metric ${rule.metric} is not a non-negative safe integer`,
            );
          }
          const breach =
            rule.comparison === '>' ? observed > rule.threshold : observed >= rule.threshold;
          const alert = (alertState: AlertState): Alert => ({
            ruleId: rule.id,
            metric: rule.metric,
            comparison: rule.comparison,
            threshold: rule.threshold,
            observed,
            windowStart: window.start,
            windowEnd: window.end,
            state: alertState,
          });
          if (breach) {
            if (!state.firing) {
              state.consecutive = Math.min(state.consecutive + 1, rule.forWindows);
              if (state.consecutive === rule.forWindows) {
                state.firing = true;
                out.push(alert('firing'));
              }
            }
          } else {
            state.consecutive = 0;
            if (state.firing) {
              state.firing = false;
              out.push(alert('resolved'));
            }
          }
        });
        for (const alert of out) {
          this.push(alert);
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}
