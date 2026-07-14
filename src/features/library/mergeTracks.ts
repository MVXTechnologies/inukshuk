import { buildGpx, parseGpx } from '@core/geo/gpx';
import { mergeTracks, type MergeSource } from '@core/geo/gpx/edit';
import { buildImportedTrack } from '@core/geo/track';
import type { Track, TrackSummary } from '@core/models';
import * as storage from '@data/storage';

export interface MergedLibraryTrack {
  track: Track;
  fileUri: string;
}

/**
 * Merge the GPX files of the given library trails (in the user's selection
 * order) into a single new trail saved alongside them. Sources with timestamps
 * are ordered chronologically by `mergeTracks`; waypoints in the source files
 * are carried over. The originals are untouched. Throws when a source file
 * cannot be read or parsed, or when the merge yields no points.
 */
export async function mergeLibraryTracks(
  summaries: readonly TrackSummary[],
): Promise<MergedLibraryTrack> {
  const sources: MergeSource[] = [];
  for (const s of summaries) {
    const xml = await storage.readFileText(s.fileUri);
    const { points, waypoints } = parseGpx(xml);
    sources.push({ name: s.name, points, waypoints });
  }

  const merged = mergeTracks(sources);
  if (merged.points.length === 0) throw new Error('Nothing to merge: no track points');

  const id = storage.newId();
  const xml = buildGpx({
    points: merged.points,
    metadata: { name: merged.name },
    waypoints: merged.waypoints,
  });
  const fileUri = storage.writeTrackGpx(id, xml);
  const track = buildImportedTrack({
    id,
    points: merged.points,
    name: merged.name,
    fallbackName: merged.name,
    fallbackTime: Date.now(),
  });
  return { track, fileUri };
}
