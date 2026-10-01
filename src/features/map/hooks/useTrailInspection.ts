import { parseGpx } from '@core/geo/gpx';
import type { TrackPointAt } from '@core/geo/track';
import type { TrackPoint, TrackSummary } from '@core/models';
import * as storage from '@data/storage';
import { useCallback, useEffect, useState } from 'react';

/**
 * Trail inspection: tap a trail trace to open its elevation profile; scrubbing
 * the profile drives a marker along the trace (markerAt). Trimming has moved
 * to the focused trail viewer (Trail3DGLScreen) — this hook only owns
 * selection + the scrub marker now.
 */
export function useTrailInspection(tracks: readonly TrackSummary[]) {
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [inspectPoints, setInspectPoints] = useState<readonly TrackPoint[] | null>(null);
  const [markerAt, setMarkerAt] = useState<TrackPointAt | null>(null);
  const inspectTrack = tracks.find((t) => t.id === inspectId) ?? null;
  const inspectFileUri = inspectTrack?.fileUri ?? null;

  // Enter/leave inspection; clears any previously-loaded points + marker.
  // Stable across renders: the drawing tool's `onBeforeStart` closes the panel
  // through it, and a fresh function each render re-armed (and so cancelled)
  // the deferred "Edit route" request on every map re-render.
  const inspect = useCallback((id: string | null) => {
    setInspectId(id);
    setInspectPoints(null);
    setMarkerAt(null);
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
  };
}
