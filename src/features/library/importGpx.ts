import type { Track } from '@core/models';
import { parseGpx } from '@core/geo/gpx';
import { buildImportedTrack, snapWaypointsToNotes, type ImportedNote } from '@core/geo/track';
import * as storage from '@data/storage';
import { primeTrailStats } from '@data/trailStatsStore';

export interface ImportedTrack {
  track: Track;
  fileUri: string;
  notes: ImportedNote[];
}

function buildFromGpxText(
  text: string,
  id: string,
  fileUri: string,
  fallbackName: string,
): ImportedTrack {
  const { metadata, points, segmentStarts, waypoints, hasTrackOrRoutePoints } = parseGpx(text);
  if (points.length === 0) {
    storage.deleteFileAt(fileUri);
    throw new Error('No track points');
  }
  const track = buildImportedTrack({
    id,
    points,
    // A multi-<trkseg> export (Garmin/Strava pauses) is measured per segment.
    segmentStarts,
    name: metadata.name,
    fallbackName,
    fallbackTime: Date.now(),
  });
  // A GPX without timestamps is a route to follow, not a recorded activity —
  // classify it as a Navigation trail so it never reads as a zero-minute run.
  if (
    track.category === undefined &&
    !points.some((pt) => pt.hasTime !== false && Number.isFinite(pt.time))
  ) {
    track.category = 'navigation';
  }
  const notes = hasTrackOrRoutePoints ? snapWaypointsToNotes(points, waypoints) : [];
  // Statistics from the points in hand: the Logbook never reads this GPX back.
  primeTrailStats(track, points, segmentStarts);
  return { track, fileUri, notes };
}

/**
 * The file is copied into permanent storage BEFORE it can be validated (we need
 * its text to parse). If the parse then throws — the picker accepts `*\/*`, so
 * any photo or PDF gets this far — delete the copy, or it is orphaned in the
 * tracks dir forever.
 */
async function buildOrCleanUp(
  text: string,
  id: string,
  fileUri: string,
  fallbackName: string,
): Promise<ImportedTrack> {
  try {
    return buildFromGpxText(text, id, fileUri, fallbackName);
  } catch (err) {
    storage.deleteFileAt(fileUri);
    throw err;
  }
}

/** Import a GPX from an arbitrary opened URI (e.g. an Android "Open with" intent). */
export async function importGpxFromUri(uri: string, fallbackName: string): Promise<ImportedTrack> {
  const id = storage.newId();
  const text = await storage.readFileText(uri);
  const fileUri = storage.writeTrackGpx(id, text);
  return buildOrCleanUp(text, id, fileUri, fallbackName);
}
