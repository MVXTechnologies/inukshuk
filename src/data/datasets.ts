/**
 * The extensions' published tile archives (`@core/extensions` `DatasetId`):
 * where each one's tiles and TileJSON (coverage: sources, counts, build date)
 * are. Minimal on purpose (architecture review P2-4 has the full table): the
 * tile templates themselves stay in `./basemapTiles`, frozen by
 * `tileUrls.contract.test.ts` — this only names them.
 *
 * Changing a TileJSON `?v=` here is free (nothing offline is keyed by it);
 * changing a tile template is not: read docs/design/tile-urls.md.
 */
import type { DatasetId } from '@core/extensions/types';

import { geodeticTilesUrl, TILE_HOST, tideTilesUrl } from './basemapTiles';

interface Dataset {
  /** Its tile template (build-time override or ours), or null while unpublished. */
  tiles: () => string | null;
  /** Its TileJSON on the tile Worker. */
  tileJson: string;
}

const DATASETS: Record<DatasetId, Dataset> = {
  geodetic: { tiles: geodeticTilesUrl, tileJson: `${TILE_HOST}/geodetic.json?v=2` },
  tides: { tiles: tideTilesUrl, tileJson: `${TILE_HOST}/tides.json?v=1` },
};

export function datasetTilesUrl(id: DatasetId): string | null {
  return DATASETS[id].tiles();
}

export function datasetTileJsonUrl(id: DatasetId): string {
  return DATASETS[id].tileJson;
}
