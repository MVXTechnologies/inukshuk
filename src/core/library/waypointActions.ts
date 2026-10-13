import { formatDistance, headingToCardinal, type Units } from '@core/format';
import { haversineMeters, initialBearingDeg } from '@core/geo/geomath';
import type { LatLng } from '@core/models';

/**
 * Wording and thresholds for the map's quick waypoint actions: the one-tap
 * drop (#671) and Move (#676). Pure, so the copy is unit-tested once.
 */

/** Below this a fix is good enough not to mention (owner decision on the #671 mockup). */
export const LOW_ACCURACY_M = 10;

/** The + menu row's sub-line, and the snackbar, while there is no fix yet. */
export const WAITING_FOR_FIX = 'Waiting for a GPS fix…';

/**
 * "Waypoint 7 added at your position", with "· ±24 m, low accuracy" only when
 * the fix is worse than {@link LOW_ACCURACY_M} — below that it is noise.
 */
export function waypointDropMessage(
  label: string,
  accuracyM: number | null | undefined,
  units: Units,
): string {
  const base = `${label} added at your position`;
  if (accuracyM == null || !Number.isFinite(accuracyM) || accuracyM <= LOW_ACCURACY_M) {
    return base;
  }
  return `${base} · ±${formatDistance(accuracyM, units)}, low accuracy`;
}

/** Below this a move is "not moved yet" (one GPS-grade metre). */
export const MOVE_EPSILON_M = 0.5;

export interface MoveSummary {
  meters: number;
  /** "38 m NE", or null while the pin has not moved. */
  text: string | null;
}

/** How far, and which way, the pin has moved from where it was. */
export function moveSummary(from: LatLng, to: LatLng, units: Units): MoveSummary {
  const meters = haversineMeters(from, to);
  if (!Number.isFinite(meters) || meters < MOVE_EPSILON_M) return { meters: 0, text: null };
  return {
    meters,
    text: `${formatDistance(meters, units)} ${headingToCardinal(initialBearingDeg(from, to))}`,
  };
}

/** The move bar's second line. */
export function moveBarHint(summary: MoveSummary): string {
  return summary.text === null
    ? 'Pan the map to put the pin in its new place'
    : `Moved ${summary.text} · zoom in for precision`;
}

/** The snackbar after Confirm: "Moved 38 m". */
export function movedMessage(summary: MoveSummary, units: Units): string {
  return `Moved ${formatDistance(summary.meters, units)}`;
}
