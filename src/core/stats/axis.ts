/**
 * A y-axis that hugs the data: the smallest "nice" maximum at or above the
 * tallest bar, with evenly spaced ticks from 0. The shared `niceAxisMax`
 * (`@core/dashboard/logbook`) always halves a 1/2/5 ceiling, which can leave
 * a 45 km month under a 100 km axis; this one also considers thirds and
 * quarters and a finer step ladder: about 9 % headroom on average, and
 * never more than 25 % (round numbers only: 62 km sits under 75).
 */
export interface TightAxis {
  /** The axis maximum (the top tick). */
  max: number;
  /** Ascending tick values, 0 first and `max` last: 3 to 5 of them. */
  ticks: number[];
}

/** Step mantissas, multiplied by a power of ten. */
const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
/** Interval counts in order of preference when two scales share a maximum. */
const INTERVALS = [3, 4, 2];

/** A tick must print cleanly: whole numbers, or 0.1 / 0.2 / 0.5 steps below 1. */
function printable(step: number, mantissa: number): boolean {
  if (step < 1) return mantissa === 1 || mantissa === 2 || mantissa === 5 || mantissa === 10;
  return Math.abs(step - Math.round(step)) < 1e-9;
}

export function tightAxis(dataMax: number): TightAxis {
  if (!Number.isFinite(dataMax) || dataMax <= 0) return { max: 2, ticks: [0, 1, 2] };
  let best: { max: number; step: number; n: number } | null = null;
  for (const n of INTERVALS) {
    const need = dataMax / n;
    const magnitude = 10 ** Math.floor(Math.log10(need));
    for (const m of [...STEPS, 10]) {
      const step = Number((m * magnitude).toPrecision(6));
      if (step * n < dataMax - 1e-9 || !printable(step, m)) continue;
      const max = Number((step * n).toPrecision(6));
      // Strictly smaller wins; on a tie the earlier (preferred) count stays.
      if (best === null || max < best.max - 1e-9) best = { max, step, n };
      break;
    }
  }
  if (best === null) return { max: 2, ticks: [0, 1, 2] };
  const { step, n } = best;
  return {
    max: best.max,
    ticks: Array.from({ length: n + 1 }, (_, k) => Number((step * k).toPrecision(6))),
  };
}
