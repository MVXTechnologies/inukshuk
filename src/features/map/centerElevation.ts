import { createPointElevationReader, type PointElevationReader } from '@core/geo/pointElevation';
import { useEffect, useState } from 'react';

import { fetchDemTile } from './dem';

/**
 * The map centre's ground elevation (#677): one shared reader over the DEM
 * tiles, fetched and decoded by the same `fetchDemTile` as route elevation
 * and trail climb (on-disk tile cache first, so tiles any of those already
 * pulled are read offline; "Locally downloaded only" honoured), the decoded
 * tiles kept in `@core/geo/pointElevation`'s LRU.
 */
const makeReader = (): PointElevationReader =>
  createPointElevationReader(async (key) => ({
    size: 256,
    data: await fetchDemTile(key.z, key.x, key.y),
  }));

let shared = makeReader();

/** Tests: start from an empty cache. */
export function resetCenterElevation(): void {
  shared = makeReader();
}

/**
 * Elevation (m) at `at`, or null while unknown or unavailable. Never a stale
 * number: the value is read for THIS point on every render.
 *
 * Per camera idle: a cached tile answers synchronously in render (an LRU
 * lookup and a bilinear sample of four pixels; no state update, so no extra
 * render). Otherwise one tile load starts; when it lands the hook renders
 * once more, unless the camera moved on (the stale result is dropped; the
 * decoded tile still lands in the cache for the next idle there).
 */
export function useCenterElevation(
  at: { latitude: number; longitude: number } | null,
  reader: PointElevationReader = shared,
): number | null {
  const [, setLoaded] = useState(0);
  const lat = at?.latitude;
  const lon = at?.longitude;
  const known = lat === undefined || lon === undefined ? null : reader.peek(lat, lon);

  useEffect(() => {
    if (lat === undefined || lon === undefined || known !== undefined) return;
    let alive = true;
    void reader.load(lat, lon).then(() => {
      if (alive) setLoaded((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [lat, lon, known, reader]);

  return known ?? null;
}
