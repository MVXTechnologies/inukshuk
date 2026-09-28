/**
 * The contract every connected activity source implements (Strava, Apple
 * Health, Health Connect — #432/#435), so one importer, one import sheet and
 * one duplicate check serve them all. File imports (#431) have their own
 * archive walker; they meet this pipeline at the save step.
 *
 * A source LISTS cheaply first (start time, distance, name — no GPS), the
 * importer drops duplicates and route-less entries, and only then are routes
 * fetched one by one. That order matters: Strava allows ~1,000 reads a day,
 * and a Health route read costs a permission-gated native query each.
 */

import type { TrackPoint } from '@core/models';

export type ActivitySourceId = 'strava' | 'apple-health' | 'health-connect';

/** Where an imported trail came from, persisted with it (badge, filter, disconnect cleanup). */
export interface TrackOrigin {
  source: ActivitySourceId;
  /** The activity's id at the source (Strava activity id, HealthKit workout UUID, HC record id). */
  externalId: string;
}

/** One listed activity, before its route is fetched. */
export interface RemoteActivity {
  origin: TrackOrigin;
  /** Name given at the source; the importer falls back to "<Sport> <date>". */
  name?: string;
  /** Our category id (`@core/library/categories`), when the sport maps to one. */
  category?: string;
  /** Human sport label for the fallback name ("Trail Run"). */
  sportLabel?: string;
  /** Epoch ms. */
  startedAt: number;
  /** Metres; 0 when the source doesn't say. */
  distanceM: number;
  /**
   * False when the source already knows there is nothing to draw (manual
   * entry, treadmill, a workout saved without a route). Skipped, counted as
   * "no GPS".
   */
  hasRoute: boolean;
}

export interface ActivityRoute {
  points: TrackPoint[];
  /** Pause boundaries, as in `@core/geo/track/segments`. */
  segmentStarts: number[];
}

/** Which slice of history to import. */
export type ImportRange =
  { kind: 'since'; after: number } | { kind: 'last-days'; days: number } | { kind: 'everything' };

/** Epoch ms lower bound for a range (0 = the beginning), given "now". */
export function rangeStart(range: ImportRange, now: number): number {
  switch (range.kind) {
    case 'since':
      return Math.max(0, range.after);
    case 'last-days':
      return Math.max(0, now - range.days * 86_400_000);
    case 'everything':
      return 0;
  }
}

/** Why the importer is waiting, surfaced on the progress card. */
export type ImportPause = { kind: 'rate-limit'; resumeAt: number } | null;

/**
 * A connected source. Implementations live in `src/lib` (network / native);
 * everything they return is plain data so the importer stays testable.
 */
export interface ActivitySource {
  id: ActivitySourceId;
  /**
   * Every activity that started at or after `since`, newest first. May take
   * several pages; implementations handle their own paging.
   */
  list(since: number, signal: AbortSignal): Promise<RemoteActivity[]>;
  /**
   * The activity's GPS route (empty points = nothing to draw after all).
   * `onPause` reports a rate-limit wait the implementation is sitting out.
   */
  fetchRoute(
    activity: RemoteActivity,
    signal: AbortSignal,
    onPause: (pause: ImportPause) => void,
  ): Promise<ActivityRoute>;
}
