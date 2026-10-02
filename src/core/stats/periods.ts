import { addLocalDays, matchesCategoryFilter, startOfLocalWeek } from '@core/dashboard/aggregate';
import { startOfLocalMonth, startOfLocalYear } from '@core/dashboard/logbook';
import { BUILT_IN_CATEGORIES } from '@core/library/categories';
import type { TrackSummary } from '@core/models';

/**
 * Logbook › Statistics: totals per period, the comparison line, the period's
 * bar chart and the average card — pure aggregation over the library index
 * (no point lists). Local time throughout; weeks start Monday (the shared
 * `@core/dashboard/aggregate` helpers, DST-safe).
 */

export type StatsPeriod = 'week' | 'month' | 'year' | 'all';

/** A half-open time window, epoch ms. */
export interface TimeWindow {
  startMs: number;
  endMs: number;
}

export interface PeriodTotals {
  distanceM: number;
  movingTimeS: number;
  ascentM: number;
  count: number;
}

type StatsTrack = Pick<TrackSummary, 'id' | 'startedAt' | 'category' | 'plan' | 'stats'>;

function finite(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** The trails a Statistics view counts: performed, and of the chosen activity (null: all). */
export function statsTracks<T extends StatsTrack>(
  tracks: readonly T[],
  activity: string | null,
): T[] {
  return tracks.filter((t) => matchesCategoryFilter(t, activity));
}

/** Activity chip order: the board's Run · Hike · Bike · Ski, then the other built-ins, then customs. */
const CHIP_ORDER = ['run', 'hike', 'bike', 'ski'];

/**
 * The activity chips to offer after "All": only categories the user has
 * performed activities in, in the board's order. Navigation trails and
 * uncategorized trails never get a chip (uncategorized still counts in All).
 */
export function activityChips(tracks: readonly StatsTrack[]): string[] {
  const have = new Set<string>();
  for (const t of tracks) {
    if (t.category !== undefined && t.category !== 'navigation' && t.plan === undefined) {
      have.add(t.category);
    }
  }
  const builtIn = [
    ...CHIP_ORDER,
    ...BUILT_IN_CATEGORIES.map((c) => c.id).filter((id) => !CHIP_ORDER.includes(id)),
  ];
  const ordered = builtIn.filter((id) => have.has(id));
  const custom = [...have].filter((id) => !builtIn.includes(id)).sort();
  return [...ordered, ...custom];
}

/** Sum of the trails starting inside `window`. */
export function totalsIn(tracks: readonly StatsTrack[], window: TimeWindow): PeriodTotals {
  const out: PeriodTotals = { distanceM: 0, movingTimeS: 0, ascentM: 0, count: 0 };
  for (const t of tracks) {
    if (t.startedAt < window.startMs || t.startedAt >= window.endMs) continue;
    // A hand-edited library.json can lack `stats`; it then adds only its count.
    const stats: TrackSummary['stats'] | undefined = t.stats;
    out.distanceM += finite(stats?.distanceM);
    out.movingTimeS += finite(stats?.movingTimeS);
    out.ascentM += finite(stats?.ascentM);
    out.count += 1;
  }
  return out;
}

/** The current period, from its start up to and including `now`. */
export function periodWindow(period: StatsPeriod, now: number): TimeWindow {
  const endMs = now + 1;
  switch (period) {
    case 'week':
      return { startMs: startOfLocalWeek(now), endMs };
    case 'month':
      return { startMs: startOfLocalMonth(now), endMs };
    case 'year':
      return { startMs: startOfLocalYear(now), endMs };
    case 'all':
      return { startMs: Number.NEGATIVE_INFINITY, endMs };
  }
}

/** `t` moved by whole local months, clamping the day (Mar 31 − 1 month = Feb 28/29). */
export function addLocalMonths(t: number, months: number): number {
  const d = new Date(t);
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(
    target.getFullYear(),
    target.getMonth(),
    Math.min(d.getDate(), lastDay),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  ).getTime();
}

export interface Comparison {
  /** The same stretch of the previous period (its start up to the same point in it). */
  window: TimeWindow;
  /** "vs last week", "vs same date last month", "vs same date last year". */
  label: string;
}

/** What the current period is compared with; null for All time. */
export function comparisonWindow(period: StatsPeriod, now: number): Comparison | null {
  const current = periodWindow(period, now);
  switch (period) {
    case 'week':
      return {
        window: { startMs: addLocalDays(current.startMs, -7), endMs: addLocalDays(now, -7) + 1 },
        label: 'vs last week',
      };
    case 'month':
      return {
        window: {
          startMs: addLocalMonths(current.startMs, -1),
          endMs: addLocalMonths(now, -1) + 1,
        },
        label: 'vs same date last month',
      };
    case 'year':
      return {
        window: {
          startMs: addLocalMonths(current.startMs, -12),
          endMs: addLocalMonths(now, -12) + 1,
        },
        label: 'vs same date last year',
      };
    case 'all':
      return null;
  }
}

/**
 * The comparison line under the totals, on distance: "+22 % vs same date
 * last year", "Same as last week", or — with nothing to compare against —
 * "Nothing logged by this date last year". Null for All time.
 */
export function comparisonLine(
  tracks: readonly StatsTrack[],
  period: StatsPeriod,
  now: number,
): { text: string; delta: number | null } | null {
  const cmp = comparisonWindow(period, now);
  if (cmp === null) return null;
  const current = totalsIn(tracks, periodWindow(period, now)).distanceM;
  const previous = totalsIn(tracks, cmp.window).distanceM;
  if (previous <= 0) {
    const when =
      period === 'week'
        ? 'by this point last week'
        : period === 'month'
          ? 'by this date last month'
          : 'by this date last year';
    return { text: `Nothing logged ${when}`, delta: null };
  }
  const delta = (current - previous) / previous;
  const pct = Math.round(delta * 100);
  if (pct === 0) return { text: `Same distance ${cmp.label}`, delta: 0 };
  // U+2212 minus: the same glyph width as "+" in tabular figures.
  const sign = pct > 0 ? '+' : '−';
  return { text: `${sign}${Math.abs(pct)} % ${cmp.label}`, delta };
}

/** One bar of the Statistics chart. */
export interface StatsBar extends PeriodTotals, TimeWindow {
  /** Short axis label: "M", "Sep 1", "J", "2025". */
  label: string;
  /** The bar that holds `now` (drawn darker). */
  current: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** Most year bars All time shows (the newest ones). */
export const MAX_YEAR_BARS = 10;

/**
 * The chart under the totals, oldest → newest: this week day by day (Mon–Sun),
 * the last 12 weeks for Month, this year month by month (Jan–Dec) for Year,
 * and year by year (from the first activity, at most {@link MAX_YEAR_BARS})
 * for All time.
 */
export function periodBars(
  tracks: readonly StatsTrack[],
  period: StatsPeriod,
  now: number,
): StatsBar[] {
  const windows: (TimeWindow & { label: string })[] = [];
  if (period === 'week') {
    const monday = startOfLocalWeek(now);
    for (let i = 0; i < 7; i++) {
      const startMs = addLocalDays(monday, i);
      windows.push({ startMs, endMs: addLocalDays(startMs, 1), label: WEEKDAYS[i]! });
    }
  } else if (period === 'month') {
    const newest = startOfLocalWeek(now);
    for (let i = 11; i >= 0; i--) {
      const startMs = addLocalDays(newest, -7 * i);
      const d = new Date(startMs);
      windows.push({
        startMs,
        endMs: addLocalDays(startMs, 7),
        label: `${MONTHS[d.getMonth()]} ${d.getDate()}`,
      });
    }
  } else if (period === 'year') {
    const year = new Date(now).getFullYear();
    for (let m = 0; m < 12; m++) {
      windows.push({
        startMs: new Date(year, m, 1).getTime(),
        endMs: new Date(year, m + 1, 1).getTime(),
        label: MONTHS[m]!.charAt(0),
      });
    }
  } else {
    const thisYear = new Date(now).getFullYear();
    const first = tracks.reduce(
      (min, t) => (t.startedAt <= now ? Math.min(min, new Date(t.startedAt).getFullYear()) : min),
      thisYear,
    );
    for (let y = Math.max(first, thisYear - MAX_YEAR_BARS + 1); y <= thisYear; y++) {
      windows.push({
        startMs: new Date(y, 0, 1).getTime(),
        endMs: new Date(y + 1, 0, 1).getTime(),
        label: String(y),
      });
    }
  }
  const bars: StatsBar[] = windows.map((w) => ({
    ...w,
    distanceM: 0,
    movingTimeS: 0,
    ascentM: 0,
    count: 0,
    current: now >= w.startMs && now < w.endMs,
  }));
  for (const t of tracks) {
    const bar = findBar(bars, t.startedAt);
    if (bar === undefined) continue;
    const stats: TrackSummary['stats'] | undefined = t.stats;
    bar.distanceM += finite(stats?.distanceM);
    bar.movingTimeS += finite(stats?.movingTimeS);
    bar.ascentM += finite(stats?.ascentM);
    bar.count += 1;
  }
  return bars;
}

/** Binary search over contiguous, sorted bars. */
function findBar(bars: StatsBar[], t: number): StatsBar | undefined {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = bars[mid]!;
    if (t < b.startMs) hi = mid - 1;
    else if (t >= b.endMs) lo = mid + 1;
    else return b;
  }
  return undefined;
}

/** Which average the small card shows for an activity. */
export type AverageKind = 'pace' | 'speed' | 'climb' | 'distance';

const PACE = new Set(['run', 'trail-run', 'walk']);
const SPEED = new Set(['bike', 'ski']);
const CLIMB = new Set(['hike', 'snowshoe']);

/**
 * Pace for running and walking, speed for bike and ski, climb per outing for
 * hiking and snowshoeing; distance per outing for All and for activities
 * that have no natural one (a pace over runs and rides mixed means nothing).
 */
export function averageKind(activity: string | null): AverageKind {
  if (activity === null) return 'distance';
  if (PACE.has(activity)) return 'pace';
  if (SPEED.has(activity)) return 'speed';
  if (CLIMB.has(activity)) return 'climb';
  return 'distance';
}

/**
 * The average for {@link averageKind}: m/s for pace and speed (moving
 * distance ÷ moving time), metres per outing for climb and distance; null
 * when there is nothing to average.
 */
export function averageValue(totals: PeriodTotals, kind: AverageKind): number | null {
  if (totals.count === 0) return null;
  switch (kind) {
    case 'pace':
    case 'speed':
      return totals.movingTimeS > 0 && totals.distanceM > 0
        ? totals.distanceM / totals.movingTimeS
        : null;
    case 'climb':
      return totals.ascentM / totals.count;
    case 'distance':
      return totals.distanceM / totals.count;
  }
}
