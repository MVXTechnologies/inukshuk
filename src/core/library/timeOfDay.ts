/** The part of the day a recording's auto title opens with ("Morning hike · Québec"). */
export type TimeOfDay = 'Morning' | 'Afternoon' | 'Evening' | 'Night';

/**
 * By the local hour (0–23): 5–11 Morning, 12–16 Afternoon, 17–20 Evening,
 * 21–4 Night. Night wraps past midnight: a 4 a.m. start is a night outing,
 * never an "Afternoon" one (2.5.2 QA).
 */
export function timeOfDayForHour(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 12) return 'Morning';
  if (hour >= 12 && hour < 17) return 'Afternoon';
  if (hour >= 17 && hour < 21) return 'Evening';
  return 'Night';
}

/** The local time of day at `ms` (epoch milliseconds). */
export function timeOfDay(ms: number): TimeOfDay {
  return timeOfDayForHour(new Date(ms).getHours());
}
