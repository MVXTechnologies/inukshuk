/**
 * Small formatting helpers shared by the fields: split a formatted quantity
 * into the value and the (smaller) unit, distances in a fixed unit, bearings
 * and durations as the strip prints them.
 */
import { formatDistance, type Units } from '@core/format';
import { formatBearing } from '@core/geo/destination';

import type { StripValue } from './types';

/** "3.42 km" → value "3.42", unit "km"; "13:53/km" and "—" stay whole. */
export function splitUnit(text: string): { value: string; unit?: string } {
  const m = /^(.*?\d\S*)\s+(\D.*)$/.exec(text);
  return m ? { value: m[1]!, unit: m[2]! } : { value: text };
}

/** A distance unit choice: the app's units, or a fixed one (nmi for paddling). */
export type DistanceUnit = 'app' | 'km' | 'mi' | 'nmi';

const M_PER_NMI = 1852;

/** Metres in the chosen unit: "1.23 km", "840 m", "0.66 nmi". */
export function formatDistanceIn(meters: number, unit: DistanceUnit, units: Units): string {
  switch (unit) {
    case 'app':
      return formatDistance(meters, units);
    case 'km':
      return formatDistance(meters, 'metric');
    case 'mi':
      return formatDistance(meters, 'imperial');
    case 'nmi': {
      const n = Math.max(0, meters) / M_PER_NMI;
      return `${n.toFixed(n < 10 ? 2 : 1)} nmi`;
    }
  }
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
