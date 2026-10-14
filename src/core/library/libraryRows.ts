/**
 * Text for the revamped Library rows (revamp §5, board `After-Library.html`):
 *
 * - the trail stats line, `11.2 km · 3:31 · ↑1068 m` — three stats only,
 *   compact enough never to truncate (pace and descent live in the trail view);
 * - the caption, `Aug 29 · Hike`, which names the activity type in words so
 *   the category never rests on colour alone (decision 7);
 * - the All · Trails · Maps · Waypoints · Areas type filter.
 *
 * Pure: units and "now" are arguments.
 */

import { formatDistance, formatElevation, type Units } from '@core/format';
import type { TrackStats } from '@core/models';

/** Metres → "840 m" / "11.2 km" / "142 km" (one decimal under 100), in the user's units. */
export function compactDistance(meters: number, units: Units): string {
  return formatDistance(meters, units, { style: 'tenths' });
}

/** Seconds → "3:31" (h:mm) from an hour up, "42 min" below it. */
export function compactDuration(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalMinutes = Math.round(s / 60);
  const h = Math.floor(totalMinutes / 60);
  const min = totalMinutes % 60;
  if (h === 0) return `${Math.max(1, min)} min`;
  return `${h}:${min.toString().padStart(2, '0')}`;
}

/**
 * `11.2 km · 3:31 · ↑1068 m`. Untimed trails (a planned route, a navigation
 * GPX) have no meaningful duration, so it is left out rather than shown as 0.
 */
export function trailStatsLine(
  stats: Pick<TrackStats, 'distanceM' | 'durationS' | 'ascentM'>,
  units: Units,
): string {
  return [
    compactDistance(stats.distanceM, units),
    ...(stats.durationS > 0 ? [compactDuration(stats.durationS)] : []),
    `↑${formatElevation(stats.ascentM, units)}`,
  ].join(' · ');
}

/** "Aug 29" this year, "Aug 29, 2025" otherwise (local time). */
export function shortDate(epochMs: number, nowMs: number): string {
  const d = new Date(epochMs);
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** `Aug 29 · Hike`, or just the date for an uncategorized trail. */
export function trailCaption(startedAt: number, typeName: string | null, nowMs: number): string {
  const date = shortDate(startedAt, nowMs);
  return typeName ? `${date} · ${typeName}` : date;
}

/** The Library's type chips. */
export type LibraryTypeFilter = 'all' | 'trails' | 'maps' | 'waypoints' | 'areas';

export const LIBRARY_TYPE_FILTERS: readonly { id: LibraryTypeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'trails', label: 'Trails' },
  { id: 'maps', label: 'Maps' },
  { id: 'waypoints', label: 'Waypoints' },
  { id: 'areas', label: 'Areas' },
];

/** Whether items of `kind` are listed under the `filter` chip. */
export function showsKind(filter: LibraryTypeFilter, kind: Exclude<LibraryTypeFilter, 'all'>) {
  return filter === 'all' || filter === kind;
}

/** Per-chip counts. */
export function typeCounts(counts: {
  trails: number;
  maps: number;
  waypoints: number;
  /** Drawn areas (#503); absent counts as none. */
  areas?: number;
}): Record<LibraryTypeFilter, number> {
  const areas = counts.areas ?? 0;
  return { ...counts, areas, all: counts.trails + counts.maps + counts.waypoints + areas };
}
