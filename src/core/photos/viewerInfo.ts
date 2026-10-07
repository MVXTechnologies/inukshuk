import type { Formatters } from '@core/format';

import { mapAlongPoints } from './axis';
import type { PhotoPlacement, TrackPhoto } from './model';

/**
 * The photo viewer's info sheet (#587, mockup 03): where and when on the
 * outing a photo was taken. Everything is measured on the trail view's axis
 * (pauses not bridged, #325), so "3.20 km of 9.02 km" matches the charts.
 */

/** The trail, per point, as the viewer measures it. */
export interface ViewerTrail {
  /** Cumulative distance per point on the trail view's axis (metres). */
  axisCumM: ArrayLike<number>;
  /** Elevation per point, when recorded. */
  elevations: readonly (number | undefined)[];
  /** The axis length (the trail's distance). */
  totalM: number;
  /** The recording's first timed fix (epoch ms), if it is a timed recording. */
  startMs?: number;
}

export type TrailDirection = 'up' | 'down';

export interface PhotoFacts {
  /** Metres along the axis. */
  distanceM: number;
  elevationM?: number;
  /** Climb from the start to the photo (hysteresis, like the trail's D+). */
  climbedM?: number;
  /** Going up or down there (null: about level, or no elevation). */
  direction: TrailDirection | null;
  /** Time since the recording started, ms (only for a photo taken during it). */
  sinceStartMs?: number;
}

/** The elevation at an axis distance, interpolated (undefined without altitude). */
export function elevationAt(trail: ViewerTrail, distanceM: number): number | undefined {
  const { axisCumM: cum, elevations } = trail;
  const n = Math.min(cum.length, elevations.length);
  if (n === 0) return undefined;
  let i = 0;
  while (i < n - 1 && cum[i + 1]! <= distanceM) i++;
  const a = elevations[i];
  const j = Math.min(i + 1, n - 1);
  const b = elevations[j];
  if (a === undefined) return b;
  if (b === undefined || j === i) return a;
  const span = cum[j]! - cum[i]!;
  const t = span > 0 ? Math.min(1, Math.max(0, (distanceM - cum[i]!) / span)) : 0;
  return a + (b - a) * t;
}

/**
 * Climb from the start up to `distanceM`, with the same idea as the trail's
 * D+: a rise only counts once it beats `thresholdM` over the last reference,
 * so GPS altitude noise on the flat adds nothing.
 */
export function climbedUpTo(trail: ViewerTrail, distanceM: number, thresholdM = 3): number {
  const { axisCumM: cum, elevations } = trail;
  const n = Math.min(cum.length, elevations.length);
  let ref: number | undefined;
  let climbed = 0;
  for (let i = 0; i < n && cum[i]! <= distanceM; i++) {
    const e = elevations[i];
    if (e === undefined) continue;
    if (ref === undefined) {
      ref = e;
      continue;
    }
    if (e - ref >= thresholdM) {
      climbed += e - ref;
      ref = e;
    } else if (ref - e >= thresholdM) {
      ref = e;
    }
  }
  const end = elevationAt(trail, distanceM);
  if (ref !== undefined && end !== undefined && end - ref >= thresholdM) climbed += end - ref;
  return climbed;
}

/**
 * Going up or down at a spot: the elevation change across `windowM` either
 * side of it. Under `minDeltaM` it is about level and says nothing.
 */
export function directionAt(
  trail: ViewerTrail,
  distanceM: number,
  windowM = 120,
  minDeltaM = 4,
): TrailDirection | null {
  const before = elevationAt(trail, Math.max(0, distanceM - windowM));
  const after = elevationAt(trail, Math.min(trail.totalM, distanceM + windowM));
  if (before === undefined || after === undefined) return null;
  const delta = after - before;
  if (Math.abs(delta) < minDeltaM) return null;
  return delta > 0 ? 'up' : 'down';
}

/** The facts of one photo on a trail. `indexCumM` maps its anchor onto the axis. */
export function photoFacts(
  photo: Pick<TrackPhoto, 'distanceM' | 'takenAt' | 'elevationM'>,
  trail: ViewerTrail,
  indexCumM: ArrayLike<number>,
): PhotoFacts {
  const distanceM = mapAlongPoints(indexCumM, trail.axisCumM, photo.distanceM);
  const facts: PhotoFacts = { distanceM, direction: directionAt(trail, distanceM) };
  const elevationM = elevationAt(trail, distanceM) ?? photo.elevationM;
  if (elevationM !== undefined) {
    facts.elevationM = elevationM;
    facts.climbedM = climbedUpTo(trail, distanceM);
  }
  if (
    photo.takenAt !== undefined &&
    trail.startMs !== undefined &&
    photo.takenAt >= trail.startMs
  ) {
    facts.sinceStartMs = photo.takenAt - trail.startMs;
  }
  return facts;
}

/** "at the start", "12 min after the start", "1 h 21 after the start". */
export function sinceStartText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'at the start';
  if (min < 60) return `${min} min after the start`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} h ${m.toString().padStart(2, '0')} after the start`;
}

/** How the photo got its place, for the provenance line. */
export function provenanceText(placement: PhotoPlacement, isNote = false): string {
  if (isNote) return 'From a trail note';
  switch (placement) {
    case 'time':
      return 'Placed on the trail by its time';
    case 'gps':
      return 'Placed on the trail by its location';
    case 'capture':
      return 'Taken during the recording';
    case 'manual':
      return 'Placed by hand';
  }
}

/** The info sheet's lines, formatted. */
export interface ViewerInfoText {
  /** Caption, or "Photo 11" when it has none. */
  title: string;
  /** "Sun 27 Sep 2026 · 10:32 · 1 h 21 after the start" (empty without a time). */
  when: string;
  distance: string;
  /** "of 9.02 km · going up". */
  distanceSub: string;
  elevation: string | null;
  climbed: string | null;
  provenance: string;
}

export function viewerInfoText(
  photo: Pick<TrackPhoto, 'caption' | 'takenAt' | 'placement'>,
  facts: PhotoFacts,
  ctx: {
    /** 1-based position in the viewer's order. */
    number: number;
    totalM: number;
    isNote?: boolean;
    fmt: Pick<Formatters, 'formatDistance' | 'formatElevation'>;
    /** "Sun 27 Sep 2026 · 10:32" for an instant (locale-aware, injected). */
    formatWhen: (epochMs: number) => string;
  },
): ViewerInfoText {
  const when: string[] = [];
  if (photo.takenAt !== undefined) when.push(ctx.formatWhen(photo.takenAt));
  if (facts.sinceStartMs !== undefined) when.push(sinceStartText(facts.sinceStartMs));
  const dir =
    facts.direction === 'up' ? 'going up' : facts.direction === 'down' ? 'on the way down' : null;
  return {
    title: photo.caption?.trim() || `Photo ${ctx.number}`,
    when: when.join(' · '),
    distance: ctx.fmt.formatDistance(facts.distanceM),
    distanceSub: [`of ${ctx.fmt.formatDistance(ctx.totalM)}`, dir].filter(Boolean).join(' · '),
    elevation: facts.elevationM === undefined ? null : ctx.fmt.formatElevation(facts.elevationM),
    climbed: facts.climbedM === undefined ? null : `+${ctx.fmt.formatElevation(facts.climbedM)}`,
    provenance: provenanceText(photo.placement, ctx.isNote),
  };
}
