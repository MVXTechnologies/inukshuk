import type { TrackSummary } from '@core/models';

/**
 * Year in review: one value per local calendar day (distance or moving
 * time), shaded in four steps, and the year's month-by-month totals with its
 * best month.
 */

export type ReviewMetric = 'distance' | 'time';

export interface YearReview {
  year: number;
  /** One value per day of the year (index 0 = Jan 1): metres or seconds. */
  days: number[];
  /** 0 (nothing) … 4 per day, see {@link shadeLevels}. */
  levels: number[];
  /** Metres per month (Jan … Dec) — the bars are always distance. */
  monthDistanceM: number[];
  /** Index of the month with the most distance; null for an empty year. */
  bestMonth: number | null;
  /** Weekday of Jan 1, Monday = 0 … Sunday = 6 (the heatmap's first column offset). */
  firstWeekday: number;
  /** Days with at least one outing. */
  activeDays: number;
  totalDistanceM: number;
  outings: number;
}

type ReviewTrack = Pick<TrackSummary, 'startedAt' | 'stats'>;

/** Local day-of-year index (0-based) of `t` within `year`, or -1 outside it. */
export function dayOfYear(t: number, year: number): number {
  const d = new Date(t);
  if (d.getFullYear() !== year) return -1;
  const midnight = new Date(year, d.getMonth(), d.getDate()).getTime();
  // Whole local days since Jan 1; rounding absorbs a DST hour.
  return Math.round((midnight - new Date(year, 0, 1).getTime()) / 86_400_000);
}

export function daysInYear(year: number): number {
  return dayOfYear(new Date(year, 11, 31).getTime(), year) + 1;
}

/**
 * Four shades over the days that have something: by quartile of the non-zero
 * values, so a year of short runs still spans the scale. 0 stays 0.
 */
export function shadeLevels(values: readonly number[]): number[] {
  const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return values.map(() => 0);
  const q = (f: number) => nonZero[Math.min(nonZero.length - 1, Math.floor(f * nonZero.length))]!;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  return values.map((v) => {
    if (!(v > 0)) return 0;
    if (v < cuts[0]!) return 1;
    if (v < cuts[1]!) return 2;
    if (v < cuts[2]!) return 3;
    return 4;
  });
}

function finite(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** The review of `year` over already-filtered trails. */
export function yearReview(
  tracks: readonly ReviewTrack[],
  year: number,
  metric: ReviewMetric,
): YearReview {
  const days = new Array<number>(daysInYear(year)).fill(0);
  const touched = new Array<boolean>(days.length).fill(false);
  const monthDistanceM = new Array<number>(12).fill(0);
  let outings = 0;
  let totalDistanceM = 0;
  for (const t of tracks) {
    const i = dayOfYear(t.startedAt, year);
    if (i < 0) continue;
    const distance = finite(t.stats?.distanceM);
    days[i]! += metric === 'distance' ? distance : finite(t.stats?.movingTimeS);
    touched[i] = true;
    monthDistanceM[new Date(t.startedAt).getMonth()]! += distance;
    totalDistanceM += distance;
    outings++;
  }
  let bestMonth: number | null = null;
  monthDistanceM.forEach((m, i) => {
    if (m > 0 && (bestMonth === null || m > monthDistanceM[bestMonth]!)) bestMonth = i;
  });
  // A day with an outing but a zero value (an untimed trail on Time) still shows.
  const levels = shadeLevels(days).map((l, i) => (l === 0 && touched[i] ? 1 : l));
  return {
    year,
    days,
    levels,
    monthDistanceM,
    bestMonth,
    firstWeekday: (new Date(year, 0, 1).getDay() + 6) % 7,
    activeDays: touched.filter(Boolean).length,
    totalDistanceM,
    outings,
  };
}

/** Years the selector offers: every year with an outing, plus the current one, newest first. */
export function reviewYears(
  tracks: readonly Pick<TrackSummary, 'startedAt'>[],
  now: number,
): number[] {
  const years = new Set<number>([new Date(now).getFullYear()]);
  for (const t of tracks) {
    if (t.startedAt <= now && Number.isFinite(t.startedAt)) {
      years.add(new Date(t.startedAt).getFullYear());
    }
  }
  return [...years].sort((a, b) => b - a);
}

/**
 * The year heatmap as a horizontally scrollable strip: `visibleWeeks` week
 * columns fill the card, the rest scroll. It opens on the most recent weeks —
 * today's week for the current year, December otherwise.
 */
export interface HeatmapStrip {
  /** Week columns the year spans (53 or 54). */
  columns: number;
  /** Side of one day cell. */
  cell: number;
  /** Width of the whole strip. */
  contentWidth: number;
  /** Scroll offset that puts the focus week at the right edge. */
  offsetX: number;
}

export function heatmapStrip(opts: {
  year: number;
  firstWeekday: number;
  dayCount: number;
  now: number;
  width: number;
  gap: number;
  visibleWeeks?: number;
}): HeatmapStrip {
  const { year, firstWeekday, dayCount, now, width, gap } = opts;
  const columns = Math.ceil((firstWeekday + dayCount) / 7);
  if (!(opts.width > 0)) return { columns, cell: 0, contentWidth: 0, offsetX: 0 };
  const visible = Math.min(columns, opts.visibleWeeks ?? 26);
  const cell = Math.max(0, (width - (visible - 1) * gap) / visible);
  const contentWidth = columns * cell + (columns - 1) * gap;
  const today = new Date(now);
  let focus = columns - 1;
  if (today.getFullYear() === year) {
    focus = Math.floor((firstWeekday + dayOfYear(now, year)) / 7);
  }
  const right = (focus + 1) * cell + focus * gap;
  const offsetX = Math.max(0, Math.min(contentWidth - width, right - width));
  return { columns, cell, contentWidth, offsetX };
}
