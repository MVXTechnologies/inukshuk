import { buildGpx, parseGpx } from '@core/geo/gpx';
import { retargetNotesAfterTrim, sliceTrack } from '@core/geo/gpx/edit';
import { buildImportedTrack } from '@core/geo/track';
import type { Track, TrackPoint, TrackSummary } from '@core/models';
import * as storage from '@data/storage';

/**
 * Persistence half of the trim tool. The pure math (slice, stats, note
 * re-anchoring) lives in `@core/geo/gpx/edit`; this module reads/writes the
 * GPX files and prepares the library mutations.
 *
 * Waypoints in the source GPX are geographically anchored (not index-anchored),
 * so both save paths carry them over verbatim.
 */

/** Kept [start, end] point-index window while trimming (inclusive both ends). */
export interface TrimRange {
  start: number;
  end: number;
}

/** Read the source file's standalone waypoints; a trim never discards them. */
async function readSourceWaypoints(fileUri: string) {
  try {
    return parseGpx(await storage.readFileText(fileUri)).waypoints;
  } catch {
    return []; // source unreadable — the caller still has the in-memory points
  }
}

/**
 * Save the kept segment as a NEW library trail ("save as copy"). The original
 * file and summary are untouched. Trail notes stay with the original (their
 * photos are single-owner files — sharing them across two trails would break
 * delete semantics).
 */
export async function saveTrimmedCopy(
  summary: TrackSummary,
  points: readonly TrackPoint[],
  startIdx: number,
  endIdx: number,
): Promise<{ track: Track; fileUri: string }> {
  const { points: kept } = sliceTrack(points, startIdx, endIdx);
  if (kept.length < 2) throw new Error('Trim leaves fewer than 2 points');
  const name = `${summary.name} (trimmed)`;
  const waypoints = await readSourceWaypoints(summary.fileUri);
  const id = storage.newId();
  const xml = buildGpx({ points: kept, metadata: { name }, waypoints });
  const fileUri = storage.writeTrackGpx(id, xml);
  const track: Track = {
    ...buildImportedTrack({
      id,
      points: kept,
      name,
      fallbackName: name,
      fallbackTime: Date.now(),
    }),
    // The copy is the same activity as its source — keep its category.
    ...(summary.category ? { category: summary.category } : {}),
  };
  return { track, fileUri };
}

/** The library-summary patch produced by an overwrite trim. */
export interface TrimOverwriteResult {
  patch: Pick<TrackSummary, 'fileUri' | 'startedAt' | 'endedAt' | 'stats' | 'notes'>;
}

/**
 * Save a new GPX revision, commit its library pointer, then retire old assets.
 * If metadata fails, retain both revisions: a recoverable staged index might
 * reference the new one while the current index still references the original.
 */
export async function overwriteWithTrim(
  summary: TrackSummary,
  points: readonly TrackPoint[],
  startIdx: number,
  endIdx: number,
  commit: (patch: TrimOverwriteResult['patch']) => void | Promise<void>,
): Promise<TrimOverwriteResult> {
  const { points: kept, stats } = sliceTrack(points, startIdx, endIdx);
  if (kept.length < 2) throw new Error('Trim leaves fewer than 2 points');
  // An unreadable source must not silently discard its standalone waypoints.
  const waypoints = parseGpx(await storage.readFileText(summary.fileUri)).waypoints;
  const xml = buildGpx({ points: kept, metadata: { name: summary.name }, waypoints });
  const fileUri = storage.writeTrackGpx(storage.newId(), xml);
  const { kept: notes, dropped } = retargetNotesAfterTrim(
    summary.notes ?? [],
    points,
    startIdx,
    endIdx,
  );
  const rebuilt = buildImportedTrack({
    id: summary.id,
    points: kept,
    name: summary.name,
    fallbackName: summary.name,
    fallbackTime: summary.startedAt,
  });
  const patch: TrimOverwriteResult['patch'] = {
    fileUri,
    startedAt: rebuilt.startedAt,
    endedAt: rebuilt.endedAt,
    stats,
    notes,
  };
  await commit(patch);
  for (const uri of [summary.fileUri, ...dropped.map((note) => note.photoUri)]) {
    if (!uri) continue;
    try {
      storage.deleteFileAt(uri);
    } catch {
      // The new revision is committed; an orphan must not turn success into failure.
    }
  }
  return { patch };
}
