import { formatDistance, headingToCardinal, type Units } from '@core/format';
import type { LatLng } from '@core/models';
import { haversineMeters, initialBearingDeg } from './geomath';

/**
 * The dropped-pin destination readout: how far away it is and which way to
 * walk. Deliberately NOT routing — no legs, no turns, no ETA, no snapping to a
 * trail (that is issue #95). Straight-line distance and the initial
 * great-circle bearing are the two numbers a compass and a paper map can
 * actually use, and they degrade gracefully: they stay meaningful when the
 * trail network is unmapped, which is most of where this app is used.
 */
export interface DestinationReadout {
  /** Great-circle distance in metres. */
  distanceM: number;
  /** Initial bearing, degrees clockwise from true north. */
  bearingDeg: number;
  /** Distance in the user's units, e.g. "1.23 km" / "840 ft". */
  distance: string;
  /** Bearing as a zero-padded compass reading + cardinal, e.g. "042° NE". */
  bearing: string;
}

/** Zero-padded whole degrees + the 8-point cardinal, e.g. `042° NE`. */
export function formatBearing(deg: number): string {
  if (!Number.isFinite(deg)) return '—';
  // Round first, then wrap: 359.7° must read 000° N, never 360° N.
  const whole = Math.round(((deg % 360) + 360) % 360) % 360;
  return `${String(whole).padStart(3, '0')}° ${headingToCardinal(whole)}`;
}

/**
 * Distance and bearing from the current position to the destination pin,
 * pre-formatted for the chip. Returns `null` when either point is unusable —
 * the caller then simply shows nothing rather than a confident wrong arrow.
 */
export function destinationReadout(
  from: LatLng | null | undefined,
  to: LatLng | null | undefined,
  units: Units,
): DestinationReadout | null {
  if (!isUsable(from) || !isUsable(to)) return null;
  const distanceM = haversineMeters(from, to);
  const bearingDeg = initialBearingDeg(from, to);
  if (!Number.isFinite(distanceM)) return null;
  return {
    distanceM,
    bearingDeg,
    distance: formatDistance(distanceM, units),
    bearing: formatBearing(bearingDeg),
  };
}

function isUsable(p: LatLng | null | undefined): p is LatLng {
  return (
    p != null &&
    Number.isFinite(p.latitude) &&
    Number.isFinite(p.longitude) &&
    Math.abs(p.latitude) <= 90 &&
    Math.abs(p.longitude) <= 180
  );
}
