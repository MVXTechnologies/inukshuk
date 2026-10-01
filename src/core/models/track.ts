import type { TrackOrigin } from '@core/import/sources';

import type { BoundingBox, LngLat } from './geo';

/** A single recorded GPS fix. */
export interface TrackPoint {
  latitude: number;
  longitude: number;
  /** Metres above the WGS84 ellipsoid / MSL as reported by GPS, if available. */
  altitude?: number;
  /** Epoch milliseconds of the fix. */
  time: number;
  /** GPX timestamp presence; false marks missing/invalid time despite its 0 placeholder.
   * Absent on native/synthetic fixes, whose finite time (including 0) is valid. */
  hasTime?: boolean;
  /** Horizontal accuracy radius in metres, if available. */
  accuracy?: number;
  /** Vertical accuracy in metres, if available. */
  altitudeAccuracy?: number;
  /** Instantaneous ground speed in m/s reported by GPS, if available. */
  speed?: number;
  /** Heart rate in beats/min, from GPX Garmin TrackPointExtension imports. */
  heartRateBpm?: number;
}

/** Derived statistics for a sequence of {@link TrackPoint}s. */
export interface TrackStats {
  /** Total horizontal (haversine) distance in metres. */
  distanceM: number;
  /** Cumulative elevation gain, "D+", in metres. */
  ascentM: number;
  /** Cumulative elevation loss, "D-", in metres (positive number). */
  descentM: number;
  /** Wall-clock duration between first and last timed fixes, in seconds. */
  durationS: number;
  /** Duration excluding stationary periods, in seconds. */
  movingTimeS: number;
  /** Average speed over timed moving segments, in m/s. */
  avgSpeedMps: number;
  /** Peak smoothed speed in m/s. */
  maxSpeedMps: number;
  minAltitudeM?: number;
  maxAltitudeM?: number;
  bbox?: BoundingBox;
  pointCount: number;
}

/** A user annotation anchored at a distance along a recorded trail. */
export interface TrackNote {
  id: string;
  /** Distance from the trail start, in metres, where the note is anchored. */
  distanceM: number;
  text: string;
  createdAt: number;
  /** Absolute file:// uri of an attached photo stored in app storage, if any. */
  photoUri?: string;
}

export type TrackStatus = 'recording' | 'paused' | 'finished';

/**
 * A route drawn on the map rather than recorded (#502) — a plan to follow.
 * Its presence is what makes a trail a "planned route": no timestamps, never
 * counted as an activity (dashboard, heatmap), and editable again from the
 * vertices the user placed (the GPX holds the densified, elevation-sampled
 * line; these are the handles the drawing tool reopens with).
 */
/** How one leg of a drawn route was made (#515): snapped to trails or roads, or straight. */
export type RouteLegMode = 'freehand' | 'trails' | 'roads';

export interface RoutePlan {
  /** The mode the drawing tool was in when saved (the chip it reopens on). */
  mode: RouteLegMode;
  /** The vertices the user placed, `[lng, lat]`, ≥ 2. */
  vertices: LngLat[];
  /**
   * Per leg (`vertices.length - 1`): how the line between vertex i and i+1
   * was made. Absent = every leg Freehand (routes drawn before #515, and
   * all-Freehand routes, which keep their original shape on disk).
   */
  legModes?: RouteLegMode[];
}

/** A recorded route, persisted as GPX. */
export interface Track {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  status: TrackStatus;
  points: TrackPoint[];
  stats: TrackStats;
  /** Activity category id (see `@core/library/categories`); absent = uncategorized. */
  category?: string;
  /** The connected source it was imported from (#432/#435); absent for everything else. */
  origin?: TrackOrigin;
  /** Set when the trail is a route drawn on the map (#502); absent for recordings/imports. */
  plan?: RoutePlan;
}

/**
 * Lightweight track record kept in the library index. The full point list lives
 * in the GPX file at `fileUri` and is loaded on demand.
 */
export interface TrackSummary {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  stats: TrackStats;
  fileUri: string;
  /** Id of the {@link Folder} this trail is organized under; undefined = Ungrouped. */
  folderId?: string;
  /** User annotations along the trail (added in the GPX editor). */
  notes?: TrackNote[];
  /**
   * Activity category: a built-in id or a custom category's id (see
   * `@core/library/categories`). Absent = uncategorized — tracks saved before
   * this field existed (or imported GPX) need no migration.
   */
  category?: string;
  /**
   * The connected source (Strava, Apple Health, Health Connect) and its id
   * for the activity, when the trail was imported from one (#432/#435).
   * Drives the Library's source mark and filter chip, the importer's "already
   * here" check, and the "delete what came from Strava" disconnect option.
   * Absent for recordings and file imports.
   */
  origin?: TrackOrigin;
  /**
   * The drawn route's plan (#502): present only on routes drawn on the map.
   * Marks the trail as a plan (not a performed activity) and holds the
   * vertices "Edit route" reopens the drawing tool with.
   */
  plan?: RoutePlan;
}
