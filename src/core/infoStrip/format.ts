/**
 * Small formatting helpers shared by the fields: split a formatted quantity
 * into the value and the (smaller) unit, distances in a fixed unit, bearings
 * and durations as the strip prints them.
 */
import {
  formatClockTime,
  formatDistance,
  type DistanceUnit as AppDistanceUnit,
  type Units,
} from '@core/format';
import { formatBearing } from '@core/geo/destination';

import type { StripValue } from './types';

/** "3.42 km" → value "3.42", unit "km"; "13:53/km" and "—" stay whole. */
export function splitUnit(text: string): { value: string; unit?: string } {
  const m = /^(.*?\d\S*)\s+(\D.*)$/.exec(text);
  return m ? { value: m[1]!, unit: m[2]! } : { value: text };
}

/** A distance unit choice: the app's units, or a fixed one (nmi for paddling). */
export type DistanceUnit = 'app' | AppDistanceUnit;

/**
 * Metres in the chosen unit: "1.23 km", "840 m", "0.66 NM". A fixed unit
 * overrides the app's distance unit only; the short fallback still follows
 * the app's choices where it can (NM falls back to the elevation unit).
 */
export function formatDistanceIn(meters: number, unit: DistanceUnit, units: Units): string {
  if (unit === 'app') return formatDistance(meters, units);
  return formatDistance(meters, { distance: unit, elevation: units.elevation });
}

/**
 * A bearing as the strip prints it: "042°" + "NE" (true), "056°M" + "NE"
 * (magnetic: the marine/aviation "°M" suffix).
 */
export function bearingValue(deg: number, magnetic: boolean): Pick<StripValue, 'value' | 'unit'> {
  // `formatBearing` rounds before it wraps: 359.7° reads "000° N".
  const [value, unit] = formatBearing(deg).split(' ');
  return { value: `${value}${magnetic ? 'M' : ''}`, unit };
}

/** Seconds → "H:MM", rounded up to the minute (an ETE never promises early). */
export function formatHoursMinutes(seconds: number): string {
  const totalMin = Math.ceil(Math.max(0, seconds) / 60);
  const h = Math.floor(totalMin / 60);
  return `${h}:${String(totalMin % 60).padStart(2, '0')}`;
}

/** A signed angle with a true minus sign and one decimal: "−14.6°", "+2.1°", "0.0°". */
export function signedDegrees(deg: number): string {
  const t = Math.abs(deg).toFixed(1);
  if (Number(t) === 0) return `${t}°`;
  return `${deg < 0 ? '−' : '+'}${t}°`;
}

/** A day, ms. */
export const DAY_MS = 24 * 3_600_000;

/**
 * An arrival as the strip prints it: the clock time, and the day too once it
 * is more than 24 h away ("Thu 14:32"), so a multi-day ETA never reads as
 * today's.
 */
export function formatArrival(atMs: number, nowMs: number): string {
  const clock = formatClockTime(atMs);
  if (atMs - nowMs <= DAY_MS) return clock;
  return `${new Date(atMs).toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`;
}
