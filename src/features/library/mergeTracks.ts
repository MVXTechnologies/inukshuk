import { buildGpx, parseGpx } from '@core/geo/gpx';
import { mergeTracks, type MergeSource } from '@core/geo/gpx/edit';
import { buildImportedTrack } from '@core/geo/track';
import type { Track, TrackSummary } from '@core/models';
import * as storage from '@data/storage';
import type { SeedNote } from '@state/libraryStore';

export interface MergedLibraryTrack {
  track: Track;
  fileUri: string;
  /**
   * The sources' notes re-anchored on the merged trail, ready for
   * `addTrack(track, fileUri, notes)`. Photos are fresh copies the merged
   * trail owns — deleting either it or a source never strands the other.
   */
  notes: SeedNote[];
}

/** Best-effort removal of files this merge created before it failed. */
function discardAll(uris: readonly string[]): void {
  for (const uri of uris) {
    try {
      storage.deleteFileAt(uri);
    } catch {
      // Nothing references the file; an orphan beats masking the real error.
    }
  }
}

/**
 * Merge the GPX files of the given library trails (in the user's selection
 * order) into a single new trail saved alongside them. Sources with timestamps
 * are ordered chronologically by `mergeTracks`; waypoints in the source files
 * are carried over, and so are the sources' library notes and photos (#304):
 * notes are re-anchored by merged distance and every photo is copied so the
 * merged trail owns its attachments outright. The originals are untouched.
 * Throws when a source file cannot be read or parsed, when the merge yields
 * no points, or when a photo cannot be copied — nothing this call created is
 * left behind in that case.
 */
export async function mergeLibraryTracks(
  summaries: readonly TrackSummary[],
): Promise<MergedLibraryTrack> {
  const sources: MergeSource[] = [];
  for (const s of summaries) {
    const xml = await storage.readFileText(s.fileUri);
    const { points, waypoints } = parseGpx(xml);
    sources.push({ name: s.name, points, waypoints, notes: s.notes });
  }

  const merged = mergeTracks(sources);
  if (merged.points.length === 0) throw new Error('Nothing to merge: no track points');

  // Copy photos BEFORE writing the GPX: a copy that fails leaves nothing to
  // undo but the copies before it.
  const created: string[] = [];
  const notes: SeedNote[] = [];
  try {
    for (const n of merged.notes) {
      let photoUri: string | undefined;
      if (n.photoUri) {
        photoUri = await storage.importPhoto(n.photoUri, storage.newId());
        created.push(photoUri);
      }
      notes.push({ distanceM: n.distanceM, text: n.text, ...(photoUri ? { photoUri } : {}) });
    }
  } catch (err) {
    discardAll(created);
    throw err;
  }

  const id = storage.newId();
  const xml = buildGpx({
    points: merged.points,
    metadata: { name: merged.name },
    waypoints: merged.waypoints,
  });
  let fileUri: string;
  try {
    fileUri = storage.writeTrackGpx(id, xml);
  } catch (err) {
    discardAll(created);
    throw err;
  }
  const track = buildImportedTrack({
    id,
    points: merged.points,
    name: merged.name,
    fallbackName: merged.name,
    fallbackTime: Date.now(),
  });
  return { track, fileUri, notes };
}
