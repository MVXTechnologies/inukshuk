import { parseGpx } from '@core/geo/gpx';
import type { TrackPointAt } from '@core/geo/track';
import type { TrackPoint, TrackSummary } from '@core/models';
import * as storage from '@data/storage';
import { useCallback, useEffect, useState } from 'react';
import type { TrimRange } from '../components/TrailInspectPanel';

/**
 * Trail inspection: tap a trail trace to open its elevation profile; scrubbing
 * the profile drives a marker along the trace (markerAt). The panel can also
 * enter a trim mode (trimRange != null): two handles select the kept [start,
 * end] point window, previewed live on the map by MapScreen.
 */
export function useTrailInspection(tracks: readonly TrackSummary[]) {
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [inspectPoints, setInspectPoints] = useState<readonly TrackPoint[] | null>(null);
  const [markerAt, setMarkerAt] = useState<TrackPointAt | null>(null);
  const [trimRange, setTrimRange] = useState<TrimRange | null>(null);
  const inspectTrack = tracks.find((t) => t.id === inspectId) ?? null;
  const inspectFileUri = inspectTrack?.fileUri ?? null;

  // Enter/leave inspection; clears any previously-loaded points + marker + trim.
  const inspect = (id: string | null) => {
    setInspectId(id);
    setInspectPoints(null);
    setMarkerAt(null);
    setTrimRange(null);
  };

  const beginTrim = useCallback(() => {
    if (inspectPoints && inspectPoints.length >= 3) {
      setMarkerAt(null);
      setTrimRange({ start: 0, end: inspectPoints.length - 1 });
    }
  }, [inspectPoints]);

  const cancelTrim = useCallback(() => setTrimRange(null), []);

  const changeTrim = useCallback((start: number, end: number) => {
    setTrimRange({ start, end });
  }, []);

  // Load the inspected trail's GPX points once selected.
  useEffect(() => {
    if (!inspectFileUri) return;
    let cancelled = false;
    (async () => {
      try {
        const gpx = await storage.readFileText(inspectFileUri);
        const { points: pts } = parseGpx(gpx);
        if (!cancelled) setInspectPoints(pts);
      } catch {
        if (!cancelled) setInspectPoints(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inspectFileUri]);

  return {
    inspectId,
    inspectTrack,
    inspectPoints,
    markerAt,
    setMarkerAt,
    inspect,
    trimRange,
    beginTrim,
    cancelTrim,
    changeTrim,
  };
}
