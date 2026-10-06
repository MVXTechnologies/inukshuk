import { haversineMeters } from '@core/geo/geomath';
import type { LngLat } from '@core/models';

import {
  estimateClockOffset,
  type ClockEstimate,
  type ClockOptions,
  type ClockSample,
} from './clock';
import type { PhotoPlacement, TakenAtSource } from './model';
import {
  passesNear,
  positionAtDistance,
  positionAtTime,
  timeAtDistance,
  type TimeLookupOptions,
  type TrackIndex,
  type TrailPass,
  type TrailPosition,
} from './trackIndex';

/**
 * Where a photo goes on a trail (#587). Time first: interpolating the
 * recording at the minute the photo was taken is exact to a few metres, and is
 * the ONLY way to tell the way up from the way down on an out-and-back. The
 * photo's own GPS is the fallback (no time in the file, or a planned route
 * with no timestamps) and the input to the camera-clock check.
 */

/** What placement knows about one photo. */
export interface PhotoFix {
  /** EXIF time resolved to an instant, before any clock correction. */
  takenAt?: number;
  takenAtSource?: TakenAtSource;
  lngLat?: LngLat;
}

export type OutsideReason =
  /** Its time is outside the recording (another day, before the start, after the end). */
  | 'time'
  /** Its GPS position is too far from the trail. */
  | 'far'
  /** Neither a usable time nor a position. */
  | 'no-data';

export type PlacementResult =
  | {
      kind: 'time';
      position: TrailPosition;
      /** The corrected time used for the lookup. */
      takenAt: number;
      /** Distance from the photo's own GPS to the placed position, if it has GPS. */
      gpsOffM?: number;
    }
  | { kind: 'gps'; position: TrailPosition; offTrackM: number }
  | { kind: 'outside'; reason: OutsideReason; offTrackM?: number };

export interface PlacementOptions extends TimeLookupOptions {
  /** Correction added to the EXIF time (see `./clock`). */
  clockOffsetMs?: number;
  /** A GPS fix farther than this from the trail is not on it (m). */
  maxGpsM?: number;
  /**
   * Passes within this many metres of the closest one are equally plausible;
   * the earliest along the trail (or the closest in time) wins (m).
   */
  passToleranceM?: number;
}

export const DEFAULT_MAX_GPS_M = 200;
const DEFAULT_PASS_TOLERANCE_M = 15;

const toLatLng = (p: LngLat) => ({ latitude: p[1], longitude: p[0] });

/**
 * Pick among several passes of the trail near a GPS fix (an out-and-back
 * passes every spot twice). Passes about as close as the closest are ties:
 * with a time hint the pass the recording reached closest to that time wins,
 * otherwise the first one along the trail.
 */
export function choosePass(
  index: TrackIndex,
  passes: readonly TrailPass[],
  timeHint: number | undefined,
  toleranceM = DEFAULT_PASS_TOLERANCE_M,
): TrailPass | undefined {
  if (passes.length === 0) return undefined;
  const closest = Math.min(...passes.map((p) => p.offTrackM));
  const tied = passes.filter((p) => p.offTrackM <= closest + toleranceM);
  if (tied.length === 1 || timeHint === undefined) return tied[0];
  let best = tied[0]!;
  let bestDt = Infinity;
  for (const pass of tied) {
    const t = timeAtDistance(index, pass.distanceM);
    const dt = t === undefined ? Infinity : Math.abs(t - timeHint);
    if (dt < bestDt) {
      bestDt = dt;
      best = pass;
    }
  }
  return best;
}

/** Place one photo on a trail. */
export function placePhoto(
  index: TrackIndex,
  fix: PhotoFix,
  {
    clockOffsetMs = 0,
    maxGpsM = DEFAULT_MAX_GPS_M,
    passToleranceM,
    ...timeOpts
  }: PlacementOptions = {},
): PlacementResult {
  const timedTrail = index.startMs !== undefined;
  if (fix.takenAt !== undefined && timedTrail) {
    const takenAt = fix.takenAt + clockOffsetMs;
    const position = positionAtTime(index, takenAt, timeOpts);
    if (!position) return { kind: 'outside', reason: 'time' };
    const result: PlacementResult = { kind: 'time', position, takenAt };
    if (fix.lngLat)
      result.gpsOffM = haversineMeters(toLatLng(fix.lngLat), toLatLng(position.lngLat));
    return result;
  }
  if (fix.lngLat) return placeByGps(index, fix.lngLat, fix.takenAt, maxGpsM, passToleranceM);
  return { kind: 'outside', reason: 'no-data' };
}

function placeByGps(
  index: TrackIndex,
  lngLat: LngLat,
  timeHint: number | undefined,
  maxGpsM: number,
  passToleranceM: number | undefined,
): PlacementResult {
  const pass = choosePass(index, passesNear(index, lngLat, maxGpsM), timeHint, passToleranceM);
  if (!pass) return { kind: 'outside', reason: 'far' };
  const { offTrackM, ...position } = pass;
  return { kind: 'gps', position, offTrackM };
}

/**
 * Where a photo the user ticked anyway goes: its GPS pass if it has one (at
 * any distance), else `fallbackDistanceM` (the profile cursor, or the start).
 */
export function placeForced(
  index: TrackIndex,
  fix: PhotoFix,
  fallbackDistanceM = 0,
): { placement: PhotoPlacement; position: TrailPosition } | null {
  if (fix.lngLat) {
    const pass = choosePass(index, passesNear(index, fix.lngLat, Infinity), fix.takenAt);
    if (pass) {
      const { offTrackM: _off, ...position } = pass;
      return { placement: 'gps', position };
    }
  }
  const position = positionAtDistance(index, fallbackDistanceM);
  return position ? { placement: 'manual', position } : null;
}

/** One picked photo going through the Add-photos sheet. */
export interface ImportCandidate extends PhotoFix {
  /** The caller's id for it (picker asset id, or an index). */
  key: string;
  /** The camera that took it (EXIF Make + Model), when known: its clock is checked on its own. */
  camera?: string;
}

export interface PlannedPhoto {
  candidate: ImportCandidate;
  result: PlacementResult;
  /** The clock correction this photo was placed with (its camera's, else the batch's). */
  clockOffsetMs: number;
}

/** The Add-photos sheet's three groups plus the clock check. */
export interface ImportPlan {
  /** The whole batch's clock (or the user's Adjust value). */
  clock: ClockEstimate;
  /**
   * Each named camera's own estimate (empty with a manual Adjust). A camera
   * whose estimate is `unknown` (too few photos with time AND GPS) uses
   * {@link clock}, as do photos with no Make/Model.
   */
  cameraClocks: Map<string, ClockEstimate>;
  /** "On the trail, by time" — checked by default. */
  byTime: PlannedPhoto[];
  /** "By location only" — checked by default. */
  byGps: PlannedPhoto[];
  /** "Not from this outing" — unchecked by default. */
  outside: PlannedPhoto[];
}

export interface ImportPlanOptions extends PlacementOptions {
  /** A clock offset the user set with Adjust: skips the estimate. */
  manualClockOffsetMs?: number;
  clock?: ClockOptions;
}

const clockSamples = (candidates: readonly ImportCandidate[]): ClockSample[] =>
  candidates.flatMap((c) =>
    c.takenAt !== undefined && c.lngLat ? [{ takenAt: c.takenAt, lngLat: c.lngLat }] : [],
  );

/**
 * Plan an import: check the camera clocks on the photos that have both time
 * and GPS, then place every photo with its correction and sort it into the
 * sheet's groups. Each group is in trail order (distance), outsiders by time.
 *
 * Clocks are checked per camera (EXIF Make + Model): a phone and a DSLR in
 * one batch rarely agree. A camera with too few usable photos for its own
 * estimate, and photos with no Make/Model, use the whole batch's estimate.
 * Two bodies of the same model share one estimate (EXIF has no portable
 * serial the picker exposes).
 */
export function planPhotoImport(
  index: TrackIndex,
  candidates: readonly ImportCandidate[],
  { manualClockOffsetMs, clock: clockOpts, ...placementOpts }: ImportPlanOptions = {},
): ImportPlan {
  const samples = clockSamples(candidates);
  const clock: ClockEstimate =
    manualClockOffsetMs !== undefined
      ? {
          status: manualClockOffsetMs === 0 ? 'ok' : 'corrected',
          offsetMs: manualClockOffsetMs,
          samples: samples.length,
        }
      : estimateClockOffset(index, samples, clockOpts);
  const cameraClocks = new Map<string, ClockEstimate>();
  if (manualClockOffsetMs === undefined) {
    const byCamera = new Map<string, ImportCandidate[]>();
    for (const c of candidates) {
      if (c.camera === undefined) continue;
      const group = byCamera.get(c.camera);
      if (group) group.push(c);
      else byCamera.set(c.camera, [c]);
    }
    for (const [camera, group] of byCamera) {
      cameraClocks.set(camera, estimateClockOffset(index, clockSamples(group), clockOpts));
    }
  }
  const offsetFor = (c: ImportCandidate): number => {
    const own = c.camera === undefined ? undefined : cameraClocks.get(c.camera);
    return own && own.status !== 'unknown' ? own.offsetMs : clock.offsetMs;
  };
  const plan: ImportPlan = { clock, cameraClocks, byTime: [], byGps: [], outside: [] };
  for (const candidate of candidates) {
    const clockOffsetMs = offsetFor(candidate);
    const result = placePhoto(index, candidate, { ...placementOpts, clockOffsetMs });
    const planned = { candidate, result, clockOffsetMs };
    if (result.kind === 'time') plan.byTime.push(planned);
    else if (result.kind === 'gps') plan.byGps.push(planned);
    else plan.outside.push(planned);
  }
  const byDistance = (a: PlannedPhoto, b: PlannedPhoto) =>
    distanceOf(a.result) - distanceOf(b.result) || a.candidate.key.localeCompare(b.candidate.key);
  plan.byTime.sort(byDistance);
  plan.byGps.sort(byDistance);
  plan.outside.sort(
    (a, b) =>
      (a.candidate.takenAt ?? Infinity) - (b.candidate.takenAt ?? Infinity) ||
      a.candidate.key.localeCompare(b.candidate.key),
  );
  return plan;
}

function distanceOf(result: PlacementResult): number {
  return result.kind === 'outside' ? Infinity : result.position.distanceM;
}
