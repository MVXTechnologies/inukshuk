import type { TrackSummary } from '@core/models';
import { parseGpx } from '@core/geo/gpx';
import * as storage from '@data/storage';
import type { Feature, LineString } from 'geojson';
import { useEffect, useState } from 'react';
import { toLineFeature } from './geojson';

export interface TrackOverlay {
  id: string;
  feature: Feature<LineString>;
}

// Cache key: the id alone is not enough — a trim "overwrite" rewrites the GPX
// under the same id, and a stale cached feature would keep drawing the old
// geometry until app restart. Point count + distance change on any edit.
const cacheKey = (t: TrackSummary): string => `${t.id}|${t.stats.pointCount}|${t.stats.distanceM}`;

/**
 * Loads + parses the GPX of every active trail (persisted in the library store,
 * like PDF page activation) into GeoJSON line features for rendering. Parsed
 * features are cached by track id + stats so toggling a trail back on is
 * instant while an edited trail reloads. Mirrors `usePdfOverlays`.
 */
export function useTrackOverlays(
  tracks: readonly TrackSummary[],
  /** Which trails to draw — the caller resolves the visibility mode. */
  activeTrackIds: readonly string[],
): TrackOverlay[] {
  const [cache, setCache] = useState<Record<string, Feature<LineString> | null>>({});

  const key = activeTrackIds.join('|');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const id of activeTrackIds) {
        const t = tracks.find((x) => x.id === id);
        if (!t) continue;
        const ck = cacheKey(t);
        if (cache[ck] !== undefined) continue;
        try {
          const gpx = await storage.readFileText(t.fileUri);
          const { points } = parseGpx(gpx);
          if (cancelled) return;
          setCache((c) => ({ ...c, [ck]: toLineFeature(points) }));
        } catch {
          if (cancelled) return;
          setCache((c) => ({ ...c, [ck]: null }));
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
    const t = tracks.find((x) => x.id === id);
    if (!t) continue;
    const feature = cache[cacheKey(t)];
    if (feature) overlays.push({ id, feature });
  }
  return overlays;
}
