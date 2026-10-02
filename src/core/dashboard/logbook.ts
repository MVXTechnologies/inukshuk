import type { Units } from '@core/format';
import type { TrackStats, TrackSummary } from '@core/models';
import {
  addLocalDays,
  matchesCategoryFilter,
  startOfLocalWeek,
  type ActivityBucket,
} from './aggregate';

/**
 * The Logbook (revamp `After-Logbook.html`, spec §7): the "Distance per week /
 * month / year" bar chart, the hero numbers, the "Activities by type"
 * counts and the Recent list. Pure — local-time bucketing reuses
 * `aggregate.ts` (Monday weeks, DST-safe day arithmetic).
 */

export type ChartGranularity = 'week' | 'month' | 'year';

/** Bars per granularity: the board's 12 weeks; a year of months; five years. */
export const CHART_BUCKETS: Record<ChartGranularity, number> = { week: 12, month: 12, year: 5 };

/** Local midnight on the 1st of the month containing t. */
export function startOfLocalMonth(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** Local midnight on Jan 1 of the year containing t. */
export function startOfLocalYear(t: number): number {
  return new Date(new Date(t).getFullYear(), 0, 1).getTime();
}

function shift(start: number, granularity: ChartGranularity, n: number): number {
  if (granularity === 'week') return addLocalDays(start, 7 * n);
  const d = new Date(start);
  return granularity === 'month'
    ? new Date(d.getFullYear(), d.getMonth() + n, 1).getTime()
    : new Date(d.getFullYear() + n, 0, 1).getTime();
}

/**
 * The chart's bars, oldest → newest, always the full count (empty bars have
 * zero sums), ending with the bucket that contains `now`. Same filter as the
 * rest of the dashboard: `categoryId` null = every performed activity.
 */
export function distanceSeries(
  tracks: readonly TrackSummary[],
  granularity: ChartGranularity,
  now: number,
  categoryId: string | null,
): ActivityBucket[] {
  const newest =
    granularity === 'week'
      ? startOfLocalWeek(now)
      : granularity === 'month'
        ? startOfLocalMonth(now)
        : startOfLocalYear(now);
  const count = CHART_BUCKETS[granularity];
  const out: ActivityBucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const startMs = shift(newest, granularity, -i);
    out.push({
      startMs,
      endMs: shift(startMs, granularity, 1),
      distanceM: 0,
      movingTimeS: 0,
      ascentM: 0,
      trackIds: [],
    });
  }
  const sorted = tracks
    .filter((t) => matchesCategoryFilter(t, categoryId))
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const t of sorted) {
    const bucket = out.find((b) => t.startedAt >= b.startMs && t.startedAt < b.endMs);
    if (bucket === undefined) continue;
    // A hand-edited library.json can lack `stats`; it adds nothing (lifetime.ts).
    const stats: TrackStats | undefined = t.stats;
    bucket.distanceM += finite(stats?.distanceM);
    bucket.movingTimeS += finite(stats?.movingTimeS);
    bucket.ascentM += finite(stats?.ascentM);
    bucket.trackIds.push(t.id);
  }
  return out;
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

/** Metres in one display distance unit (km / mi). */
export function distanceUnitMeters(units: Units): number {
  return units === 'imperial' ? M_PER_MI : 1000;
}

/**
 * A "nice" y-axis ceiling for the bar chart, in display units: the smallest of
 * 1/2/5 × 10ⁿ steps such that two steps cover `max` (the board labels 0, 20,
 * 40 for a 36 km week). Never below 2 (a 0.3 km week still gets 0 · 1 · 2).
 */
export function niceAxisMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 2;
  const rawStep = max / 2;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  for (const m of [1, 2, 5, 10]) {
    const step = m * magnitude;
    if (step * 2 >= max) return Math.max(2, step * 2);
  }
  return Math.max(2, 20 * magnitude);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthName(d: Date): string {
  return MONTHS[d.getMonth()] ?? '';
}

/** X-axis / readout label for a bar: "Jul 7" (week), "Jul" (month), "2025" (year). */
export function bucketLabel(startMs: number, granularity: ChartGranularity): string {
  const d = new Date(startMs);
  if (granularity === 'year') return String(d.getFullYear());
  if (granularity === 'month') return monthName(d);
  return `${monthName(d)} ${d.getDate()}`;
}

/**
 * Which bars carry an x label. Four labels fit 326 dp at 12 dp type: every
 * fourth week from the oldest (board: Jul 7 · Aug 4 · Sep 1), every third
 * month, every year. The newest bar is always "Now" and is labelled by the
 * caller, so it is never in this list.
 */
export function labelledBars(count: number, granularity: ChartGranularity): number[] {
  const every = granularity === 'week' ? 4 : granularity === 'month' ? 3 : 1;
  const out: number[] = [];
  for (let i = 0; i < count - 1; i += every) out.push(i);
  return out;
}

/** One lifetime hero number, split so the unit can be set smaller. */
export interface HeroValue {
  value: string;
  unit: string;
}

function oneDecimalBelowTen(v: number): string {
  return v < 10 ? (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
}

function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Lifetime distance: "412 km", "4.2 km", "840 m". */
export function heroDistance(meters: number, units: Units): HeroValue {
  const m = finite(meters);
  if (units === 'imperial') {
    const mi = m / M_PER_MI;
    if (mi < 0.1) return { value: String(Math.round(m / M_PER_FT)), unit: 'ft' };
    return { value: mi < 10 ? oneDecimalBelowTen(mi) : grouped(Math.round(mi)), unit: 'mi' };
  }
  if (m < 1000) return { value: String(Math.round(m)), unit: 'm' };
  const km = m / 1000;
  return { value: km < 10 ? oneDecimalBelowTen(km) : grouped(Math.round(km)), unit: 'km' };
}

/** Lifetime time: "118 h", "4.5 h", "45 min". */
export function heroTime(seconds: number): HeroValue {
  const s = finite(seconds);
  if (s < 3600) return { value: String(Math.round(s / 60)), unit: 'min' };
  const h = s / 3600;
  return { value: h < 10 ? oneDecimalBelowTen(h) : grouped(Math.round(h)), unit: 'h' };
}

/** Lifetime climb: "845 m", "1,068 m", and "21.4 km" once it passes 10 km. */
export function heroClimb(meters: number, units: Units): HeroValue {
  const m = finite(meters);
  if (units === 'imperial') {
    const ft = Math.round(m / M_PER_FT);
    if (ft < 10_000) return { value: grouped(ft), unit: 'ft' };
    return { value: (Math.round(ft / 100) / 10).toFixed(1), unit: 'k ft' };
  }
  if (m < 10_000) return { value: grouped(Math.round(m)), unit: 'm' };
  return { value: (Math.round(m / 100) / 10).toFixed(1), unit: 'km' };
}

/** Activity counts per category id, for the "Activities by type" chips. */
export interface TypeCount {
  categoryId: string;
  count: number;
}

/** The board's four chips, always shown (a zero count still offers the filter). */
export const HEADLINE_TYPES = ['hike', 'run', 'ski', 'bike'] as const;

/**
 * Counts per activity type: the four headline types first (in board order,
 * zero counts included), then every other category that has activities, most
 * first. Navigation trails are plans, not activities, and are left out, as
 * are uncategorized tracks (no chip can filter to them).
 */
export function countsByType(tracks: readonly Pick<TrackSummary, 'category'>[]): TypeCount[] {
  const counts = new Map<string, number>();
  for (const t of tracks) {
    if (typeof t.category !== 'string' || t.category === '') continue;
    if (!matchesCategoryFilter(t, null)) continue;
    counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  }
  const headline: TypeCount[] = HEADLINE_TYPES.map((id) => ({
    categoryId: id,
    count: counts.get(id) ?? 0,
  }));
  const rest: TypeCount[] = [...counts.entries()]
    .filter(([id]) => !(HEADLINE_TYPES as readonly string[]).includes(id))
    .map(([categoryId, count]) => ({ categoryId, count }))
    .sort((a, b) => b.count - a.count || a.categoryId.localeCompare(b.categoryId));
  return [...headline, ...rest];
}

/** The newest `limit` activities passing the filter, newest first. */
export function recentActivities<T extends Pick<TrackSummary, 'category' | 'startedAt'>>(
  tracks: readonly T[],
  categoryId: string | null,
  limit: number,
): T[] {
  return tracks
    .filter((t) => matchesCategoryFilter(t, categoryId))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, Math.max(0, limit));
}

/**
 * The row's stats line, board style: "11.2 km · 3:31 · ↑1068 m" — one-decimal
 * distance, H:MM moving time (wall-clock when there is no moving time), and
 * the climb. An untimed track drops the time instead of showing "0:00".
 */
export function activityStatsLine(stats: TrackStats | undefined, units: Units): string {
  const distanceM = finite(stats?.distanceM);
  const seconds = finite(stats?.movingTimeS) || finite(stats?.durationS);
  const ascentM = finite(stats?.ascentM);
  const distance =
    units === 'imperial'
      ? `${(distanceM / M_PER_MI).toFixed(1)} mi`
      : `${(distanceM / 1000).toFixed(1)} km`;
  const parts = [distance];
  if (seconds > 0) {
    const totalMin = Math.round(seconds / 60);
    parts.push(`${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}`);
  }
  parts.push(
    units === 'imperial' ? `↑${Math.round(ascentM / M_PER_FT)} ft` : `↑${Math.round(ascentM)} m`,
  );
  return parts.join(' · ');
}

/** The row caption: "Aug 29 · Hike" (date only when the type is unknown). */
export function activityCaption(startedAt: number, typeName: string | null): string {
  const d = new Date(startedAt);
  const date = `${monthName(d)} ${d.getDate()}`;
  return typeName !== null ? `${date} · ${typeName}` : date;
}
