import { describe, expect, it } from 'vitest';

const MAX = Number.MAX_SAFE_INTEGER;

type IntHelper = (value: number) => number;

// `toBe` compares with Object.is, so an expected 0 also rejects -0: the shared helpers return
// positive zero (SPEC Assumptions).
function expectCases(
  helper: IntHelper,
  name: string,
  cases: ReadonlyArray<[number, number]>,
): void {
  for (const [input, expected] of cases) {
    expect.soft(helper(input), `${name}(${String(input)})`).toBe(expected);
  }
}

const SHARED_CASES: ReadonlyArray<[number, number]> = [
  // NaN, negatives, negative fractions and -Infinity → 0
  [Number.NaN, 0],
  [-1, 0],
  [-42, 0],
  [-MAX, 0],
  [Number.NEGATIVE_INFINITY, 0],
  [-0, 0],
  [-0.4, 0],
  [-0.5, 0],
  [-0.9, 0],
  [-2.5, 0],
  [-2.7, 0],
  // in-range integers unchanged
  [0, 0],
  [1, 1],
  [7, 7],
  [1_000_000, 1_000_000],
  [MAX - 1, MAX - 1],
  [MAX, MAX],
  // above the safe range and +Infinity → MAX_SAFE_INTEGER
  [MAX + 2, MAX],
  [2 ** 60, MAX],
  [1e300, MAX],
  [Number.MAX_VALUE, MAX],
  [Number.POSITIVE_INFINITY, MAX],
];

describe('shared integer helpers — AC-1', () => {
  it('AC-1: roundToNonNegativeInt clamps to 0..MAX_SAFE_INTEGER and rounds non-negative fractions with Math.round', async () => {
    const { roundToNonNegativeInt } = await import('./int.js');
    expect(typeof roundToNonNegativeInt).toBe('function');

    expectCases(roundToNonNegativeInt, 'roundToNonNegativeInt', [
      ...SHARED_CASES,
      // Math.round of a non-negative fraction
      [2.4, 2],
      [2.5, 3],
      [0.5, 1],
      [0.4, 0],
      [0.6, 1],
      [2.9, 3],
      [10.49, 10],
      [10.5, 11],
    ]);
  });
});

describe('shared integer helpers — AC-2', () => {
  it('AC-2: truncToNonNegativeInt clamps to 0..MAX_SAFE_INTEGER and truncates non-negative fractions with Math.trunc', async () => {
    const { truncToNonNegativeInt } = await import('./int.js');
    expect(typeof truncToNonNegativeInt).toBe('function');

    expectCases(truncToNonNegativeInt, 'truncToNonNegativeInt', [
      ...SHARED_CASES,
      // Math.trunc of a non-negative fraction
      [2.9, 2],
      [2.5, 2],
      [0.5, 0],
      [0.4, 0],
      [0.9, 0],
      [2.4, 2],
      [10.99, 10],
      [10.5, 10],
    ]);
  });
});
