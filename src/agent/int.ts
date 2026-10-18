/**
 * Round to the nearest integer (`Math.round`), then clamp to 0..Number.MAX_SAFE_INTEGER.
 * NaN, negatives and -Infinity give 0; +Infinity gives Number.MAX_SAFE_INTEGER.
 */
export function roundToNonNegativeInt(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  const rounded = Math.round(value);
  if (rounded <= 0) {
    return 0;
  }
  return rounded > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : rounded;
}

/**
 * Truncate toward zero (`Math.trunc`), then clamp to 0..Number.MAX_SAFE_INTEGER.
 * NaN, negatives and -Infinity give 0; +Infinity gives Number.MAX_SAFE_INTEGER.
 */
export function truncToNonNegativeInt(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  const truncated = Math.trunc(value);
  if (truncated <= 0) {
    return 0;
  }
  return truncated > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : truncated;
}
