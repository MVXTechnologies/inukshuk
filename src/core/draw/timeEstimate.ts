/**
 * Moving-time estimate for a drawn route (#502), Naismith-style: a flat pace
 * plus a time cost per 100 m of climb. Hiking is Naismith's own rule as the
 * owner put it — about 4.5 km/h and 10 minutes per 100 m up. The other
 * activities scale the same two terms; a route with no (or an unknown)
 * category is estimated as a hike.
 *
 * An estimate, labelled as one in the UI: it ignores descent, terrain and
 * breaks, which is exactly why Naismith's rule has lasted.
 */

export interface PaceProfile {
  /** Pace on the flat, km/h. */
  flatKmh: number;
  /** Extra minutes per 100 m of ascent. */
  climbMinPer100m: number;
}

const HIKE: PaceProfile = { flatKmh: 4.5, climbMinPer100m: 10 };

/** Per built-in category id (see `@core/library/categories`). */
export const PACE_BY_CATEGORY: Readonly<Record<string, PaceProfile>> = {
  hike: HIKE,
  walk: { flatKmh: 4.5, climbMinPer100m: 10 },
  snowshoe: { flatKmh: 3, climbMinPer100m: 12 },
  ski: { flatKmh: 6, climbMinPer100m: 10 },
  'trail-run': { flatKmh: 8, climbMinPer100m: 6 },
  run: { flatKmh: 10, climbMinPer100m: 5 },
  bike: { flatKmh: 16, climbMinPer100m: 6 },
};

/** The pace for a category; hiking for none, navigation, other and custom ones. */
export function paceProfileFor(categoryId: string | null | undefined): PaceProfile {
  return (categoryId ? PACE_BY_CATEGORY[categoryId] : undefined) ?? HIKE;
}

/** Estimated moving time in seconds (0 for an empty route). */
export function estimateDurationS(
  distanceM: number,
  ascentM: number,
  categoryId?: string | null,
): number {
  const { flatKmh, climbMinPer100m } = paceProfileFor(categoryId);
  const d = Number.isFinite(distanceM) && distanceM > 0 ? distanceM : 0;
  const up = Number.isFinite(ascentM) && ascentM > 0 ? ascentM : 0;
  const flatS = (d / 1000 / flatKmh) * 3600;
  const climbS = (up / 100) * climbMinPer100m * 60;
  return Math.round(flatS + climbS);
}

/** "2 h 40" / "45 min" — the mockup's compact estimate (rounded to 5 min past an hour). */
export function formatEstimate(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${Math.max(minutes, s > 0 ? 1 : 0)} min`;
  const rounded = Math.round(minutes / 5) * 5;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `${h} h` : `${h} h ${m.toString().padStart(2, '0')}`;
}
