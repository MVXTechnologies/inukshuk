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
  const track = buildImportedTrack({
    id,
    points: kept,
    name,
    fallbackName: name,
    fallbackTime: Date.now(),
  });
  return { track, fileUri };
}

/** The library-summary patch produced by an overwrite trim. */
export interface TrimOverwriteResult {
  patch: Pick<TrackSummary, 'startedAt' | 'endedAt' | 'stats' | 'notes'>;
}

/**
 * Overwrite the trail's GPX file with the kept segment and return the summary
 * patch for the library index. Distance-anchored notes are shifted by the cut
 * head distance; notes falling outside the kept segment are dropped and their
 * photos deleted (they would otherwise be orphaned files).
 */
export async function overwriteWithTrim(
  summary: TrackSummary,
  points: readonly TrackPoint[],
  startIdx: number,
  endIdx: number,
): Promise<TrimOverwriteResult> {
  const { points: kept, stats } = sliceTrack(points, startIdx, endIdx);
  if (kept.length < 2) throw new Error('Trim leaves fewer than 2 points');
  const waypoints = await readSourceWaypoints(summary.fileUri);
  const xml = buildGpx({ points: kept, metadata: { name: summary.name }, waypoints });
  // Every trail GPX lives at tracks/<id>.gpx (recorder + import + merge all
  // write through writeTrackGpx), so writing under the same id replaces it.
  storage.writeTrackGpx(summary.id, xml);

  const { kept: notes, dropped } = retargetNotesAfterTrim(
    summary.notes ?? [],
    points,
    startIdx,
    endIdx,
  );
  for (const n of dropped) {
    if (n.photoUri) storage.deleteFileAt(n.photoUri);
  }

  const rebuilt = buildImportedTrack({
    id: summary.id,
    points: kept,
    name: summary.name,
    fallbackName: summary.name,
    fallbackTime: summary.startedAt,
  });
  return {
    patch: {
      startedAt: rebuilt.startedAt,
      endedAt: rebuilt.endedAt,
      stats,
      notes,
    },
  };
}
