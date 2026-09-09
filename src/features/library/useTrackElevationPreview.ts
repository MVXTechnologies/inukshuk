import { parseGpx } from '@core/geo/gpx';
import type { TrackPoint, TrackSummary } from '@core/models';
import * as storage from '@data/storage';
import { useEffect, useMemo, useRef, useState } from 'react';

type Request = { track: TrackSummary | undefined };
type Preview = { request: Request; points: TrackPoint[] };

/** A summary replacement invalidates cached GPX even when its id/URI are reused. */
export function useTrackElevationPreview(
  track: TrackSummary | undefined,
  onError: (error: Error) => void,
) {
  const cache = useRef(new WeakMap<TrackSummary, TrackPoint[]>());
  const [preview, setPreview] = useState<Preview>();
  const request = useMemo(() => ({ track }), [track]);

  useEffect(() => {
    const { track } = request;
    if (!track) return;
    let cancelled = false;
    const load = async () => {
      try {
        const points =
          cache.current.get(track) ?? parseGpx(await storage.readFileText(track.fileUri)).points;
        if (cancelled) return;
        cache.current.set(track, points);
        setPreview({ request, points });
      } catch (error) {
        if (!cancelled) onError(error instanceof Error ? error : new Error(String(error)));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [request, onError]);

  // Never show the prior revision for the render before the effect runs.
  return preview?.request === request ? preview : undefined;
}
