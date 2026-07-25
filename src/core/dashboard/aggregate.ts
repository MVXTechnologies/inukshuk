import type { TrackSummary } from '@core/models';

/**
 * Dashboard aggregation — pure bucketing of the library's track summaries for
 * the profile view's period graph and month calendar. All bucketing uses
 * DEVICE-LOCAL time via local Date methods (never fixed 86.4M-ms arithmetic),
 * so buckets stay aligned to local midnight across DST transitions. Weeks
 * start Monday. A track belongs to the local day/week of its `startedAt`;
 * re-bucketing after a timezone change is accepted behavior.
 */

export type DashboardPeriod = '7d' | '3m' | '1y';

/** One graph point: a local day (7d) or a Monday-start local week (3m/1y). */
export interface ActivityBucket {
  /** Local midnight (day) or local Monday-midnight (week), epoch ms. */
  startMs: number;
  /** Exclusive end, epoch ms (next local midnight / next Monday-midnight). */
  endMs: number;
  distanceM: number;
  /** Sum of stats.movingTimeS; 0 when only untimed tracks fall in the bucket. */
  movingTimeS: number;
  /** Sum of stats.ascentM (D+). */
  ascentM: number;
  /** Contributing tracks, newest first. */
  trackIds: string[];
}

/** A calendar-month day that has at least one activity. */
export interface CalendarDayEntry {
  /** 1-based day of month. */
  day: number;
  /** Chronological by startedAt; category is the raw id (may be dangling). */
  tracks: { id: string; category?: string }[];
}

/** Local midnight of the day containing t, epoch ms. */
export function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local Monday-midnight of the week containing t, epoch ms. */
export function startOfLocalWeek(t: number): number {
  const d = new Date(startOfLocalDay(t));
  // getDay(): 0 = Sunday … 6 = Saturday. Monday-start → Sunday rolls back 6.
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** t shifted by whole local days (DST-safe, via Date#setDate). */
export function addLocalDays(t: number, days: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * Performed = anything except category 'navigation': untimed imported routes
 * are plans, not activities — their `startedAt` is the import time and would
 * fabricate training volume. Uncategorized counts as performed.
 */
export function isPerformedActivity(track: Pick<TrackSummary, 'category'>): boolean {
  return track.category !== 'navigation';
}

/**
 * Whether a track passes the dashboard category filter.
 * null = all performed activities ({@link isPerformedActivity});
 * 'navigation' = exactly the navigation trails;
 * any other id = strict equality with track.category.
 */
export function matchesCategoryFilter(
  track: Pick<TrackSummary, 'category'>,
  categoryId: string | null,
): boolean {
  if (categoryId === null) return isPerformedActivity(track);
  return track.category === categoryId;
}

/** Bucket count and granularity per period. */
const PERIOD_SHAPE: Record<DashboardPeriod, { buckets: number; weekly: boolean }> = {
  '7d': { buckets: 7, weekly: false },
  '3m': { buckets: 13, weekly: true },
  '1y': { buckets: 52, weekly: true },
};

/**
 * The graph's buckets, oldest → newest, ALWAYS the full fixed count (empty
 * buckets have zero sums and empty trackIds): '7d' → 7 daily buckets ending
 * with the local day containing `now`; '3m' → 13 weekly buckets ending with
 * the current week; '1y' → 52 weekly buckets ending with the current week.
 */
export function aggregateBuckets(
  tracks: readonly TrackSummary[],
  period: DashboardPeriod,
  now: number,
  categoryId: string | null,
): ActivityBucket[] {
  const { buckets: count, weekly } = PERIOD_SHAPE[period];
  const step = weekly ? 7 : 1;
  const newestStart = weekly ? startOfLocalWeek(now) : startOfLocalDay(now);

  const out: ActivityBucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const startMs = addLocalDays(newestStart, -i * step);
    out.push({
      startMs,
      endMs: addLocalDays(startMs, step),
      distanceM: 0,
      movingTimeS: 0,
      ascentM: 0,
      trackIds: [],
    });
  }

  const windowStart = out[0]!.startMs;
  const windowEnd = out[out.length - 1]!.endMs;
  // Newest-first so each bucket's trackIds comes out newest-first.
  const sorted = tracks
    .filter(
      (t) =>
        matchesCategoryFilter(t, categoryId) &&
        t.startedAt >= windowStart &&
        t.startedAt < windowEnd,
    )
    .sort((a, b) => b.startedAt - a.startedAt);

  for (const t of sorted) {
    // Buckets are contiguous and sorted; binary search is overkill at this scale.
    const bucket = out.find((b) => t.startedAt >= b.startMs && t.startedAt < b.endMs);
    if (!bucket) continue;
    bucket.distanceM += t.stats.distanceM;
    bucket.movingTimeS += t.stats.movingTimeS;
    bucket.ascentM += t.stats.ascentM;
    bucket.trackIds.push(t.id);
  }
  return out;
}

/**
 * Per-day activity index for one local calendar month (month is 0-based),
 * filtered like {@link aggregateBuckets}. Only days with ≥1 match are
 * returned, ascending by day; each day's tracks are chronological.
 */
export function calendarIndex(
  tracks: readonly TrackSummary[],
  year: number,
  month: number,
  categoryId: string | null,
): CalendarDayEntry[] {
  const byDay = new Map<number, { id: string; category?: string; startedAt: number }[]>();
  for (const t of tracks) {
    if (!matchesCategoryFilter(t, categoryId)) continue;
    const d = new Date(t.startedAt);
    if (d.getFullYear() !== year || d.getMonth() !== month) continue;
    const day = d.getDate();
    const list = byDay.get(day);
    const entry = {
      id: t.id,
      startedAt: t.startedAt,
      ...(t.category !== undefined ? { category: t.category } : {}),
    };
    if (list) list.push(entry);
    else byDay.set(day, [entry]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, list]) => ({
      day,
      tracks: list
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(({ id, category }) => (category !== undefined ? { id, category } : { id })),
    }));
}
