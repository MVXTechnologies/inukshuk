import { parseGpx } from '@core/geo/gpx';
import { buildImportedTrack, snapWaypointsToNotes } from '@core/geo/track';
import type { LngLat, TrackNote, TrackPoint } from '@core/models';

import type { WebTrack } from './types';

/**
 * GPX text → a Library trail. The browser twin of
 * `src/features/library/importGpx.ts`, and the same four `@core` calls in the
 * same order:
 *
 *   parseGpx → buildImportedTrack → snapWaypointsToNotes → computeTrackStats
 *
 * (the last one inside `buildImportedTrack`). The only thing this file adds is
 * where the bytes go: IndexedDB instead of the document directory, and a
 * decimated preview line so the map can draw the trail without re-parsing.
 */

/** Trace colours, cycled by import order — legible on both basemaps. */
export const TRACK_PALETTE = [
  '#F2643C',
  '#FFC24B',
  '#5BD2A4',
  '#61B4F2',
  '#C48AF0',
  '#F98BB8',
  '#8FD14F',
  '#FF9A6C',
];

/** Target vertex count for the index's overview polyline. */
const PREVIEW_POINTS = 600;

/**
 * Evenly decimate to at most {@link PREVIEW_POINTS} vertices, always keeping
 * the last point. Uniform index stride, not Douglas-Peucker: at 600 vertices a
 * multi-kilometre trail is already sub-pixel-accurate at any zoom the overview
 * map reaches, and a simplification pass would only add a dependency and a
 * tolerance to tune.
 */
export function previewLine(points: readonly TrackPoint[]): LngLat[] {
  if (points.length === 0) return [];
  const stride = Math.max(1, Math.ceil(points.length / PREVIEW_POINTS));
  const out: LngLat[] = [];
  for (let i = 0; i < points.length; i += stride) {
    const p = points[i]!;
    out.push([p.longitude, p.latitude]);
  }
  const last = points[points.length - 1]!;
  const tail = out[out.length - 1];
  if (tail === undefined || tail[0] !== last.longitude || tail[1] !== last.latitude) {
    out.push([last.longitude, last.latitude]);
  }
  return out;
}

export interface ImportedGpx {
  track: WebTrack;
  points: TrackPoint[];
}

export interface ImportOverrides {
  id?: string;
  name?: string;
  category?: string;
  folderId?: string;
  color?: string;
}

/**
 * Parse one GPX document into a Library trail.
 *
 * Throws when the file yields fewer than two track points — the same bar the
 * weather-map drop path applies, and the reason a one-point GPX can never make
 * it into the library and produce a degenerate profile.
 */
export function importGpxText(
  xml: string,
  fallbackName: string,
  importedAt: number,
  overrides: ImportOverrides = {},
): ImportedGpx {
  const doc = parseGpx(xml);
  if (doc.points.length < 2) throw new Error('no track points');

  const id =
    overrides.id ?? `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const built = buildImportedTrack({
    id,
    points: doc.points,
    ...(doc.metadata.name === undefined ? {} : { name: doc.metadata.name }),
    fallbackName,
    fallbackTime: importedAt,
  });

  // GPX <wpt> markers become distance-anchored trail notes, exactly as on
  // device — they are things ON the trail, not free-standing library pins.
  const notes: TrackNote[] = snapWaypointsToNotes(doc.points, doc.waypoints).map((n, i) => ({
    id: `${id}-n${i}`,
    distanceM: n.distanceM,
    text: n.text,
    createdAt: built.startedAt + i,
  }));

  const track: WebTrack = {
    id,
    name: overrides.name ?? built.name,
    startedAt: built.startedAt,
    ...(built.endedAt === undefined ? {} : { endedAt: built.endedAt }),
    stats: built.stats,
    // Same field, same meaning, different filesystem: the points live at this
    // key in the `gpx` object store rather than at a file:// path.
    fileUri: `idb://gpx/${id}`,
    preview: previewLine(doc.points),
    color: overrides.color ?? TRACK_PALETTE[0]!,
    ...(notes.length === 0 ? {} : { notes }),
    ...(overrides.category === undefined ? {} : { category: overrides.category }),
    ...(overrides.folderId === undefined ? {} : { folderId: overrides.folderId }),
  };

  return { track, points: doc.points };
}
