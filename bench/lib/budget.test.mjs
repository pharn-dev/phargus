import { describe, expect, it } from 'vitest';
import { BUDGETS, judgeBudgets, MAX_CV } from './budget.mjs';

const BUDGET = { workload: 'trivial', variant: 'full', metric: 'cpuUsPerReq', maxDelta: 0.25 };

function metric(median, cv, n = 3) {
  return { median, min: median, max: median, cv, n };
}

function summary(base, full) {
  return { trivial: { none: { cpuUsPerReq: base }, full: { cpuUsPerReq: full } } };
}

describe('judgeBudgets', () => {
  it('records the trivial full-versus-none CPU budget at +25% with a 10% CV limit', () => {
    expect(BUDGETS).toEqual([BUDGET]);
    expect(MAX_CV).toBe(0.1);
  });

  it('passes a delta within the budget', () => {
    const [result] = judgeBudgets(summary(metric(10, 0.02), metric(12, 0.02)), [BUDGET]);
    expect(result).toMatchObject({ status: 'within', cv: 0.02, rounds: 3 });
    expect(result.delta).toBeCloseTo(0.2);
  });

  it('fails a delta over the budget when both cells vary less than the CV limit', () => {
    const [result] = judgeBudgets(summary(metric(10, 0.05), metric(13, 0.09)), [BUDGET]);
    expect(result).toMatchObject({ status: 'exceeded', cv: 0.09 });
    expect(result.delta).toBeCloseTo(0.3);
  });

  it('does not fail a delta over the budget when either cell is noisy', () => {
    const noisyBase = judgeBudgets(summary(metric(10, 0.1), metric(13, 0.01)), [BUDGET]);
    const noisyFull = judgeBudgets(summary(metric(10, 0.01), metric(13, 0.3)), [BUDGET]);
    expect(noisyBase[0].status).toBe('noisy');
    expect(noisyFull[0].status).toBe('noisy');
  });

  it('does not fail a single round, whose CV says nothing about variance', () => {
    const [result] = judgeBudgets(summary(metric(10, 0, 1), metric(20, 0, 1)), [BUDGET]);
    expect(result).toMatchObject({ status: 'noisy', rounds: 1 });
  });

  it('skips a budget whose cells did not run or have no usable baseline', () => {
    expect(judgeBudgets({}, [BUDGET])[0].status).toBe('skipped');
    expect(judgeBudgets({ trivial: { none: {} } }, [BUDGET])[0].status).toBe('skipped');
    expect(judgeBudgets(summary(metric(0, 0), metric(5, 0)), [BUDGET])[0].status).toBe('skipped');
  });
});
