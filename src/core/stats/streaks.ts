import { addLocalDays, matchesCategoryFilter, startOfLocalWeek } from '@core/dashboard/aggregate';
import type { TrackSummary } from '@core/models';

/**
 * Week streaks: consecutive local weeks (Monday-start) with at least one
 * outing. The current streak is still alive during a week that has no outing
 * YET — it counts back from last week then, and only breaks once a whole week
 * passes empty.
 */
export interface WeekStreaks {
  current: number;
  best: number;
}

export function weekStreaks(startTimes: Iterable<number>, now: number): WeekStreaks {
  const weeks = new Set<number>();
  for (const t of startTimes) {
    if (Number.isFinite(t) && t <= now) weeks.add(startOfLocalWeek(t));
  }
  if (weeks.size === 0) return { current: 0, best: 0 };

  let week = startOfLocalWeek(now);
  if (!weeks.has(week)) week = addLocalDays(week, -7);
  let current = 0;
  while (weeks.has(week)) {
    current++;
    week = addLocalDays(week, -7);
  }

  let best = 0;
  let run = 0;
  let previous: number | null = null;
  for (const w of [...weeks].sort((a, b) => a - b)) {
    run = previous !== null && addLocalDays(previous, 7) === w ? run + 1 : 1;
    if (run > best) best = run;
    previous = w;
  }
  return { current, best: Math.max(best, current) };
}

/**
 * The week streaks of one activity, or of every performed activity (`null`).
 * The Logbook header flame and the Statistics card both read this, so the
 * flame always equals the Statistics "All" card.
 */
export function activityWeekStreaks(
  tracks: readonly Pick<TrackSummary, 'category' | 'plan' | 'startedAt'>[],
  activity: string | null,
  now: number,
): WeekStreaks {
  return weekStreaks(
    tracks.filter((t) => matchesCategoryFilter(t, activity)).map((t) => t.startedAt),
    now,
  );
}

/** The streak card's title: "Week streak" for All, "Run week streak" for an activity. */
export function streakTitle(activityName: string | null): string {
  return activityName === null ? 'Week streak' : `${activityName} week streak`;
}
