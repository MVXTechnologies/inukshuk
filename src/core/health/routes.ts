/**
 * Health-store route samples → our {@link TrackPoint}s, pure so the native
 * wrappers (`@lib/health`) stay thin. Inputs are typed structurally (the
 * shapes the two native libraries hand to JS), never imported from them.
 */

import type { ActivityRoute } from '@core/import/sources';
import type { TrackPoint } from '@core/models';
import {
  normalizeSegmentStarts,
  segmentStartsFromPauses,
  type PauseInterval,
} from '@core/geo/track/segments';

type TimeLike = Date | number | string;

/** Epoch ms of a Date / epoch number / ISO string; NaN when unreadable. */
export function toEpochMs(t: TimeLike | null | undefined): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  if (typeof t === 'string') return Date.parse(t);
  return Number.NaN;
}

function validLatLon(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    // (0, 0) is a GPS "no fix" placeholder, never a real trail.
    !(lat === 0 && lon === 0)
  );
}

// --- Apple Health ------------------------------------------------------------

/** A `CLLocation` as `@kingstinct/react-native-healthkit` serializes it. */
export interface AppleRouteLocation {
  latitude: number;
  longitude: number;
  altitude?: number;
  date: TimeLike;
  horizontalAccuracy?: number;
  verticalAccuracy?: number;
  speed?: number;
}

/**
 * One CLLocation → TrackPoint, or null when unusable. CoreLocation marks
 * invalid fields with negatives: `horizontalAccuracy < 0` = no position,
 * `verticalAccuracy < 0` = no altitude, `speed < 0` = no speed.
 */
export function appleLocationToPoint(loc: AppleRouteLocation): TrackPoint | null {
  const time = toEpochMs(loc.date);
  if (!Number.isFinite(time) || !validLatLon(loc.latitude, loc.longitude)) return null;
  const h = loc.horizontalAccuracy;
  if (typeof h === 'number' && h < 0) return null;
  const point: TrackPoint = { latitude: loc.latitude, longitude: loc.longitude, time };
  const v = loc.verticalAccuracy;
  const altitudeValid = typeof v !== 'number' || (Number.isFinite(v) && v >= 0);
  if (altitudeValid && typeof loc.altitude === 'number' && Number.isFinite(loc.altitude)) {
    point.altitude = loc.altitude;
    if (typeof v === 'number') point.altitudeAccuracy = v;
  }
  if (typeof h === 'number' && Number.isFinite(h)) point.accuracy = h;
  if (typeof loc.speed === 'number' && Number.isFinite(loc.speed) && loc.speed >= 0) {
    point.speed = loc.speed;
  }
  return point;
}

/** A workout event as HealthKit reports it (type: HKWorkoutEventType raw value). */
export interface AppleWorkoutEvent {
  type: number;
  startDate: TimeLike;
}

const HK_EVENT_PAUSE = 1;
const HK_EVENT_RESUME = 2;

/**
 * The user's manual pauses (pause → resume event pairs), for segment
 * boundaries. An unmatched pause (workout ended while paused) closes nothing.
 * Auto-pause (motion) events are left out: they would chop a trail at every
 * traffic light.
 */
export function appleWorkoutPauses(
  events: readonly AppleWorkoutEvent[] | undefined,
): PauseInterval[] {
  if (!events) return [];
  const sorted = events
    .map((e) => ({ type: e.type, t: toEpochMs(e.startDate) }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);
  const pauses: PauseInterval[] = [];
  let pausedAt: number | null = null;
  for (const e of sorted) {
    if (e.type === HK_EVENT_PAUSE && pausedAt === null) pausedAt = e.t;
    else if (e.type === HK_EVENT_RESUME && pausedAt !== null) {
      pauses.push({ from: pausedAt, to: e.t });
      pausedAt = null;
    }
  }
  return pauses;
}

/** A length as HealthKit reports it (`{ quantity, unit }`). */
export interface QuantityLike {
  quantity: number;
  unit: string;
}

const METRES_PER_UNIT: Readonly<Record<string, number>> = {
  m: 1,
  meter: 1,
  meters: 1,
  km: 1000,
  mi: 1609.344,
  ft: 0.3048,
  yd: 0.9144,
};

/** A HealthKit length quantity in metres; 0 when absent, unknown or invalid. */
export function quantityToMetres(q: QuantityLike | null | undefined): number {
  if (!q || typeof q.quantity !== 'number' || !Number.isFinite(q.quantity)) return 0;
  const factor = METRES_PER_UNIT[q.unit];
  return factor === undefined ? 0 : Math.max(0, q.quantity * factor);
}

// --- Stitching ---------------------------------------------------------------

/**
 * Several routes of one workout (HealthKit saves one per GPS session; a
 * paused-and-resumed or multi-sport workout has several) → one time-ordered
 * point list, a new segment at each route boundary and after each pause.
 * Empty routes are dropped; routes are ordered by their first fix.
 */
export function stitchRoutes(
  routes: readonly (readonly TrackPoint[])[],
  pauses: readonly PauseInterval[] = [],
): ActivityRoute {
  const nonEmpty = routes
    .filter((r) => r.length > 0)
    .map((r) => [...r].sort((a, b) => a.time - b.time));
  nonEmpty.sort((a, b) => (a[0]?.time ?? 0) - (b[0]?.time ?? 0));
  const points: TrackPoint[] = [];
  const starts: number[] = [];
  for (const r of nonEmpty) {
    if (points.length > 0) starts.push(points.length);
    points.push(...r);
  }
  const all = [...starts, ...segmentStartsFromPauses(points, pauses)];
  return { points, segmentStarts: normalizeSegmentStarts(all, points.length) };
}

// --- Health Connect ----------------------------------------------------------

/** What an ExerciseSession's `exerciseRoute` says about its GPS. */
export type HealthConnectRouteState = 'data' | 'no-data' | 'consent-required' | 'unknown';

/**
 * Classify an ExerciseSession's `exerciseRoute`. The native side sends the
 * strings `DATA` / `NO_DATA` / `CONSENT_REQUIRED` although the library's TS
 * enum is numeric (0 / 1 / 2), so both are accepted.
 */
export function classifyHealthConnectRoute(exerciseRoute: unknown): HealthConnectRouteState {
  if (!exerciseRoute || typeof exerciseRoute !== 'object') return 'unknown';
  const type = (exerciseRoute as { type?: unknown }).type;
  switch (type) {
    case 'DATA':
    case 0:
      return 'data';
    case 'NO_DATA':
    case 1:
      return 'no-data';
    case 'CONSENT_REQUIRED':
    case 2:
      return 'consent-required';
    default:
      return 'unknown';
  }
}

/** A route Location as `react-native-health-connect` returns it. */
export interface HealthConnectLocation {
  time: string;
  latitude: number;
  longitude: number;
  altitude?: { inMeters?: number } | null;
  horizontalAccuracy?: { inMeters?: number } | null;
  verticalAccuracy?: { inMeters?: number } | null;
}

/**
 * The library serializes an absent Length as all-zeros, so an exact 0 means
 * "not reported" (a real 0.000 m accuracy / altitude is not a thing GPS gives).
 */
function reportedMetres(len: { inMeters?: number } | null | undefined): number | undefined {
  const m = len?.inMeters;
  return typeof m === 'number' && Number.isFinite(m) && m !== 0 ? m : undefined;
}

/** One Health Connect route Location → TrackPoint, or null when unusable. */
export function healthConnectLocationToPoint(loc: HealthConnectLocation): TrackPoint | null {
  const time = toEpochMs(loc.time);
  if (!Number.isFinite(time) || !validLatLon(loc.latitude, loc.longitude)) return null;
  const point: TrackPoint = { latitude: loc.latitude, longitude: loc.longitude, time };
  const altitude = reportedMetres(loc.altitude);
  if (altitude !== undefined) {
    point.altitude = altitude;
    const va = reportedMetres(loc.verticalAccuracy);
    if (va !== undefined && va > 0) point.altitudeAccuracy = va;
  }
  const ha = reportedMetres(loc.horizontalAccuracy);
  if (ha !== undefined && ha > 0) point.accuracy = ha;
  return point;
}

/** A Health Connect route → one time-ordered segment (HC routes have no pauses). */
export function healthConnectRouteToActivityRoute(
  locations: readonly HealthConnectLocation[] | null | undefined,
): ActivityRoute {
  const points: TrackPoint[] = [];
  for (const loc of locations ?? []) {
    const p = healthConnectLocationToPoint(loc);
    if (p) points.push(p);
  }
  return stitchRoutes([points]);
}
