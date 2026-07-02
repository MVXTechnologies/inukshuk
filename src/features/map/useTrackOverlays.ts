import type { TrackSummary } from '@core/models';
import { parseGpx } from '@core/geo/gpx';
import * as storage from '@data/storage';
import type { Feature, LineString } from 'geojson';
import { useEffect, useState } from 'react';
import { toLineFeature } from './geojson';
import { useMapStore } from '@state/mapStore';

export interface TrackOverlay {
  id: string;
  feature: Feature<LineString>;
}

/**
 * Loads + parses the GPX of every active trail (from the map store) into GeoJSON
 * line features for rendering. Parsed features are cached by track id so toggling
 * a trail back on is instant. Mirrors `usePdfOverlays`.
 */
export function useTrackOverlays(tracks: readonly TrackSummary[]): TrackOverlay[] {
  const activeTrackIds = useMapStore((s) => s.activeTrackIds);
  const [cache, setCache] = useState<Record<string, Feature<LineString> | null>>({});

  const key = activeTrackIds.join('|');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const id of activeTrackIds) {
        if (cache[id] !== undefined) continue;
        const t = tracks.find((x) => x.id === id);
        if (!t) continue;
        try {
          const gpx = await storage.readFileText(t.fileUri);
          const { points } = parseGpx(gpx);
          if (cancelled) return;
          setCache((c) => ({ ...c, [id]: toLineFeature(points) }));
        } catch {
          if (cancelled) return;
          setCache((c) => ({ ...c, [id]: null }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tracks]);

  const overlays: TrackOverlay[] = [];
  for (const id of activeTrackIds) {
    // Membership check: a deleted trail can linger in activeTrackIds (and in
    // the parsed cache) — without this it kept rendering until app restart.
    if (!tracks.some((t) => t.id === id)) continue;
    const feature = cache[id];
    if (feature) overlays.push({ id, feature });
  }
  return overlays;
}
