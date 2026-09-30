import type { Units } from '@core/format';

import type { LongTrail, TrailActivity, TrailCountry, TrailNetworkLevel } from './schema';

/**
 * Labels and meta lines for the long-distance trails (#467) — the strings of
 * boards `Main/List/Detail/OnMap.dc.html`.
 */

export const TRAIL_ACTIVITY_LABELS: Record<TrailActivity, string> = {
  hiking: 'Hiking',
  cycling: 'Cycling',
  skiing: 'Skiing',
  paddling: 'Paddling',
};

/** MaterialCommunityIcons glyph per activity. */
export const TRAIL_ACTIVITY_ICONS: Record<TrailActivity, string> = {
  hiking: 'hiking',
  cycling: 'bike',
  skiing: 'ski-cross-country',
  paddling: 'kayaking',
};

export const TRAIL_NETWORK_LABELS: Record<TrailNetworkLevel, string> = {
  i: 'International route',
  n: 'National route',
  r: 'Regional route',
  o: 'Local route',
};

const KM_PER_MI = 1.609344;

/** Narrow no-break space grouping, as Explore's counts and scales ("1 600"). */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
}

/** "≈50 km", "≈1 600 km", "≈31 mi" — lengths are OSM-derived, so always approximate. */
export function formatTrailLength(km: number, units: Units): string {
  const value = units === 'imperial' ? km / KM_PER_MI : km;
  const unit = units === 'imperial' ? 'mi' : 'km';
  if (!Number.isFinite(value) || value <= 0) return `— ${unit}`;
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `≈${grouped(rounded)} ${unit}`;
}

/** "≈1 850 m" / "≈6 070 ft" of climb. */
export function formatClimb(meters: number, units: Units): string {
  const value = units === 'imperial' ? meters / 0.3048 : meters;
  return `≈${grouped(Math.round(value / 10) * 10)} ${units === 'imperial' ? 'ft' : 'm'}`;
}

export function activitiesLabel(activities: readonly TrailActivity[]): string {
  return activities.map((a) => TRAIL_ACTIVITY_LABELS[a]).join(' · ');
}

/** "France, Italy, Switzerland" from the index's country table. */
export function countriesLabel(
  codes: readonly string[],
  countries: Record<string, TrailCountry>,
): string | null {
  const names = codes
    .map((c) => countries[c]?.name)
    .filter((n): n is string => n !== undefined && n !== '');
  return names.length > 0 ? names.join(', ') : null;
}

/** Where the trail is, in a few words: "Georgia → Maine", "Vermont", "France, Italy". */
export function trailPlaceLabel(
  trail: LongTrail,
  countries: Record<string, TrailCountry>,
): string | null {
  if (trail.from !== undefined && trail.to !== undefined && trail.from !== trail.to) {
    return `${trail.from} → ${trail.to}`;
  }
  if (trail.countries.length > 1) return countriesLabel(trail.countries, countries);
  return trail.region ?? countriesLabel(trail.countries, countries);
}

/** Carousel card: "Hiking · ≈50 km · 4 stages". */
export function trailCardMeta(trail: LongTrail, units: Units): string {
  return [
    activitiesLabel(trail.activities),
    formatTrailLength(trail.lengthKm, units),
    trail.stageCount > 0 ? stagesLabel(trail.stageCount) : null,
  ]
    .filter((p): p is string => p !== null && p !== '')
    .join(' · ');
}

/** List row: "Hiking · Georgia → Maine · ≈3 500 km". */
export function trailListMeta(
  trail: LongTrail,
  countries: Record<string, TrailCountry>,
  units: Units,
): string {
  return [
    activitiesLabel(trail.activities),
    trailPlaceLabel(trail, countries),
    formatTrailLength(trail.lengthKm, units),
  ]
    .filter((p): p is string => p !== null && p !== '')
    .join(' · ');
}

export function stagesLabel(n: number): string {
  return `${n} ${n === 1 ? 'stage' : 'stages'}`;
}
