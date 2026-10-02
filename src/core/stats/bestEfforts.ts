/**
 * Best efforts (Logbook statistics, personal records): the fastest continuous
 * stretch of a track covering a target amount of something that only grows
 * along it — horizontal distance ("fastest 5 km") or climbed metres ("fastest
 * 500 m of ascent").
 *
 * One O(n) two-pointer pass per target over the cumulative series: for each
 * end point the start pointer only ever moves forward, so the whole track is
 * walked twice at most. The start is interpolated inside its step, so a 5 km
 * effort is timed over exactly 5 km, not over whatever the fixes happen to
 * span.
 */

/**
 * Cumulative series along a track: `cum[k]` is the amount (metres of
 * distance or of ascent) covered from the start of the chain to point k,
 * `timeS[k]` the fix time in seconds. Both non-decreasing within a chain.
 */
export interface CumulativeSeries {
  cum: ArrayLike<number>;
  timeS: ArrayLike<number>;
  /** Indices where a new chain starts (a GPS jump, a time reversal). Never 0. */
  breaks?: readonly number[];
}

/**
 * The shortest time, in seconds, to cover each target along `series` without
 * crossing a break; null where no chain is long enough. Targets ≤ 0 are null.
 */
export function bestEffortTimes(
  series: CumulativeSeries,
  targets: readonly number[],
): (number | null)[] {
  const { cum, timeS } = series;
  const n = Math.min(cum.length, timeS.length);
  const bounds = [0, ...(series.breaks ?? []).filter((b) => b > 0 && b < n), n];
  return targets.map((target) => {
    if (!(target > 0)) return null;
    let best = Number.POSITIVE_INFINITY;
    for (let c = 0; c + 1 < bounds.length; c++) {
      const from = bounds[c]!;
      const to = bounds[c + 1]!;
      const t = bestInChain(cum, timeS, from, to, target);
      if (t < best) best = t;
    }
    return Number.isFinite(best) ? best : null;
  });
}

function bestInChain(
  cum: ArrayLike<number>,
  timeS: ArrayLike<number>,
  from: number,
  to: number,
  target: number,
): number {
  let best = Number.POSITIVE_INFINITY;
  let i = from;
  for (let j = from + 1; j < to; j++) {
    const end = cum[j]!;
    // Advance the start while the stretch from the NEXT point still covers it.
    while (i + 1 < j && end - cum[i + 1]! >= target) i++;
    if (end - cum[i]! < target) continue;
    // The exact start lies inside step i → i+1: interpolate its time.
    const startPos = end - target;
    const a = cum[i]!;
    const b = cum[i + 1]!;
    const frac = b > a ? (startPos - a) / (b - a) : 0;
    const t0 = timeS[i]! + frac * (timeS[i + 1]! - timeS[i]!);
    const dt = timeS[j]! - t0;
    if (dt > 0 && dt < best) best = dt;
  }
  return best;
}
