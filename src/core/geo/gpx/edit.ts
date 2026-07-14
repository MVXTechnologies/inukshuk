import type { TrackNote, TrackPoint, TrackStats } from '@core/models';
import { computeTrackStats, haversineMeters } from '@core/geo/track';
import type { GpxWaypoint } from './index';

/**
 * Pure GPX editing operations: merging several tracks into one and trimming a
 * track from either end. No platform dependencies — the Library / map UI are
 * thin wrappers over these.
 */

/** One source track fed into {@link mergeTracks}, in user (selection) order. */
export interface MergeSource {
  name: string;
  points: readonly TrackPoint[];
  /** Standalone <wpt> markers from the source GPX, carried into the merge. */
  waypoints?: readonly GpxWaypoint[];
}

export interface MergeResult {
  /** Suggested name, e.g. `Merged: A + B`. */
  name: string;
  /** All source points concatenated in merge order. */
  points: TrackPoint[];
  /** All source waypoints concatenated in merge order. */
  waypoints: GpxWaypoint[];
  /** Stats recomputed over the merged point list. */
  stats: TrackStats;
}

/** First real timestamp of a point series, or undefined when untimed. */
function startTime(points: readonly TrackPoint[]): number | undefined {
  for (const p of points) {
    if (Number.isFinite(p.time) && p.time > 0) return p.time;
  }
  return undefined;
}

/**
 * Merge several tracks into a single one.
 *
 * Ordering: when every non-empty source carries timestamps the sources are
 * concatenated by start time (a morning leg recorded after an afternoon leg
 * still merges chronologically); otherwise the user's order is preserved —
 * mixing timed and untimed tracks has no meaningful chronology, so we don't
 * invent one. The sort is stable: ties keep user order.
 *
 * Waypoints are preserved (concatenated in the same order as their tracks);
 * stats are recomputed over the merged point list. Empty sources contribute
 * nothing but keep their name out of the merged name too.
 */
export function mergeTracks(sources: readonly MergeSource[]): MergeResult {
  const nonEmpty = sources.filter((s) => s.points.length > 0);
  const starts = nonEmpty.map((s) => startTime(s.points));
  const allTimed = nonEmpty.length > 0 && starts.every((t) => t !== undefined);

  let ordered: readonly MergeSource[] = nonEmpty;
  if (allTimed) {
    ordered = nonEmpty
      .map((s, i) => ({ s, t: starts[i] ?? 0, i }))
      .sort((a, b) => a.t - b.t || a.i - b.i)
      .map((x) => x.s);
  }

  const points: TrackPoint[] = [];
  const waypoints: GpxWaypoint[] = [];
  for (const s of ordered) {
    points.push(...s.points);
    if (s.waypoints) waypoints.push(...s.waypoints);
  }

  const names = ordered.map((s) => s.name.trim()).filter((n) => n.length > 0);
  const name = names.length > 0 ? `Merged: ${names.join(' + ')}` : 'Merged trail';

  return { name, points, waypoints, stats: computeTrackStats(points) };
}

export interface SliceResult {
  /** The kept points — `points[startIdx..endIdx]`, both ends inclusive. */
  points: TrackPoint[];
  /** Stats recomputed over the kept points (empty stats when nothing is kept). */
  stats: TrackStats;
}

/**
 * Keep only `points[startIdx..endIdx]` (inclusive) of a track. Indices are
 * clamped into range; an inverted or fully out-of-range window yields an empty
 * result. Timestamps (and every other per-point field) are kept verbatim;
 * stats/distance are recomputed over the kept segment.
 */
export function sliceTrack(
  points: readonly TrackPoint[],
  startIdx: number,
  endIdx: number,
): SliceResult {
  const last = points.length - 1;
  const start = Math.max(0, Math.floor(startIdx));
  const end = Math.min(last, Math.floor(endIdx));
  if (points.length === 0 || start > end) {
    return { points: [], stats: computeTrackStats([]) };
  }
  const kept = points.slice(start, end + 1);
  return { points: kept, stats: computeTrackStats(kept) };
}

/** Cumulative haversine distance from `points[0]` to `points[idx]`, in metres. */
function distanceToIndex(points: readonly TrackPoint[], idx: number): number {
  let d = 0;
  for (let i = 1; i <= idx; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (!prev || !cur) break;
    d += haversineMeters(prev, cur);
  }
  return d;
}

/**
 * Re-anchor distance-based trail notes after a trim. Notes are anchored by
 * distance from the trail start, so cutting the head shifts every anchor left
 * by the removed distance; notes that fall outside the kept segment are
 * dropped (their return also tells the caller which photos became orphans).
 */
export function retargetNotesAfterTrim(
  notes: readonly TrackNote[],
  points: readonly TrackPoint[],
  startIdx: number,
  endIdx: number,
): { kept: TrackNote[]; dropped: TrackNote[] } {
  const last = points.length - 1;
  const start = Math.max(0, Math.floor(startIdx));
  const end = Math.min(last, Math.floor(endIdx));
  if (points.length === 0 || start > end) {
    return { kept: [], dropped: [...notes] };
  }
  const cutM = distanceToIndex(points, start);
  const keptTotalM = distanceToIndex(points, end) - cutM;
  const kept: TrackNote[] = [];
  const dropped: TrackNote[] = [];
  for (const n of notes) {
    const shifted = n.distanceM - cutM;
    // Small epsilon: a note anchored exactly at a cut boundary survives.
    if (shifted >= -0.5 && shifted <= keptTotalM + 0.5) {
      kept.push({ ...n, distanceM: Math.min(Math.max(0, shifted), keptTotalM) });
    } else {
      dropped.push(n);
    }
  }
  return { kept, dropped };
}
