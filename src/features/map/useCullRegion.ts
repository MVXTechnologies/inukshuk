import { nextCullRegion, type CullRegion } from '@core/map/viewportCull';
import { useEffect, useState } from 'react';

/** Settled viewport edges, degrees (the map's settled bounds). */
export interface SettledViewport {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Quiet time after a camera settle before the region moves (a fling settles several times). */
export const CULL_SETTLE_MS = 250;

/**
 * The map's cull region (#494): the settled viewport plus a margin, at the
 * settled integer zoom — what the trail lines and the heatmap are built for.
 * Debounced on camera settles, and sticky: while the viewport stays inside
 * the current region at the same integer zoom the same object comes back
 * (React then skips the update), so a GPS follow tick or a small pan
 * rebuilds nothing. `null` until the map has reported a viewport.
 */
export function useCullRegion(
  bounds: SettledViewport | null,
  zoom: number | null,
  settleMs: number = CULL_SETTLE_MS,
): CullRegion | null {
  const [region, setRegion] = useState<CullRegion | null>(null);
  const known = region !== null;
  useEffect(() => {
    if (bounds === null || zoom === null) return;
    const viewport = {
      minLng: bounds.west,
      minLat: bounds.south,
      maxLng: bounds.east,
      maxLat: bounds.north,
    };
    // The first region is wanted at once (nothing is drawn without one);
    // later ones wait for the camera to stay put.
    const timer = setTimeout(
      () => setRegion((prev) => nextCullRegion(prev, viewport, zoom)),
      known ? settleMs : 0,
    );
    return () => clearTimeout(timer);
  }, [bounds, zoom, settleMs, known]);
  return region;
}
