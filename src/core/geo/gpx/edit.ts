import type { TrackNote, TrackPoint, TrackStats } from '@core/models';
import {
  buildTrackAxis,
  computeSegmentedTrackStats,
  haversineMeters,
  normalizeSegmentStarts,
} from '@core/geo/track';
import type { GpxWaypoint } from './index';

/**
 * Pure GPX editing operations: merging several tracks into one and trimming a
 * track from either end. No platform dependencies — the Library / map UI are
 * thin wrappers over these.
 *
 * Segments (#325): a recording is cut into segments at every pause, and a
 * multi-`<trkseg>` import keeps its own. Both operations keep those
 * boundaries (`segmentStarts`) and measure distance the way the trail's stats
 * do, never across a boundary.
 */

/** One source track fed into {@link mergeTracks}, in user (selection) order. */
export interface MergeSource {
  name: string;
  points: readonly TrackPoint[];
  /** The source's own segment boundaries (indices into `points`). */
  segmentStarts?: readonly number[];
  /** Standalone <wpt> markers from the source GPX, carried into the merge. */
  waypoints?: readonly GpxWaypoint[];
  /**
   * The source's library notes (recorded waypoints, imported-GPX markers),
   * anchored by distance from ITS OWN start. Re-anchored onto the merged
   * trail by {@link mergeTracks}.
   */
  notes?: readonly TrackNote[];
}

export interface MergeResult {
  /** Suggested name, e.g. `Merged: A + B`. */
  name: string;
  /** All source points concatenated in merge order. */
  points: TrackPoint[];
  /** All source waypoints concatenated in merge order. */
  waypoints: GpxWaypoint[];
  /**
   * All source notes in merge order, `distanceM` re-anchored from the merged
   * start. Ids and `photoUri`s are the sources' own — a caller that persists
   * the merge must give it its own copies (see `mergeLibraryTracks`).
   */
  notes: TrackNote[];
  /** Segment boundaries of the merged trail: every source's own, re-indexed. */
  segmentStarts: number[];
  /** Stats recomputed over the merged point list, per segment. */
  stats: TrackStats;
}

/** First real timestamp of a point series, or undefined when untimed. */
function startTime(points: readonly TrackPoint[]): number | undefined {
  for (const p of points) {
    if (p.hasTime !== false && Number.isFinite(p.time) && (p.time > 0 || p.hasTime === true))
      return p.time;
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
 *
 * Segments (#325): every source keeps its own segments (its pauses). The
 * sources themselves are joined into one continuous trail, as before: merging
 * is the user saying these legs are one trail.
 *
 * Notes are re-anchored: a note `d` metres into its source lands `d` metres
 * past that source's first point on the merged trail, where the merged
 * distance also counts the hop from the previous source's last point. Both
 * are measured on the same segment-aware axis the stats and elevation profile
 * use. An anchor past its source's own length is clamped to it.
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
  const notes: TrackNote[] = [];
  const segmentStarts: number[] = [];
  // Distance from the merged start to the last point pushed so far.
  let mergedM = 0;
  // Plain loops, not `push(...s.points)`: spreading a whole point series into
  // one call overflows the engine's argument limit — a valid 150k-point GPX
  // threw RangeError before anything was written (Hermes caps vary).
  for (const s of ordered) {
    const first = s.points[0];
    const last = points[points.length - 1];
    if (first && last) mergedM += haversineMeters(last, first);
    const offset = points.length;
    const own = normalizeSegmentStarts(s.segmentStarts ?? [], s.points.length);
    for (const start of own) segmentStarts.push(offset + start);
    const offsetM = mergedM;
    const lengthM = buildTrackAxis(s.points, own).totalM;
    for (const n of s.notes ?? []) {
      const localM = Math.min(Math.max(0, n.distanceM), lengthM);
      notes.push({ ...n, distanceM: offsetM + localM });
    }
    mergedM += lengthM;
    for (const p of s.points) points.push(p);
    if (s.waypoints) for (const w of s.waypoints) waypoints.push(w);
  }

  const names = ordered.map((s) => s.name.trim()).filter((n) => n.length > 0);
  const name = names.length > 0 ? `Merged: ${names.join(' + ')}` : 'Merged trail';

  return {
    name,
    points,
    waypoints,
    notes,
    segmentStarts,
    stats: computeSegmentedTrackStats(points, segmentStarts),
  };
}

export interface SliceResult {
  /** The kept points — `points[startIdx..endIdx]`, both ends inclusive. */
  points: TrackPoint[];
  /** The source's segment boundaries that fall inside the kept window, re-indexed. */
  segmentStarts: number[];
  /** Stats recomputed over the kept points (empty stats when nothing is kept). */
  stats: TrackStats;
}

/** Clamp a trim window to `[0, length - 1]`; null when nothing is kept. */
function clampWindow(
  length: number,
  startIdx: number,
  endIdx: number,
): { start: number; end: number } | null {
  const start = Math.max(0, Math.floor(startIdx));
  const end = Math.min(length - 1, Math.floor(endIdx));
  return length === 0 || start > end ? null : { start, end };
}

/**
 * Keep only `points[startIdx..endIdx]` (inclusive) of a track. Indices are
 * clamped into range; an inverted or fully out-of-range window yields an empty
 * result. Timestamps (and every other per-point field) are kept verbatim;
 * segment boundaries inside the window are kept (#325); stats/distance are
 * recomputed over the kept segments.
 */
export function sliceTrack(
  points: readonly TrackPoint[],
  startIdx: number,
  endIdx: number,
  segmentStarts: readonly number[] = [],
): SliceResult {
  const window = clampWindow(points.length, startIdx, endIdx);
  if (window === null) {
    return { points: [], segmentStarts: [], stats: computeSegmentedTrackStats([], []) };
  }
  const { start, end } = window;
  const kept = points.slice(start, end + 1);
  const keptStarts = normalizeSegmentStarts(
    segmentStarts.map((i) => i - start),
    kept.length,
  );
  return {
    points: kept,
    segmentStarts: keptStarts,
    stats: computeSegmentedTrackStats(kept, keptStarts),
  };
}

/**
 * Re-anchor distance-based trail notes after a trim. Notes are anchored by
 * distance from the trail start (on the segment-aware axis, #325), so cutting
 * the head shifts every anchor left by the removed distance; notes that fall
 * outside the kept segment are dropped (their return also tells the caller
 * which photos became orphans).
 */
export function retargetNotesAfterTrim(
  notes: readonly TrackNote[],
  points: readonly TrackPoint[],
  startIdx: number,
  endIdx: number,
  segmentStarts: readonly number[] = [],
): { kept: TrackNote[]; dropped: TrackNote[] } {
  const window = clampWindow(points.length, startIdx, endIdx);
  if (window === null) {
    return { kept: [], dropped: [...notes] };
  }
  const { cumM } = buildTrackAxis(points, segmentStarts);
  const cutM = cumM[window.start] ?? 0;
  const keptTotalM = (cumM[window.end] ?? 0) - cutM;
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
