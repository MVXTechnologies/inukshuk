import type { TrackGeometry } from '@core/geo/track/simplify';
import type { TrackSummary } from '@core/models';
import { peekTrackGeometry } from '@data/trackGeometry';
import { useMemo } from 'react';

import type { TrailLineFeature } from './geojson';
import { indexTracks, useTrackGeometries } from './useTrackGeometries';

export interface TrackOverlay {
  id: string;
  /** One part per `<trkseg>` — a recording's pauses are never drawn across. */
  feature: TrailLineFeature;
}

// One feature per geometry object (a new object per trail revision), so the
// overlay list's entries keep their identity across rebuilds.
const features = new WeakMap<TrackGeometry, TrailLineFeature | null>();

function featureOf(g: TrackGeometry): TrailLineFeature | null {
  let f = features.get(g);
  if (f === undefined) {
    const parts = g.parts.filter((p) => p.length >= 2);
    const [only] = parts;
    f = only
      ? {
          type: 'Feature',
          geometry:
            parts.length === 1
              ? { type: 'LineString', coordinates: only }
              : { type: 'MultiLineString', coordinates: parts },
          properties: {},
        }
      : null;
    features.set(g, f);
  }
  return f;
}

/**
 * The line features of every active trail (the caller resolves visibility),
 * for the 3D drape and the overlay count. Geometry is the shared simplified
 * one (`@data/trackGeometry`, loaded in batches by `useTrackGeometries`) —
 * this used to parse every active trail's GPX a second time, next to
 * `useTrackHeat`, and keep full-resolution copies (#465). An edited trail is
 * a new revision and reloads; a deleted one drops out with the track list.
 */
export function useTrackOverlays(
  tracks: readonly TrackSummary[],
  /** Which trails to draw — the caller resolves the visibility mode. */
  activeTrackIds: readonly string[],
): TrackOverlay[] {
  const tracksById = useMemo(() => indexTracks(tracks), [tracks]);
  const version = useTrackGeometries(tracksById, activeTrackIds);
  const key = activeTrackIds.join('|');

  // Memoized on the resolved inputs: an unmemoized array here got a new
  // identity on every host render, which defeated the caller's own memos (the
  // 3D drape's polyline list) even when nothing had changed.
  return useMemo(() => {
    const overlays: TrackOverlay[] = [];
    for (const id of activeTrackIds) {
      // Membership check: a stale persisted id must never render a deleted trail.
      const t = tracksById.get(id);
      if (!t) continue;
      const g = peekTrackGeometry(t);
      const feature = g ? featureOf(g) : null;
      if (feature) overlays.push({ id, feature });
    }
    return overlays;
    // `key` is the joined activeTrackIds — the array itself is rebuilt by the
    // caller on every render, so keying on its content is what makes this hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tracksById, version]);
}
