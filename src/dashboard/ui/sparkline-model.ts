export interface Sparkline {
  /** One SVG `points` value per series, in the order given. */
  readonly points: readonly string[];
  /** The largest value across every series (0 when there are none). */
  readonly max: number;
}

/**
 * Lays series out as sparkline polylines in a `slots` by `height` box: one x unit per value,
 * right-aligned so the newest value sits at x = slots - 1, and y scaled to the max across all
 * series (0 at the bottom). Pure and DOM-free.
 *
 * The dashboard client embeds this function through `Function.prototype.toString()`, so it must stay
 * self-contained: nothing refers to a module-level binding, and the body holds no backtick and no
 * dollar-brace sequence.
 */
export function buildSparkline(
  series: readonly (readonly number[])[],
  slots: number,
  height: number,
): Sparkline {
  let max = 0;
  for (const values of series) {
    for (const value of values) {
      max = Math.max(max, value);
    }
  }
  const points = series.map((values) => {
    const offset = slots - values.length;
    return values
      .map((value, i) => {
        const y = max > 0 ? height - Math.round((value * height) / max) : height;
        return offset + i + ',' + y;
      })
      .join(' ');
  });
  return { points, max };
}
