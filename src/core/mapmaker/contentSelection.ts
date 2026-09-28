import type { BoundingBox } from '@core/models';

/**
 * Which of the user's own trails and waypoints get drawn on a made map (#349).
 *
 * This replaces the blanket "My tracks & waypoints" switch, which printed the
 * entire library and — worse — made `makeMap` read and XML-parse EVERY GPX
 * file on every single make, letting the composer's clipper throw away the
 * ones that missed the page (#356). Track summaries already carry a bounding
 * box, so the ones that cannot appear are excluded here with no file I/O at
 * all: on a hundred-track library over one valley that is ~3 reads instead of
 * 100.
 *
 * Selection is an EXPLICIT set of ids, seeded from "everything in the frame".
 * It deliberately does not re-evaluate as the frame moves: a checkbox that
 * silently unticks itself while you pan is worse than one that needs a tap to
 * re-seed, and the picker offers exactly that tap.
 */

/** The slice of a track summary this module needs. */
export interface SelectableTrack {
  id: string;
  /** Absent on tracks saved before the field existed, or on a failed parse. */
  bbox?: BoundingBox;
}

/** The slice of a waypoint this module needs. */
export interface SelectablePoint {
  id: string;
  longitude: number;
  latitude: number;
}

/** Do two lng/lat boxes overlap at all? Touching edges count as overlapping. */
export function bboxesIntersect(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.minLng <= b.maxLng && a.maxLng >= b.minLng && a.minLat <= b.maxLat && a.maxLat >= b.minLat
  );
}

/**
 * Could this track put ink on the page?
 *
 * A track with no recorded bbox returns `true`: we cannot rule it out, and the
 * composer clips per-segment anyway, so the cost of being wrong is one wasted
 * parse rather than a silently missing trail.
 */
export function trackTouchesPage(track: SelectableTrack, page: BoundingBox): boolean {
  return track.bbox === undefined || bboxesIntersect(track.bbox, page);
}

export function pointOnPage(p: SelectablePoint, page: BoundingBox): boolean {
  return (
    p.longitude >= page.minLng &&
    p.longitude <= page.maxLng &&
    p.latitude >= page.minLat &&
    p.latitude <= page.maxLat
  );
}

/** Ids of every track that could appear on the page — the picker's default. */
export function tracksOnPage(tracks: readonly SelectableTrack[], page: BoundingBox): string[] {
  return tracks.filter((t) => trackTouchesPage(t, page)).map((t) => t.id);
}

/** Ids of every waypoint that falls inside the page. */
export function pointsOnPage(points: readonly SelectablePoint[], page: BoundingBox): string[] {
  return points.filter((p) => pointOnPage(p, page)).map((p) => p.id);
}

/**
 * What a make should actually load: the chosen ids, minus anything that cannot
 * reach the page. The bbox check is applied again here on purpose — a
 * selection is seeded from one frame and the user may pan before pressing
 * Create, and re-checking costs nothing next to a GPX parse.
 */
export function resolveTracksToLoad(
  tracks: readonly SelectableTrack[],
  page: BoundingBox,
  selectedIds: readonly string[] | undefined,
): string[] {
  const chosen = selectedIds === undefined ? null : new Set(selectedIds);
  return tracks
    .filter((t) => (chosen === null || chosen.has(t.id)) && trackTouchesPage(t, page))
    .map((t) => t.id);
}

export function resolvePointsToLoad(
  points: readonly SelectablePoint[],
  page: BoundingBox,
  selectedIds: readonly string[] | undefined,
): string[] {
  const chosen = selectedIds === undefined ? null : new Set(selectedIds);
  return points
    .filter((p) => (chosen === null || chosen.has(p.id)) && pointOnPage(p, page))
    .map((p) => p.id);
}
