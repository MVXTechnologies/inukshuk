import { parseGpx } from '@core/geo/gpx';
import { buildTrackAxis } from '@core/geo/track';
import type { TrackPoint, TrackSummary } from '@core/models';
import type { TrackPhoto } from '@core/photos/model';
import { combineTrailPhotos, notePhotosOnTrail } from '@core/photos/notePhotos';
import { indexTrack } from '@core/photos/trackIndex';
import type { ViewerTrail } from '@core/photos/viewerInfo';
import * as storage from '@data/storage';
import { useLibraryStore } from '@state/libraryStore';
import { useTrailPhotos, type TrailPhotosStatus } from '@state/trailPhotosStore';
import { useEffect, useMemo, useState } from 'react';

export interface ViewerTrailData {
  track: TrackSummary | undefined;
  /** The trail's photos (own, hidden ones included so they can be shown again, + note photos), viewer order. */
  photos: TrackPhoto[];
  status: TrailPhotosStatus;
  /** Null until the GPX is read. */
  trail: ViewerTrail | null;
  /** The photo anchors' cumulative metres per point (see `@core/photos/axis`). */
  indexCumM: ArrayLike<number> | null;
}

const hasTime = (p: TrackPoint) => p.hasTime !== false && Number.isFinite(p.time) && p.time > 0;

/** A trail's photos and the points they are measured on, for the photo viewer (#587). */
export function useViewerTrail(trackId: string): ViewerTrailData {
  const track = useLibraryStore((s) => s.tracks.find((t) => t.id === trackId));
  const { status, photos: own } = useTrailPhotos(trackId);
  const [gpx, setGpx] = useState<{ points: TrackPoint[]; segmentStarts: number[] } | null>(null);
  const fileUri = track?.fileUri;

  useEffect(() => {
    if (!fileUri) return;
    let cancelled = false;
    void (async () => {
      try {
        const doc = parseGpx(await storage.readFileText(fileUri));
        if (!cancelled) setGpx({ points: doc.points, segmentStarts: doc.segmentStarts });
      } catch {
        // Unreadable trail: the photos still show, without distances.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileUri]);

  const index = useMemo(() => (gpx ? indexTrack(gpx.points) : null), [gpx]);
  const planned = track?.plan !== undefined;
  const trail = useMemo((): ViewerTrail | null => {
    if (!gpx) return null;
    const axis = buildTrackAxis(gpx.points, gpx.segmentStarts);
    const first = planned ? undefined : gpx.points.find(hasTime);
    return {
      axisCumM: axis.cumM,
      elevations: gpx.points.map((p) =>
        p.altitude !== undefined && Number.isFinite(p.altitude) ? p.altitude : undefined,
      ),
      totalM: axis.totalM,
      ...(first ? { startMs: first.time } : {}),
    };
  }, [gpx, planned]);

  const notes = track?.notes;
  const photos = useMemo(() => {
    const shown = own;
    return index ? combineTrailPhotos(shown, notePhotosOnTrail(notes, trackId, index)) : shown;
  }, [own, index, notes, trackId]);

  return { track, photos, status, trail, indexCumM: index ? index.cumM : null };
}
