import type { TrackSummary } from '@core/models';
import { parseGpx } from '@core/geo/gpx';
import * as storage from '@data/storage';
import type { Feature, LineString } from 'geojson';
import { useEffect, useState } from 'react';
import { toLineFeature } from './geojson';
import { useLibraryStore } from '@state/libraryStore';

export interface TrackOverlay {
  id: string;
  feature: Feature<LineString>;
}

/**
 * Loads + parses the GPX of every active trail (persisted in the library store,
 * like PDF page activation) into GeoJSON line features for rendering. Parsed
 * features are cached by track id so toggling a trail back on is instant.
 * Mirrors `usePdfOverlays`.
 */
export function useTrackOverlays(tracks: readonly TrackSummary[]): TrackOverlay[] {
  const activeTrackIds = useLibraryStore((s) => s.activeTrackIds);
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
    // Membership check: removeTrack prunes activeTrackIds, but the parsed cache
    // (and any stale persisted id) must never render a deleted trail — without
    // this it kept rendering until app restart.
    if (!tracks.some((t) => t.id === id)) continue;
    const feature = cache[id];
    if (feature) overlays.push({ id, feature });
  }
  return overlays;
}
