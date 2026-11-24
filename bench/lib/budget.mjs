// Overhead budgets: the soft check the nightly benchmark runs (see "Budget" in bench/README.md).
import { delta } from './stats.mjs';

/** Each budget caps one metric's change of `variant` versus `none` on `workload`. */
export const BUDGETS = [
  { workload: 'trivial', variant: 'full', metric: 'cpuUsPerReq', maxDelta: 0.25 },
];

/** A run is judged only when both cells vary less than this across rounds. */
export const MAX_CV = 0.1;

/**
 * Judge each budget against a run's `summary`. Over the budget is `exceeded` only when both cells
 * ran at least two rounds with a coefficient of variation under `maxCv`; otherwise it is `noisy`,
 * which never fails a run. A budget whose cells did not run (or failed) is `skipped`.
 */
export function judgeBudgets(summary, budgets = BUDGETS, maxCv = MAX_CV) {
  return budgets.map((budget) => {
    const base = summary[budget.workload]?.none?.[budget.metric];
    const entry = summary[budget.workload]?.[budget.variant]?.[budget.metric];
    const change = entry === undefined ? undefined : delta(entry.median, base?.median);
    if (change === undefined || !Number.isFinite(change)) return { ...budget, status: 'skipped' };
    const cv = Math.max(base.cv, entry.cv);
    const rounds = Math.min(base.n, entry.n);
    let status = 'within';
    if (change > budget.maxDelta) status = rounds >= 2 && cv < maxCv ? 'exceeded' : 'noisy';
    return { ...budget, delta: change, cv, rounds, status };
  });
}
