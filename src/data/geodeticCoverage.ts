import { parseGeodeticCoverage } from '@core/geodetic/coverage';
import { TILE_HOST } from '@data/basemapTiles';
import { useGeodeticStore } from '@state/geodeticStore';

/**
 * Fetch the geodetic archive's coverage (sources, vertical datums, counts,
 * build date) from its TileJSON — `/geodetic.json` on the tile Worker. Kept
 * out of the extension's actions so light screens (the filter panel) don't
 * pull in the offline-pack machinery. Offline: no-op, screens fall back to
 * the bundled catalogue without counts.
 */
export async function refreshGeodeticCoverage(): Promise<void> {
  try {
    const res = await fetch(`${TILE_HOST}/geodetic.json?v=2`);
    if (!res.ok) return;
    const coverage = parseGeodeticCoverage(await res.json());
    if (coverage) useGeodeticStore.getState().patch({ coverage });
  } catch {
    // offline
  }
}
